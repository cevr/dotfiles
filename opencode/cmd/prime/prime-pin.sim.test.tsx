// tests/prime-pin.test.ts's names on the simulated TUI (sim-tui/), each at its
// first SEEDS seeds: the fork's real TUI in this process with Prime loaded by
// path, in front of the server double, on a virtual clock. The ask pinned over
// the transcript: none at the bottom; scrolled up, the transcript's first row
// is the prompt the top of the view answers, drawn as the prompt draws, on one
// line; a click on it scrolls that prompt to the top, where it shows itself.
// scenarios/prime-pin.ts step for step: two asks, each with a 40-line answer,
// then wheel steps up over the transcript and a click on the pinned line.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import * as Golden from "../../sim-tui/golden.ts"
import { type Model, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-pin.sim.test.tsx"
/**
 * Seeds this file runs, by sim-tui's measured headroom rule (a file keeps half its 5 s of CPU): two
 * 40-line answers typed and streamed take 500–600 ms a seed (10 seeds took 5033 ms at load 28, 5 took 2983 ms at load 30), so 4.
 */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 100, height: 30 }

App.bootTest(BOOT)

// The transcript's first row, under the one-row top bar.
const FIRST = 1
const ASK_ONE = "List the first batch."
// Wider than the 100-column viewport, so its pinned line ends in an ellipsis.
const ASK_TWO = "Now list the second batch, and keep going well past the width of this terminal so the pinned line has to be cut short."
const ASK_TWO_START = "Now list the second batch"
const answer = (name: string) => Array.from({ length: 40 }, (_, index) => `- ${name} item ${String(index + 1).padStart(2, "0")}`).join("\n")

/** Each ask is answered in one step, its 40-line list. */
const model: Model = ({ text: prompt, step }) => [[text(answer(["one", "two"][Number(prompt.includes(ASK_TWO_START))] ?? "one"))]][step] ?? []

const NAMES = ["pin-bottom", "pin-answer-2", "pin-answer-1", "pin-revealed"] as const
type Name = (typeof NAMES)[number]
interface Saved {
  readonly text: ReadonlyArray<string>
  readonly frame: App.Frame
}

/** The scenario at `seed`: its four frames, played once a seed (the five tests read the same run). */
const played = new Map<number, Record<Name, Saved>>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((frames) => Effect.sync(() => played.set(seed, frames)))),
  })
const play = (seed: number) =>
  App.seed(BOOT, { key: "prime-pin", seed, model, title: () => "two batches" }, (tui) =>
    Effect.gen(function* () {
      const blank: Saved = { text: [], frame: { lines: [] } }
      const frames: Record<Name, Saved> = { "pin-bottom": blank, "pin-answer-2": blank, "pin-answer-1": blank, "pin-revealed": blank }
      const save = (name: Name) => Effect.sync(() => (frames[name] = { text: tui.text(), frame: tui.frame() }))
      const done = (last: string) => (shown: ReadonlyArray<string>) => shown.join("\n").includes(last) && !shown.join("\n").includes("Executing")
      const submit = (ask: string) => tui.type(ask).pipe(Effect.andThen(tui.press({ name: "enter" })))
      // One wheel step up over the transcript at a time, until the frame is ready (the scenario's 60 steps of 150 ms).
      const scrollUntil = (name: string, ready: (shown: ReadonlyArray<string>) => boolean) =>
        Effect.gen(function* () {
          for (let step = 0; step < 60; step++) {
            yield* tui.advance(150)
            if (ready(tui.text())) return
            yield* tui.mouse({ action: "scroll", x: 40, y: 12, direction: "up" })
          }
          yield* tui.until(name, ready)
        })
      yield* submit(ASK_ONE)
      yield* tui.until("pin-turn-1", done("one item 40"))
      yield* submit(ASK_TWO)
      yield* tui.until("pin-bottom", done("two item 40"))
      yield* tui.advance(500)
      yield* save("pin-bottom")
      // Into answer 2, its prompt scrolled out of view above.
      yield* scrollUntil("pin-answer-2", (shown) => /two item 1\d/.test(`${shown[FIRST] ?? ""}${shown[FIRST + 1] ?? ""}`))
      yield* tui.advance(300)
      yield* save("pin-answer-2")
      // Further, into answer 1.
      yield* scrollUntil("pin-answer-1", (shown) => /one item 2\d/.test(shown[FIRST + 1] ?? ""))
      yield* tui.advance(300)
      yield* save("pin-answer-1")
      // A click on the pinned line scrolls its prompt to the top.
      yield* tui.mouse({ action: "move", x: 10, y: FIRST })
      yield* tui.mouse({ action: "down", x: 10, y: FIRST })
      yield* tui.mouse({ action: "up", x: 10, y: FIRST })
      yield* tui.until("pin-revealed", (shown) => shown.join("\n").includes("one item 01"))
      yield* tui.advance(500)
      yield* save("pin-revealed")
      return frames
    }),
  )

