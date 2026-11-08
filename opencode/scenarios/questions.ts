// Background questions: a scripted model asks two questions through
// `ask_user_async`, directly (QUESTIONS_VIA=direct, the default) or from a
// kernel cell (QUESTIONS_VIA=kernel), then a third in a second call, and
// carries on; then it starts a background subagent that asks one of its own
// the same way. The root's tray counts all four. /answer opens the host's own
// question form (the built-in `question` tool's) with the root's three
// questions as tabs: the user moves off the assumption on the first, types an
// answer of their own on the second, leaves the third blank and submits once,
// so the idle root wakes on ONE letter with both answers. The same /answer
// opened the subagent's form too, naming who asked; it shows next, and Esc
// closes it, leaving its question open. shift+← on the empty composer then
// opens the forms again: the root's left-over question, which the user
// answers with its assumption (its own letter), and the subagent's, closed
// again with Esc.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out QUESTIONS_VIA=kernel bunx opencode-drive run scenarios/questions.ts
//
// It writes, under SCENARIO_OUT, `questions-<via>-<name>.txt` for the frames
// `tray` (four open), `form` (the form on the first question), `moved` (the
// cursor on Redis), `typed` (an answer typed on the second), `review` (the
// submit tab), `answered` (the root's letter and the tray after), `again` (the
// left-over question's form), `subagent` (the subagent's form) and `done`
// (after Esc); `-timeout.txt` when a wait times out; `-requests.json` (each
// model request, by the session it came from) and `-transcripts.json`.
import { Deferred, Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const via = process.env.QUESTIONS_VIA === "kernel" ? "kernel" : "direct"
const label = `questions-${via}`

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]

const ASK: ToolInput = {
  questions: [
    {
      question: "Which database should the cache use?",
      header: "Cache store",
      options: [{ label: "SQLite", description: "one file, no server" }, { label: "Redis" }],
      assume: "SQLite",
    },
    { question: "Should the old /v1 endpoint stay for a release?", header: "Old endpoint", assume: "Keep it" },
  ],
}
const ASK_MORE: ToolInput = {
  questions: [{ question: "Should the logs be JSON?", header: "Log format", options: [{ label: "JSON" }, { label: "Plain text" }], assume: "JSON" }],
}
const SUB_ASK: ToolInput = {
  questions: [{ question: "Which test runner should the suite use?", header: "Test runner", options: [{ label: "bun test" }, { label: "vitest" }], assume: "bun test" }],
}
const RUNNER_PROMPT = "Subagent brief runner."
const RUNNER: ToolInput = { description: "Runner check", prompt: RUNNER_PROMPT, agent: "general", background: true }

/** One step's call: the tool itself, or a kernel cell that runs it and prints what it answered. */
const call = (id: string, name: string, input: ToolInput) =>
  Stream.make(
    via === "kernel"
      ? Llm.toolCall({
          index: 0,
          id,
          name: "kernel",
          input: { code: `const answered = await tools.${name}(${JSON.stringify(input)}); console.log(typeof answered === "string" ? answered : JSON.stringify(answered))` },
        })
      : Llm.toolCall({ index: 0, id, name, input }),
    Llm.finish("tool-calls"),
  )
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

/** The session a request came from, by the words only its conversation holds. */
const sessionOf = (s: string): "root" | "subagent" | "title" => {
  if (s.includes("You name conversations")) return "title"
  if (s.includes("questions-fixture")) return "root"
  return "subagent"
}

