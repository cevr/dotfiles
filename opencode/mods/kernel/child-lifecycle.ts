import { Match, Option, Schema } from "effect"
import { RowFact } from "./child-row.ts"

const Outcome = Schema.Literals(["succeeded", "failed", "interrupted"])
export type Outcome = typeof Outcome.Type

const Cause = Schema.Literals(["PolicyDenied", "PermissionDenied", "Quota", "Transient", "UnsupportedCapability", "ProviderFailure", "UserStop", "Unknown"])
export type Cause = typeof Cause.Type

const Point = Schema.Struct({ id: Schema.String, seq: Schema.Int, at: Schema.Finite })
type Point = typeof Point.Type

export const Diagnostic = Schema.TaggedUnion({
  StepError: { cause: Cause },
  RetryScheduled: { cause: Cause, attempt: Schema.Int, at: Schema.Finite },
})
type Diagnostic = typeof Diagnostic.Type

export const Hold = Schema.TaggedUnion({
  Pace: {},
  Sabbath: {},
  Unknown: {},
})
export type Hold = typeof Hold.Type

const Ref = Schema.Struct({ provider: Schema.String, model: Schema.String, effort: Schema.optionalKey(Schema.String) })
const Route = Schema.TaggedUnion({ Pending: { requested: Schema.optionalKey(Ref) }, Committed: { effective: Ref } })

/** Shell exits are host events, but are ephemeral and have no durable sequence. */
export const Undetermined = Schema.TaggedStruct("ShellResultUndetermined", {
  shellID: Schema.String,
  exit: Schema.Struct({ id: Schema.String, at: Schema.Finite }),
})
export type Undetermined = typeof Undetermined.Type

export const Phase = Schema.TaggedUnion({
  Unknown: { reason: Schema.optionalKey(Undetermined) },
  Latched: { hold: Hold, recheckAt: Schema.optionalKey(Schema.Finite), opensAt: Schema.optionalKey(Schema.Finite) },
  Running: {},
  Continuing: { on: Schema.Literals(["Shell", "Child", "Wake"]) },
  Recovering: {},
  Settled: { outcome: Outcome, cause: Cause, terminal: Schema.optionalKey(Point) },
})
export type Phase = typeof Phase.Type
export const Basis = Schema.Literals(["current", "as-of-last-observation"])

/** Observation at one read. A terminal without a host point is coarse display, not a binding receipt. */
export const Observation = Schema.Struct({
  version: Schema.Literal(1),
  child: Schema.String,
  revision: Schema.optionalKey(Schema.Int),
  basis: Schema.optionalKey(Basis),
  started: Schema.optionalKey(Point),
  phase: Phase,
  diagnostic: Schema.optionalKey(Diagnostic),
  /** Reserved: this observer never populates a requested or effective route. */
  route: Schema.optionalKey(Route),
})
export type Observation = typeof Observation.Type

export const Terminal = Schema.TaggedUnion({
  Ended: { outcome: Outcome, cause: Cause },
  Shutdown: {},
})
type Terminal = typeof Terminal.Type
const Segment = Schema.Struct({
  point: Point,
  terminal: Schema.optionalKey(Terminal),
})

const Noted = Schema.Struct({ point: Point, diagnostic: Diagnostic })
const Seen = { seenIn: Schema.optionalKey(Schema.Int) }
const StoredPoint = Schema.Struct({ ...Point.fields, ...Seen })
const Confirmation = Schema.Struct({ input: Schema.String, generation: Schema.optionalKey(Schema.Int), seq: Schema.Int, ...Seen })
const StoredSegment = Schema.Struct({ ...Segment.fields, ...Seen, confirmation: Schema.optionalKey(Confirmation) })
const StoredExit = Schema.TaggedStruct("ShellResultUndetermined", { shellID: Schema.String, exit: Undetermined.fields.exit, ...Seen })
const Disposition = Schema.optionalKey(Schema.Literals(["cancelled", "delivered"]))
const Inbox = Schema.Struct({
  seq: Schema.Int, pending: Schema.Boolean, shellID: Schema.optionalKey(Schema.String),
  generation: Schema.optionalKey(Schema.Int), terminalSeq: Schema.optionalKey(Schema.Int),
  disposition: Disposition, ...Seen,
})
const Prefix = Schema.Struct({ first: Schema.Int, last: Schema.Int })
type Stamp = { readonly seenIn?: number }

