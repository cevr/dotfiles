// The /answer pane holds its place while the questions are read again. A
// scripted model asks one question with four choices through
// `ask_user_async` and starts a background subagent that waits. shift+← with
// text in the composer selects there (typing then replaces the selected
// character) and leaves the tray; on an empty
// composer it opens the pane. The user moves down twice; the subagent then
// asks a question of its own (a `changed` event and a longer list), and the
// pane is read again past two 2-second ticks: the cursor stays on the third
// choice. The ctrl+x arm and a typed answer hold across a tick too. Enter
// sends the typed answer and the pane moves to the subagent's question, on its
// assumption with nothing typed.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/questions-hold.ts
//
// It writes, under SCENARIO_OUT, `questions-hold-<name>.txt` for the frames
// `tray`, `selecting` (shift+← with text in the composer), `pane`, `moved`,
// `held` (after the subagent asked and two ticks), `armed`, `typed`, `next`
// (the subagent's question) and `done`; `-timeout.txt` when a wait times out;
// and `-requests.json`.
import { Deferred, Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const label = "questions-hold"

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]

const ASK: ToolInput = {
  questions: [
    {
      question: "Which store should the cache use?",
      header: "Cache store",
      options: [{ label: "SQLite" }, { label: "Redis" }, { label: "Memcached" }, { label: "Postgres" }],
      assume: "SQLite",
    },
  ],
}
const SUB_ASK: ToolInput = {
  questions: [{ question: "Which test runner should the suite use?", header: "Test runner", options: [{ label: "bun test" }, { label: "vitest" }], assume: "bun test" }],
}
const RUNNER: ToolInput = { description: "Runner check", prompt: "Subagent brief runner.", agent: "general", background: true }

const call = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

const sessionOf = (s: string): "root" | "subagent" | "title" => {
  if (s.includes("You name conversations")) return "title"
  if (s.includes("questions-hold-fixture")) return "root"
  return "subagent"
}

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo", plugins: [`${root}/cmd/questions`] },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/mods/prime`, `${root}/cmd/questions`],
    },
    tui: { viewport: { cols: 150, rows: 50 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      const requests: Array<{ readonly session: string; readonly request: string }> = []
      // The subagent asks only once the cursor has moved.
      const release = yield* Deferred.make<void>()
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        const session = sessionOf(s)
        requests.push({ session, request: s })
        if (session === "title") return say("Questions hold fixture")
        if (session === "subagent") {
          if (!s.includes("call_sub_ask")) return Stream.fromEffect(Deferred.await(release)).pipe(Stream.drain, Stream.concat(call("call_sub_ask", "ask_user_async", SUB_ASK)))
          return say("Subagent asked and carried on")
        }
        if (s.includes("A: Use Postgres with a TTL")) return say("Root read the answer")
        if (!s.includes("call_ask")) return call("call_ask", "ask_user_async", ASK)
        if (!s.includes("call_runner")) return call("call_runner", "subagent", RUNNER)
        return say("Root carried on, assuming SQLite")
      })

      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const dump = Effect.sync(() => writeFileSync(`${out}/${label}-requests.json`, JSON.stringify(requests, null, 2)))
      const until = (ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError(() =>
            ui.capture().pipe(
              Effect.map((frame) => writeFileSync(`${out}/${label}-timeout.txt`, text(frame))),
              Effect.andThen(dump),
            ),
          ),
        )
      const keep = (name: string) => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${label}-${name}.txt`, text(frame))))

      yield* ui.submit("questions-hold-fixture")
      yield* until((frame) => frame.includes("Root carried on, assuming SQLite") && frame.includes("1 open question"))
      yield* keep("tray")

      // shift+← with text in the composer is the composer's: it selects, and the pane stays shut.
      yield* ui.type("holdtext")
      yield* until((frame) => frame.includes("holdtext"))
      // Typing over the selection replaces the last character: the key selected it.
      yield* ui.press("left", { shift: true })
      yield* ui.type("Z")
      yield* until((frame) => frame.includes("holdtexZ"))
      yield* Effect.sleep("700 millis")
      yield* keep("selecting")
      for (let i = 0; i < 10; i++) yield* ui.press("backspace")
      yield* until((frame) => !frame.includes("holdtex"))

      // On an empty composer shift+← opens the pane.
      yield* ui.press("left", { shift: true })
      yield* until((frame) => frame.includes("Question 1/1") && frame.includes("▸ SQLite"))
      yield* keep("pane")
      yield* ui.press("down")
      yield* ui.press("down")
      yield* until((frame) => frame.includes("▸ Memcached"))
      yield* keep("moved")

      // The subagent asks: a changed event, a second question in the list; then two ticks.
      yield* Deferred.succeed(release, undefined)
      yield* until((frame) => frame.includes("Question 1/2"))
      yield* Effect.sleep("5 seconds")
      yield* keep("held")

      // The arm and a typed answer hold across a tick too.
      yield* ui.press("x", { ctrl: true })
      yield* until((frame) => frame.includes("ctrl+x again dismisses"))
      yield* Effect.sleep("2500 millis")
      yield* keep("armed")
      yield* ui.press("escape")
      yield* until((frame) => !frame.includes("ctrl+x again dismisses"))
      yield* ui.type("Use Postgres with a TTL")
      yield* until((frame) => frame.includes("▸ Use Postgres with a TTL"))
      yield* Effect.sleep("2500 millis")
      yield* keep("typed")

      // Enter sends it; the pane moves to the subagent's question, on its assumption.
      yield* ui.press("return")
      yield* until((frame) => frame.includes("Question 1/1") && frame.includes("Test runner") && frame.includes("Root read the answer"))
      yield* keep("next")
      yield* ui.press("escape")
      yield* until((frame) => !frame.includes("Question 1/1") && frame.includes("1 open question"))
      yield* keep("done")
      yield* dump
    }),
)
