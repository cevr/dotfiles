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

/** Observation at one read. A terminal without a host point is coarse display, not a binding receipt. */
export const Observation = Schema.Struct({
  version: Schema.Literal(1),
  child: Schema.String,
  revision: Schema.optionalKey(Schema.Int),
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

/** The bounded, redacted projection in the existing plugin store. No request, report or shell content. */
export const Projection = Schema.Struct({
  version: Schema.Literal(1),
  child: Schema.String,
  parent: Schema.String,
  rev: Schema.Int,
  start: Schema.optionalKey(Point),
  segment: Schema.optionalKey(Segment),
  /** An observed shell exit is evidence of uncertainty, not of pending work. */
  exits: Schema.optionalKey(Schema.Array(Undetermined)),
  /** An owner correlation for an exit received after subscription restart; not a list of live jobs. */
  shellOwners: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
  inbox: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({
    seq: Schema.Int,
    pending: Schema.Boolean,
    shellID: Schema.optionalKey(Schema.String),
  }))),
  noted: Schema.optionalKey(Noted),
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
  Inbox: { ...Owner, id: Schema.String, seq: Schema.Int, shellID: Schema.optionalKey(Schema.String) },
})
export type Fact = typeof Fact.Type

const pointSeq = (point?: Point) => Option.getOrElse(Option.map(Option.fromUndefinedOr(point), (item) => item.seq), () => -1)

const withExecution = (state: Projection, fact: typeof Fact.cases.Execution.Type): Projection => {
  const { point, terminal } = fact.segment
  const newest = point.seq > pointSeq(state.segment?.point)
  const newestStart = !terminal && point.seq > pointSeq(state.start)
  if (!newest && !newestStart) return state
  const next = { ...state, rev: state.rev + 1 }
  if (newestStart) next.start = point
  if (newest) {
    next.segment = fact.segment
    delete next.exits
    if (state.inbox && terminal) {
      next.inbox = Object.fromEntries(Object.entries(state.inbox).filter(([, item]) => item.pending || item.seq > point.seq))
    }
  }
  return next
}

const withExit = (state: Projection, reason: Undetermined): Projection => {
  const next = withoutShell(state, reason.shellID)
  const segment = next.segment
  if (segment?.terminal?._tag !== "Ended" || segment.terminal.outcome !== "failed" || reason.exit.at < segment.point.at) return next
  const exits = Option.getOrElse(Option.fromUndefinedOr(next.exits), () => [])
  if (exits.some((exit) => exit.shellID === reason.shellID)) return next
  if (Object.values(Option.getOrElse(Option.fromUndefinedOr(next.inbox), () => ({}))).some((input) => input.shellID === reason.shellID)) return next
  return { ...next, rev: state.rev + 1, exits: [...exits, reason] }
}

const withoutShell = (state: Projection, id: string): Projection => {
  if (!state.shellOwners || !Object.hasOwn(state.shellOwners, id)) return state
  const shellOwners = { ...state.shellOwners }
  delete shellOwners[id]
  return { ...state, rev: state.rev + 1, shellOwners }
}

const withShell = (state: Projection, id: string, at: number): Projection => {
  if (state.shellOwners?.[id] === at || state.exits?.some((item) => item.shellID === id)) return state
  return { ...state, rev: state.rev + 1, shellOwners: { ...state.shellOwners, [id]: at } }
}

const withInbox = (state: Projection, fact: typeof Fact.cases.Inbox.Type): Projection => {
  const inbox = state.inbox
  const prev = inbox?.[fact.id]
  const segment = state.segment
  if (!prev && segment?.terminal && fact.seq < segment.point.seq) return state
  // A close can be observed first. A late admission contributes correlation,
  // but cannot resurrect that input. Repeats and conflicting IDs do nothing.
  if (prev?.shellID && fact.shellID && prev.shellID !== fact.shellID) return state
  const shellID = prev?.shellID ?? fact.shellID
  const newer = !prev || prev.seq < fact.seq
  if (!newer && prev.shellID === shellID) return state
  const entry = { seq: fact.seq, pending: Boolean(fact.shellID) }
  if (!newer) {
    entry.seq = prev.seq
    entry.pending = prev.pending
  }
  const next = { ...state, rev: state.rev + 1, inbox: { ...inbox, [fact.id]: entry } }
  if (shellID) {
    next.inbox[fact.id] = { ...entry, shellID }
    if (state.exits) next.exits = state.exits.filter((exit) => exit.shellID !== shellID)
  }
  return next
}