/** The bounded, redacted projection in the existing plugin store. No request, report or shell content. */
export const Projection = Schema.Struct({
  version: Schema.Literal(1),
  child: Schema.String,
  parent: Schema.String,
  rev: Schema.Int,
  created: Schema.optionalKey(Schema.Finite),
  start: Schema.optionalKey(StoredPoint),
  segment: Schema.optionalKey(StoredSegment),
  /** An observed shell exit is evidence of uncertainty, not of pending work. */
  exits: Schema.optionalKey(Schema.Array(StoredExit)),
  /** An owner correlation for an exit received after subscription restart; not a list of live jobs. */
  shellOwners: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
  work: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({
    kind: Schema.Literals(["Shell", "Child"]), running: Schema.Boolean, at: Schema.Finite,
    native: Schema.Boolean, backgrounded: Schema.Boolean,
    startEvent: Schema.optionalKey(Schema.String), ambiguous: Schema.optionalKey(Schema.Boolean), ...Seen,
  }))),
  stopAfter: Schema.optionalKey(Schema.Int),
  stopSeenIn: Schema.optionalKey(Schema.Int),
  attention: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({
    kind: Schema.Literals(["permission", "question"]), at: Schema.Finite, open: Schema.Boolean,
    openedBy: Schema.optionalKey(Schema.String), ...Seen,
  }))),
  inbox: Schema.optionalKey(Schema.Record(Schema.String, Inbox)),
  prefix: Schema.optionalKey(Prefix),
  uncertainInput: Schema.optionalKey(Schema.Struct({ seq: Schema.Int, ...Seen })),
  noted: Schema.optionalKey(Schema.Struct({ ...Noted.fields, ...Seen })),
  sampled: Schema.optionalKey(Schema.String),
})
export type Projection = typeof Projection.Type

export const initial = (child: string, parent: string): Projection => ({ version: 1, child, parent, rev: 0 })

/** An incarnation reset discards facts, but never lowers the reader's revision floor. */
export const forIncarnation = (state: Projection, parent: string, created: Option.Option<number>, reset = false): Projection => {
  const changed = Option.exists(Option.fromUndefinedOr(state.created), (old) => Option.exists(created, (marker) => marker !== old))
  let next = state
  if (reset || state.parent !== parent || changed) next = { ...initial(state.child, parent), rev: state.rev }
  return Option.match(created, { onNone: () => next, onSome: (created) => ({ ...next, created }) })
}

const Owner = { child: Schema.String, parent: Schema.String }
export const Fact = Schema.TaggedUnion({
  Execution: { ...Owner, segment: Segment },
  Diagnostic: { ...Owner, note: Noted },
  Exit: { ...Owner, reason: Undetermined },
  ShellObserved: { ...Owner, id: Schema.String, startedAt: Schema.Finite },
  ShellRemoved: { ...Owner, id: Schema.String },
  Work: { ...Owner, id: Schema.String, work: Schema.Struct({
    kind: Schema.Literals(["Shell", "Child"]), running: Schema.Boolean, at: Schema.Finite,
    native: Schema.Boolean, backgrounded: Schema.Boolean, startEvent: Schema.optionalKey(Schema.String),
  }) },
  StopRequested: { ...Owner, seq: Schema.Int },
  Attention: { ...Owner, id: Schema.String, kind: Schema.Literals(["permission", "question"]), at: Schema.Finite, open: Schema.Boolean,
    event: Schema.optionalKey(Schema.String) },
  Inbox: { ...Owner, id: Schema.String, seq: Schema.Int, shellID: Schema.optionalKey(Schema.String), disposition: Disposition },
  Position: { ...Owner, seq: Schema.Int },
})
export type Fact = typeof Fact.Type

const pointSeq = (point?: Point) => Option.getOrElse(Option.map(Option.fromUndefinedOr(point), (item) => item.seq), () => -1)

