// Typing on the built-in question form: a scripted model asks through
// `question` twice. On the first, the user types "Postgres" straight away, with
// no Enter to open the custom answer first: the first letter opens it with that
// letter typed, and Enter sends it. On the second, the user presses "2", which
// picks the second option as before. The form is the fork's
// (packages/tui/src/routes/session/form.tsx), drawn under the Prime look.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/question-typing.ts
//
// It writes, under SCENARIO_OUT, `question-typing-before.txt` (the form as it
// arrives), `-typed.txt` (after typing "Postgres"), `-digit.txt` (the second
// form), `-done.txt` (after "2") and `-timeout.txt` when a wait times out.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const label = "question-typing"

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]

const STORE: ToolInput = {
  questions: [
    {
      question: "Which database should the cache use?",
      header: "Cache store",
      options: [
        { label: "SQLite", description: "one file, no server" },
        { label: "Redis", description: "a server" },
      ],
    },
  ],
}
const RUNNER: ToolInput = {
  questions: [
    {
      question: "Which test runner should the suite use?",
      header: "Test runner",
      options: [
        { label: "bun test", description: "built in" },
        { label: "vitest", description: "a dependency" },
      ],
    },
  ],
}

const call = (id: string, input: ToolInput) =>
  Stream.make(Llm.toolCall({ index: 0, id, name: "question", input }), Llm.finish("tool-calls"))
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo" },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
    },
    tui: { viewport: { cols: 120, rows: 40 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        if (s.includes("You name conversations")) return say("Question typing")
        if (!s.includes("call_store")) return call("call_store", STORE)
        if (!s.includes("call_runner")) return call("call_runner", RUNNER)
        // The answers come back as `"<question>"="<answer>"`, escaped once or twice in the request JSON.
        if (/=\\*"Postgres/.test(s) && /=\\*"vitest/.test(s)) return say("Root uses Postgres and vitest")
        return say("Root missed an answer")
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

      yield* ui.submit("question-typing-fixture")
      yield* until((frame) => frame.includes("Which database should the cache use?") && frame.includes("Type your own answer"))
      yield* keep("before")
      yield* ui.type("Postgres")
      yield* until((frame) => frame.includes("3. Postgres"))
      yield* keep("typed")
      yield* ui.press("return")

      yield* until((frame) => frame.includes("Which test runner should the suite use?"))
      yield* keep("digit")
      yield* ui.press("2")
      yield* until((frame) => frame.includes("Root uses Postgres and vitest"))
      yield* keep("done")
    }),
)
