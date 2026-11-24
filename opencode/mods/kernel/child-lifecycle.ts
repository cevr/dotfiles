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
const Confirmation = Schema.Struct({ input: Schema.String, seq: Schema.Int, ...Seen })
const StoredSegment = Schema.Struct({ ...Segment.fields, ...Seen, confirmation: Schema.optionalKey(Confirmation) })
const StoredExit = Schema.TaggedStruct("ShellResultUndetermined", { shellID: Schema.String, exit: Undetermined.fields.exit, ...Seen })
const Disposition = Schema.optionalKey(Schema.Literals(["cancelled", "delivered"]))
const Inbox = Schema.Struct({
  seq: Schema.Int, pending: Schema.Boolean, shellID: Schema.optionalKey(Schema.String),
  terminalSeq: Schema.optionalKey(Schema.Int), disposition: Disposition, ...Seen,
})
type Stamp = { readonly seenIn?: number }

/** The bounded, redacted projection in the existing plugin store. No request, report or shell content. */
export const Projection = Schema.Struct({
  version: Schema.Literal(1),
  child: Schema.String,
  parent: Schema.String,
  rev: Schema.Int,
  start: Schema.optionalKey(StoredPoint),
  segment: Schema.optionalKey(StoredSegment),
  /** An observed shell exit is evidence of uncertainty, not of pending work. */
  exits: Schema.optionalKey(Schema.Array(StoredExit)),
  /** An owner correlation for an exit received after subscription restart; not a list of live jobs. */
  shellOwners: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
  work: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({
    kind: Schema.Literals(["Shell", "Child"]), running: Schema.Boolean, at: Schema.Finite,
    native: Schema.Boolean, backgrounded: Schema.Boolean, ...Seen,
  }))),
  stopAfter: Schema.optionalKey(Schema.Int),
  stopSeenIn: Schema.optionalKey(Schema.Int),
  attention: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({
    kind: Schema.Literals(["permission", "question"]), at: Schema.Finite, open: Schema.Boolean, ...Seen,
  }))),
  inbox: Schema.optionalKey(Schema.Record(Schema.String, Inbox)),
  noted: Schema.optionalKey(Schema.Struct({ ...Noted.fields, ...Seen })),
  sampled: Schema.optionalKey(Schema.String),
})
export type Projection = typeof Projection.Type

export const initial = (child: string, parent: string): Projection => ({ version: 1, child, parent, rev: 0 })