const withExecution = (state: Projection, fact: typeof Fact.cases.Execution.Type, stamp: Stamp): Projection => {
  const { point, terminal } = fact.segment
  const newest = point.seq > pointSeq(state.segment?.point)
  const newestStart = !terminal && point.seq > pointSeq(state.start)
  if (!newest && !newestStart) return confirmExecution(state, fact, stamp)
  const next = { ...state, rev: state.rev + 1 }
  if (newestStart) next.start = { ...point, ...stamp }
  if (newest) {
    next.segment = { ...fact.segment, ...stamp }
    delete next.exits
    if (terminal && Option.exists(Option.fromUndefinedOr(next.stopAfter), (seq) => point.seq > seq)) {
      delete next.stopAfter
      delete next.stopSeenIn
    }
    if (terminal && state.attention) {
      next.attention = Object.fromEntries(Object.entries(state.attention).filter(([, item]) => item.at > point.at))
    }
    if (state.inbox && terminal) {
      next.inbox = Object.fromEntries(Object.entries(state.inbox).filter(([, item]) => item.pending || item.seq > point.seq))
    }
  }
  return next
}

const confirmExecution = (state: Projection, fact: typeof Fact.cases.Execution.Type, stamp: Stamp): Projection => {
  const { point, terminal } = fact.segment
  const arrivesAgain = (stored: Point & Stamp) => stored.id === point.id && stored.seq === point.seq && stored.seenIn !== stamp.seenIn
  const start = state.start
  const next = { ...state }
  if (!terminal && start && arrivesAgain(start)) next.start = { ...start, ...stamp }
  const current = state.segment
  if (current && arrivesAgain({ ...current.point, ...current })) next.segment = { ...current, ...stamp }
  if (next.start === start && next.segment === current) return state
  return { ...next, rev: state.rev + 1 }
}

const withExit = (state: Projection, reason: Undetermined, stamp: Stamp): Projection => {
  const next = withoutShell(state, reason.shellID, stamp)
  const segment = next.segment
  if (segment?.terminal?._tag !== "Ended" || segment.terminal.outcome !== "failed" || reason.exit.at < segment.point.at) return next
  const exits = Option.getOrElse(Option.fromUndefinedOr(next.exits), () => [])
  const prior = exits.find((exit) => exit.shellID === reason.shellID)
  if (prior) {
    if (prior.exit.id !== reason.exit.id || prior.seenIn === stamp.seenIn) return next
    const refreshed = exits.map((exit) => {
      if (exit === prior) return { ...exit, ...stamp }
      return exit
    })
    return { ...next, rev: state.rev + 1, exits: refreshed }
  }
  if (Object.values(Option.getOrElse(Option.fromUndefinedOr(next.inbox), () => ({}))).some((input) => input.shellID === reason.shellID)) return next
  return { ...next, rev: state.rev + 1, exits: [...exits, { ...reason, ...stamp }] }
}

const withoutShell = (state: Projection, id: string, stamp: Stamp): Projection => {
  const work = state.work?.[id]
  const owned = state.shellOwners && Object.hasOwn(state.shellOwners, id)
  if (!owned && !work?.running) return state
  const shellOwners = { ...state.shellOwners }
  delete shellOwners[id]
  const next = { ...state, rev: state.rev + 1, shellOwners }
  if (work) next.work = { ...state.work, [id]: { ...work, ...stamp, running: false } }
  return next
}

const withShell = (state: Projection, id: string, at: number): Projection => {
  if (state.shellOwners?.[id] === at || state.exits?.some((item) => item.shellID === id)) return state
  return { ...state, rev: state.rev + 1, shellOwners: { ...state.shellOwners, [id]: at } }
}

type Work = typeof Fact.cases.Work.Type.work
type StoredWork = NonNullable<Projection["work"]>[string]
const updateChildWork = (previous: StoredWork, work: Work, stamp: Stamp): Option.Option<StoredWork> => {
  if (!work.running) {
    if (work.at !== previous.at || previous.ambiguous || !previous.running || previous.seenIn !== stamp.seenIn) return Option.none()
    return Option.some({ ...previous, running: false })
  }
  if (work.at < previous.at) return Option.none()
  if (work.at > previous.at) return Option.some(work)
  if (work.startEvent === previous.startEvent) return Option.filter(Option.some(previous), ({ running }) => running)
  if (!previous.running) return Option.some(work)
  if (previous.ambiguous) return Option.none()
  return Option.some({ ...previous, ambiguous: true })
}

const sameWork = (previous: StoredWork, work: Work, stamp: Stamp) =>
  previous.at === work.at && previous.running === work.running &&
  previous.native === work.native && previous.backgrounded === work.backgrounded &&
  previous.startEvent === work.startEvent && previous.seenIn === stamp.seenIn

