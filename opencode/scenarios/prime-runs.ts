// Where a run of calls breaks in the Prime look: each model step is a group
// of its own, so a step's parallel calls share one header, the next step's
// call opens its own line even with nothing drawn between, and a call after
// the assistant's text or a message the reader sent while the turn ran does
// too. A long command is the newest row. Replayed against OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-runs.ts
//
// It writes, under SCENARIO_OUT:
// - `runs-running`: the long command runs, after the text;
// - `runs`: the finished turn, in Details mode;
// - `runs-all` and `runs-overview` after each Ctrl+O.
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
import { Deferred, Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Check the build, then run the long suite."
const STEER = "Also read the notes file."
const LONG = "sleep 6; printf 'suite ok\\n'"

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: { autoupdate: false, username: "Demo" },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
    },
    tui: { viewport: { cols: 106, rows: 48 } },
    project: {
      git: true,
      files: {
        ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8"),
        "notes.md": "ship it\n",
      },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      // The long command's step is held open until the reader's message is in.
      const steered = yield* Deferred.make<void>()
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("long suite"), Llm.finish())
        const step = (call: { id: string; name: string; input: { command: string } | { path: string } }, prose?: string) =>
          Stream.make(
            ...(prose ? [Llm.text(prose)] : []),
            Llm.toolCall({ index: 0, ...call }),
            Llm.finish("tool-calls"),
          )
        // One step with two calls in parallel, then a step of one call with nothing drawn between.
        if (!s.includes("call_a"))
          return Stream.make(
            Llm.toolCall({ index: 0, id: "call_a", name: "shell", input: { command: "printf 'build a ok\\n'" } }),
            Llm.toolCall({ index: 1, id: "call_b", name: "shell", input: { command: "printf 'build b ok\\n'" } }),
            Llm.finish("tool-calls"),
          )
        if (!s.includes("call_lint")) return step({ id: "call_lint", name: "shell", input: { command: "printf 'lint ok\\n'" } })
        if (!s.includes("call_long"))
          return step({ id: "call_long", name: "shell", input: { command: LONG } }, "Both builds pass. Running the long suite.")
        if (!s.includes(STEER))
          return Stream.fromEffect(Deferred.await(steered)).pipe(Stream.drain, Stream.concat(Stream.make(Llm.text("Suite passed."), Llm.finish())))
        if (!s.includes("call_notes")) return step({ id: "call_notes", name: "read", input: { path: "notes.md" } })
        return Stream.make(Llm.text("Suite passed; the notes say ship it."), Llm.finish())
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
      yield* until("runs-running", (frame) => frame.includes("Running sleep 6"))
      yield* save("runs-running")
      // The reader writes while the long command runs; the model reads it on the next step.
      yield* ui.submit(STEER)
      yield* Deferred.succeed(steered, undefined)
      yield* until("runs", (frame) => frame.includes("the notes say ship it") && !frame.includes("Executing"))
      yield* Effect.sleep("500 millis")
      yield* save("runs")
      for (const mode of ["all", "overview"]) {
        yield* ui.press("o", { ctrl: true })
        yield* Effect.sleep("300 millis")
        yield* save(`runs-${mode}`)
      }
    }),
)
