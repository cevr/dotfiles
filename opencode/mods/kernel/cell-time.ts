// Time in cells (law W6): each kernel call records `CellTimed` when it ends,
// from the moment the call arrived (time queued for a slot or behind the
// session's earlier call counts as in the cell) to its answer. The `CellTime`
// view keeps the last hour of them per session and the last notice each
// session was given, so its size is bounded by the hour's cells, not by a
// session's life. `share` is the part of the hour before `now` a session spent
// inside cells; over `UNWELL_SHARE` the session is `unwell`, and a root is told
// so at most once an hour (`noticeDue`), naming its three longest cells.
import { Match, Option, Record, Schema } from "effect"
import type { Fold } from "@dotfiles/decider/decider"

export const HOUR = 60 * 60_000

/** The share of an hour in cells over which a root is flagged. */
export const UNWELL_SHARE = 0.15

/** The characters of a cell's description the view keeps. */
const DESCRIPTION_CHARS = 80

/** One cell's time: when its call arrived and answered, how much of it was waiting on calls, and whether it was cut. */
export const CellTimed = Schema.TaggedStruct("CellTimed", {
  session: Schema.String,
  startedAt: Schema.Finite,
  endedAt: Schema.Finite,
  waitedMs: Schema.Finite,
  computeMs: Schema.Finite,
  cut: Schema.Boolean,
  /** The cell's header, when the call gave one. */
  description: Schema.optionalKey(Schema.String),
})
export type CellTimed = typeof CellTimed.Type

/** The session was told its hour is over the bound. */
export const CellTimeNoticed = Schema.TaggedStruct("CellTimeNoticed", { session: Schema.String, at: Schema.Finite })
export type CellTimeNoticed = typeof CellTimeNoticed.Type

export type Event = CellTimed | CellTimeNoticed

/** A cell as the view keeps it: start, end, cut, and its description when it had one. */
export const Kept = Schema.Struct({ s: Schema.Finite, e: Schema.Finite, c: Schema.Boolean, d: Schema.optionalKey(Schema.String) })
export type Kept = typeof Kept.Type

/**
 * The view: each session's cells that end within an hour of the latest start
 * seen, and when each session was last told. The latest start is the view's
 * clock: a reading is taken at a `now` no earlier than it.
 */
export const CellTimeState = Schema.Struct({
  latest: Schema.Finite,
  sessions: Schema.Record(Schema.String, Schema.Array(Kept)),
  noticed: Schema.Record(Schema.String, Schema.Finite),
})
export type CellTimeState = typeof CellTimeState.Type

/** The state with what ended more than an hour before `latest` forgotten. */
const forget = (state: CellTimeState): CellTimeState => {
  const horizon = state.latest - HOUR
  return {
    latest: state.latest,
    sessions: Record.filter(
      Record.map(state.sessions, (cells) => cells.filter((cell) => cell.e >= horizon)),
      (kept) => kept.length > 0,
    ),
    noticed: Record.filter(state.noticed, (at) => at >= horizon),
  }
}

/** A cell as the view keeps it: its description only when it had one, cut to `DESCRIPTION_CHARS`. */
const keptOf = (event: CellTimed): Kept => {
  const cell = { s: event.startedAt, e: Math.max(event.startedAt, event.endedAt), c: event.cut }
  return Option.match(
    Option.filter(Option.fromUndefinedOr(event.description), (description) => description !== ""),
    { onNone: () => cell, onSome: (description) => ({ ...cell, d: description.slice(0, DESCRIPTION_CHARS) }) },
  )
}

const evolveFrom = (state: CellTimeState) =>
  Match.type<Event>().pipe(
    Match.tagsExhaustive({
      CellTimed: (event) => {
        const cells = [...(state.sessions[event.session] ?? []), keptOf(event)]
        return forget({ ...state, latest: Math.max(state.latest, event.startedAt), sessions: { ...state.sessions, [event.session]: cells } })
      },
      CellTimeNoticed: (event) =>
        forget({ ...state, noticed: { ...state.noticed, [event.session]: Math.max(state.noticed[event.session] ?? 0, event.at) } }),
    }),
  )

export const CellTime: Fold<CellTimeState, Event> = {
  initial: { latest: 0, sessions: {}, noticed: {} },
  evolve: (state, event) => evolveFrom(state)(event),
}

/** The session's cells that overlap the hour before `now`, each with its part inside the hour. */
const inHour = (state: CellTimeState, session: string, now: number) =>
  (state.sessions[session] ?? []).flatMap((cell) => {
    const from = Math.max(cell.s, now - HOUR)
    const to = Math.min(cell.e, now)
    // A cell of no length that started inside the hour still counts as a cell.
    if (to > from || (cell.s >= now - HOUR && cell.s <= now)) return [{ cell, from, to: Math.max(from, to) }]
    return []
  })

