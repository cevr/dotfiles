// A subagent's view in the Prime look, on the simulated TUI (sim-tui/): the
// fork's real TUI with Prime and the escape plugin loaded by path, in front of
// the server double. Entering a subagent from the parent's open Subagents
// panel shows the subagent's view alone (no panel under its rows, the prompt
// has the keyboard); there ↑ on the empty prompt goes back to the parent, as
// Escape does, while ↑ on a draft keeps the view; and in the parent ↑ still
// walks the prompt history.
import { Array as Arr, Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import { MODEL_REF, type Model, stall, subagent, text } from "../../sim-tui/server.ts"
import { composerRow } from "../../tests/composer.ts"

const FILE = "cmd/prime/prime-subagent-view.sim.test.tsx"
/** Seeds this file runs: sim-tui's measured headroom rule (a file keeps half its 5 s of CPU). */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime", "cmd/escape"], width: 106, height: 40 }

App.bootTest(BOOT)

const ASK = "Fix the money parsing in a worker."
const STARTED = "The worker is on it."
const BRIEF = "Worker brief: fix money parsing."
const WORKING = "Reading the parser"
const DRAFT = "Check the cents"
const NAMES = ["panel", "entered", "typed", "drafted-up", "parent", "history"] as const
type Name = (typeof NAMES)[number]

/** The composer panel's header row, its Subagents tab first. */
const isPanel = (frame: ReadonlyArray<string>) => frame.some((line) => /^\s*┃\s+Subagents(\s|$)/.test(line))
/** The parent's panel lists the worker working. */
const listed = (frame: ReadonlyArray<string>) => /┃\s+Subagents 1\s/.test(frame.join("\n")) && /Fix money parsing .* working +\d+s/.test(frame.join("\n"))
const has = (shown: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(shown)
/** A subagent's view: its title behind its parent's on the top bar. */
const inside = (frame: ReadonlyArray<string>) => (frame[0] ?? "").includes(" › ")
/** The composer's first row (tests/composer.ts; the dock's session row sits above it). */
const composer = (frame: ReadonlyArray<string>) => frame[composerRow(frame)] ?? ""
const joined = (frame: ReadonlyArray<string>) => frame.join("\n")

const play = (seed: number) => {
  const model: Model = ({ text: prompt, step }) => {
    if (prompt === ASK)
      return [[subagent({ id: "call_worker", input: { agent: "general", description: "Fix money parsing", prompt: BRIEF, background: true }, title: "Fix money parsing", agent: "general", model: MODEL_REF })], [text(STARTED)]][step] ?? []
    if (prompt.includes(BRIEF) && step === 0) return [text(WORKING), stall]
    return []
  }
  return App.seed(BOOT, { key: "prime-subagent-view", seed, model, title: () => "money parsing" }, (tui) =>
    Effect.gen(function* () {
      const frames = new Map<Name, ReadonlyArray<string>>()
      const save = (name: Name) => Effect.sync(() => frames.set(name, tui.text()))
      yield* tui.type(ASK)
      yield* tui.press({ name: "enter" })
      yield* tui.until("started", (frame) => has(STARTED)(frame) && has("1 subagent")(frame))
      // The parent's panel open, the subagent entered from it.
      yield* tui.press({ name: "down" })
      yield* tui.until("panel", listed)
      yield* save("panel")
      yield* tui.press({ name: "enter" })
      yield* tui.until("entered", (frame) => inside(frame) && has(WORKING)(frame))
      yield* tui.advance(1_500)
      yield* save("entered")
      // A panel left open (as the view opened before) is put away, as the user would, so ↑ is tried on the prompt.
      if (isPanel(tui.text())) {
        yield* tui.press({ name: "escape" })
        yield* tui.until("dismissed", (frame) => !isPanel(frame))
      }
      // What is typed lands in the prompt; ↑ on that draft keeps the view.
      yield* tui.type(DRAFT)
      yield* tui.until("typed", (frame) => composer(frame).includes(DRAFT))
      yield* save("typed")
      yield* tui.press({ name: "up" })
      yield* tui.advance(1_500)
      yield* save("drafted-up")
      // ↑ left the cursor at the draft's start; ↓ takes it to the end, and each backspace (OpenTUI's mock keys name it by
      // its key code) takes a character.
      yield* tui.press({ name: "down" })
      for (const _ of DRAFT) yield* tui.press({ name: "BACKSPACE" })
      yield* tui.until("cleared", (frame) => !composer(frame).includes(DRAFT))
      // ↑ on the empty prompt: back to the parent.
      yield* tui.press({ name: "up" })
      yield* tui.until("parent", (frame) => !inside(frame) && has(ASK)(frame), 10_000)
      yield* tui.advance(1_500)
      yield* save("parent")
      // ↑ on the parent's empty prompt walks its history, as before.
      yield* tui.press({ name: "up" })
      yield* tui.until("history", (frame) => composer(frame).includes(ASK), 10_000)
      yield* save("history")
      const shown = (name: Name) => frames.get(name) ?? []
      return {
        panel: shown("panel"),
        entered: shown("entered"),
        typed: shown("typed"),
        "drafted-up": shown("drafted-up"),
        parent: shown("parent"),
        history: shown("history"),
      } satisfies Record<Name, ReadonlyArray<string>>
    }),
  )
}

/** The scenario at `seed`, played once a seed (the tests read the same run). */
const played = new Map<number, Record<Name, ReadonlyArray<string>>>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((run) => Effect.sync(() => played.set(seed, run)))),
  })

