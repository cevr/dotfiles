// The transcript map (ctrl+x g) on a long session, with Prime loaded. Two
// hundred asks were queued at once, so each keeps the id it was given when
// queued, older than the answers before it (as a notice queued long before it
// arrives does on a real session). Eight pages up, the map opens on the turns
// that were on screen: the turn at the transcript's top is the one selected
// and keeps its line, Esc shows the transcript as it was, and Enter unfolds a
// turn with its start on its collapsed row's line. The wheel scrolls the map
// as far as it scrolls the transcript, the selection riding with its row, and
// a click on a prompt unfolds the transcript there.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import { type Model, ranShell, reasoning, stall, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-map-long.sim.test.tsx"
/** Seeds this file runs: one seed plays two hundred turns, about half a file's CPU budget. */
const SEEDS = 1
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 100, height: 30 }

App.bootTest(BOOT)

const TURNS = 200
// The transcript's first row, under the one-row top bar (Prime pins the top turn's ask over it).
const FIRST = 1
// The line the wheel turns over (the row under it is lit as the mouse is over it).
const POINTER = 12
const name = (turn: number) => `n${String(turn).padStart(3, "0")}`
const ask = (turn: number) => `Ask ${name(turn)}`

/** Each ask: a thought and a shell call, then a two-sentence answer and a short list; every line names its turn. */
const model: Model = ({ text: prompt, step }) => {
  const turn = /n\d{3}/.exec(prompt)?.[0] ?? name(0)
  // The first answer holds until the test releases it, so the asks after it wait in the queue meanwhile.
  const steps = [
    [reasoning(`Weighing ${turn}`), ranShell({ id: `call_${turn}`, command: `echo ${turn}`, output: turn })],
    [[text(answer(turn)), stall][Number(turn === name(0))] ?? stall],
  ]
  return steps[step] ?? []
}
const answer = (turn: string) => `Answer ${turn} is ready. Here is the list.\n\n${[1, 2, 3].map((item) => `- ${turn} item ${item}`).join("\n")}`

/**
 * The map's selected line: the one turn row on a background no other row of its kind (an ask, an answer) has; -1 for
 * none. The row on line `hovered`, under the mouse, is lit too, so it is left out.
 */
const selectedLine = (frame: App.Frame, hovered = -1) => {
  const rows = frame.lines.flatMap((line, index) =>
    line.spans
      .filter((each) => index !== hovered && /Ask n\d{3}|Answer n\d{3}/.test(each.text))
      .slice(0, 1)
      .map((span) => ({ index, kind: span.text.includes("Ask"), bg: span.bg })),
  )
  const unique = rows.filter((row) => rows.filter((other) => other.kind === row.kind && other.bg === row.bg).length === 1)
  return [-1, unique[0]?.index ?? -1][Number(unique.length === 1)] ?? -1
}

type Frames = Record<"expanded" | "collapsed" | "restored" | "unfolded", ReadonlyArray<string>> & {
  /** The selected line when the map opened. */
  readonly selected: number
  /** The line of the prompt Enter unfolded, in the map, and its ask. */
  readonly picked: { readonly line: number; readonly ask: string }
  /** How many of the session's messages have an id older than the message before them. */
  readonly unordered: number
  /** Lines one wheel step moves the transcript, two move the map, and the map's selected line before and after. */
  readonly wheel: { readonly transcriptStep: number; readonly foldedStep: number; readonly foldedSelected: number; readonly scrolledSelected: number }
  /** The prompt a click unfolded: its line in the map, its ask, and the transcript after. */
  readonly clicked: { readonly line: number; readonly ask: string; readonly after: ReadonlyArray<string> }
}

/** How many lines down the screen moved from `before` to `after`, read off the first answer line both show (0 for none). */
const moved = (before: ReadonlyArray<string>, after: ReadonlyArray<string>) => {
  const from = before.findIndex((row, index) => index > FIRST && /Answer n\d{3}/.test(row) && after.includes(row))
  return [after.indexOf(before[from] ?? "") - from, 0][Number(from === -1)] ?? 0
}

const played = new Map<number, Frames>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((frames) => Effect.sync(() => played.set(seed, frames)))),
  })

