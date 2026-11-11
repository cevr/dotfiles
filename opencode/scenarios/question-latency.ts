// What a key costs while questions are open, in the Prime look with our TUI
// plugins. A first turn builds a transcript (LAT_GROUPS tool groups); a
// second asks three long background questions (sixty lines each) through
// `ask_user_async` and starts LAT_SUBAGENTS background workers that stream
// slowly, the first of which asks one more. Then, over the same family:
//
// - `tray`: the tray shows above the composer; LAT_KEYS letters are typed into
//   the composer, one at a time, each waited for on the frame (the cursor
//   moves), then a burst of LAT_KEYS letters at LAT_RATE a second, as a held
//   key sends them, timed until the last one shows;
// - `arrows`: /answer's form is open on the first question; LAT_KEYS ↓, each
//   waited for (the highlighted option moves), then a held ↓ burst;
// - `typing`: the custom answer of the form, LAT_KEYS letters each waited for,
//   then a held burst.
//
// Each phase writes the per-key latency (ms from the key to the frame that
// shows it: p50, p90, max), the held burst's lag after its last key, and the
// TUI's CPU per key and the main thread's busy share (Linux /proc; elsewhere
// the process's CPU from ps). LAT_PROFILE=<phase> sends the TUI SIGPROF as
// that phase starts: the fork writes a 10 s JS CPU profile into its log dir
// (packages/cli/src/cpu-profile.ts). It writes `latency.json` under SCENARIO_OUT.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out OPENCODE_DRIVE_MEDIA_DIR=out/media bunx opencode-drive run scenarios/question-latency.ts
import { Effect, Schedule, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const env = process.env
const GROUPS = Number(env.LAT_GROUPS ?? 100)
const SUBAGENTS = Number(env.LAT_SUBAGENTS ?? 3)
const KEYS = Number(env.LAT_KEYS ?? 40)
const RATE = Number(env.LAT_RATE ?? 30)
const PROFILE = env.LAT_PROFILE
/** LAT_ASK=0: no question is asked, so the tray phase is the composer with none open, and the form phases are skipped. */
const ASKS = env.LAT_ASK !== "0"
const WORK_SECONDS = Number(env.LAT_WORK_SECONDS ?? 150)
const IDLE_MS = Number(env.LAT_IDLE_MS ?? 20_000)
const PER_STEP = 5
/** The owner's TUI plugins (the workbox's cli.json). */
const PLUGINS = ["prime", "status", "herdr", "git", "cache", "questions", "btw", "skills", "recover", "orchestrate", "escape"]

type Span = { readonly text: string; readonly fg?: unknown }
type Frame = { readonly cursor: unknown; readonly lines: ReadonlyArray<{ readonly spans: ReadonlyArray<Span> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")
/** The letters typed, a-z over and over, so each prefix of them reads once on a line. */
const SEQUENCE = Array.from({ length: 2 * KEYS }, (_, i) => String.fromCharCode(97 + (i % 26))).join("")
/** How many of SEQUENCE's letters a line of the frame shows. */
const typedOf = (frame: Frame) => {
  const lines = text(frame).split("\n")
  let k = 0
  while (k < SEQUENCE.length && lines.some((line) => line.includes(SEQUENCE.slice(0, k + 1)))) k++
  return String(k)
}
/** Which option the form highlights: the colours of the option labels' spans. */
const highlightOf = (frame: Frame) =>
  JSON.stringify(
    frame.lines.flatMap((l) => l.spans.filter((s) => /Keep it|Drop it|Type your own answer|Use the default/.test(s.text)).map((s) => s.fg)),
  )

const BUILD = "Survey the code base."
const BUILT = "Survey done."
const ASK = "Ask me, then work."
const ASKED = "Asked; workers started."
const WORKER = (i: number) => `Worker brief ${i}.`
const long = (topic: string) => Array.from({ length: 60 }, (_, i) => `${topic}: line ${i + 1} of the question`).join("\n")
const OPTIONS = [
  { label: "Keep it", description: "as it is" },
  { label: "Drop it", description: "for good" },
]
const QUESTIONS = ["Cache", "Endpoint", "Logs"].map((topic) => ({ question: long(topic), header: `${topic} choice`, options: OPTIONS, assume: "Keep it" }))
const SOURCE = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i} // line ${i}`).join("\n")
const slow = (seconds: number, label: string) =>
  Llm.text(Array.from({ length: seconds * 10 }, (_, i) => `${label} word ${i}${i % 12 === 11 ? ".\n\n" : " "}`).join(""), {
    delay: 100,
    chunkSize: label.length + 10,
  })

/** The TUI's pid: the descendant of this driver whose command line is OpenCode's without `serve`. */
const tuiPid = () => {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .flatMap((m) => (m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }] : []))
  const mine = new Set([process.pid])
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows)
      if (!mine.has(row.pid) && mine.has(row.ppid)) {
        mine.add(row.pid)
        grew = true
      }
  }
  const candidates = rows.filter((row) => mine.has(row.pid) && row.pid !== process.pid)
  writeFileSync(`${out}/processes.txt`, candidates.map((row) => `${row.pid} ${row.ppid} ${row.command}`).join("\n"))
  const tui = candidates.filter((row) => !/\bserve\b|--service/.test(row.command) && /opencode|index\.ts|bun/.test(row.command))
  return tui.map((row) => row.pid)
}

