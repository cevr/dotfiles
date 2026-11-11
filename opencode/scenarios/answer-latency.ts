// How long an answer takes to land, from the key that submits it, on a small or
// a large transcript, in the Prime look with our TUI plugins. A first turn
// builds the transcript (LAT_GROUPS tool groups, five to a model step). Then,
// LAT_ROUNDS times each:
//
// - `async`: the model asks one background question through `ask_user_async`
//   and ends its turn; /answer opens the host's form on it, and return picks
//   the highlighted choice, which submits it;
// - `builtin`: the model asks one question through the built-in `question`
//   tool, which waits; return picks the highlighted choice.
//
// From the return key, each round times (ms):
// - `closed`: the first frame without the form;
// - `shown`: the first frame that shows the answer in the transcript (our
//   `answered ·` notice row; the built-in tool's row turned from `Asking` to
//   `Asked`);
// - `request`: the model request that carries the answer reaching the
//   simulated model (the driver's handler sees it).
// LAT_SESSION=<id> runs the rounds on an existing session instead (see SESSION).
// It writes `answer-latency.json` under SCENARIO_OUT, and logs each round as
// `answer:` lines. LAT_PROFILE=<round> sends the TUI SIGPROF before that round's async
// submit (the fork writes a 10 s CPU profile into its log dir) and keeps it.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out OPENCODE_DRIVE_MEDIA_DIR=out/media LAT_GROUPS=1000 bunx opencode-drive run scenarios/answer-latency.ts
import { Effect, Schedule, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { appendFileSync, copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const env = process.env
/**
 * LAT_SESSION=<id>: the TUI is on that existing session (a copy of a real one, opened through
 * a development entrypoint that adds `--session`), so no transcript is built.
 */
const SESSION = env.LAT_SESSION
const GROUPS = SESSION === undefined ? Number(env.LAT_GROUPS ?? 20) : 0
const ROUNDS = Number(env.LAT_ROUNDS ?? 3)
const PER_STEP = 5
/** The owner's TUI plugins (the workbox's cli.json). */
const PLUGINS = ["prime", "status", "herdr", "git", "cache", "questions", "btw", "skills", "recover", "orchestrate", "escape"]

type Span = { readonly text: string }
type Frame = { readonly lines: ReadonlyArray<{ readonly spans: ReadonlyArray<Span> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const BUILD = "Survey the code base."
const BUILT = "Survey done."
const ASYNC = (round: number) => `Ask me in the background, round ${round}.`
const BUILTIN = (round: number) => `Ask me and wait, round ${round}.`
const ASKED = (round: number) => `Asked in round ${round}; carrying on.`
const READ = (round: number) => `Read the answer of round ${round}.`
/** A choice whose label is only in the form, and one in the answer. */
const choices = (round: number) => [
  { label: `Pick r${round}`, description: "the highlighted one" },
  { label: `Other r${round}`, description: "the other one" },
]
const SOURCE = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i} // line ${i}`).join("\n")
const say = (line: string) => Stream.make(Llm.text(line), Llm.finish())
const call = (id: string, name: string, input: Parameters<typeof Llm.toolCall>[0]["input"]) =>
  Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))

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
  return rows.filter((row) => mine.has(row.pid) && row.pid !== process.pid && !/\bserve\b|--service/.test(row.command) && /opencode|index\.ts|bun/.test(row.command)).map((row) => row.pid)
}