const isMap = (shown: ReadonlyArray<string>) => shown.join("\n").includes("· + 1 thought, 1 tool")
const play = (seed: number) =>
  App.seed(BOOT, { key: "prime-map-long", seed, model, title: () => "two hundred asks" }, (tui) =>
    Effect.gen(function* () {
      // Queued at once, while the first answer holds: each ask is delivered when the run before it ends, under the
      // id it was queued with, older than every answer but the first.
      for (let turn = 0; turn < TURNS; turn++) tui.server.enqueue(tui.sessionID, ask(turn), "queue")
      yield* tui.advance(200)
      tui.server.release(tui.sessionID, answer(name(0)))
      const last = name(TURNS - 1)
      yield* tui.until("every answer", (shown) => shown.join("\n").includes(`${last} item 3`) && !tui.server.running(tui.sessionID), 60_000)
      yield* tui.advance(500)
      const ids = tui.server.messages(tui.sessionID).map((message) => message.id)
      const unordered = ids.filter((id, index) => index > 0 && id < (ids[index - 1] ?? "")).length
      for (let page = 0; page < 8; page++) {
        yield* tui.press({ name: "\x1b[5~" }) // PgUp
        yield* tui.advance(200)
      }
      yield* tui.advance(300)
      const expanded = tui.text()
      const open = Effect.gen(function* () {
        yield* tui.press({ name: "x", ctrl: true })
        yield* tui.press({ name: "g" })
        yield* tui.until("the map", isMap)
        yield* tui.advance(300)
      })
      yield* open
      const collapsed = tui.text()
      const selected = selectedLine(tui.frame())
      yield* tui.press({ name: "escape" })
      yield* tui.until("the transcript again", (shown) => !isMap(shown))
      yield* tui.advance(300)
      const restored = tui.text()
      // Again, then down to the next prompt, and Enter.
      yield* open
      for (let step = 0; step < 3; step++) {
        yield* tui.press({ name: "j" })
        yield* tui.advance(100)
        if (/┃ Ask/.test(tui.text()[selectedLine(tui.frame())] ?? "")) break
      }
      const line = selectedLine(tui.frame())
      const picked = { line, ask: /Ask n\d{3}/.exec(tui.text()[line] ?? "")?.[0] ?? "" }
      yield* tui.press({ name: "enter" })
      yield* tui.until("unfolded", (shown) => !isMap(shown))
      yield* tui.advance(500)
      const unfolded = tui.text()

      // The transcript's wheel step, read off a line that stays on screen across it.
      const wheel = Effect.gen(function* () {
        yield* tui.mouse({ action: "scroll", x: 40, y: POINTER, direction: "up" })
        yield* tui.advance(150)
      })
      const before = tui.text()
      yield* wheel
      const transcriptStep = moved(before, tui.text())
      // Folded, the wheel moves the rows as far, and the selection rides with its row: none moves to the line.
      yield* open
      const folded = tui.text()
      const foldedSelected = selectedLine(tui.frame(), POINTER)
      yield* wheel
      yield* wheel
      const scrolled = tui.text()
      const scrolledSelected = selectedLine(tui.frame(), POINTER)
      const foldedStep = moved(folded, scrolled)
      // A click on a prompt unfolds the transcript there, its rail on the line the row was on.
      const row = scrolled.findIndex((row, index) => index > FIRST + 2 && /┃ Ask n\d{3}/.test(row))
      const clicked = { line: row, ask: /Ask n\d{3}/.exec(scrolled[row] ?? "")?.[0] ?? "" }
      yield* tui.mouse({ action: "move", x: 20, y: row })
      yield* tui.mouse({ action: "down", x: 20, y: row })
      yield* tui.mouse({ action: "up", x: 20, y: row })
      yield* tui.until("unfolded by a click", (shown) => !isMap(shown))
      yield* tui.advance(500)
      return {
        expanded,
        collapsed,
        restored,
        unfolded,
        selected,
        picked,
        unordered,
        wheel: { transcriptStep, foldedStep, foldedSelected, scrolledSelected },
        clicked: { ...clicked, after: tui.text() },
      } satisfies Frames
    }),
  )

/** The turn a transcript line shows, by the name every line of it carries ("" for none), and whether it is the prompt. */
const turnOf = (row: string) => ({ name: /n\d{3}/.exec(row)?.[0] ?? "", prompt: /┃ Ask/.test(row) })

seeded("eight pages up a long session, the map opens on the turns that were on screen, the top one selected on its line", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    // The asks arrived after the answers before them, with older ids.
    expect(frames.unordered).toBeGreaterThan(TURNS / 2)
    // Well up from the end: the last turns are off screen.
    expect(frames.expanded.slice(FIRST + 1, -6).join("\n")).not.toContain(name(TURNS - 1))
    // The transcript's first line under the pin that shows a turn, and the turn: folded, that turn holds that line
    // and is the one selected (or, when the pinned line held the turn's first row, it holds the pinned line).
    // (A run's folded work line names no turn; the run's next line does.)
    const top = frames.expanded.findIndex((row, index) => index > FIRST && row.trim() !== "")
    const shown = turnOf(frames.expanded.find((row, index) => index >= top && turnOf(row).name !== "") ?? "")
    expect(shown.name).not.toBe("")
    expect([FIRST, top]).toContain(frames.selected)
    const opened = turnOf(frames.collapsed[frames.selected] ?? "")
    if (frames.selected === top) expect(opened).toEqual(shown)
    else expect([shown.name, name(Number(shown.name.slice(1)) - 1)]).toContain(opened.name)
    // Every ask that was on screen is on screen still, folded.
    const asks = new Set(frames.expanded.slice(FIRST + 1).flatMap((row) => /┃ Ask n\d{3}/.exec(row)?.[0] ?? []))
    expect(asks.size).toBeGreaterThan(1)
    for (const each of asks) expect(frames.collapsed.join("\n")).toContain(each)
    // Esc: the transcript exactly as it was.
    expect(frames.restored).toEqual(frames.expanded)
  }),
)

seeded("Enter on a prompt below the opening turn unfolds it with its start on its collapsed row's line", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    expect(frames.picked.line).toBeGreaterThan(frames.selected)
    expect(frames.picked.ask).not.toBe("")
    expect(frames.unfolded[frames.picked.line]).toContain(`┃ ${frames.picked.ask}`)
  }),
)

seeded("the wheel scrolls the folded transcript as it scrolls the transcript, moving no selection; a click unfolds a turn", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { wheel, clicked } = yield* scenario(seed)
    expect(wheel.transcriptStep).toBeGreaterThan(0)
    expect(wheel.foldedStep).toBe(wheel.transcriptStep * 2)
    expect(wheel.scrolledSelected).toBe(wheel.foldedSelected + wheel.foldedStep)
    expect(clicked.ask).not.toBe("")
    expect(clicked.after[clicked.line]).toContain(`┃ ${clicked.ask}`)
  }),
)

App.closeTest()
