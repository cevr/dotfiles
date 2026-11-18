// What the Queue tab draws: the queue as a plan, a plain-text state machine.
// Each item is a block: its mark, its text, the state it is in (a linked
// subagent's live one), whose it is; then the items it waits on other than
// the one it is drawn under (`after …`) and what follows each of its outcomes
// (`on accepted ⇥ …`). An item that waits on another (`after`), or that is
// what follows one of another's outcomes (`on`), nests under it, behind a
// guide; the rest stand at the left in the board's order (needs-you, running,
// waiting, scheduled, next, done). Every item is drawn once, cycles too. Pure;
// the TUI supplies the live states and the time.
import { Array as Arr, Match, Option } from "effect"
import { board, GLYPHS, type Live, LINGER_MS, type Mark, type Row } from "./board.ts"
import type { Item } from "./item.ts"

/** The state a block names after its text. */
export const WORDS: Readonly<Record<Mark, string>> = {
  "needs-you": "needs you",
  blocked: "blocked",
  running: "running",
  waiting: "waiting",
  scheduled: "scheduled",
  next: "next",
  done: "done",
  failed: "failed",
}

/** Where an outcome leads, or what an item waits on: an item on the board (with its mark), or the words the agent wrote. */
export interface Target {
  readonly text: string
  readonly mark: Option.Option<Mark>
}

/** An item's own line: its board row, and the subagent session it is linked to. */
export interface ItemLine {
  readonly kind: "item"
  readonly key: string
  readonly depth: number
  readonly row: Row
  readonly session: Option.Option<string>
}

/** What an item waits on besides the item it is drawn under. */
export interface AfterLine {
  readonly kind: "after"
  readonly key: string
  readonly depth: number
  readonly waits: ReadonlyArray<Target>
}

/** One outcome of an item and what follows it; `pad` lines the item's outcomes up. */
export interface OutcomeLine {
  readonly kind: "outcome"
  readonly key: string
  readonly depth: number
  readonly outcome: string
  readonly pad: number
  readonly target: Target
}

/** One line of the plan. `depth` is how far it nests; `key` is its item's id. */
export type PlanLine = ItemLine | AfterLine | OutcomeLine

/** How a part of a line is coloured. */
export type Tone = "guide" | "label" | "arrow" | "text" | "muted" | "faint" | Mark

export interface Segment {
  readonly text: string
  readonly tone: Tone
}

const words = (text: string): Target => ({ text, mark: Option.none() })

/**
 * The plan of `items` at `now`, given each linked subagent session's live
 * state (`live`, by session id). Done items drop off as the board's do; an
 * item whose parent dropped stands at the left.
 */
export const plan = (items: ReadonlyArray<Item>, live: ReadonlyMap<string, Live>, now: number, linger = LINGER_MS): ReadonlyArray<PlanLine> => {
  const rows = board(items, live, now, linger)
  const byId = new Map(items.map((item) => [item.id, item]))
  const shown = new Map(rows.map((row) => [row.key, row]))
  const after = (key: string): ReadonlyArray<string> => Option.getOrElse(Option.fromNullishOr(byId.get(key)?.after), Arr.empty)
  const outcomes = (key: string): ReadonlyArray<readonly [string, string]> => Object.entries(Option.getOrElse(Option.fromNullishOr(byId.get(key)?.on), () => ({})))
  const target = (id: string): Target =>
    Option.match(Option.fromNullishOr(shown.get(id)), { onNone: () => words(id), onSome: (row) => ({ text: row.text, mark: Option.some(row.mark) }) })
  // An item's parent: the first item it waits on that is shown, else the first shown item one of whose outcomes leads to it.
  const parentOf = (row: Row): Option.Option<string> =>
    Option.orElse(Arr.findFirst(after(row.key), (id) => id !== row.key && shown.has(id)), () =>
      Option.map(
        Arr.findFirst(rows, (other) => other.key !== row.key && outcomes(other.key).some(([, next]) => next === row.key)),
        (other) => other.key,
      ),
    )
  const parents = new Map(rows.map((row) => [row.key, parentOf(row)]))
  const children = (key: string) => rows.filter((row) => Option.contains(Option.flatten(Option.fromNullishOr(parents.get(row.key))), key))

  const lines: Array<PlanLine> = []
  const drawn = new Set<string>()
  // `under` is the item it is drawn under, which its `after …` line need not name again.
  const draw = (row: Row, depth: number, under: Option.Option<string>): void => {
    if (drawn.has(row.key)) return
    drawn.add(row.key)
    lines.push({ kind: "item", key: row.key, depth, row, session: Option.fromNullishOr(byId.get(row.key)?.session) })
    const waits = after(row.key).filter((id) => !Option.contains(under, id))
    if (waits.length > 0) lines.push({ kind: "after", key: row.key, depth, waits: waits.map(target) })
    const own = outcomes(row.key)
    const pad = Math.max(0, ...own.map(([outcome]) => [...outcome].length))
    for (const [outcome, next] of own) lines.push({ kind: "outcome", key: row.key, depth, outcome, pad, target: target(next) })
    for (const child of children(row.key)) draw(child, depth + 1, Option.some(row.key))
  }
  for (const row of rows) if (Option.isNone(Option.flatten(Option.fromNullishOr(parents.get(row.key))))) draw(row, 0, Option.none())
  // What a cycle keeps from the left: its first item in the board's order stands there.
  for (const row of rows) draw(row, 0, Option.none())
  return lines
}