/** LAT_TRACE=<file>: a line `<ms> <pid> <name>` per mark, beside whatever an instrumented checkout writes there. */
const mark = (name: string) => {
  if (env.LAT_TRACE) appendFileSync(env.LAT_TRACE, `${Date.now()} ${process.pid} ${name}\n`)
}

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0 ? -1 : sorted[Math.floor(sorted.length / 2)]!
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
    tui: { viewport: { cols: 120, rows: 45 } },
    llm: { settlementTimeout: 120_000 },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8"), "src/values.ts": SOURCE },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      /** When the model first saw each answer, by its marker. */
      const seen = new Map<string, number>()
      yield* llm.serve((req) => {
        // The request's arrival, before the driver reads its (on a large session, many MB of) body.
        const arrived = Date.now()
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return say("answers")
        for (let round = ROUNDS - 1; round >= 0; round--) {
          if (s.includes(BUILTIN(round))) {
            if (!s.includes(`call_q${round}`))
              return call(`call_q${round}`, "question", { questions: [{ question: `Which way, round ${round}?`, header: `Way ${round}`, options: choices(round) }] })
            if (!seen.has(`builtin${round}`)) seen.set(`builtin${round}`, arrived)
            return say(READ(round))
          }
          if (s.includes(ASYNC(round))) {
            if (s.includes(`A: Pick r${round}`)) {
              if (!seen.has(`async${round}`)) seen.set(`async${round}`, arrived)
              return say(READ(round))
            }
            if (!s.includes(`call_a${round}`))
              return call(`call_a${round}`, "ask_user_async", {
                questions: [{ question: `Which way, round ${round}?`, header: `Way ${round}`, options: choices(round), assume: `Pick r${round}` }],
              })
            return say(ASKED(round))
          }
        }
        // Another session of a copied database that wakes: a word, and it is done.
        if (SESSION !== undefined) return say("ok")
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
        return say(BUILT)
      })

      const capture = ui.capture() as unknown as Effect.Effect<Frame>
      const until = (name: string, ready: (frame: string) => boolean, times = 600) =>
        capture.pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
          Effect.tapError(() => capture.pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame))))),
        )
      const save = (name: string) => capture.pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.txt`, text(frame))))

      /** Presses return on the form and times the three marks; -1 for one not reached in 10 s. */
      const submit = (name: string, key: string, open: (frame: string) => boolean, shown: (frame: string) => boolean) =>
        Effect.gen(function* () {
          const start = Date.now()
          mark(`driver.key ${name}`)
          yield* ui.press("return")
          let closed = -1
          let drawn = -1
          while (Date.now() - start < 10_000 && (closed < 0 || drawn < 0 || !seen.has(key))) {
            const frame = text(yield* capture)
            const at = Date.now() - start
            if (closed < 0 && !open(frame)) {
              closed = at
              mark(`driver.closed ${name}`)
            }
            if (drawn < 0 && shown(frame)) {
              drawn = at
              mark(`driver.shown ${name}`)
            }
            yield* Effect.sleep("2 millis")
          }
          const result = { round: name, closed, shown: drawn, request: seen.has(key) ? seen.get(key)! - start : -1 }
          console.log("answer:", JSON.stringify(result))
          yield* save(name)
          return result
        })

      if (SESSION === undefined) {
        yield* ui.submit(BUILD)
        const building = Date.now()
        yield* until("built", (frame) => frame.includes(BUILT), 6_000)
        console.log("answer:", JSON.stringify({ built: GROUPS, ms: Date.now() - building }))
      } else {
        // The session's transcript loads: its composer shows.
        yield* until("loaded", (frame) => /gpt-sim-model|Simulated Model/.test(frame), 600)
        yield* save("loaded")
      }
      yield* Effect.sleep("2 seconds")

      let profiled: number | undefined
      const rounds: Array<{ round: string; closed: number; shown: number; request: number }> = []
      for (let round = 0; round < ROUNDS; round++) {
        yield* ui.submit(ASYNC(round))
        yield* until(`asked-${round}`, (frame) => frame.includes(ASKED(round)) && frame.includes("1 open question"))
        yield* ui.submit("/answer")
        yield* until(`form-${round}`, (frame) => frame.includes(`Which way, round ${round}?`) && frame.includes("Background questions"))
        yield* Effect.sleep("1 second")
        if (env.LAT_PROFILE !== undefined && round === Number(env.LAT_PROFILE)) {
          process.kill(tuiPid()[0]!, "SIGPROF")
          profiled = Date.now()
        }
        rounds.push(
          yield* submit(
            `async${round}`,
            `async${round}`,
            (frame) => frame.includes("Background questions"),
            (frame) => frame.includes(`answered · Which way, round ${round}?`),
          ),
        )
        yield* until(`read-async-${round}`, (frame) => frame.includes(READ(round)))
        yield* Effect.sleep("1 second")

        yield* ui.submit(BUILTIN(round))
        yield* until(`builtin-form-${round}`, (frame) => frame.includes(`Other r${round}`))
        yield* Effect.sleep("1 second")
        rounds.push(
          yield* submit(
            `builtin${round}`,
            `builtin${round}`,
            (frame) => frame.includes(`Other r${round}`),
            (frame) => {
              // The Prime look's row under the prompt turns from `Asking` to `Asked 1 question`.
              const after = frame.split(BUILTIN(round))[1] ?? ""
              return !frame.includes(`Other r${round}`) && after.includes("Asked") && !after.includes("Asking")
            },
          ),
        )
        yield* until(`read-builtin-${round}`, (frame) => frame.includes(READ(round)))
        yield* Effect.sleep("1 second")
      }

      const summary = (kind: string) => {
        const of = rounds.filter((r) => r.round.startsWith(kind))
        return { closed: median(of.map((r) => r.closed)), shown: median(of.map((r) => r.shown)), request: median(of.map((r) => r.request)) }
      }
      const result = {
        groups: GROUPS,
        session: SESSION,
        load: existsSync("/proc/loadavg") ? readFileSync("/proc/loadavg", "utf8").trim() : execFileSync("sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" }).trim(),
        median: { async: summary("async"), builtin: summary("builtin") },
        rounds,
      }
      console.log("answer:", JSON.stringify(result.median))
      writeFileSync(`${out}/answer-latency.json`, JSON.stringify(result, null, 2))
      if (profiled !== undefined) {
        // The fork writes the profile 10 s after the signal.
        yield* Effect.sleep(Math.max(0, profiled + 11_000 - Date.now()))
        keepProfile(tuiPid()[0]!)
      }
    }),
)

/** Copies the TUI's newest CPU profile from its log dir to `<out>/tui.cpuprofile`. */
function keepProfile(pid: number) {
  const environ = existsSync(`/proc/${pid}/environ`) ? readFileSync(`/proc/${pid}/environ`, "utf8").split("\0") : []
  const value = (key: string) => environ.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1)
  const log = join(value("XDG_DATA_HOME") ?? join(value("HOME") ?? homedir(), ".local/share"), "opencode", "log")
  const newest = existsSync(log) ? readdirSync(log).filter((file) => file.startsWith(`cpu-${pid}-`)).sort().at(-1) : undefined
  if (newest === undefined) return console.log(`answer: no profile of ${pid} in ${log}`)
  copyFileSync(join(log, newest), `${out}/tui.cpuprofile`)
}
