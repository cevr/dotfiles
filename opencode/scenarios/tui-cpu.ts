// The TUI's CPU while a session works, in the Prime look. A first turn builds
// a long transcript (GROUPS steps, each a thought and two calls), then a
// second turn starts SUBAGENTS background workers that stream slowly and
// streams its own answer slowly. Over WINDOW_MS of that second turn the
// scenario reads the TUI process's CPU time, then again over WINDOW_MS once
// everything is idle. Replayed against OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/tui-cpu.ts
//
// Knobs (env): CPU_PRIME=0 drops the Prime plugin; CPU_ANIMATIONS=1 turns the
// host's animations on; CPU_GROUPS (300), CPU_SUBAGENTS (3), CPU_STREAM=0 keeps
// the main session's answer from streaming (only the subagents work);
// CPU_WINDOW_MS (15000); CPU_TUI_PLUGINS=all (or a comma list of cmd/<mod>)
// loads our other TUI plugins too. It writes `cpu.json` under SCENARIO_OUT:
// `{ busy, idle }`, each the TUI's CPU share of one core over its window.
import { Effect, Schedule, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const env = process.env
const PRIME = env.CPU_PRIME !== "0"
const ANIMATIONS = env.CPU_ANIMATIONS === "1"
const GROUPS = Number(env.CPU_GROUPS ?? 300)
const SUBAGENTS = Number(env.CPU_SUBAGENTS ?? 3)
const STREAM = env.CPU_STREAM !== "0"
const WINDOW_MS = Number(env.CPU_WINDOW_MS ?? 15_000)
/** The other TUI plugins loaded beside Prime (CPU_TUI_PLUGINS=all: every cmd/<mod> with a tui.tsx). */
const OTHERS =
  env.CPU_TUI_PLUGINS === "all" ? ["btw", "cache", "git", "questions", "queue", "skills", "status"] : (env.CPU_TUI_PLUGINS ?? "").split(",").filter(Boolean)
/** Tool groups per model step of the first turn (answer text splits them). */
const PER_STEP = 5

type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const BUILD = "Survey the code base."
const BUILT = "Survey done."
const WORK = "Now fix it, with workers."
const STARTED = "Workers started; writing the plan."
const DONE = "Plan written."
const WORKER = (i: number) => `Worker brief ${i}.`
/** A long answer streamed a few characters at a time, ~10 chunks a second. */
const slow = (seconds: number, label: string) =>
  Llm.text(
    Array.from({ length: seconds * 10 }, (_, i) => `${label} word ${i}${i % 12 === 11 ? ".\n\n" : " "}`).join(""),
    { delay: 100, chunkSize: label.length + 10 },
  )
const SOURCE = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i} // line ${i}`).join("\n")

/** Cumulative CPU seconds of a process (user + system), from ps. */
const cpuSeconds = (pid: number) => {
  const time = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim()
  const parts = time.split(/[:-]/).map(Number)
  return parts.reduce((total, part) => total * 60 + part, 0)
}

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

export default OpenCodeDriver.use(
  {
    opencode: env.OPENCODE_DEV ? { dev: env.OPENCODE_DEV } : undefined,
    // The long transcript outgrows the simulated model's window; it must not compact mid-measure.
    config: { autoupdate: false, username: "Demo", compaction: { auto: false } },
    tuiConfig: {
      animations: ANIMATIONS,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [...(PRIME ? [`${root}/cmd/prime`] : []), ...OTHERS.map((name) => `${root}/cmd/${name}`)],
    },
    // From 160 columns the host shows its sidebar (CPU_COLS=160).
    tui: { viewport: { cols: Number(env.CPU_COLS ?? 120), rows: 45 } },
    project: {
      git: true,
      files: {
        ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8"),
        "src/values.ts": SOURCE,
      },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("survey"), Llm.finish())
        const worker = Array.from({ length: SUBAGENTS }, (_, i) => i).find((i) => s.includes(WORKER(i)) && !s.includes(BUILD))
        if (worker !== undefined)
          return Stream.make(Llm.reasoning(`Worker ${worker} reads the brief.`), slow(60, `w${worker}`), Llm.finish())
        if (s.includes(WORK)) {
          if (s.includes(STARTED)) return Stream.make(Llm.text(DONE), Llm.finish())
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
          return STREAM
            ? Stream.make(Llm.text(STARTED), slow(60, "main"), Llm.finish())
            : Stream.make(Llm.text(STARTED), Llm.pause(60_000), Llm.finish())
        }
        // Each step draws PER_STEP groups: answer text ends a group within a step.
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
      const until = (name: string, ready: (frame: string) => boolean, times = 600) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times }),
          Effect.tapError(() =>
            ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame)))),
          ),
        )
      const save = (name: string) =>
        ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.txt`, text(frame))))
      /** The TUI's CPU share of one core over the window (no captures meanwhile). */
      const measure = Effect.gen(function* () {
        const pids = tuiPid()
        const before = pids.map(cpuSeconds)
        const start = Date.now()
        yield* Effect.sleep(WINDOW_MS)
        const after = pids.map(cpuSeconds)
        const seconds = (Date.now() - start) / 1000
        return pids.map((pid, i) => ({ pid, share: Number(((after[i]! - before[i]!) / seconds).toFixed(3)) }))
      })

      const t0 = Date.now()
      yield* ui.submit(BUILD)
      yield* until("built", (frame) => frame.includes(BUILT), 3_000)
      const buildSeconds = (Date.now() - t0) / 1000
      yield* Effect.sleep("2 seconds")
      const idle = yield* measure
      yield* ui.submit(WORK)
      yield* until("started", (frame) => frame.includes(STARTED))
      yield* Effect.sleep("2 seconds")
      const busy = yield* measure
      yield* save("busy")
      const result = { prime: PRIME, animations: ANIMATIONS, groups: GROUPS, subagents: SUBAGENTS, stream: STREAM, buildSeconds, idle, busy }
      writeFileSync(`${out}/cpu.json`, JSON.stringify(result, null, 2))
      console.log("cpu:", JSON.stringify(result))
      // Let every slow stream end before the driver checks each model response settled.
      yield* Effect.sleep(70_000 - WINDOW_MS)
    }),
)