/** A colour as the frame carries it (`rgba(r, g, b, a)`, each 0–1): its alpha, 0–255. */
const alpha = (colour: string) => Math.round(Number(colour.replace(/\)$/, "").split(",").at(-1) ?? "0") * 255)

/** The rail and the prompt's text on a row: each span's text, colour and boldness, the blank padding left out. */
const look = (saved: Saved, y: number) =>
  (saved.frame.lines[y]?.spans ?? []).filter((span) => span.text.trim() !== "").map((span) => ({ text: span.text, fg: span.fg, bold: (span.attributes & 1) === 1 }))

const golden = (frames: Record<Name, Saved>, name: Name) => Golden.check("prime-pin", name, frames[name].text)

seeded("at the bottom nothing is pinned: the first row is the answer", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    expect(yield* golden(frames, "pin-bottom")).toEqual([])
    expect(frames["pin-bottom"].text[FIRST]).toMatch(/^ {2}- two item \d\d$/)
    expect(frames["pin-bottom"].text.join("\n")).not.toContain("┃ Now list")
  }),
)

seeded("scrolled into answer 2, the first row is ask 2 on one line, cut with an ellipsis at the width", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    const shown = frames["pin-answer-2"].text
    expect(yield* golden(frames, "pin-answer-2")).toEqual([])
    expect(shown[FIRST]).toBe(" ┃ Now list the second batch, and keep going well past the width of this terminal so the pinned li…")
    expect(Array.from(shown[FIRST] ?? "").length).toBeLessThanOrEqual(100)
    expect(shown[FIRST + 1]).toMatch(/^ {2}- two item \d\d$/)
    // Ask 2's own rows are out of view: only the pin names it.
    expect(shown.filter((line) => line.includes(ASK_TWO_START))).toHaveLength(1)
  }),
)

seeded("scrolled further, into answer 1, the first row is ask 1", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    const shown = frames["pin-answer-1"].text
    expect(yield* golden(frames, "pin-answer-1")).toEqual([])
    expect(shown[FIRST]).toBe(` ┃ ${ASK_ONE}`)
    expect(shown[FIRST + 1]).toMatch(/^ {2}- one item \d\d$/)
    // Ask 2 is in view further down, yet the top answers ask 1: the pin follows the top, not the newest ask.
    expect(shown.findIndex((line) => line.includes(ASK_TWO_START))).toBeGreaterThan(FIRST + 1)
  }),
)

seeded("the pin draws as the prompt does: the rail and bold text in the prompt's colour", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    const pinned = look(frames["pin-answer-1"], FIRST)
    expect(pinned.map((span) => span.text)).toEqual(["┃", ASK_ONE])
    expect(pinned).toEqual(look(frames["pin-revealed"], FIRST))
    expect(pinned[1]?.bold).toBe(true)
  }),
)

seeded("a click on the pin scrolls ask 1 to the top, in place, its answer under it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    const shown = frames["pin-revealed"].text
    expect(yield* golden(frames, "pin-revealed")).toEqual([])
    expect(shown[FIRST]).toBe(` ┃ ${ASK_ONE}`)
    expect(shown.slice(FIRST + 1).filter((line) => line.trim() !== "")[0]).toBe("  - one item 01")
    // It is the prompt's own row, not the pin: the pin fills its row opaque, the transcript does not.
    const fill = (name: Name) => Option.map(Option.fromUndefinedOr(frames[name].frame.lines[FIRST]?.spans.find((span) => span.text === ASK_ONE)), (span) => alpha(span.bg))
    expect(fill("pin-answer-1")).toEqual(Option.some(255))
    expect(fill("pin-revealed")).toEqual(Option.some(0))
  }),
)

App.closeTest()
