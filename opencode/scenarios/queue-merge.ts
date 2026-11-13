// Waiting prompts as one, with the escape plugins (cmd/escape, its TUI half
// beside Prime and its server half) against OpenCode with a scripted model.
// CASE picks the case:
// - `up`: the model holds its answer to the first prompt; three prompts go to
//   the queue (leader+Enter), then Up on the empty composer;
// - `escape`: the same, then Escape in place of Up;
// - `deliver`: the same three queued, then the model answers and the turn ends
//   on its own;
// - `history`: one prompt answered, nothing queued, then Up on the empty composer.
// Run: CASE=up OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/queue-merge.ts
//
// It writes, under SCENARIO_OUT, `<case>-before.txt` (the frame before the
// key; for `deliver`, once the three are queued), `<case>-after.txt` (once the
// key acted and the first turn ended, or the queued prompts were answered),
// and `<case>-requests.json`: the user texts of each model request after the
// first. It waits on what the frame shows, never on a clock.
import { Array as Arr, Deferred, Effect, Option, Predicate, Schedule, Schema, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT || "out"
const which = process.env.CASE || "up"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Rename the helper."
const QUEUED = ["Also update the docs.", "Then run the tests.", "Then tag it."]
const PARTIAL = "Working on it"
const FINISHED = " and done."
const DONE = "All three done."

/** A chat-completions request, as far as its user texts go. */
const Request = Schema.Struct({
  body: Schema.Struct({
    messages: Schema.Array(
      Schema.Struct({
        role: Schema.String,
        content: Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))]),
      }),
    ),
  }),
})
const decodeRequest = Schema.decodeUnknownOption(Request)

/** A message's text: its string, or its parts' texts joined. */
const contentText = (content: typeof Request.Type.body.messages[number]["content"]) => {
  if (Predicate.isString(content)) return content
  return content.flatMap((part) => Option.toArray(Option.fromUndefinedOr(part.text))).join("")
}

/** The user texts of a request, in order. */
const userTexts = (req: Parameters<typeof decodeRequest>[0]): ReadonlyArray<string> =>
  Option.match(decodeRequest(req), {
    onNone: () => [],
    onSome: (request) => request.body.messages.filter((message) => message.role === "user").map((message) => contentText(message.content)),
  })

/** The composer's rows: the last run of rail rows above the dock's rule. */
const composerRows = (frame: string) => {
  const lines = frame.split("\n")
  const rule = lines.findLastIndex((line) => /^ ─{10,}\s*$/.test(line))
  const above = lines.slice(0, Math.max(0, rule))
  const last = above.findLastIndex((line) => line.startsWith(" ┃"))
  const first = Arr.findLastIndex(above.slice(0, last + 1), (line) => !line.startsWith(" ┃"))
  return above.slice(Option.getOrElse(first, () => -1) + 1, last + 1)
}
/** Whether the composer holds exactly `rows`. */
const holds = (frame: string, rows: ReadonlyArray<string>) => composerRows(frame).join("\n") === rows.map((row) => ` ┃ ${row}`).join("\n")
/** Whether the composer is empty: its one rail row and nothing on it. */
const empty = (frame: string) => composerRows(frame).join("\n") === " ┃"

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV || "" },
    config: { autoupdate: false, username: "Demo", plugins: [`${root}/cmd/escape`] },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`, `${root}/cmd/escape`],
    },
    tui: { viewport: { cols: 106, rows: 40 } },
    llm: { settlementTimeout: 120_000 },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      const requests: Array<ReadonlyArray<string>> = []
      /** Released when the first answer may finish: at once in `history`, after the key or the queueing otherwise. */
      const release = yield* Deferred.make<boolean>()
      const answered = { first: false }
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("helper rename"), Llm.finish())
        if (!answered.first) {
          answered.first = true
          return Stream.make(Llm.text(PARTIAL)).pipe(
            Stream.concat(Stream.fromEffect(Deferred.await(release)).pipe(Stream.drain)),
            Stream.concat(Stream.make(Llm.text(FINISHED), Llm.finish())),
          )
        }
        requests.push(userTexts(req))
        return Stream.make(Llm.text(DONE), Llm.finish())
      })
      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.map(text),
          Effect.filterOrFail(ready, () => "pending"),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 200 }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${which}-${name}.timeout.txt`, text(frame))))),
        )
      const save = (name: string) => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${which}-${name}.txt`, text(frame))))
      const settled = (frame: string) => !frame.includes("Executing") && !frame.includes("◌")

      yield* ui.submit(ASK)
      yield* until("streaming", (frame) => frame.includes(PARTIAL))
      if (which === "history") {
        yield* Deferred.succeed(release, true)
        yield* until("idle", (frame) => frame.includes(FINISHED) && settled(frame) && empty(frame))
        yield* save("before")
        yield* ui.press("up")
        yield* until("after", (frame) => holds(frame, [ASK]))
        yield* save("after")
      }
      if (which !== "history") {
        // To the queue: leader (ctrl+x) then Enter, one at a time, each seen in the queue before the next.
        for (const prompt of QUEUED) {
          yield* ui.type(prompt)
          yield* ui.press("x", { ctrl: true })
          yield* ui.enter()
          yield* until("queued", (frame) => frame.includes(`◌ after the turn · ${prompt}`) && empty(frame))
        }
        yield* save("before")
      }
      if (which === "deliver") {
        yield* Deferred.succeed(release, true)
        yield* until("answered", (frame) => frame.includes(DONE) && settled(frame))
        yield* save("after")
      }
      if (which === "up" || which === "escape") {
        if (which === "up") yield* ui.press("up")
        if (which === "escape") yield* ui.press("escape")
        yield* until("taken", (frame) => holds(frame, QUEUED) && !frame.includes("◌"))
        // The first answer ends (Up leaves its turn running; Escape cut it): a prompt the key failed to take back would
        // reach the model in a request after it.
        yield* Deferred.succeed(release, true)
        yield* until("after", (frame) => settled(frame) && (frame.includes(FINISHED) || frame.includes("■ Interrupted")))
        yield* save("after")
      }
      writeFileSync(`${out}/${which}-requests.json`, JSON.stringify(requests))
    }),
)
