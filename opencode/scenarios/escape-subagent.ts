// Escape in a running subagent's view, with the escape TUI plugin (cmd/escape)
// beside Prime, against OpenCode with a scripted model. The parent starts one
// background worker, whose answer stalls after its first words. Down on the
// empty prompt opens the Subagents picker and Enter goes into the worker,
// whose view opens on that picker. One Escape puts the picker away and leaves
// the worker running, the prompt focused; a message typed there and sent is a
// steer to the worker. A second Escape, nothing open now, goes back to the
// parent's view and leaves the worker running: its stalled answer runs to its
// end, and the steer reaches it then, while the parent is on screen. Back in
// the worker's view (its answer to the steer stalls in turn), Ctrl+Enter with
// a draft interrupts it and sends the draft at once.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/escape-subagent.ts
//
// It writes, under SCENARIO_OUT, a `.txt` of each frame's text:
// - `picker`: in the worker's view, on its picker;
// - `dismissed`: 1.5 s after the first Escape;
// - `typed`: the steer typed into the prompt, not yet sent;
// - `steered`: 1.5 s after Enter sent it;
// - `parent`: 1.5 s after the second Escape, on the parent's view;
// - `parent-steered`: once the worker's model got the steer, still on the parent's view;
// - `back`: in the worker's view again, its answer to the steer showing;
// - `drafted`: the second message typed into the worker's prompt, not yet sent;
// - `sent`: once Ctrl+Enter interrupted the worker;
// - `answered`: once the worker answered the second message;
// and `requests.txt`: one line per model request of the worker: `brief`,
// `steer` when it carries the steer, `now` when it carries the second message.
import { Effect, Schedule, Stream } from "effect"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Fix the money parsing in a worker."
const STARTED = "The worker is on it."
const BRIEF = "Worker brief: fix money parsing."
const WORKING = "Reading the parser"
const DONE = " and done."
const STEER = "Check the cents rounding too."
const STEERED = "Cents rounding checked"
const NOW = "Stop and ship the fix now."
const SHIPPED = "Shipped the fix."
/** How long each stalled answer stalls after its first words: past every press made while it stalls. */
const STALL = 20_000
/** The picker's header row: the host's composer panel, its Subagents tab first. */
const picker = (frame: string) => frame.split("\n").some((line) => /^\s*┃\s+Subagents(\s|$)/.test(line))
/** The root's picker lists the worker as Prime's panel rows read (mods/prime/panel.ts): its tab counts it, its row ends `working  12s`. */
const listed = (frame: string) => /┃\s+Subagents 1\s/.test(frame) && /Fix money parsing .* working +\d+s/.test(frame)

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: { autoupdate: false, username: "Demo" },
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
      writeFileSync(`${out}/requests.txt`, "")
      /** When the last stalled answer started, so the run waits for it to end. */
      let stalled = 0
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("money parsing"), Llm.finish())
        if (s.includes(BRIEF) && !s.includes(ASK)) {
          const kind = s.includes(NOW) ? "now" : s.includes(STEER) ? "steer" : "brief"
          appendFileSync(`${out}/requests.txt`, `${kind}\n`)
          if (kind === "now") return Stream.make(Llm.text(SHIPPED), Llm.finish())
          stalled = Date.now()
          const first = kind === "steer" ? STEERED : WORKING
          return Stream.make(Llm.text(first), Llm.pause(STALL), Llm.text(DONE), Llm.finish())
        }
        if (s.includes("call_worker")) return Stream.make(Llm.text(STARTED), Llm.finish())
        return Stream.make(
          Llm.toolCall({
            index: 0,
            id: "call_worker",
            name: "subagent",
            input: { agent: "general", description: "Fix money parsing", prompt: BRIEF, background: true },
          }),
          Llm.finish("tool-calls"),
        )
      })
      const until = (name: string, ready: (frame: string) => boolean, times = 200) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
          Effect.tapError(() =>
            ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame)))),
          ),
        )
      const save = (name: string) =>
        ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.txt`, text(frame))))
      const requests = () => readFileSync(`${out}/requests.txt`, "utf8").trim().split("\n")

      yield* ui.submit(ASK)
      yield* until("started", (frame) => frame.includes(STARTED) && frame.includes("1 subagent"))

      yield* ui.arrow("down")
      yield* until("root-picker", listed)
      yield* ui.enter()
      yield* until("picker", (frame) => frame.includes(WORKING) && frame.includes("Subagents"))
      yield* save("picker")

      yield* ui.press("escape")
      yield* Effect.sleep("1500 millis")
      yield* save("dismissed")

      yield* ui.type(STEER)
      yield* until("typed", (frame) => frame.includes(STEER))
      yield* save("typed")
      yield* ui.enter()
      yield* Effect.sleep("1500 millis")
      yield* save("steered")

      // Nothing open: back to the parent, whose view shows its own prompt.
      yield* ui.press("escape")
      yield* until("parent", (frame) => frame.includes(ASK))
      yield* Effect.sleep("1500 millis")
      yield* save("parent")
      // The worker's stalled answer ends on its own and its turn takes the steer, the parent still on screen.
      yield* until("parent-steered", () => requests().includes("steer"), 400)
      yield* Effect.sleep("500 millis")
      yield* save("parent-steered")

      yield* ui.arrow("down")
      yield* until("back-picker", listed)
      yield* ui.enter()
      yield* until("back", (frame) => frame.includes(STEERED) && !frame.includes(ASK))
      if (picker(text(yield* ui.capture()))) {
        yield* ui.press("escape")
        yield* until("back-dismissed", (frame) => !picker(frame))
      }
      yield* save("back")

      yield* ui.type(NOW)
      yield* until("drafted", (frame) => frame.includes(NOW))
      yield* save("drafted")
      yield* ui.press("return", { ctrl: true })
      yield* until("sent", (frame) => frame.includes("Interrupted"))
      yield* save("sent")
      yield* until("answered", (frame) => frame.includes(SHIPPED))
      yield* save("answered")
      // Let a stalled answer end (if nothing cut it) before the driver checks every model response settled.
      yield* Effect.sleep(Math.max(0, stalled + STALL + 3_000 - Date.now()))
    }),
)