const Owner = { child: Schema.String, parent: Schema.String }
export const Fact = Schema.TaggedUnion({
  Execution: { ...Owner, segment: Segment },
  Diagnostic: { ...Owner, note: Noted },
  Exit: { ...Owner, reason: Undetermined },
  ShellObserved: { ...Owner, id: Schema.String, startedAt: Schema.Finite },
  ShellRemoved: { ...Owner, id: Schema.String },
  Work: { ...Owner, id: Schema.String, work: Schema.Struct({
    kind: Schema.Literals(["Shell", "Child"]), running: Schema.Boolean, at: Schema.Finite,
    native: Schema.Boolean, backgrounded: Schema.Boolean,
  }) },
  StopRequested: { ...Owner, seq: Schema.Int },
  Attention: { ...Owner, id: Schema.String, kind: Schema.Literals(["permission", "question"]), at: Schema.Finite, open: Schema.Boolean },
  Inbox: { ...Owner, id: Schema.String, seq: Schema.Int, shellID: Schema.optionalKey(Schema.String), disposition: Disposition },
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
      next.inbox = Object.fromEntries(Object.entries(state.inbox).filter(([, item]) => item.seq > point.seq))
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

const withWork = (state: Projection, fact: typeof Fact.cases.Work.Type, stamp: Stamp): Projection => {
  const previous = state.work?.[fact.id]
  let work = fact.work
  // A job's completion may precede the native exit. It cannot close the native process.
  if (previous?.native && !work.native) {
    if (previous.backgrounded || !work.backgrounded || !previous.running) return state
    work = { ...previous, backgrounded: true }
  } else if (previous && (previous.at > work.at || (previous.at === work.at && !previous.running))) return state
  if (previous && previous.at === work.at && previous.running === work.running
    && previous.native === work.native && previous.backgrounded === work.backgrounded && previous.seenIn === stamp.seenIn) return state
  const next = { ...state, rev: state.rev + 1, work: { ...state.work, [fact.id]: { ...work, ...stamp } } }
  if (work.kind === "Shell" && work.backgrounded && work.running) {
    next.shellOwners = { ...state.shellOwners, [fact.id]: work.at }
  }
  return next
}

const linkTerminal = (state: Projection, shellID: string, seq: number) => {
  const segment = state.segment
  if (segment?.terminal?._tag !== "Ended" || segment.terminal.outcome !== "failed" || seq <= segment.point.seq) return {}
  if (!state.exits?.some((exit) => exit.shellID === shellID)) return {}
  return { terminalSeq: segment.point.seq }
}

const inboxEntry = (previous: Option.Option<typeof Inbox.Type>, fact: typeof Fact.cases.Inbox.Type, stamp: Stamp) => {
  const disposition = Option.map(Option.fromUndefinedOr(fact.disposition), (disposition) => ({ disposition }))
  const entry = { seq: fact.seq, pending: Boolean(fact.shellID), ...Option.getOrElse(disposition, () => ({})), ...stamp }
  if (Option.isNone(previous)) return entry
  const prev = previous.value
  if (prev.seq > fact.seq) return prev
  return { ...prev, ...entry }
}

const confirmDisposition = (next: Projection, input: string, disposition: typeof Inbox.Type): Projection => {
  const segment = next.segment
  if (!segment || disposition.pending || disposition.disposition !== "cancelled" || disposition.terminalSeq !== segment.point.seq) return next
  const prior = segment.confirmation
  const stamp = Option.map(Option.fromUndefinedOr(disposition.seenIn), (seenIn) => ({ seenIn }))
  if (prior && prior.seenIn === disposition.seenIn && prior.seq > disposition.seq) return next
  const confirmation = { input, seq: disposition.seq, ...Option.getOrElse(stamp, () => ({})) }
  return { ...next, segment: { ...segment, confirmation } }
}

const withInbox = (state: Projection, fact: typeof Fact.cases.Inbox.Type, stamp: Stamp): Projection => {
  const prev = state.inbox?.[fact.id]
  const segment = state.segment
  if (!prev && segment?.terminal && fact.seq < segment.point.seq) return state
  // A close can be observed first. A late admission contributes correlation,
  // but cannot resurrect that input. Repeats and conflicting IDs do nothing.
  if (prev?.shellID && fact.shellID && prev.shellID !== fact.shellID) return state
  const shellID = prev?.shellID ?? fact.shellID
  if (prev && prev.seq > fact.seq && prev.shellID === shellID) return state
  if (prev && prev.seq === fact.seq && (prev.pending !== Boolean(fact.shellID) || prev.seenIn === stamp.seenIn)) return state
  const entry = inboxEntry(Option.fromUndefinedOr(prev), fact, stamp)
  const next = { ...state, rev: state.rev + 1, inbox: { ...state.inbox, [fact.id]: entry } }
  if (shellID) {
    const link = Option.match(Option.fromUndefinedOr(fact.shellID), { onNone: () => ({}), onSome: () => linkTerminal(state, shellID, fact.seq) })
    const disposition = { ...entry, shellID, ...link }
    next.inbox[fact.id] = disposition
    if (state.exits) next.exits = state.exits.filter((exit) => exit.shellID !== shellID)
    return confirmDisposition(next, fact.id, disposition)
  }
  return next
}

/** Fold only authenticated host facts for this child and parent, ordered by aggregate sequence. */
export const evolve = (state: Projection, fact: Fact & Stamp): Projection => {
  if (fact.child !== state.child || fact.parent !== state.parent) return state
  const stamp: Stamp = Option.match(Option.fromUndefinedOr(fact.seenIn), { onNone: () => ({}), onSome: (seenIn) => ({ seenIn }) })
  return Match.value(fact).pipe(Match.tagsExhaustive({
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
    Attention: ({ id, kind, at, open }) => {
      const record = state.attention?.[id]
      if (record && (record.at > at || (record.at === at && (record.open === open || !record.open)))) return state
      const ended = state.segment?.terminal && state.segment.point.at >= at
      if (ended && open) return state
      return { ...state, rev: state.rev + 1, attention: { ...state.attention, [id]: { kind, at, open, ...stamp } } }
    },
    Inbox: (input) => withInbox(state, input, stamp),
    Diagnostic: ({ note }) => {
      if (note.point.seq <= pointSeq(state.noted?.point)) return state
      return { ...state, rev: state.rev + 1, noted: { ...note, ...stamp } }
    },
  }))
}

export interface Snapshot {
  readonly running: boolean
  readonly outcome?: Outcome
  readonly busyAt?: number
  readonly idleAt?: number
  readonly background?: "Shell" | "Child" | "Wake"
  readonly latch?: Extract<Phase, { readonly _tag: "Latched" }>
  readonly latchCancelled?: boolean
  readonly latchFailed?: boolean
  readonly stopUncertain?: boolean
}

type Evidence = {
  readonly subject: "execution" | "work" | "input" | "exit" | "attention" | "stop" | "wake-mark" | "session"
  readonly id: string
  readonly seenIn: Option.Option<number>
}
const evidence = (subject: Evidence["subject"], id: string, stamp: Stamp): Evidence =>
  ({ subject, id, seenIn: Option.fromUndefinedOr(stamp.seenIn) })
export interface WorkEvidence {
  readonly kind: NonNullable<Snapshot["background"]>
  readonly facts: ReadonlyArray<Evidence>
}
const entries = <A>(items?: Readonly<Record<string, A>>) => Object.entries(Option.getOrElse(Option.fromUndefinedOr(items), () => ({})))
export const workEvidence = (state: Projection): Option.Option<WorkEvidence> => {
  const work = entries(state.work).find(([, item]) => item.running)
  if (work) return Option.some({ kind: work[1].kind, facts: [evidence("work", work[0], work[1])] })
  const pending = entries(state.inbox).find(([, item]) => item.pending)
  if (pending) return Option.some({ kind: "Wake", facts: [evidence("input", pending[0], pending[1])] })
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
  return { ...result, facts: [...result.facts, evidence("attention", attention[0], attention[1])] }
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
  if (applicable && state.segment) return orderedPhase(state.segment, background, exit)
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

const terminalEvidence = (segment: typeof StoredSegment.Type) => {
  const original = evidence("execution", segment.point.id, segment)
  if (!segment.confirmation) return [original]
  const confirmation = evidence("input", segment.confirmation.input, segment.confirmation)
  const wasSeen = Option.getOrElse(original.seenIn, () => 0)
  if (!Option.exists(confirmation.seenIn, (seenIn) => seenIn > wasSeen)) return [original]
  // A correlated close reconfirms the exact failed segment whose continuation
  // it resolved; it never substitutes a new terminal point or certifies an ID
  // without this persisted association.
  return [{ ...original, seenIn: confirmation.seenIn }, confirmation]
}

const orderedPhase = (
  segment: typeof StoredSegment.Type, background: Option.Option<WorkEvidence>, exit: Option.Option<typeof StoredExit.Type>,
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
  return claim(Phase.cases.Settled.make({ outcome: terminal.outcome, cause: terminal.cause, terminal: point }), ...terminalEvidence(segment))
}
