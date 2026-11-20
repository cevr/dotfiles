// The digest's fold: the events of every log line into one state, with no model call and no clock. A fact is kept
// under its key, the newest by (time, line) winning, so the state is the same whatever order the lines arrive in,
// and a line read twice (a replica, a restart's re-read) changes nothing. `fold(fold(s, a), b)` is `fold(s, a ++ b)`.
// The page (view.ts) is a pure function of this state, the read marks and the time.
import { Match, Option, Predicate } from "effect"
import { type DigestEvent, encodeLine } from "./event.ts"

type Of<Tag extends DigestEvent["_tag"]> = Extract<DigestEvent, { readonly _tag: Tag }>
export type Run = Of<"Run">
export type Lane = Of<"Lane">
export type Start = Of<"Start">
export type HandBack = Of<"HandBack">
export type Verdict = Of<"Verdict">
export type Land = Of<"Land">
export type Check = Of<"Check">
export type Item = Of<"Item">
export type ItemGone = Of<"ItemGone">
export type Asked = Of<"Asked">
export type Answered = Of<"Answered">
export type Closed = Of<"Closed">
export type Install = Of<"Install">
export type Dropped = Of<"Dropped">

/** Every fact the log holds, each under its key, the newest kept. */
export interface State {
  /** A run's record, by its root session. */
  readonly runs: ReadonlyMap<string, Run>
  /** A unit's lane, by root and unit. */
  readonly lanes: ReadonlyMap<string, Lane>
  /** A step's start, by root, role, unit and round. */
  readonly starts: ReadonlyMap<string, Start>
  /** A step's hand-back, by root, role, unit and round. */
  readonly handBacks: ReadonlyMap<string, HandBack>
  /** A verifier's verdict, by root, batch and round. */
  readonly verdicts: ReadonlyMap<string, Verdict>
  /** Each land, by its line. */
  readonly lands: ReadonlyMap<string, Land>
  /** Each land check, by its line. */
  readonly checks: ReadonlyMap<string, Check>
  /** A queue item as it now stands, or its removal, by root and id. */
  readonly items: ReadonlyMap<string, Item | ItemGone>
  /** When a queue item was first written, by root and id. */
  readonly itemsSince: ReadonlyMap<string, number>
  /** A question, by asking session and id: as asked, as answered, as closed. */
  readonly asked: ReadonlyMap<string, Asked>
  readonly answered: ReadonlyMap<string, Answered>
  readonly closed: ReadonlyMap<string, Closed>
  /** Each install's outcome, by its line. */
  readonly installs: ReadonlyMap<string, Install>
  /** Each count of lines a writer dropped, by its line. */
  readonly dropped: ReadonlyMap<string, Dropped>
}

export const EMPTY: State = {
  runs: new Map(),
  lanes: new Map(),
  starts: new Map(),
  handBacks: new Map(),
  verdicts: new Map(),
  lands: new Map(),
  checks: new Map(),
  items: new Map(),
  itemsSince: new Map(),
  asked: new Map(),
  answered: new Map(),
  closed: new Map(),
  installs: new Map(),
  dropped: new Map(),
}

/** Whether an event is a step's start or hand-back. */
export const isStep = (event: DigestEvent): event is Start | HandBack => Predicate.isTagged(event, "Start") || Predicate.isTagged(event, "HandBack")

/** Whether an event is a queue item as it stands. */
export const isItem = (event: DigestEvent): event is Item => Predicate.isTagged(event, "Item")

/** The root session an event belongs to; none for a host's own (an install, a drop count). */
export const rootOf = (event: DigestEvent): Option.Option<string> =>
  Match.value(event).pipe(
    Match.tag("Install", "Dropped", () => Option.none<string>()),
    Match.orElse((each) => Option.some(each.root)),
  )

/** A key of several parts. */
export const keyOf = (...parts: ReadonlyArray<string | number>): string => parts.join("\n")

/** Whether `event` is newer than `kept`: a later time, or the same time and the greater line. */
export const isNewer = (event: DigestEvent, kept: DigestEvent): boolean => event.t > kept.t || (event.t === kept.t && encodeLine(event) > encodeLine(kept))

/** A state's maps as writable copies, for one fold. */
type Draft = { readonly [Key in keyof State]: State[Key] extends ReadonlyMap<infer K, infer V> ? Map<K, V> : never }

const draftOf = (state: State): Draft => ({
  runs: new Map(state.runs),
  lanes: new Map(state.lanes),
  starts: new Map(state.starts),
  handBacks: new Map(state.handBacks),
  verdicts: new Map(state.verdicts),
  lands: new Map(state.lands),
  checks: new Map(state.checks),
  items: new Map(state.items),
  itemsSince: new Map(state.itemsSince),
  asked: new Map(state.asked),
  answered: new Map(state.answered),
  closed: new Map(state.closed),
  installs: new Map(state.installs),
  dropped: new Map(state.dropped),
})

/** Keep `event` under `key` unless a newer one is kept there. */
const keep = <E extends DigestEvent>(map: Map<string, E>, key: string, event: E): void => {
  const kept = Option.fromUndefinedOr(map.get(key))
  if (Option.isNone(kept) || isNewer(event, kept.value)) map.set(key, event)
}

/** Keep the earlier of two times under `key`. */
const earliest = (map: Map<string, number>, key: string, t: number): void => {
  map.set(key, Math.min(t, Option.getOrElse(Option.fromUndefinedOr(map.get(key)), () => t)))
}

/** An item's change, kept under its root and id with the time it was first written. */
const keepItem = (draft: Draft, event: Item | ItemGone): void => {
  const key = keyOf(event.root, event.id)
  keep(draft.items, key, event)
  earliest(draft.itemsSince, key, event.t)
}

/** One event into the draft. */
const step = (draft: Draft, event: DigestEvent): void =>
  Match.valueTags(event, {
    Run: (run) => keep(draft.runs, run.root, run),
    Lane: (lane) => keep(draft.lanes, keyOf(lane.root, lane.unit), lane),
    Start: (start) => keep(draft.starts, keyOf(start.root, start.role, start.unit, start.round), start),
    HandBack: (back) => keep(draft.handBacks, keyOf(back.root, back.role, back.unit, back.round), back),
    Verdict: (verdict) => keep(draft.verdicts, keyOf(verdict.root, verdict.batch, verdict.round), verdict),
    Land: (land) => keep(draft.lands, encodeLine(land), land),
    Check: (check) => keep(draft.checks, encodeLine(check), check),
    Item: (item) => keepItem(draft, item),
    ItemGone: (gone) => keepItem(draft, gone),
    Asked: (asked) => keep(draft.asked, keyOf(asked.session, asked.id), asked),
    Answered: (answered) => keep(draft.answered, keyOf(answered.session, answered.id), answered),
    Closed: (closed) => keep(draft.closed, keyOf(closed.session, closed.id), closed),
    Install: (install) => keep(draft.installs, encodeLine(install), install),
    Dropped: (dropped) => keep(draft.dropped, encodeLine(dropped), dropped),
  })

/** The state after `events`, from `state`. */
export const fold = (state: State, events: Iterable<DigestEvent>): State => {
  const draft = draftOf(state)
  for (const event of events) step(draft, event)
  return draft
}