/** Fold only authenticated host facts for this child and parent, ordered by aggregate sequence. */
export const evolve = (state: Projection, fact: Fact): Projection => {
  if (fact.child !== state.child || fact.parent !== state.parent) return state
  return Match.value(fact).pipe(Match.tagsExhaustive({
    Execution: (execution) => withExecution(state, execution),
    Exit: ({ reason }) => withExit(state, reason),
    ShellObserved: ({ id, startedAt }) => withShell(state, id, startedAt),
    ShellRemoved: ({ id }) => withoutShell(state, id),
    Inbox: (input) => withInbox(state, input),
    Diagnostic: ({ note }) => {
      if (note.point.seq <= pointSeq(state.noted?.point)) return state
      return { ...state, rev: state.rev + 1, noted: note }
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
  readonly stopUncertain?: boolean
}

/** Read only evidence matching the currently reported execution, never a historical launch. */
export const rowFactOf = (state: Projection, snapshot: Snapshot): RowFact => {
  if (snapshot.running || snapshotIsNewer(state, snapshot)) return RowFact.cases.NoFact.make({})
  const exit = state.exits?.[0]
  if (exit) return RowFact.cases.ShellResultUndetermined.make({ at: exit.exit.at })
  const segment = state.segment
  if (segment?.terminal?._tag === "Ended" && segment.terminal.outcome === "failed") return RowFact.cases.Failed.make({ at: segment.point.at })
  return RowFact.cases.NoFact.make({})
}

/** One child view. `current` is from this subscription lifetime; stored facts alone can't assert freshness. */
export const observe = (state: Projection, snapshot: Snapshot, current: boolean): Observation => {
  const { start, noted } = state
  const applicable = current && !snapshotIsNewer(state, snapshot)
  const base = {
    version: 1 as const,
    child: state.child,
    revision: state.rev,
    phase: phaseOf(state, snapshot, current, applicable),
  }
  if (!applicable) return base
  const inRun = noted && noted.point.seq > pointSeq(start) && base.phase._tag !== "Settled"
  return { ...base, ...startFields(start), ...diagnosticFields(noted, inRun) }
}

const startFields = (start?: Point) => {
  if (start) return { started: start }
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

const phaseOf = (state: Projection, snapshot: Snapshot, current: boolean, applicable: boolean): Phase => {
  if (snapshot.stopUncertain) return Phase.cases.Unknown.make({})
  const exit = Option.getOrUndefined(Option.filter(Option.fromUndefinedOr(state.exits?.[0]), () => !snapshotIsNewer(state, snapshot)))
  if (applicable && state.segment) return orderedPhase(snapshot, state.segment, exit)
  if (snapshot.running) return Phase.cases.Running.make({})
  if (snapshot.background && snapshot.outcome !== "interrupted") return Phase.cases.Continuing.make({ on: snapshot.background })
  if (snapshot.latch) return snapshot.latch
  if (snapshot.latchCancelled) return Phase.cases.Settled.make({ outcome: "interrupted", cause: "UserStop" })
  if (exit) return Phase.cases.Unknown.make({ reason: exit })
  if (current) return Phase.cases.Unknown.make({})
  if (state.segment?.terminal?._tag === "Shutdown") return Phase.cases.Recovering.make({})
  if (snapshot.outcome) return Phase.cases.Settled.make({ outcome: snapshot.outcome, cause: "Unknown" })
  return Phase.cases.Unknown.make({})
}

const orderedPhase = (snapshot: Snapshot, segment: typeof Segment.Type, exit?: Undetermined): Phase => {
  const { terminal, point } = segment
  if (!terminal) return Phase.cases.Running.make({})
  if (terminal._tag === "Shutdown") return Phase.cases.Recovering.make({})
  if (snapshot.background && terminal.outcome !== "interrupted") return Phase.cases.Continuing.make({ on: snapshot.background })
  if (exit && terminal.outcome === "failed") return Phase.cases.Unknown.make({ reason: exit })
  return Phase.cases.Settled.make({ outcome: terminal.outcome, cause: terminal.cause, terminal: point })
}
