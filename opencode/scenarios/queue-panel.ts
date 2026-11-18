// The queue where the owner looks, in the Prime look with the sidebar hidden:
// a scripted model keeps the queue through the `queue` tool (an item that
// needs the owner, a running unit whose outcomes lead on, a verifier after
// it, a next step) and answers in one line. The dock under the composer then
// counts `4 queued, 1 needs you`; `/queue` opens the composer panel's Queue
// tab, which draws the plan (each item, its outcomes, what waits on it nested
// under it); Escape puts it away; a click on the dock's count opens it again.
// Then Enter on the first item (no choices) opens the host's question form
// with the queue's own (done, still needed) and the owner types an answer;
// /queue, ↓ to the last item and Enter opens its own choices and the first is
// picked. Each answer reaches the model as one message, which it replies to,
// and the tab marks the item answered.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/queue-panel.ts
//
// It writes, under SCENARIO_OUT, `queue-panel-<name>.txt` for each frame:
// `bar` (the reply and the dock's count), `tab` (after /queue, with a
// screenshot), `closed` (after Escape), `clicked` (after the click),
// `builtins` (the form with the queue's own choices), `typed` (the reply to
// the typed answer), `choices` (the form with the item's own, with a
// screenshot), `picked` (the reply to the pick), `answered` (the tab after), and
// `queue-panel-<name>.timeout.txt` when a wait times out.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"

/** What the model's reply says: one line, no queue in it. */
export const REPLY = "Started the money parsing unit."

/** The queue the model sets, as the tool takes it. */
export const ITEMS: Array<Record<string, string | Array<string> | Record<string, string> | Array<Record<string, string>>>> = [
  { id: "panes", text: "Close old Claude panes", state: "needs-you" },
  { id: "impl", text: "Money parsing r1", state: "running", on: { accepted: "verify", changes: "fix round 2" } },
  { id: "verify", text: "Verify money parsing", state: "next", after: ["impl"], on: { accepted: "land + install" } },
  { id: "daily", text: "Merge workers, run daily", state: "next", choices: [{ label: "Run it tonight", description: "After the merge" }, { label: "Skip today" }] },
]

/** The model's replies to each answer, by the message it reads. */
export const TYPED = { said: "Owner on queue item panes (Close old Claude panes): Keep the two newest", reply: "Keeping the two newest panes." } as const
export const PICKED = { said: "Owner on queue item daily (Merge workers, run daily): Run it tonight", reply: "Running the merge tonight." } as const

type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo", plugins: [{ package: `${root}/cmd/queue`, options: { dir: `${out}/queue-panel-queues` } }] },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`, `${root}/cmd/queue`],
      session: { sidebar: "hide" },
    },
    tui: { viewport: { cols: 120, rows: 40 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("Queue panel"), Llm.finish())
        if (!s.includes("call_queue"))
          return Stream.make(Llm.toolCall({ index: 0, id: "call_queue", name: "queue", input: { set: ITEMS } }), Llm.finish("tool-calls"))
        // The history holds every answer so far: the latest first.
        if (s.includes(PICKED.said)) return Stream.make(Llm.text(PICKED.reply), Llm.finish())
        if (s.includes(TYPED.said)) return Stream.make(Llm.text(TYPED.reply), Llm.finish())
        return Stream.make(Llm.text(REPLY), Llm.finish())
      })
      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.map(text),
          Effect.filterOrFail(ready, () => "pending"),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/queue-panel-${name}.timeout.txt`, text(frame))))),
        )
      const save = (name: string) =>
        Effect.gen(function* () {
          writeFileSync(`${out}/queue-panel-${name}.txt`, text(yield* ui.capture()))
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

      yield* ui.submit("queue-panel-fixture")
      yield* until("bar", (frame) => frame.includes(REPLY) && frame.includes("4 queued, 1 needs you"))
      yield* save("bar")
      yield* ui.submit("/queue")
      yield* until("tab", (frame) => frame.includes("on accepted ⇥ ○ Verify money parsing") && frame.includes("│ ○ Verify money parsing · next"))
      yield* save("tab")
      console.log("screenshot:", yield* ui.screenshot("queue-panel-tab"))
      yield* ui.press("escape")
      yield* until("closed", (frame) => !frame.includes("on accepted ⇥"))
      yield* save("closed")
      yield* click("4 queued")
      yield* until("clicked", (frame) => frame.includes("on accepted ⇥ ○ Verify money parsing"))
      yield* save("clicked")

      // Enter on the first item, which has no choices: the queue's own, and an answer typed, which wakes the agent.
      yield* ui.press("return")
      yield* until("builtins", (frame) => frame.includes("Done / no longer needed") && frame.includes("Type your own answer"))
      yield* save("builtins")
      yield* ui.press("down")
      yield* ui.press("down")
      yield* ui.press("return")
      yield* ui.type("Keep the two newest")
      yield* until("typing", (frame) => frame.includes("Keep the two newest"))
      yield* ui.press("return")
      yield* until("typed", (frame) => frame.includes(TYPED.reply))
      yield* save("typed")

      // The last item's own choices: the first picked.
      yield* ui.submit("/queue")
      yield* until("reopened", (frame) => frame.includes("answered: Keep the two newest"))
      yield* ui.press("down")
      yield* ui.press("down")
      yield* ui.press("down")
      yield* ui.press("return")
      yield* until("choices", (frame) => frame.includes("Skip today") && frame.includes("After the merge"))
      yield* save("choices")
      console.log("screenshot:", yield* ui.screenshot("queue-panel-choices"))
      yield* ui.press("return")
      yield* until("picked", (frame) => frame.includes(PICKED.reply))
      yield* save("picked")
      yield* ui.submit("/queue")
      yield* until("answered", (frame) => frame.includes("answered: Run it tonight"))
      yield* save("answered")
    }),
)
