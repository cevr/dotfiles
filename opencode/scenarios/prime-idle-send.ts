// Prompts sent to an idle session, in the Prime look, against OpenCode with a
// scripted model. A prompt sent while nothing runs is no queued prompt: it
// enters the transcript as the reader's message at once, and no queued row
// (`◌ queued · …`, `◌ after the turn · …`) shows for it, even in the moment
// before the runner takes it. While a turn runs, a steer and a prompt sent to
// the queue still wait in the rows; when that turn ends and the runner takes
// them, each moves from its row to the transcript without ever showing in
// both. The frames are captured back to back from just before each Enter.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-idle-send.ts
//
// It writes, under SCENARIO_OUT, each phase's frames as a JSON list of texts:
// - `first.json`: from the first prompt's Enter (a new session) until its answer;
// - `second.json`: from a second prompt's Enter (the session idle after a turn) until its answer;
// - `busy.json`: from a steer's Enter, during a stalled turn, through a prompt sent to the queue, until both answered.
import { Effect, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

export const FIRST = "Check the build."
export const SECOND = "Now run the linter."
export const SLOW = "Run the slow suite."
export const STEER = "Also update the docs."
export const LATER = "Afterwards tag the release."
const ANSWER_FIRST = "The build passes."
const ANSWER_SECOND = "The linter is clean."
const ANSWER_SLOW = "The suite passes."
const ANSWER_STEER = "Docs updated."
const ANSWER_LATER = "Release tagged."
/** How long the slow turn stalls: time to send a steer and a queued prompt behind it. */
const SLOW_MS = 5_000

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
    tui: { viewport: { cols: 106, rows: 40 } },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("checks"), Llm.finish())
        if (s.includes(LATER)) return Stream.make(Llm.text(ANSWER_LATER), Llm.finish())
        if (s.includes(STEER)) return Stream.make(Llm.text(ANSWER_STEER), Llm.finish())
        if (s.includes(SLOW)) return Stream.make(Llm.text("Running"), Llm.pause(SLOW_MS), Llm.text(` ${ANSWER_SLOW}`), Llm.finish())
        if (s.includes(SECOND)) return Stream.make(Llm.text(ANSWER_SECOND), Llm.finish())
        return Stream.make(Llm.text(ANSWER_FIRST), Llm.finish())
      })

      /** Captures frames back to back until `done` holds for one (or a minute passes), the frames' texts in order. */
      const record = (done: (frame: string) => boolean) =>
        Effect.gen(function* () {
          const frames: string[] = []
          const deadline = Date.now() + 60_000
          while (Date.now() < deadline) {
            const frame = text(yield* ui.capture())
            frames.push(frame)
            if (done(frame)) break
          }
          return frames
        })
      /** Types `prompt`, then records from just before its Enter (or `send`) until `done`. */
      const sent = (name: string, prompt: string, send: Effect.Effect<void, unknown>, done: (frame: string) => boolean) =>
        Effect.gen(function* () {
          yield* ui.type(prompt)
          const [frames] = yield* Effect.all([record(done), Effect.sleep("30 millis").pipe(Effect.andThen(send))], {
            concurrency: 2,
          })
          writeFileSync(`${out}/${name}.json`, JSON.stringify(frames))
          return frames
        })
      const enter = ui.press("return")

      yield* sent("first", FIRST, enter, (frame) => frame.includes(ANSWER_FIRST))
      yield* Effect.sleep("1000 millis")
      yield* sent("second", SECOND, enter, (frame) => frame.includes(ANSWER_SECOND))
      yield* Effect.sleep("1000 millis")
      // A slow turn, then a steer and a prompt to the queue (leader, Ctrl+X, then Enter) behind it.
      yield* ui.submit(SLOW)
      yield* record((frame) => frame.includes("Running"))
      yield* ui.type(STEER)
      yield* Effect.all(
        [
          record((frame) => frame.includes(ANSWER_LATER) && !frame.includes("◌")).pipe(
            Effect.tap((frames) => Effect.sync(() => writeFileSync(`${out}/busy.json`, JSON.stringify(frames)))),
          ),
          Effect.gen(function* () {
            yield* Effect.sleep("30 millis")
            yield* enter
            yield* Effect.sleep("500 millis")
            yield* ui.type(LATER)
            yield* ui.press("x", { ctrl: true })
            yield* enter
          }),
        ],
        { concurrency: 2 },
      )
    }),
)