type Entry = string | { readonly package: string; readonly options: Readonly<Record<string, string>> }
const plugins: Array<Entry> = [`${root}/cmd/questions`, ...(via === "kernel" ? [`${root}/cmd/kernel`] : [])]

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo", plugins },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`, `${root}/cmd/questions`],
    },
    tui: { viewport: { cols: 150, rows: 50 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm, opencode }) =>
    Effect.gen(function* () {
      const requests: Array<{ readonly session: string; readonly request: string }> = []
      const subagentAsked = yield* Deferred.make<void>()
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        const session = sessionOf(s)
        requests.push({ session, request: s })
        if (session === "title") return say("Questions fixture")
        if (session === "subagent") {
          if (!s.includes("call_sub_ask")) return call("call_sub_ask", "ask_user_async", SUB_ASK)
          return Stream.fromEffect(Deferred.succeed(subagentAsked, undefined)).pipe(Stream.drain, Stream.concat(say("Subagent asked and carried on")))
        }
        // The root: the answers it reads, newest first.
        if (s.includes("Answer to your background question q3")) return say("Root kept JSON logs")
        if (s.includes("Answers to your background questions q1 and q2"))
          return say(s.includes("revise the work that rests on q1 and q2") ? "Root switched to Redis and dropped the endpoint" : "Root missed the difference")
        if (!s.includes("call_ask")) return call("call_ask", "ask_user_async", ASK)
        if (!s.includes("call_more")) return call("call_more", "ask_user_async", ASK_MORE)
        if (!s.includes("call_runner")) return call("call_runner", "subagent", RUNNER)
        return say("Root carried on, assuming SQLite")
      })

      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const dump = Effect.gen(function* () {
        writeFileSync(`${out}/${label}-requests.json`, JSON.stringify(requests, null, 2))
        const page = yield* opencode.session.list()
        const transcripts = yield* Effect.forEach(page.data, (session) =>
          opencode.session
            .context({ sessionID: session.id })
            .pipe(Effect.map((messages) => ({ id: session.id, parentID: session.parentID, title: session.title, messages }))),
        )
        writeFileSync(`${out}/${label}-transcripts.json`, JSON.stringify(transcripts, null, 2))
      })
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

      yield* ui.submit("questions-fixture")
      yield* Deferred.await(subagentAsked)
      yield* until((frame) => frame.includes("Root carried on, assuming SQLite") && frame.includes("4 open questions"))
      yield* keep("tray")

      // One form for the root's three questions, from both its asks.
      yield* ui.submit("/answer")
      yield* until((frame) => frame.includes("Background questions") && frame.includes("Which database should the cache use?"))
      yield* keep("form")
      console.log("screenshot:", yield* ui.screenshot(`${label}-form`))
      yield* ui.press("down")
      yield* keep("moved")
      yield* ui.press("return")
      yield* until((frame) => frame.includes("Should the old /v1 endpoint stay for a release?"))
      // The second: an answer of one's own, on the row under the assumption.
      yield* ui.press("down")
      yield* ui.press("return")
      yield* ui.type("Drop it after this release")
      yield* until((frame) => frame.includes("Drop it after this release"))
      yield* keep("typed")
      yield* ui.press("return")
      yield* until((frame) => frame.includes("Should the logs be JSON?"))
      // The third stays blank: on to the submit tab.
      yield* ui.press("tab")
      yield* until((frame) => frame.includes("(not answered)"))
      yield* keep("review")
      console.log("screenshot:", yield* ui.screenshot(`${label}-review`))
      yield* ui.press("return")
      // One letter wakes the root; the subagent's form, opened by the same /answer, shows next.
      yield* until(
        (frame) =>
          frame.includes("Root switched to Redis and dropped the endpoint") && frame.includes("2 open questions") && frame.includes("Which test runner should the suite use?"),
      )
      yield* keep("answered")
      console.log("screenshot:", yield* ui.screenshot(`${label}-answered`))
      // Esc closes it; the question stays open.
      yield* ui.press("escape")
      yield* until((frame) => !frame.includes("Which test runner should the suite use?") && frame.includes("2 open questions"))

      // shift+← on the empty composer: the left-over question, then the subagent's again.
      yield* ui.press("left", { shift: true })
      yield* until((frame) => frame.includes("Should the logs be JSON?") && !frame.includes("Which database should the cache use?"))
      yield* keep("again")
      yield* ui.press("return")
      yield* until((frame) => frame.includes("Which test runner should the suite use?") && frame.includes("Root kept JSON logs"))
      yield* keep("subagent")
      yield* ui.press("escape")
      yield* until((frame) => !frame.includes("Which test runner should the suite use?") && frame.includes("1 open question"))
      // The prompt has the focus back.
      yield* ui.type("typed-after-answer")
      yield* until((frame) => frame.includes("typed-after-answer"))
      yield* keep("done")
      yield* dump
    }),
)