const withWork = (state: Projection, fact: typeof Fact.cases.Work.Type, stamp: Stamp): Projection => {
  const previous = state.work?.[fact.id]
  let work = fact.work
  // A job's completion may precede the native exit. It cannot close the native process.
  if (previous?.native && !work.native) {
    if (previous.backgrounded || !work.backgrounded || !previous.running) return state
    work = { ...previous, backgrounded: true }
  } else if (work.kind === "Child" && previous) {
    const next = updateChildWork(previous, work, stamp)
    if (Option.isNone(next)) return state
    if (next.value.ambiguous) return { ...state, rev: state.rev + 1, work: { ...state.work, [fact.id]: next.value } }
    work = next.value
  } else if (previous && (previous.at > work.at || (previous.at === work.at && !previous.running))) return state
  if (previous && sameWork(previous, work, stamp)) return state
  const next = { ...state, rev: state.rev + 1, work: { ...state.work, [fact.id]: { ...work, ...stamp } } }
  if (work.kind === "Shell" && work.backgrounded && work.running) {
    next.shellOwners = { ...state.shellOwners, [fact.id]: work.at }
  }
  return next
}

const withAttention = (state: Projection, fact: typeof Fact.cases.Attention.Type, stamp: Stamp): Projection => {
  const { id, kind, at, open, event } = fact
  const prior = state.attention?.[id]
  if (prior && prior.at > at) return state
  if (!open) {
    // An ID-only ephemeral reply cannot certify an opening from a previous
    // subscription. Unlike the durable inbox, it carries no sequence.
    if (!prior?.open || prior.kind !== kind || prior.seenIn !== stamp.seenIn) return state
    return { ...state, rev: state.rev + 1, attention: { ...state.attention, [id]: { ...prior, at, open } } }
  }
  if (prior?.openedBy === event && prior?.open) return state
  if (state.segment?.terminal && state.segment.point.at >= at) return state
  const openedBy = Option.match(Option.fromUndefinedOr(event), { onNone: () => ({}), onSome: (openedBy) => ({ openedBy }) })
  return { ...state, rev: state.rev + 1, attention: { ...state.attention, [id]: { kind, at, open, ...openedBy, ...stamp } } }
}

const linkTerminal = (state: Projection, shellID: string, seq: number) => {
  const segment = state.segment
  if (segment?.terminal?._tag !== "Ended" || segment.terminal.outcome !== "failed" || seq <= segment.point.seq) return {}
  if (!state.exits?.some((exit) => exit.shellID === shellID)) return {}
  return { terminalSeq: segment.point.seq }
}

const confirmDisposition = (next: Projection, input: string, disposition: typeof Inbox.Type): Projection => {
  const segment = next.segment
  if (!segment || disposition.pending || disposition.disposition !== "cancelled" || disposition.terminalSeq !== segment.point.seq) return next
  const generation = Option.fromUndefinedOr(disposition.generation)
  if (Option.isNone(generation)) return next
  const prior = segment.confirmation
  const stamp = Option.map(Option.fromUndefinedOr(disposition.seenIn), (seenIn) => ({ seenIn }))
  if (prior && prior.seenIn === disposition.seenIn && prior.seq > disposition.seq) return next
  const confirmation = { input, generation: generation.value, seq: disposition.seq, ...Option.getOrElse(stamp, () => ({})) }
  return { ...next, segment: { ...segment, confirmation } }
}

const writeInbox = (state: Projection, id: string, entry: typeof Inbox.Type): Projection =>
  ({ ...state, rev: state.rev + 1, inbox: { ...state.inbox, [id]: entry } })

const isPriorWake = (state: Projection, item: typeof Inbox.Type) =>
  Boolean(item.pending && item.shellID && item.seq > pointSeq(state.segment?.terminal && state.segment.point))

const withAdmission = (state: Projection, fact: typeof Fact.cases.Inbox.Type, stamp: Stamp, prior?: typeof Inbox.Type) => {
  const { id, seq, shellID } = fact
  if (prior?.generation === seq || (prior && seq === prior.seq) || observedPosition(state, seq)) return state
  const entry = { seq, generation: seq, pending: true, ...stamp }
  if (prior && seq < prior.seq) {
    if (prior.generation || !prior.disposition || !shellID || !coversClose(Option.fromUndefinedOr(state.prefix), seq + 1, prior.seq)) return state
    return bindAdmission(state, id, shellID, { ...entry, ...prior, generation: seq, pending: false })
  }
  const next = Option.match(Option.fromUndefinedOr(shellID), {
    onNone: () => writeInbox(state, id, entry), onSome: (shellID) => bindAdmission(state, id, shellID, entry),
  })
  if (prior && isPriorWake(state, prior)) return withUncertainty(next, seq, stamp)
  return next
}

