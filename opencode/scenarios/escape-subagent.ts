// Escape in a running subagent's view, with the escape TUI plugin (cmd/escape)
// beside Prime, against OpenCode with a scripted model. The parent starts one
// background worker, whose answer stalls after its first words. Down on the
// empty prompt opens the Subagents picker and Enter goes into the worker,
// whose view opens on that picker. One Escape puts the picker away and leaves
// the worker running, the prompt focused; a message typed there and sent is a
// steer to the worker. A second Escape, nothing open now, interrupts the
// worker as on any session, and its resume delivers the steer.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/escape-subagent.ts
//
// It writes, under SCENARIO_OUT, a `.txt` of each frame's text:
// - `picker`: in the worker's view, on its picker;
// - `dismissed`: 1.5 s after the first Escape;
// - `typed`: the steer typed into the prompt, not yet sent;
// - `steered`: 1.5 s after Enter sent it;
// - `interrupted`: after the second Escape;
// - `answered`: once the worker answered the steer;
// and `requests.txt`: one line per model request of the worker, `steer` when it carries the steer, else `brief`.
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
const STEER = "Check the cents rounding too."
const STEERED = "Cents rounding checked."
/** How long the worker's first answer stalls after its first words: past every press here. */
const STALL = 25_000

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
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("money parsing"), Llm.finish())
        if (s.includes(BRIEF) && !s.includes(ASK)) {
          const steered = s.includes(STEER)
          appendFileSync(`${out}/requests.txt`, `${steered ? "steer" : "brief"}\n`)
          if (steered) return Stream.make(Llm.text(STEERED), Llm.finish())
          return Stream.make(Llm.text(WORKING), Llm.pause(STALL), Llm.text(" and done."), Llm.finish())
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
      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 200 }),
          Effect.tapError(() =>
            ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame)))),
          ),
        )
      const save = (name: string) =>
        ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.txt`, text(frame))))

      yield* ui.submit(ASK)
      yield* until("started", (frame) => frame.includes(STARTED) && frame.includes("1 subagent"))
      const sent = Date.now()

      yield* ui.arrow("down")
      yield* until("root-picker", (frame) => frame.includes("Subagents") && frame.includes("Running"))
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

      yield* ui.press("escape")
      yield* until("interrupted", (frame) => frame.includes("Interrupted"))
      yield* save("interrupted")
      yield* until("answered", (frame) => frame.includes(STEERED))
      yield* save("answered")
      // Let the stalled answer end (if nothing cut it) before the driver checks every model response settled.
      yield* Effect.sleep(Math.max(0, sent + STALL + 3_000 - Date.now()))
    }),
)
