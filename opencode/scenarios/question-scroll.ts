// A question taller than a phone's pane: a scripted model asks one question of
// sixty lines, through the built-in `question` tool (QUESTION_VIA=builtin, the
// default) or through `ask_user_async`, answered from /answer's form
// (QUESTION_VIA=async). The pane is 45 columns by 25 rows. The form opens on
// the question's first line with its keys on screen; the mouse wheel moves it
// and PageDown pages it to its last line and its options; the user moves to the second
// option and presses Enter; the answer reaches the session, whose model says
// what it read. Both forms are the fork's (packages/tui/src/routes/session/form.tsx).
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out QUESTION_VIA=async bunx opencode-drive run scenarios/question-scroll.ts
//
// It writes, under SCENARIO_OUT, `question-scroll-<via>-<name>.txt` for the
// frames `start` (the form as it opens), `wheel` (after the wheel), `end` (paged to the options) and
// `done` (the model's reply to the answer); `-timeout.txt` when a wait times out.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const via = process.env.QUESTION_VIA === "async" ? "async" : "builtin"
const label = `question-scroll-${via}`

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]

/** Sixty numbered lines, so the first and the last are each findable on the frame. */
export const QUESTION = Array.from({ length: 60 }, (_, index) => `line ${index + 1} of the question`).join("\n")
const OPTIONS = [
  { label: "Keep it", description: "as it is" },
  { label: "Drop it", description: "for good" },
]

const ASK: ToolInput =
  via === "async"
    ? { questions: [{ question: QUESTION, header: "Long one", options: OPTIONS, assume: "Keep it" }] }
    : { questions: [{ question: QUESTION, header: "Long one", options: OPTIONS }] }

/** PageDown as a terminal sends it; the simulation passes a key it has no name for through as these bytes. */
const PAGE_DOWN = "\u001b[6~"

const call = (id: string, name: string, input: ToolInput) =>
  Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

const plugins = via === "async" ? [`${root}/cmd/questions`] : []

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo", plugins },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`, ...plugins],
    },
    tui: { viewport: { cols: 45, rows: 25 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        if (s.includes("You name conversations")) return say("Long question")
        if (!s.includes("call_ask")) return call("call_ask", via === "async" ? "ask_user_async" : "question", ASK)
        // The built-in tool's answer comes back as `"<question>"="Drop it"`, escaped once or twice; ours as a letter with `A: Drop it`.
        if (/=\\*"Drop it/.test(s) || s.includes("A: Drop it")) return say("Root read Drop it")
        return say("Root carried on")
      })

      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const until = (ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${label}-timeout.txt`, text(frame))))),
        )
      const keep = (name: string) => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${label}-${name}.txt`, text(frame))))
      const current = ui.capture().pipe(Effect.map(text))

      yield* ui.submit("question-scroll-fixture")
      if (via === "async") {
        yield* until((frame) => frame.includes("Root carried on") && frame.includes("1 open question"))
        yield* ui.submit("/answer")
      }
      yield* until((frame) => frame.includes("line 1 of the question"))
      yield* keep("start")

      // The wheel (a phone's touch scroll) moves the question off its first line.
      for (let step = 0; step < 5; step++) yield* ui.mouse({ action: "scroll", x: 10, y: 12, direction: "down" })
      yield* until((frame) => !frame.includes("line 1 of the question"))
      yield* keep("wheel")
      // PageDown pages it, half a pane at a time, to its last line and its options.
      for (let page = 0; page < 30 && !(yield* current).includes("Type your own answer"); page++) {
        yield* ui.press(PAGE_DOWN)
        yield* Effect.sleep("100 millis")
      }
      yield* until((frame) => frame.includes("line 60 of the question") && frame.includes("Type your own answer"))
      yield* keep("end")

      yield* ui.press("down")
      yield* ui.press("return")
      yield* until((frame) => frame.includes("Root read Drop it"))
      yield* keep("done")
    }),
)