const bindAdmission = (state: Projection, id: string, shellID: string, entry: typeof Inbox.Type) => {
  // A late admission can explain an earlier unmatched close when the
  // intervening suffix is known. It cannot re-observe the past terminal.
  const generation = Option.fromUndefinedOr(entry.generation)
  const linked = Option.map(generation, (seq) => linkTerminal(state, shellID, seq))
  const next = writeInbox(state, id, { ...entry, shellID, ...Option.getOrElse(linked, () => ({})) })
  if (state.exits) return { ...next, exits: state.exits.filter((exit) => exit.shellID !== shellID) }
  return next
}

const coversClose = (prefix: Option.Option<typeof Prefix.Type>, generation: number, close: number) =>
  Option.exists(prefix, ({ first, last }) => first <= generation && last >= close - 1)

const observedPosition = (state: Projection, seq: number) =>
  coversClose(Option.fromUndefinedOr(state.prefix), seq, seq + 1)

export const needsPositions = (state: Projection) =>
  Boolean(state.exits?.length || entries(state.inbox).some(([, item]) => item.pending))

const withUncertainty = (state: Projection, seq: number, stamp: Stamp) => {
  if (state.uncertainInput && state.uncertainInput.seq >= seq) return state
  return { ...state, uncertainInput: { seq, ...stamp } }
}

const withClose = (state: Projection, fact: typeof Fact.cases.Inbox.Type, stamp: Stamp, prior?: typeof Inbox.Type) => {
  const { id, seq, disposition } = fact
  if ((prior && seq <= prior.seq) || observedPosition(state, seq)) return state
  const closed = { seq, pending: false, ...stamp, ...Option.match(Option.fromUndefinedOr(disposition), {
    onNone: () => ({}), onSome: (disposition) => ({ disposition }),
  }) }
  if (!prior?.pending) return writeInbox(state, id, closed)
  const generation = Option.fromUndefinedOr(prior.generation)
  if (!Option.exists(generation, (at) => coversClose(Option.fromUndefinedOr(state.prefix), at, seq))) {
    const next = writeInbox(state, id, closed)
    if (isPriorWake(state, prior)) return withUncertainty(next, seq, stamp)
    return next
  }
  const consumed = { ...prior, ...closed }
  return confirmDisposition(writeInbox(state, id, consumed), id, consumed)
}

const withInbox = (state: Projection, fact: typeof Fact.cases.Inbox.Type, stamp: Stamp) => {
  const prior = state.inbox?.[fact.id]
  if (fact.disposition) return withClose(state, fact, stamp, prior)
  return withAdmission(state, fact, stamp, prior)
}

const positionOf = (fact: Fact) => Match.value(fact).pipe(Match.tags({
  Inbox: ({ seq }) => Option.some(seq),
  Position: ({ seq }) => Option.some(seq),
  Execution: ({ segment }) => Option.some(segment.point.seq),
  Diagnostic: ({ note }) => Option.some(note.point.seq),
}), Match.orElse(() => Option.none<number>()))

const extendPrefix = (state: Projection, reduced: Projection, seq: number) => {
  const previous = state.prefix
  if (previous && seq + 1 === previous.first) {
    return { ...reduced, rev: state.rev + 1, prefix: { first: seq, last: previous.last } }
  }
  if (previous && previous.last >= seq) return reduced
  let first = seq
  if (previous && previous.last + 1 === seq) first = previous.first
  return { ...reduced, rev: state.rev + 1, prefix: { first, last: seq } }
}

