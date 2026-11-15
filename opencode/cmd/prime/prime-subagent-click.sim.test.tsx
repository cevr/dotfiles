// The ways back and across in a subagent's view are pressable, in the Prime
// look, on the simulated TUI (sim-tui/): the fork's real TUI with Prime and
// the escape plugin loaded by path, in front of the server double. Two workers
// run, the money worker with a subagent of its own. In that grandchild a click
// on the top bar's parent segment goes to its direct parent, the money worker;
// there a click on the dock's → moves to another subagent and ← back, as the
// keys do, and a click on the dock's way back goes to the session. Entered
// again, the dates worker's top bar parent segment goes back to the session
// too. The pointer over the way back brightens it, in place.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import { MODEL_REF, type Model, stall, subagent, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-subagent-click.sim.test.tsx"
/** Seeds this file runs: sim-tui's measured headroom rule (a file keeps half its 5 s of CPU). */
const SEEDS = 2
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime", "cmd/escape"], width: 106, height: 40 }

App.bootTest(BOOT)

const ASK = "Fix the money parsing and the dates in two workers."
const STARTED = "Both workers are on it."
const MONEY = { id: "call_money", title: "Fix money parsing", brief: "Worker brief: fix money parsing.", working: "Reading the parser" }
const DATES = { id: "call_dates", title: "Fix date parsing", brief: "Worker brief: fix date parsing.", working: "Reading the calendar" }
const CENTS = { id: "call_cents", title: "Check the cents", brief: "Worker brief: check the cents.", working: "Counting cents" }
const BACK = "↑ back to parent"
const NAMES = ["grandchild", "grandchild-up", "next", "previous", "hover", "parent", "dates", "dates-up"] as const
type Name = (typeof NAMES)[number]
type Shot = { readonly text: ReadonlyArray<string>; readonly frame: App.Frame }