/** CPU seconds of the process and of its main thread (user + system); the thread's is the process's off Linux. */
const cpu = (pid: number) => {
  const stat = `/proc/${pid}/stat`
  const ticks = (file: string) => {
    const fields = readFileSync(file, "utf8").split(") ")[1]!.split(" ")
    return (Number(fields[11]) + Number(fields[12])) / 100
  }
  if (existsSync(stat)) return { process: ticks(stat), main: ticks(`/proc/${pid}/task/${pid}/stat`) }
  const time = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim()
  const seconds = time.split(/[:-]/).map(Number).reduce((total, part) => total * 60 + part, 0)
  return { process: seconds, main: seconds }
}

const quantile = (values: ReadonlyArray<number>, q: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

export default OpenCodeDriver.use(
  {
    opencode: env.OPENCODE_DEV ? { dev: env.OPENCODE_DEV } : undefined,
    config: { autoupdate: false, username: "Demo", compaction: { auto: false }, plugins: [`${root}/cmd/questions`] },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: PLUGINS.map((name) => `${root}/cmd/${name}`),
    },
    tui: { viewport: { cols: Number(env.LAT_COLS ?? 120), rows: 45 } },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8"), "src/values.ts": SOURCE },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("questions"), Llm.finish())
        const worker = Array.from({ length: SUBAGENTS }, (_, i) => i).find((i) => s.includes(WORKER(i)) && !s.includes(BUILD))
        if (worker !== undefined) {
          if (ASKS && worker === 0 && !s.includes("call_sub_ask"))
            return Stream.make(
              Llm.toolCall({
                index: 0,
                id: "call_sub_ask",
                name: "ask_user_async",
                input: { questions: [{ question: long("Worker"), header: "Worker choice", options: OPTIONS, assume: "Keep it" }] },
              }),
              Llm.finish("tool-calls"),
            )
          return Stream.make(Llm.reasoning(`Worker ${worker} reads the brief.`), slow(WORK_SECONDS, `w${worker}`), Llm.finish())
        }
        if (s.includes(ASK)) {
          if (s.includes(ASKED)) return Stream.make(Llm.text("Carried on."), Llm.finish())
          if (ASKS && !s.includes("call_ask"))
            return Stream.make(Llm.toolCall({ index: 0, id: "call_ask", name: "ask_user_async", input: { questions: QUESTIONS } }), Llm.finish("tool-calls"))
          const next = Array.from({ length: SUBAGENTS }, (_, i) => i).find((i) => !s.includes(`call_worker_${i}`))
          if (next !== undefined)
            return Stream.make(
              Llm.toolCall({
                index: 0,
                id: `call_worker_${next}`,
                name: "subagent",
                input: { agent: "general", description: `Fix module ${next}`, prompt: WORKER(next), background: true },
              }),
              Llm.finish("tool-calls"),
            )
          return Stream.make(Llm.text(ASKED), Llm.finish())
        }
        let step = 0
        while (step * PER_STEP < GROUPS && s.includes(`"call_r${step}_0"`)) step++
        if (step * PER_STEP < GROUPS)
          return Stream.make(
            ...Array.from({ length: PER_STEP }, (_, g) => [
              Llm.reasoning(`Step ${step}.${g}: check the values next.`),
              Llm.toolCall({ index: 2 * g, id: `call_r${step}_${g}`, name: "read", input: { path: "src/values.ts" } }),
              Llm.toolCall({ index: 2 * g + 1, id: `call_g${step}_${g}`, name: "grep", input: { pattern: `value${g}`, path: "src" } }),
              Llm.text(`Group ${step}.${g} read.`),
            ]).flat(),
            Llm.finish("tool-calls"),
          )
        return Stream.make(Llm.text(BUILT), Llm.finish())
      })

      const capture = ui.capture() as unknown as Effect.Effect<Frame>
      const until = (name: string, ready: (frame: string) => boolean, times = 600) =>
        capture.pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times }),
          Effect.tapError(() => capture.pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame))))),
        )
      const save = (name: string) => capture.pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.txt`, text(frame))))
      /** Polls the frame until `sign` differs from `before`; the ms it took, or -1 past 5 s. */
      const changed = (sign: (frame: Frame) => string, before: string, start: number) =>
        Effect.gen(function* () {
          while (Date.now() - start < 5000) {
            const frame = yield* capture
            if (sign(frame) !== before) return Date.now() - start
            yield* Effect.sleep("5 millis")
          }
          return -1
        })

      /** The TUI's CPU over LAT_IDLE_MS with no key and no capture: what it costs to sit there. */
      const still = (name: string) =>
        Effect.gen(function* () {
          const pid = tuiPid()[0]!
          if (profiled(name)) process.kill(pid, "SIGPROF")
          const before = cpu(pid)
          const started = Date.now()
          yield* Effect.sleep(IDLE_MS)
          const after = cpu(pid)
          const seconds = (Date.now() - started) / 1000
          const result = {
            phase: name,
            cores: Number(((after.process - before.process) / seconds).toFixed(3)),
            mainBusy: Number(((after.main - before.main) / seconds).toFixed(3)),
            seconds: Number(seconds.toFixed(1)),
            startedAt: started,
          }
          console.log("latency:", JSON.stringify(result))
          if (profiled(name)) {
            yield* Effect.sleep(Math.max(0, started + 11_000 - Date.now()))
            keepProfile(pid, name)
          }
          return result
        })

      /** One phase: `keys` pressed one at a time, each waited for on `sign`, then a held burst of them. */
      const phase = (name: string, key: (i: number) => Effect.Effect<unknown, unknown>, sign: (frame: Frame) => string) =>
        Effect.gen(function* () {
          const pid = tuiPid()[0]!
          if (profiled(name)) process.kill(pid, "SIGPROF")
          const before = cpu(pid)
          const started = Date.now()
          const latencies: Array<number> = []
          for (let i = 0; i < KEYS; i++) {
            const from = sign(yield* capture)
            const start = Date.now()
            yield* key(i)
            latencies.push(yield* changed(sign, from, start))
          }
          // A held key: the burst at RATE a second, then the time from its last key until the frame stops changing.
          for (let i = 0; i < KEYS; i++) {
            yield* key(KEYS + i)
            yield* Effect.sleep(`${Math.round(1000 / RATE)} millis`)
          }
          const last = Date.now()
          let settled = sign(yield* capture)
          let quiet = Date.now()
          while (Date.now() - quiet < 300 && Date.now() - last < 10_000) {
            yield* Effect.sleep("10 millis")
            const now = sign(yield* capture)
            if (now !== settled) {
              settled = now
              quiet = Date.now()
            }
          }
          const lag = quiet - last
          const after = cpu(pid)
          const seconds = (Date.now() - started) / 1000
          const result = {
            phase: name,
            keys: 2 * KEYS,
            p50: quantile(latencies, 0.5),
            p90: quantile(latencies, 0.9),
            max: Math.max(...latencies),
            missed: latencies.filter((ms) => ms < 0).length,
            heldLagMs: lag,
            cpuMsPerKey: Math.round(((after.process - before.process) * 1000) / (2 * KEYS)),
            mainBusy: Number(((after.main - before.main) / seconds).toFixed(3)),
            seconds: Number(seconds.toFixed(1)),
            startedAt: started,
          }
          console.log("latency:", JSON.stringify(result))
          yield* save(name)
          if (profiled(name)) {
            // The fork's profile runs 10 s from the signal; keep it, since the driver's data dir goes with the run.
            yield* Effect.sleep(Math.max(0, started + 11_000 - Date.now()))
            keepProfile(pid, name)
          }
          return result
        })

      yield* ui.submit(BUILD)
      yield* until("built", (frame) => frame.includes(BUILT), 3_000)
      yield* ui.submit(ASK)
      const asked = Date.now()
      const open = `${QUESTIONS.length + (SUBAGENTS > 0 ? 1 : 0)} open questions`
      yield* until("asked", (frame) => frame.includes(ASKED) && (!ASKS || frame.includes(open)))
      yield* Effect.sleep("2 seconds")
      const idle = yield* still("idle")
      const tray = yield* phase("tray", (i) => ui.type(SEQUENCE[i]!), typedOf)
      for (let i = 0; i < 2 * KEYS; i++) yield* ui.press("backspace")
      const form = ASKS
        ? yield* Effect.gen(function* () {
            const opening = Date.now()
            yield* ui.submit("/answer")
            yield* until("form", (frame) => frame.includes("line 1 of the question") && frame.includes("Background questions"))
            console.log("latency:", JSON.stringify({ phase: "open", ms: Date.now() - opening }))
            yield* Effect.sleep("1 second")
            const idleForm = yield* still("idle-form")
            const arrows = yield* phase("arrows", () => ui.press("down"), highlightOf)
            yield* ui.press("3")
            yield* Effect.sleep("300 millis")
            const typing = yield* phase("typing", (i) => ui.type(SEQUENCE[i]!), typedOf)
            return [idleForm, arrows, typing]
          })
        : []
      const result = { asks: ASKS, groups: GROUPS, subagents: SUBAGENTS, keys: KEYS, rate: RATE, load: readFileSafe("/proc/loadavg"), phases: [idle, tray, ...form] }
      writeFileSync(`${out}/latency.json`, JSON.stringify(result, null, 2))
      // Let every slow stream end before the driver checks each model response settled.
      yield* Effect.sleep(Math.max(0, asked + (WORK_SECONDS + 15) * 1000 - Date.now()))
    }),
)

function profiled(name: string) {
  return (PROFILE ?? "").split(",").includes(name)
}

/** Copies the TUI's newest CPU profile from its log dir (its XDG data dir's opencode/log) to `<out>/<name>.cpuprofile`. */
function keepProfile(pid: number, name: string) {
  const environ = existsSync(`/proc/${pid}/environ`) ? readFileSync(`/proc/${pid}/environ`, "utf8").split("\0") : []
  const value = (key: string) => environ.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1)
  const data = value("XDG_DATA_HOME") ?? join(value("HOME") ?? homedir(), ".local/share")
  const log = join(data, "opencode", "log")
  const found = existsSync(log) ? readdirSync(log).filter((file) => file.startsWith(`cpu-${pid}-`)).sort() : []
  const newest = found.at(-1)
  if (newest === undefined) return console.log(`latency: no profile of ${pid} in ${log}`)
  copyFileSync(join(log, newest), `${out}/${name}.cpuprofile`)
}

function readFileSafe(file: string) {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined
}