/** Fold only authenticated host facts for this child and parent, ordered by aggregate sequence. */
export const evolve = (state: Projection, fact: Fact & Stamp): Projection => {
  if (fact.child !== state.child || fact.parent !== state.parent) return state
  const stamp: Stamp = Option.match(Option.fromUndefinedOr(fact.seenIn), { onNone: () => ({}), onSome: (seenIn) => ({ seenIn }) })
  const reduced = Match.value(fact).pipe(Match.tagsExhaustive({
    Execution: (execution) => withExecution(state, execution, stamp),
    Exit: ({ reason }) => withExit(state, reason, stamp),
    ShellObserved: ({ id, startedAt }) => withShell(state, id, startedAt),
    ShellRemoved: ({ id }) => withoutShell(state, id, stamp),
    Work: (work) => withWork(state, work, stamp),
    StopRequested: ({ seq }) => {
      if (Option.exists(Option.fromUndefinedOr(state.stopAfter), (previous) => previous >= seq)) return state
      if (state.segment?.terminal && state.segment.point.seq > seq) return state
      const next = { ...state, rev: state.rev + 1, stopAfter: seq }
      const seen = Option.fromUndefinedOr(stamp.seenIn)
      if (Option.isSome(seen)) return { ...next, stopSeenIn: seen.value }
      return next
    },
    Attention: (attention) => withAttention(state, attention, stamp),
    Inbox: (input) => withInbox(state, input, stamp),
    Position: () => state,
    Diagnostic: ({ note }) => {
      if (note.point.seq <= pointSeq(state.noted?.point)) return state
      return { ...state, rev: state.rev + 1, noted: { ...note, ...stamp } }
    },
  }))
  return Option.getOrElse(Option.map(positionOf(fact), (seq) => extendPrefix(state, reduced, seq)), () => reduced)
}

export interface Snapshot {
  readonly running: boolean
  readonly outcome?: Outcome
  readonly busyAt?: number
  readonly idleAt?: number
  readonly background?: "Shell" | "Child" | "Wake"
  readonly latch?: Extract<Phase, { readonly _tag: "Latched" }>
  /** When the pending latch was kept: one kept after the last round ended is the next round's (a continued round's). */
  readonly latchAt?: number
  readonly latchCancelled?: boolean
  readonly latchFailed?: boolean
  readonly stopUncertain?: boolean
}

type Evidence = {
  readonly subject: "execution" | "work" | "input" | "exit" | "attention" | "stop" | "wake-mark" | "session"
  readonly id: string
  readonly instance?: number | string
  readonly seenIn: Option.Option<number>
}
const evidence = (subject: Evidence["subject"], id: string, stamp: Stamp): Evidence =>
  ({ subject, id, seenIn: Option.fromUndefinedOr(stamp.seenIn) })
const inputEvidence = (id: string, input: typeof Inbox.Type): Evidence =>
  Option.match(Option.fromUndefinedOr(input.generation), {
    onNone: () => evidence("input", id, input),
    onSome: (instance) => ({ ...evidence("input", id, input), instance }),
  })
const attentionEvidence = (id: string, item: NonNullable<Projection["attention"]>[string]): Evidence =>
  Option.match(Option.fromUndefinedOr(item.openedBy), {
    onNone: () => evidence("attention", id, item),
    onSome: (instance) => ({ ...evidence("attention", id, item), instance }),
  })
export interface WorkEvidence {
  readonly kind: NonNullable<Snapshot["background"]>
  readonly facts: ReadonlyArray<Evidence>
}
const entries = <A>(items?: Readonly<Record<string, A>>) => Object.entries(Option.getOrElse(Option.fromUndefinedOr(items), () => ({})))
export const workEvidence = (state: Projection): Option.Option<WorkEvidence> => {
  const work = entries(state.work).find(([, item]) => item.running)
  if (work) {
    const [id, item] = work
    let stamp: Stamp = item
    if (item.ambiguous) stamp = {}
    return Option.some({ kind: item.kind, facts: [{ ...evidence("work", id, stamp), instance: item.startEvent ?? item.at }] })
  }
  const pending = entries(state.inbox).find(([, item]) => isPriorWake(state, item))
  if (pending) return Option.some({ kind: "Wake", facts: [inputEvidence(pending[0], pending[1])] })
  return Option.none()
}
export const workOf = (state: Projection): Snapshot["background"] => Option.getOrUndefined(Option.map(workEvidence(state), ({ kind }) => kind))

export const executionActive = (state: Projection) => Boolean(state.segment && !state.segment.terminal)

/** Read only evidence matching the currently reported execution, never a historical launch. */
export const rowFactOf = (state: Projection, snapshot: Snapshot): RowFact => {
  if (snapshot.running || snapshotIsNewer(state, snapshot)) return RowFact.cases.NoFact.make({})
  const exit = state.exits?.[0]
  if (exit) return RowFact.cases.ShellResultUndetermined.make({ at: exit.exit.at })
  const segment = state.segment
  if (segment?.terminal?._tag === "Ended" && segment.terminal.outcome === "failed") return RowFact.cases.Failed.make({ at: segment.point.at })
  return RowFact.cases.NoFact.make({})
}

