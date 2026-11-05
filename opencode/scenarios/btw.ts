// /btw in real OpenCode with the btw TUI plugin (cmd/btw) and the Prime look,
// the fork's built-in /btw turned off. The session answers one question, then
// starts a shell call the scenario holds open, so the session is still
// working when /btw asks a side question. The pane shows the answer and a
// follow-up's; the shell call ends and the session finishes its turn; Esc
// closes the pane; /btw alone opens it again, and ctrl+s brings the newest
// answer back into the session, which answers it.
// Run: OPENCODE_DEV=<opencode checkout> bunx opencode-drive run scenarios/btw.ts
//
// It writes, under SCENARIO_OUT: each model request as one JSON line of
// `requests.jsonl` ({ route, request }); the frames `btw-pane.txt`,
// `btw-followup.txt`, `btw-closed.txt`, `btw-reopened.txt` and
// `btw-brought-back.txt` with a screenshot of each; `btw-timeout.txt` if a
// wait ran out.
import { Effect, Schedule, Stream } from "effect"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"

export const FIRST = "Explain the fixture."
export const FIRST_ANSWER = "It is a scratch project for the btw scenario."
export const CHECK = "Run the slow check."
export const CHECK_DONE = "The check passed."
export const SIDE = "Why is the check slow?"
export const SIDE_ANSWER = "It sleeps on purpose, to hold the session busy."
export const FOLLOW = "Which command?"
export const FOLLOW_ANSWER = "The sleep in the shell call."
export const BROUGHT = "brought back an answer from a /btw side question"
export const NOTED = "Noted the side answer."

/** The route of a request: the newest of the scenario's prompts it carries. */
const routeOf = (body: string): string => {
  if (body.includes("You name conversations")) return "title"
  // The brought-back notice quotes the follow-up after its own marker; it is the last request.
  if (body.includes(BROUGHT)) return "brought"
  const markers: ReadonlyArray<[string, string]> = [
    [FIRST, "first"],
    [CHECK, "check"],
    [SIDE, "side"],
    [FOLLOW, "follow"],
    ["call_check", "check-done"],
  ]
  const newest = markers.map(([marker, route]) => [body.lastIndexOf(marker), route] as const).sort((a, b) => b[0] - a[0])[0]
  return newest === undefined || newest[0] < 0 ? "unknown" : newest[1]
}

const replies: Record<string, () => Stream.Stream<Llm.Output>> = {
  title: () => Stream.make(Llm.text("btw fixture"), Llm.finish()),
  first: () => Stream.make(Llm.text(FIRST_ANSWER), Llm.finish()),
  check: () => Stream.make(Llm.toolCall({ index: 0, id: "call_check", name: "shell", input: { command: "sleep 600 && echo checked" } }), Llm.finish("tool-calls")),
  "check-done": () => Stream.make(Llm.text(CHECK_DONE), Llm.finish()),
  side: () => Stream.make(Llm.text(SIDE_ANSWER), Llm.finish()),
  follow: () => Stream.make(Llm.text(FOLLOW_ANSWER), Llm.finish()),
  brought: () => Stream.make(Llm.text(NOTED), Llm.finish()),
}

type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    tools: ["shell"],
    config: { autoupdate: false, username: "Demo" },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`, `${root}/cmd/btw`, "-opencode.btw"],
    },
    tui: { viewport: { cols: 144, rows: 44 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm, tools }) =>
    Effect.gen(function* () {
      yield* llm.serve((request) => {
        const body = JSON.stringify(request)
        const route = routeOf(body)
        appendFileSync(`${out}/requests.jsonl`, `${JSON.stringify({ route, request })}\n`)
        return (replies[route] ?? (() => Stream.make(Llm.text(`unrouted: ${route}`), Llm.finish())))()
      })
      const shells = yield* tools.control("shell")

      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.succeed(frame) : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 200 }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/btw-timeout.txt`, `waiting for ${name}\n${text(frame)}`)))),
        )
      const keep = (name: string, frame: Frame) =>
        Effect.gen(function* () {
          writeFileSync(`${out}/${name}.txt`, text(frame))
          console.log("screenshot:", yield* ui.screenshot(name))
        })

      yield* ui.submit(FIRST)
      yield* until("the first answer", (frame) => frame.includes(FIRST_ANSWER))

      // The session starts its shell call and waits on it.
      yield* ui.submit(CHECK)
      const check = yield* shells.take("call_check")

      // A side question while the session works.
      yield* ui.submit(`/btw ${SIDE}`)
      yield* keep("btw-pane", yield* until("the side answer", (frame) => frame.includes(SIDE_ANSWER) && frame.includes("ctrl+s bring back")))

      // A follow-up from the pane's ask line.
      yield* ui.type(FOLLOW)
      yield* ui.press("return")
      yield* keep("btw-followup", yield* until("the follow-up answer", (frame) => frame.includes(FOLLOW_ANSWER) && frame.includes("ctrl+s bring back")))

      // The session finishes its own turn beside the pane.
      yield* check.succeed({ output: "checked\n", exit: 0 })
      yield* until("the check's end", (frame) => frame.includes(CHECK_DONE))

      yield* ui.press("escape")
      yield* keep("btw-closed", yield* until("the pane to close", (frame) => !frame.includes("ask ›")))

      // /btw alone opens the side question again; ctrl+s brings its newest answer back.
      // Enter on a bare `/btw` picks it from the slash list, which leaves `/btw ` for its
      // arguments (packages/tui/src/component/prompt/autocomplete.tsx, insertSlash); the
      // second Enter runs it with none.
      yield* ui.submit("/btw")
      yield* until("the slash pick", (frame) => frame.includes("┃ /btw"))
      yield* ui.press("return")
      yield* keep("btw-reopened", yield* until("the pane again", (frame) => frame.includes(FOLLOW_ANSWER) && frame.includes("ctrl+s bring back")))
      yield* ui.press("s", { ctrl: true })
      yield* keep("btw-brought-back", yield* until("the session's answer to it", (frame) => frame.includes(NOTED) && !frame.includes("ask ›")))
    }),
)