/** Between two things an item waits on. */
const COMMA: ReadonlyArray<Segment> = [{ text: ", ", tone: "faint" }]

/** The guide in front of a line at `depth`: a bar per level it nests. */
const guide = (depth: number): Segment => ({ text: "│ ".repeat(depth), tone: "guide" })

const targetSegments = (target: Target): ReadonlyArray<Segment> =>
  Option.match(target.mark, {
    onNone: () => [{ text: target.text, tone: "text" }],
    onSome: (mark) => [
      { text: `${GLYPHS[mark]} `, tone: mark },
      { text: target.text, tone: "text" },
    ],
  })

/** Text that is there, as a segment in `tone` between `before` and `after`. */
const optional = (text: Option.Option<string>, tone: Tone, before = "", after = ""): ReadonlyArray<Segment> =>
  Option.match(text, { onNone: Arr.empty, onSome: (shown) => [{ text: `${before}${shown}${after}`, tone }] })

/**
 * A line of the plan as coloured parts:
 * `● Money parsing r1 · running · wC:p6`, `  after ○ Plan`, `  on accepted ⇥ ○ Land`.
 */
export const segments = (line: PlanLine): ReadonlyArray<Segment> =>
  Match.value(line).pipe(
    Match.discriminatorsExhaustive("kind")({
      item: ({ row, depth }): ReadonlyArray<Segment> => [
        guide(depth),
        { text: `${GLYPHS[row.mark]} `, tone: row.mark },
        ...optional(Option.fromNullishOr(row.time), "muted", "", " "),
        { text: row.text, tone: "text" },
        { text: ` · ${WORDS[row.mark]}`, tone: row.mark },
        ...optional(Option.fromNullishOr(row.detail), "muted", " · "),
        ...optional(Option.fromNullishOr(row.who), "muted", " · "),
        ...optional(Option.fromNullishOr(row.answered), "muted", " · answered: "),
      ],
      after: ({ waits, depth }): ReadonlyArray<Segment> => [
        guide(depth),
        { text: "  after ", tone: "label" },
        ...Arr.intersperse(waits.map(targetSegments), COMMA).flat(),
      ],
      outcome: ({ outcome, pad, target, depth }): ReadonlyArray<Segment> => [
        guide(depth),
        { text: "  on ", tone: "label" },
        { text: outcome.padEnd(pad), tone: "text" },
        { text: " ⇥ ", tone: "arrow" },
        ...targetSegments(target),
      ],
    }),
  )

/** A line of the plan as plain text. */
export const planText = (line: PlanLine): string =>
  segments(line)
    .map((segment) => segment.text)
    .join("")

/** What the bar under the composer counts: the items not done, and how many of those need the owner. */
export interface Tally {
  readonly open: number
  readonly needsYou: number
}

export const tally = (rows: ReadonlyArray<Row>): Tally => ({
  open: rows.filter((row) => row.group !== "done").length,
  needsYou: rows.filter((row) => row.group === "needs-you").length,
})
