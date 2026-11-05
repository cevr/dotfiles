// The ask pinned over the transcript in the Prime look: scrolled up, the
// prompt the top of the view answers sits on the transcript's first row, on
// one line, and a click on it scrolls that prompt to the top. Two asks, each
// with a long answer, replayed against OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-pin.ts
//
// It writes, under SCENARIO_OUT:
// - `pin-bottom`: both turns done, at the bottom;
// - `pin-answer-2`: scrolled up into answer 2;
// - `pin-answer-1`: scrolled further, into answer 1;
// - `pin-revealed`: after a click on the pinned line.
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK_ONE = "List the first batch."
// Wider than the 100-column viewport, so its pinned line ends in an ellipsis.
const ASK_TWO =
  "Now list the second batch, and keep going well past the width of this terminal so the pinned line has to be cut short."
const answer = (name: string) =>
  Array.from({ length: 40 }, (_, index) => `- ${name} item ${String(index + 1).padStart(2, "0")}`).join("\n")

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: { autoupdate: false, username: "Demo" },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/mods/prime`],
    },
    tui: { viewport: { cols: 100, rows: 30 } },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("two batches"), Llm.finish())
        if (s.includes("Now list the second batch")) return Stream.make(Llm.text(answer("two")), Llm.finish())
        return Stream.make(Llm.text(answer("one")), Llm.finish())
      })
      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError(() =>
            ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame)))),
          ),
        )
      const save = (name: string) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/${name}.txt`, text(frame))
          writeFileSync(`${out}/${name}.json`, JSON.stringify(frame))
          console.log("screenshot:", yield* ui.screenshot(name))
        })
      // The transcript starts under the one-row top bar.
      const firstRow = (frame: string) => frame.split("\n")[1] ?? ""
      // One wheel step up over the transcript at a time, until the frame is ready.
      const scrollUntil = (name: string, ready: (frame: string) => boolean) =>
        Effect.gen(function* () {
          for (let step = 0; step < 60; step++) {
            yield* Effect.sleep("150 millis")
            if (ready(text(yield* ui.capture()))) return
            yield* ui.mouse({ action: "scroll", x: 40, y: 12, direction: "up" })
          }
          yield* until(name, ready)
        })

      yield* ui.submit(ASK_ONE)
      yield* until("pin-turn-1", (frame) => frame.includes("one item 40") && !frame.includes("Executing"))
      yield* ui.submit(ASK_TWO)
      yield* until("pin-bottom", (frame) => frame.includes("two item 40") && !frame.includes("Executing"))
      yield* Effect.sleep("500 millis")
      yield* save("pin-bottom")

      // Into answer 2, its prompt scrolled out of view above.
      yield* scrollUntil("pin-answer-2", (frame) => /two item 1\d/.test(firstRow(frame).concat(frame.split("\n")[2] ?? "")))
      yield* Effect.sleep("300 millis")
      yield* save("pin-answer-2")
      // Further, into answer 1.
      yield* scrollUntil("pin-answer-1", (frame) => /one item 2\d/.test(frame.split("\n")[2] ?? ""))
      yield* Effect.sleep("300 millis")
      yield* save("pin-answer-1")

      // A click on the pinned line scrolls its prompt to the top.
      yield* ui.mouse({ action: "move", x: 10, y: 1 })
      yield* ui.mouse({ action: "down", x: 10, y: 1, button: "left" })
      yield* ui.mouse({ action: "up", x: 10, y: 1, button: "left" })
      yield* until("pin-revealed", (frame) => frame.includes("one item 01"))
      yield* Effect.sleep("500 millis")
      yield* save("pin-revealed")
    }),
)