seeded("entering a subagent from the parent's open panel closes the panel: the subagent's view shows alone", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    expect(isPanel(frames.panel)).toBe(true)
    expect(inside(frames.entered)).toBe(true)
    expect(isPanel(frames.entered)).toBe(false)
    expect(joined(frames.entered)).toContain(WORKING)
    expect(joined(frames.entered)).toContain("↑ back to parent")
    // The prompt has the keyboard.
    expect(composer(frames.typed)).toContain(DRAFT)
    expect(isPanel(frames.typed)).toBe(false)
  }),
)

/** The rows of a frame that hold `shown`. */
const rowsOf = (frame: ReadonlyArray<string>, shown: string) =>
  Arr.getSomes(frame.map((line, y) => Option.map(Option.liftPredicate(line, (text: string) => text.includes(shown)), () => y)))

seeded("the subagent's view keeps the parent's layout: the composer on the same row, the way back and the family's rows under it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    const parent = composerRow(frames.parent)
    const child = composerRow(frames.entered)
    expect(parent).toBeGreaterThan(0)
    expect(child).toBe(parent)
    // The way back is the dock's first line, right under the composer, where the parent's way down is.
    const back = rowsOf(frames.entered, "↑ back to parent")
    const down = rowsOf(frames.parent, "↓ subagents")
    expect(back).toHaveLength(1)
    expect(down).toHaveLength(1)
    expect(back[0]).toBe(down[0])
    expect(back[0]!).toBeGreaterThan(child)
    // The family's row (the worker's, marked in its own view) is under the composer in both views, on the same row.
    const row = (frame: ReadonlyArray<string>) => rowsOf(frame, "Fix money parsing").filter((y) => y > composerRow(frame))
    expect(row(frames.entered)).toHaveLength(1)
    expect(row(frames.entered)).toEqual(row(frames.parent))
    expect(frames.entered[row(frames.entered)[0]!]).toMatch(/^\s*›/)
  }),
)

seeded("↑ on a draft in the subagent's view stays there, the draft kept", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    expect(inside(frames["drafted-up"])).toBe(true)
    expect(composer(frames["drafted-up"])).toContain(DRAFT)
  }),
)

seeded("↑ on the empty prompt in the subagent's view goes back to the parent, the subagent still running", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    expect(inside(frames.parent)).toBe(false)
    expect(joined(frames.parent)).toContain(STARTED)
    expect(joined(frames.parent)).not.toContain("back to parent")
    expect(isPanel(frames.parent)).toBe(false)
    expect(joined(frames.parent)).toContain("1 subagent")
    expect(joined(frames.parent)).not.toContain("Interrupted")
  }),
)

seeded("↑ on the parent's empty prompt still walks its history", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    expect(inside(frames.history)).toBe(false)
    expect(composer(frames.history)).toContain(ASK)
  }),
)

App.closeTest()
