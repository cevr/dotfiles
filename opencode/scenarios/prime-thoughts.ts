// Thoughts as tree nodes and a finished worker's notice as a tool-call group,
// replayed against OpenCode with a scripted model and the Prime look.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-thoughts.ts
//
// The parent thinks, then reads a file and runs a command in one step; starts
// a background worker; thinks, then answers (a step with no calls). The
// worker finishes, its notice wakes the parent, which runs one more command.
// It writes, under SCENARIO_OUT and named by SCENARIO_LABEL (default `thoughts`):
// - `<label>-streaming`: while the first step's thought still streams;
// - `<label>`: after the parent's last reply, in Details mode;
// - `<label>-all` and `<label>-overview`: after each Ctrl+O;
// - `<label>-opened` and `<label>-closed`: back at Details, after a click on
//   the finished worker's notice, then after a second click.
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
import { Deferred, Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const out = process.env.SCENARIO_OUT ?? "out"
const label = process.env.SCENARIO_LABEL ?? "thoughts"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Check the money module, and have a worker fix the CSV quoting."
const BRIEF = "Worker brief: fix the CSV quoting."
// The first step's thought: a markdown heading line, then its reasoning.
export const PLAN = "**Planning the check**\n\nRead money.py first, then run its test.\nThe CSV fix goes to a worker."
export const SETTLED = "The worker has the CSV fix; nothing else needs me now."
export const STARTED = "A worker is on the CSV quoting."
// Longer than a notice's head (NOTICE_HEAD): opened, every line shows, with no `+N lines` count.
export const ANSWER = [
  "CSV quoting fixed.",
  "Quoted fields keep their commas.",
  "Escaped quotes stay doubled.",
  "Empty fields stay empty.",
  "Newlines in a field keep their quotes.",
  "The writer and the reader agree.",
  "All 12 tests pass.",
].join("\n")
const ANSWER_LAST = "All 12 tests pass."
// The finished worker's notice header.
const NOTICE = "General finished · Fix CSV quoting"
export const NOTED = "Noted: the CSV fix is in."

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
    tui: { viewport: { cols: 106, rows: 48 } },
    project: {
      git: true,
      files: {
        ".opencode/themes/prime.json": readFileSync(`${process.cwd()}/themes/prime.json`, "utf8"),
        "money.py": "def parse(text):\n    return float(text)\n",
      },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      // The first thought holds until its streaming frame is captured; the worker until the parent has answered.
      const think = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const hold = (gate: Deferred.Deferred<void>) => Stream.fromEffect(Deferred.await(gate)).pipe(Stream.drain)
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("money and csv"), Llm.finish())
        if (s.includes(BRIEF) && !s.includes(ASK))
          return hold(release).pipe(Stream.concat(Stream.make(Llm.text(ANSWER), Llm.finish())))
        if (s.includes("call_check")) return Stream.make(Llm.text(NOTED), Llm.finish())
        // The worker's notice woke the parent: one ordinary call, its own group.
        if (s.includes("CSV quoting fixed"))
          return Stream.make(
            Llm.toolCall({ index: 0, id: "call_check", name: "shell", input: { command: "printf 'csv ok\\n'" } }),
            Llm.finish("tool-calls"),
          )
        if (!s.includes("call_read"))
          return Stream.make(Llm.reasoning(PLAN)).pipe(
            Stream.concat(hold(think)),
            Stream.concat(
              Stream.make(
                Llm.toolCall({ index: 0, id: "call_read", name: "read", input: { path: "money.py" } }),
                Llm.toolCall({ index: 1, id: "call_test", name: "shell", input: { command: "printf '1 passed\\n'" } }),
                Llm.finish("tool-calls"),
              ),
            ),
          )
        if (!s.includes("call_worker"))
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: "call_worker",
              name: "subagent",
              input: { agent: "general", description: "Fix CSV quoting", prompt: BRIEF, background: true },
            }),
            Llm.finish("tool-calls"),
          )
        // A step that thinks, then answers: no calls.
        return Stream.make(Llm.reasoning(SETTLED), Llm.text(STARTED), Llm.finish())
      })
      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          // Under load the host's startup panel can still sit beneath the transcript; a
          // frame is ready only once it has gone.
          Effect.flatMap((frame) => (ready(text(frame)) && !text(frame).includes("Finishing startup") ? Effect.void : Effect.fail("pending"))),
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
      // A left click on the first cell of `needle` in the current frame.
      const click = (needle: string) =>
        Effect.gen(function* () {
          const lines = text(yield* ui.capture()).split("\n")
          const y = lines.findIndex((line) => line.includes(needle))
          if (y < 0) return yield* Effect.fail(`no line contains ${needle}`)
          const x = lines[y]!.indexOf(needle)
          yield* ui.mouse({ action: "move", x, y })
          yield* ui.mouse({ action: "down", x, y, button: "left" })
          yield* ui.mouse({ action: "up", x, y, button: "left" })
        })

      yield* ui.submit(ASK)
      yield* until(`${label}-streaming`, (frame) => frame.includes("Planning the check"))
      yield* save(`${label}-streaming`)
      yield* Deferred.succeed(think, undefined)
      yield* until(`${label}-started`, (frame) => frame.includes(STARTED))
      yield* Deferred.succeed(release, undefined)
      yield* until(label, (frame) => frame.includes(NOTED))
      yield* Effect.sleep("1000 millis")
      yield* save(label)
      for (const mode of ["all", "overview"]) {
        yield* ui.press("o", { ctrl: true })
        yield* Effect.sleep("300 millis")
        yield* save(`${label}-${mode}`)
      }
      // Back at Details, a click on the finished worker's notice opens its whole answer in place; a second closes it.
      yield* ui.press("o", { ctrl: true })
      // Details again: the thoughts the Overview hides are back.
      yield* until(`${label}-back`, (frame) => frame.includes("● Thought"))
      yield* click(NOTICE)
      yield* until(`${label}-opened`, (frame) => frame.includes(ANSWER_LAST))
      yield* save(`${label}-opened`)
      // A second click within half a second on the same cell is a double click, which selects a word (opentui); this one lands a word over.
      yield* click("finished · Fix CSV quoting")
      yield* until(`${label}-closed`, (frame) => !frame.includes(ANSWER_LAST))
      yield* save(`${label}-closed`)
    }),
)