/** The composer panel's header row, its Subagents tab first. */
const PANEL = /^\s*┃\s+Subagents(\s|$)/
const isPanel = (frame: ReadonlyArray<string>) => frame.some((line) => PANEL.test(line))
const has = (shown: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(shown)
/** A subagent's view: its title behind its parent's on the top bar. */
const inside = (frame: ReadonlyArray<string>) => (frame[0] ?? "").includes(" › ")
/** The subagent whose view this is: the top bar ends its breadcrumb with its title. */
const viewing = (title: string) => (frame: ReadonlyArray<string>) => (frame[0] ?? "").includes(`› ${title}`)
/** The panel rows under its header that list a worker, top to bottom. */
const listed = (frame: ReadonlyArray<string>) => {
  const header = frame.findIndex((line) => PANEL.test(line))
  return [MONEY, DATES, CENTS].map((worker) => ({ worker, row: frame.findIndex((line, y) => header >= 0 && y > header && line.includes(worker.title)) }))
}
/** The cell `shown` starts at on the first row holding it, counted in characters (every glyph here takes one cell). */
const cellOf = (frame: ReadonlyArray<string>, shown: string) => {
  const y = frame.findIndex((line) => line.includes(shown))
  const line = frame[y] ?? ""
  return { x: Array.from(line.slice(0, line.indexOf(shown))).length, y }
}
/** The colour the way back is drawn in. */
const backColor = (shot: Shot) => {
  const { y } = cellOf(shot.text, BACK)
  return (shot.frame.lines[y]?.spans ?? []).find((span) => span.text.includes("back to parent"))?.fg ?? "none"
}

const play = (seed: number) => {
  const model: Model = ({ text: prompt, step }) => {
    const call = (worker: typeof MONEY) =>
      subagent({ id: worker.id, input: { agent: "general", description: worker.title, prompt: worker.brief, background: true }, title: worker.title, agent: "general", model: MODEL_REF })
    if (prompt === ASK) return [[call(MONEY), call(DATES)], [text(STARTED)]][step] ?? []
    // The money worker starts a subagent of its own before it settles in.
    if (prompt.includes(MONEY.brief)) return [[call(CENTS)], [text(MONEY.working), stall]][step] ?? []
    const worker = [DATES, CENTS].find((each) => prompt.includes(each.brief))
    if (worker && step === 0) return [text(worker.working), stall]
    return []
  }
  return App.seed(BOOT, { key: "prime-subagent-click", seed, model, title: () => "parsing" }, (tui) =>
    Effect.gen(function* () {
      const shots = new Map<Name, Shot>()
      const save = (name: Name) => Effect.sync(() => shots.set(name, { text: tui.text(), frame: tui.frame() }))
      const click = (at: { readonly x: number; readonly y: number }) =>
        Effect.gen(function* () {
          yield* tui.mouse({ action: "move", ...at })
          yield* tui.mouse({ action: "down", ...at })
          yield* tui.mouse({ action: "up", ...at })
        })
      /** Enters `worker` from the session's panel: Down opens it on its first row, Down again moves a row. */
      const enter = (worker: typeof MONEY) =>
        Effect.gen(function* () {
          yield* tui.press({ name: "down" })
          yield* tui.until("the session's panel", (frame) => isPanel(frame) && listed(frame).every((each) => each.row >= 0))
          const rows = listed(tui.text()).toSorted((a, b) => a.row - b.row)
          const at = rows.findIndex((each) => each.worker === worker)
          for (let step = 0; step < at; step++) yield* tui.press({ name: "down" })
          yield* tui.press({ name: "enter" })
          yield* tui.until(`in ${worker.title}`, (frame) => viewing(worker.title)(frame) && has(worker.working)(frame) && !isPanel(frame), 10_000)
          yield* tui.advance(1_000)
        })
      /** A click on the top bar's parent segment: the cell right before its ` › `. */
      const parentSegment = () => {
        const at = cellOf(tui.text().slice(0, 1), " › ")
        return { x: at.x - 1, y: 0 }
      }
      yield* tui.type(ASK)
      yield* tui.press({ name: "enter" })
      yield* tui.until("started", (frame) => has(STARTED)(frame) && has("3 subagents")(frame), 10_000)
      // In the grandchild, the parent segment goes to its direct parent, the money worker.
      yield* enter(CENTS)
      yield* save("grandchild")
      yield* click(parentSegment())
      yield* tui.until("up to money", (frame) => viewing(MONEY.title)(frame) && has(MONEY.working)(frame), 10_000)
      yield* tui.advance(1_000)
      yield* save("grandchild-up")
      // → moves to another subagent, ← back.
      yield* click({ ...cellOf(tui.text(), "←/→"), x: cellOf(tui.text(), "←/→").x + 2 })
      yield* tui.until("next", (frame) => inside(frame) && !viewing(MONEY.title)(frame), 10_000)
      yield* tui.advance(1_000)
      yield* save("next")
      yield* click(cellOf(tui.text(), "←/→"))
      yield* tui.until("previous", viewing(MONEY.title), 10_000)
      yield* tui.advance(1_000)
      yield* save("previous")
      // The pointer over the way back brightens it; a click goes to the session.
      const back = cellOf(tui.text(), BACK)
      yield* tui.mouse({ action: "move", x: back.x + 3, y: back.y })
      yield* tui.advance(200)
      yield* save("hover")
      yield* click({ x: back.x + 3, y: back.y })
      yield* tui.until("parent", (frame) => !inside(frame) && has(ASK)(frame), 10_000)
      yield* tui.advance(1_000)
      yield* save("parent")
      // From the dates worker, the parent segment goes to the session.
      yield* enter(DATES)
      yield* save("dates")
      yield* click(parentSegment())
      yield* tui.until("dates up", (frame) => !inside(frame) && has(ASK)(frame), 10_000)
      yield* save("dates-up")
      const shot = (name: Name): Shot => shots.get(name) ?? { text: [], frame: { lines: [] } }
      return {
        grandchild: shot("grandchild"),
        "grandchild-up": shot("grandchild-up"),
        next: shot("next"),
        previous: shot("previous"),
        hover: shot("hover"),
        parent: shot("parent"),
        dates: shot("dates"),
        "dates-up": shot("dates-up"),
      } satisfies Record<Name, Shot>
    }),
  )
}

/** The scenario at `seed`, played once a seed (the tests read the same run). */
const played = new Map<number, Record<Name, Shot>>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((run) => Effect.sync(() => played.set(seed, run)))),
  })

seeded("a click on the top bar's parent segment goes to the direct parent: a grandchild to its subagent, a subagent to the session", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shots = yield* scenario(seed)
    expect(shots.grandchild.text[0]).toContain(`${MONEY.title} › ${CENTS.title}`)
    expect(viewing(MONEY.title)(shots["grandchild-up"].text)).toBe(true)
    expect(has(MONEY.working)(shots["grandchild-up"].text)).toBe(true)
    expect(viewing(DATES.title)(shots.dates.text)).toBe(true)
    expect(inside(shots["dates-up"].text)).toBe(false)
    expect(has(STARTED)(shots["dates-up"].text)).toBe(true)
  }),
)

seeded("a click on → in the dock moves to another running subagent, and ← back, as the keys do", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shots = yield* scenario(seed)
    const next = shots.next.text
    expect(inside(next)).toBe(true)
    expect(viewing(MONEY.title)(next)).toBe(false)
    expect([DATES, CENTS].some((worker) => viewing(worker.title)(next) && has(worker.working)(next))).toBe(true)
    expect(viewing(MONEY.title)(shots.previous.text)).toBe(true)
  }),
)

seeded("a click on the dock's way back goes to the session, the pointer over it brightening it in place", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shots = yield* scenario(seed)
    expect(backColor(shots.hover)).not.toBe(backColor(shots.previous))
    expect(cellOf(shots.hover.text, BACK)).toEqual(cellOf(shots.previous.text, BACK))
    expect(inside(shots.parent.text)).toBe(false)
    expect(has(STARTED)(shots.parent.text)).toBe(true)
    expect(has(BACK)(shots.parent.text)).toBe(false)
  }),
)

App.closeTest()
