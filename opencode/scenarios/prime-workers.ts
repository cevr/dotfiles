// Three background workers, started in three steps a moment apart and finishing
// together, replayed against OpenCode with a scripted model and the Prime look.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-workers.ts
//
// It writes, under SCENARIO_OUT and named by SCENARIO_LABEL (default `workers`):
// - `<label>-started`: once the three workers run;
// - `<label>`: after all three have finished and the parent has answered, in Details mode.
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
import { Deferred, Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const out = process.env.SCENARIO_OUT ?? "out"
const label = process.env.SCENARIO_LABEL ?? "workers"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Fix the three failing modules, one worker each."
const STARTED = "Three workers are on it."
// The workers, by call id: each step starts one.
const WORKERS = [
  { id: "call_fix_a", description: "Fix money parsing", prompt: "Worker brief A." },
  { id: "call_fix_b", description: "Fix CSV quoting", prompt: "Worker brief B." },
  { id: "call_fix_c", description: "Fix month padding", prompt: "Worker brief C." },
]

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: { autoupdate: false, username: "Demo" },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${process.cwd()}/cmd/prime`],
      // Each call its own row, as these frames read them; the default (low) folds a turn's calls into one.
      session: { verbosity: "medium" },
    },
    tui: { viewport: { cols: 106, rows: 40 } },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${process.cwd()}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      // The workers hold their answers until the started frame is captured, then finish together while
      // the parent is still busy in its turn, so their notices queue and land side by side.
      const release = yield* Deferred.make<void>()
      const busy = yield* Deferred.make<void>()
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("three workers"), Llm.finish())
        const worker = WORKERS.find((item) => s.includes(item.prompt) && !s.includes(ASK))
        if (worker)
          return Stream.fromEffect(Deferred.await(release)).pipe(
            Stream.drain,
            Stream.concat(Stream.make(Llm.text(`${worker.description}: done.`), Llm.finish())),
          )
        // The parent: one launch per step, then a line; any later turn (a finished worker) gets a short reply.
        if (s.includes(STARTED)) return Stream.make(Llm.text("Noted."), Llm.finish())
        const next = WORKERS.find((item) => !s.includes(item.id))
        if (next)
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: next.id,
              name: "subagent",
              input: { agent: "general", description: next.description, prompt: next.prompt, background: true },
            }),
            Llm.finish("tool-calls"),
          )
        return Stream.make(Llm.text(STARTED)).pipe(
          Stream.concat(Stream.fromEffect(Deferred.await(busy)).pipe(Stream.drain)),
          Stream.concat(Stream.make(Llm.finish())),
        )
      })
      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError(() =>
            ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame)))),
          ),
        )
      const save = (name: string) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/${name}.txt`, text(frame))
          writeFileSync(`${out}/${name}.json`, JSON.stringify(frame))
          console.log("screenshot:", yield* ui.screenshot(name))
        })

      yield* ui.submit(ASK)
      yield* until(`${label}-started`, (frame) => frame.includes(STARTED) && frame.includes("◆ 3 subagents"))
      yield* save(`${label}-started`)
      yield* Deferred.succeed(release, undefined)
      // All three done and no shell running: the dock's count line is gone.
      yield* until(`${label}-finishing`, (frame) => !/◆ \d+ subagents?  ·/.test(frame))
      yield* Deferred.succeed(busy, undefined)
      yield* until(label, (frame) => frame.includes("Noted."))
      yield* Effect.sleep("1500 millis")
      yield* save(label)
    }),
)