/** The fraction of the hour before `now` the session spent inside cells, overlapping calls counted once. In [0, 1]. */
export const share = (state: CellTimeState, session: string, now: number): number => {
  const spans = inHour(state, session, now).sort((a, b) => a.from - b.from)
  let covered = 0
  let reach = now - HOUR
  for (const span of spans) {
    const from = Math.max(span.from, reach)
    if (span.to > from) {
      covered += span.to - from
      reach = span.to
    }
  }
  return Math.min(1, Math.max(0, covered / HOUR))
}

/** A cell named in a reading: its description (or none given) and how long it took. */
export interface Longest {
  readonly description: string
  readonly ms: number
}

/** A session's hour: the share in cells, how many cells and cuts it holds, and its three longest cells. */
export interface Reading {
  readonly share: number
  readonly cells: number
  readonly cut: number
  readonly longest: ReadonlyArray<Longest>
}

/** The description a cell with none is named by. */
export const UNNAMED = "(no description)"

export const reading = (state: CellTimeState, session: string, now: number): Reading => {
  const spans = inHour(state, session, now)
  return {
    share: share(state, session, now),
    cells: spans.length,
    cut: spans.filter((span) => span.cell.c).length,
    longest: spans
      .map((span) => ({ description: span.cell.d ?? UNNAMED, ms: span.cell.e - span.cell.s }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3),
  }
}

/** The session's reading when its share of the hour is over `UNWELL_SHARE`, else none. */
export const unwell = (state: CellTimeState, session: string, now: number): Option.Option<Reading> =>
  Option.liftPredicate(reading(state, session, now), (read) => read.share > UNWELL_SHARE)

/** The reading to tell the session now: unwell, and not told in the last hour. */
export const noticeDue = (state: CellTimeState, session: string, now: number): Option.Option<Reading> =>
  Option.filter(unwell(state, session, now), () =>
    Option.match(Record.get(state.noticed, session), { onNone: () => true, onSome: (told) => now - told >= HOUR }),
  )

const counted = (count: number, noun: string) => {
  if (count === 1) return `1 ${noun}`
  return `${count} ${noun}s`
}

/** `cells 4% of the last hour · 31 cells · 2 cut`. */
export const line = (read: Pick<Reading, "share" | "cells" | "cut">): string =>
  `cells ${Math.round(read.share * 100)}% of the last hour · ${counted(read.cells, "cell")} · ${read.cut} cut`

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`

/** The notice a root gets, at most once an hour, when its cells are over the bound. */
export const noticeText = (read: Reading): string =>
  [
    `[${line(read)}: over the ${Math.round(UNWELL_SHARE * 100)}% bound. While a cell runs, your turn is held and nothing else of yours moves.`,
    `The longest: ${read.longest.map((cell) => `"${cell.description}" ${seconds(cell.ms)}`).join(", ")}.`,
    "Start a long wait in the background (a background shell, a monitor or a background subagent) and let it wake you.]",
  ].join(" ")

export const NOTICE_DESCRIPTION = "Cells over the hour's bound"

// ── The RPC ──

/** What `time` answers per session asked: its reading, its line, and whether it is over the bound. */
export const SessionTime = Schema.Struct({
  sessionID: Schema.String,
  share: Schema.Finite,
  cells: Schema.Finite,
  cut: Schema.Finite,
  longest: Schema.Array(Schema.Struct({ description: Schema.String, ms: Schema.Finite })),
  unwell: Schema.Boolean,
  line: Schema.String,
})
export type SessionTime = typeof SessionTime.Type

export const TimeAnswer = Schema.Struct({ times: Schema.Array(SessionTime) })
export type TimeAnswer = typeof TimeAnswer.Type

export const TimeInput = Schema.Struct({ sessionIDs: Schema.Array(Schema.String) })

/** Each asked session's hour, as `time` answers it. */
export const answerOf = (state: CellTimeState, sessionIDs: ReadonlyArray<string>, now: number): TimeAnswer => ({
  times: sessionIDs.map((sessionID) => {
    const read = reading(state, sessionID, now)
    return { sessionID, ...read, unwell: read.share > UNWELL_SHARE, line: line(read) }
  }),
})

/**
 * The kernel's time RPC, which the status pane and orchestrate status call.
 * `time({ sessionIDs })`: each session's hour in cells (`TimeAnswer`).
 */
export const KERNEL_TIME = {
  id: "dotfiles-opencode.kernel.time",
  methods: {
    time: {
      input: { type: "object", properties: { sessionIDs: { type: "array", items: { type: "string" } } }, required: ["sessionIDs"] },
      output: { type: "object" },
    },
  },
  events: {},
} as const
