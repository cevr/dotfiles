// Escape on a busy session in the Prime look, with an empty composer. One
// second after sending, one Escape cancels: the run stops, the session reverts
// to before the prompt and the prompt is back in the composer. Seven seconds
// after sending, past the 5 s grace, one Escape interrupts and the prompt and
// its partial answer stay. The Dock shows no Escape hint. Replayed against OpenCode with a scripted slow model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-escape.ts
//
// It writes, under SCENARIO_OUT, a `.txt` of each frame's text:
// - `cancel-hint`: just after sending, inside the grace;
// - `cancelled`: after Escape at 1 s;
// - `interrupt-hint`: 7 s after sending the prompt again;
// - `interrupted`: after Escape at 7 s.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Rename the helper."
const PARTIAL = "Working on it"
/** How long the scripted answer stalls after its first words: past the 7 s Escape, short of the run's settlement wait. */
const STALL = 9_000

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
        if (s.includes("You name conversations")) return Stream.make(Llm.text("helper rename"), Llm.finish())
        return Stream.make(Llm.text(PARTIAL), Llm.pause(STALL), Llm.text(" and done."), Llm.finish())
      })
      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }),
          Effect.tapError(() =>
            ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame)))),
          ),
        )
      const save = (name: string) =>
        ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.txt`, text(frame))))
      // Sleeps until `ms` after `start`.
      const at = (start: number, ms: number) => Effect.sleep(Math.max(0, start + ms - Date.now()))

      const first = Date.now()
      yield* ui.submit(ASK)
      yield* until("cancel-hint", (frame) => frame.includes(PARTIAL))
      yield* save("cancel-hint")
      yield* at(first, 1_000)
      yield* ui.press("escape")
      yield* until("cancelled", (frame) => !frame.includes(PARTIAL) && frame.includes(ASK))
      yield* Effect.sleep("500 millis")
      yield* save("cancelled")

      // Send the restored prompt again; this time wait out the grace.
      const second = Date.now()
      yield* ui.enter()
      yield* until("resent", (frame) => frame.includes(PARTIAL))
      yield* at(second, 7_000)
      yield* until("interrupt-hint", (frame) => frame.includes(PARTIAL))
      yield* save("interrupt-hint")
      yield* ui.press("escape")
      yield* until("interrupted", (frame) => frame.includes("Interrupted"))
      yield* Effect.sleep("500 millis")
      yield* save("interrupted")
      // Let both stalled answers end before the driver checks every model response settled.
      yield* at(second, STALL + 1_500)
    }),
)