/** Compatibility projection for callers which do not carry an activation. */
export const observe = (state: Projection, snapshot: Snapshot, current: boolean): Observation => {
  const { start, noted } = state
  const applicable = current && !snapshotIsNewer(state, snapshot)
  const available = { ...snapshot }
  if (current && !applicable) delete available.outcome
  const base = {
    version: 1 as const,
    child: state.child,
    revision: state.rev,
    phase: phaseOf(state, available, applicable,
      Option.map(Option.fromUndefinedOr(snapshot.background), (kind) => ({ kind, facts: [] })), {}).phase,
  }
  if (!applicable) return base
  const inRun = noted && noted.point.seq > pointSeq(start) && base.phase._tag !== "Settled"
  return { ...base, ...startFields(start), ...diagnosticFields(noted, inRun) }
}

/** Phase and its witnesses are decided together; the wire exposes only the derived basis. */
export const decide = (state: Projection, snapshot: Snapshot, activation: number, background = workEvidence(state)) => {
  const superseded = snapshotIsNewer(state, snapshot)
  const result = phaseOf(state, snapshot, !superseded && Boolean(state.segment), Option.filter(background, () => !superseded), { seenIn: activation })
  const attention = entries(state.attention).find(([, item]) => item.open)
  if (result.phase._tag !== "Running" || !attention) return result
  return { ...result, facts: [...result.facts, attentionEvidence(attention[0], attention[1])] }
}

export const present = (state: Projection, snapshot: Snapshot, activation: number, background = workEvidence(state)): Observation => {
  const { phase, facts } = decide(state, snapshot, activation, background)
  const basisOf = (): typeof Basis.Type => {
    if (facts.every(({ seenIn }) => Option.contains(seenIn, activation))) return "current"
    return "as-of-last-observation"
  }
  const basis = basisOf()
  const base = { version: 1 as const, child: state.child, revision: state.rev, phase, basis } satisfies Observation
  if (snapshotIsNewer(state, snapshot) || !state.segment) return base
  const { start, noted } = state
  return { ...base, ...startFields(start), ...diagnosticFields(noted, Boolean(noted && noted.point.seq > pointSeq(start) && phase._tag !== "Settled")) }
}

const startFields = (start?: Point) => {
  if (start) return { started: { id: start.id, seq: start.seq, at: start.at } }
  return {}
}
const diagnosticFields = (noted?: typeof Noted.Type, inRun?: boolean) => {
  if (noted && inRun) return { diagnostic: noted.diagnostic }
  return {}
}

// The host's busy time uses the start's clock; idle is a monotone unread
// marker and can advance past the terminal event within the same millisecond.
// It cannot order equal-time events or mint a receipt.
const snapshotIsNewer = (state: Projection, snapshot: Snapshot) =>
  Option.exists(Option.fromUndefinedOr(state.segment), ({ point, terminal }) =>
    Option.exists(Option.fromUndefinedOr(snapshot.busyAt), (time) => time > point.at || Boolean(state.start && time !== state.start.at)) ||
    incomparableOutcome(Option.fromUndefinedOr(terminal), snapshot, point.at),
  )

const incomparableOutcome = (terminal: Option.Option<Terminal>, snapshot: Snapshot, at: number) => {
  if (Option.isNone(terminal) || terminal.value._tag === "Shutdown") return false
  if (!snapshot.outcome || snapshot.outcome === terminal.value.outcome) return false
  return Option.exists(Option.fromUndefinedOr(snapshot.idleAt), (idle) => idle >= at)
}

const claim = (phase: Phase, ...facts: ReadonlyArray<Evidence>) => ({ phase, facts })
const continuing = ({ kind, facts }: WorkEvidence) => claim(Phase.cases.Continuing.make({ on: kind }), ...facts)
const atExit = ({ shellID, exit, ...stamp }: typeof StoredExit.Type) =>
  claim(Phase.cases.Unknown.make({ reason: Undetermined.make({ shellID, exit }) }), evidence("exit", shellID, stamp))

