// @reads all
// @reads-reason native TUI plugin loader reads at sim-tui/app.ts: createAppFixture({
// The composer panel opened inside a subagent's view, in the Prime look, on the
// simulated TUI (sim-tui/): the fork's real TUI with Prime and the escape plugin
// loaded by path, in front of the server double. Two workers run; the second
// is entered from the parent's panel. There Down opens the panel on the worker
// shown, ↑ moves up the panel's list (the view stays), ↑ at the list's top
// closes the panel back to the prompt (the view still stays), and only then ↑
// on the empty prompt goes back to the parent.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import { MODEL_REF, type Model, stall, subagent, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-subagent-panel.sim.test.tsx"
/** Seeds this file runs: sim-tui's measured headroom rule (a file keeps half its 5 s of CPU). */
const SEEDS = 3
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime", "cmd/escape"], width: 106, height: 40 }

App.bootTest(BOOT)

const ASK = "Fix the money parsing and the dates in two workers."
const STARTED = "Both workers are on it."
const WORKERS = [
  { id: "call_money", title: "Fix money parsing", brief: "Worker brief: fix money parsing.", working: "Reading the parser" },
  { id: "call_dates", title: "Fix date parsing", brief: "Worker brief: fix date parsing.", working: "Reading the calendar" },
] as const
const NAMES = ["entered", "panel", "moved", "closed", "parent"] as const
type Name = (typeof NAMES)[number]
type Shot = { readonly text: ReadonlyArray<string>; readonly frame: App.Frame }

/** The composer panel's header row, its Subagents tab first. */
const isPanel = (frame: ReadonlyArray<string>) => frame.some((line) => /^\s*┃\s+Subagents(\s|$)/.test(line))
const has = (shown: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(shown)
/** A subagent's view: its title behind its parent's on the top bar. */
const inside = (frame: ReadonlyArray<string>) => (frame[0] ?? "").includes(" › ")
/** The panel row that lists `title`: under the panel's header, before the family's rows under the composer. */
const rowOf = (frame: ReadonlyArray<string>, title: string) => {
  const header = frame.findIndex((line) => /^\s*┃\s+Subagents(\s|$)/.test(line))
  if (header < 0) return -1
  return frame.findIndex((line, y) => y > header && line.includes(title))
}
/** The colour a panel row's title is drawn in: the selected row's differs from the others'. */
const titleColor = (shot: Shot, title: string) => {
  const spans = shot.frame.lines[rowOf(shot.text, title)]?.spans ?? []
  return spans.find((span) => span.text.includes(title.slice(0, 8)))?.fg ?? "none"
}

const play = (seed: number) => {
  const model: Model = ({ text: prompt, step }) => {
    if (prompt === ASK)
      return (
        [
          WORKERS.map((worker) =>
            subagent({ id: worker.id, input: { agent: "general", description: worker.title, prompt: worker.brief, background: true }, title: worker.title, agent: "general", model: MODEL_REF }),
          ),
          [text(STARTED)],
        ][step] ?? []
      )
    const worker = WORKERS.find((each) => prompt.includes(each.brief))
    if (worker && step === 0) return [text(worker.working), stall]
    return []
  }
  return App.seed(BOOT, { key: "prime-subagent-panel", seed, model, title: () => "parsing" }, (tui) =>
    Effect.gen(function* () {
      const shots = new Map<Name, Shot>()
      const save = (name: Name) => Effect.sync(() => shots.set(name, { text: tui.text(), frame: tui.frame() }))
      yield* tui.type(ASK)
      yield* tui.press({ name: "enter" })
      yield* tui.until("started", (frame) => has(STARTED)(frame) && has("2 subagents")(frame))
      // The parent's panel, its second worker entered.
      yield* tui.press({ name: "down" })
      yield* tui.until("the parent's panel", (frame) => isPanel(frame) && WORKERS.every((worker) => has(worker.title)(frame)))
      const listed = tui.text()
      const second = WORKERS.toSorted((a, b) => rowOf(listed, a.title) - rowOf(listed, b.title))[1]!
      yield* tui.press({ name: "down" })
      yield* tui.press({ name: "enter" })
      yield* tui.until("entered", (frame) => inside(frame) && has(second.working)(frame) && !isPanel(frame))
      yield* tui.advance(1_000)
      yield* save("entered")
      // Down opens the panel on the worker shown, the second row.
      yield* tui.press({ name: "down" })
      yield* tui.until("the subagent's panel", (frame) => isPanel(frame) && WORKERS.every((worker) => rowOf(frame, worker.title) >= 0))
      yield* tui.advance(500)
      yield* save("panel")
      // ↑ moves up the list.
      yield* tui.press({ name: "up" })
      yield* tui.advance(500)
      yield* save("moved")
      // ↑ at the top closes the panel.
      yield* tui.press({ name: "up" })
      yield* tui.advance(500)
      yield* save("closed")
      // ↑ on the empty prompt goes back to the parent.
      yield* tui.press({ name: "up" })
      yield* tui.until("parent", (frame) => !inside(frame) && has(ASK)(frame), 10_000)
      yield* save("parent")
      const shot = (name: Name) => shots.get(name) ?? { text: [], frame: { lines: [] } }
      const taken = { entered: shot("entered"), panel: shot("panel"), moved: shot("moved"), closed: shot("closed"), parent: shot("parent") } satisfies Record<Name, Shot>
      return { second, shots: taken }
    }),
  )
}

/** The scenario at `seed`, played once a seed (the tests read the same run). */
const played = new Map<number, Effect.Success<ReturnType<typeof play>>>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((run) => Effect.sync(() => played.set(seed, run)))),
  })

seeded("↑ in a subagent's open panel moves up its list, and the view stays", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { second, shots } = yield* scenario(seed)
    const first = WORKERS.find((worker) => worker !== second)!
    expect(inside(shots.entered.text)).toBe(true)
    expect(isPanel(shots.panel.text)).toBe(true)
    // The panel opens on the worker shown: its row is drawn apart from the other's.
    expect(titleColor(shots.panel, second.title)).not.toBe(titleColor(shots.panel, first.title))
    // After ↑ the view and the panel stay, and the selection is on the first row: drawn as the second was.
    expect(inside(shots.moved.text)).toBe(true)
    expect(has(second.working)(shots.moved.text)).toBe(true)
    expect(isPanel(shots.moved.text)).toBe(true)
    expect(titleColor(shots.moved, first.title)).toBe(titleColor(shots.panel, second.title))
    expect(titleColor(shots.moved, second.title)).toBe(titleColor(shots.panel, first.title))
  }),
)

seeded("↑ at the top of a subagent's panel closes the panel and keeps the view; ↑ again goes to the parent", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { second, shots } = yield* scenario(seed)
    expect(inside(shots.closed.text)).toBe(true)
    expect(has(second.working)(shots.closed.text)).toBe(true)
    expect(isPanel(shots.closed.text)).toBe(false)
    expect(inside(shots.parent.text)).toBe(false)
    expect(has(STARTED)(shots.parent.text)).toBe(true)
  }),
)

App.closeTest()