const phaseOf = (state: Projection, snapshot: Snapshot, applicable: boolean, background: Option.Option<WorkEvidence>, read: Stamp) => {
  const session = (phase: Phase, subject: "session" | "wake-mark", stamp = read) => claim(phase, evidence(subject, state.child, stamp))
  if (snapshot.stopUncertain) return claim(Phase.cases.Unknown.make({}), {
    subject: "stop", id: state.child, seenIn: Option.fromUndefinedOr(state.stopSeenIn),
  })
  const exit = Option.filter(Option.fromUndefinedOr(state.exits?.[0]), () => !snapshotIsNewer(state, snapshot))
  // A continued round held after the last one ended is latched, not that round's end (batch 2026-11-26g).
  if (snapshot.latch && latchedAfter(state.segment, Option.fromUndefinedOr(snapshot.latchAt))) return session(snapshot.latch, "wake-mark")
  if (applicable && state.segment) return orderedPhase(state.segment, background, exit, uncertainInput(state, state.segment.point.seq))
  if (snapshot.running) return session(Phase.cases.Running.make({}), "session")
  if (Option.isSome(background) && snapshot.outcome !== "interrupted") return continuing(background.value)
  if (snapshot.latch) return session(snapshot.latch, "wake-mark")
  if (snapshot.latchCancelled) return session(Phase.cases.Settled.make({ outcome: "interrupted", cause: "UserStop" }), "wake-mark")
  if (snapshot.latchFailed) return session(Phase.cases.Settled.make({ outcome: "failed", cause: "Unknown" }), "wake-mark")
  if (Option.isSome(exit)) return atExit(exit.value)
  if (state.segment?.terminal?._tag === "Shutdown") return claim(Phase.cases.Recovering.make({}), evidence("execution", state.segment.point.id, state.segment))
  // The snapshot's outcome alone has no ordered terminal ID. Preserve the phase,
  // but never turn it into a current terminal claim.
  if (snapshot.outcome && !applicable) return session(Phase.cases.Settled.make({ outcome: snapshot.outcome, cause: "Unknown" }), "session", {})
  return claim(Phase.cases.Unknown.make({}))
}

/** Whether a latch kept at `at` came after the recorded round ended: an ended segment whose end it follows. */
const latchedAfter = (segment: Projection["segment"], at: Option.Option<number>) =>
  Option.exists(Option.filter(Option.fromUndefinedOr(segment), ({ terminal }) => Boolean(terminal)), ({ point }) =>
    Option.exists(at, (kept) => kept >= point.at))

const uncertainInput = (state: Projection, after: number) =>
  Option.map(Option.filter(Option.fromUndefinedOr(state.uncertainInput), ({ seq }) => seq > after),
    (input) => evidence("input", "unattributed", input))

const terminalEvidence = (segment: typeof StoredSegment.Type) => {
  const original = evidence("execution", segment.point.id, segment)
  if (!segment.confirmation) return [original]
  if (Option.isNone(Option.fromUndefinedOr(segment.confirmation.generation))) return [original]
  const confirmation = { ...evidence("input", segment.confirmation.input, segment.confirmation), instance: segment.confirmation.generation }
  const wasSeen = Option.getOrElse(original.seenIn, () => 0)
  if (!Option.exists(confirmation.seenIn, (seenIn) => seenIn > wasSeen)) return [original]
  // A correlated close reconfirms the exact failed segment whose continuation
  // it resolved; it never substitutes a new terminal point or certifies an ID
  // without this persisted association.
  return [{ ...original, seenIn: confirmation.seenIn }, confirmation]
}

const orderedPhase = (
  segment: typeof StoredSegment.Type, background: Option.Option<WorkEvidence>, exit: Option.Option<typeof StoredExit.Type>,
  uncertain: Option.Option<Evidence>,
) => {
  const { terminal, point } = segment
  const execution = evidence("execution", point.id, segment)
  if (!terminal) return claim(Phase.cases.Running.make({}), execution)
  if (terminal._tag === "Shutdown") return claim(Phase.cases.Recovering.make({}), execution)
  if (Option.isSome(background) && terminal.outcome !== "interrupted") {
    const work = continuing(background.value)
    return claim(work.phase, execution, ...work.facts)
  }
  if (Option.isSome(exit) && terminal.outcome === "failed") {
    const exited = atExit(exit.value)
    return claim(exited.phase, execution, ...exited.facts)
  }
  if (Option.isSome(uncertain) && terminal.outcome === "failed") return claim(Phase.cases.Unknown.make({}), execution, uncertain.value)
  return claim(Phase.cases.Settled.make({ outcome: terminal.outcome, cause: terminal.cause, terminal: point }), ...terminalEvidence(segment))
}
