import { Match, Option, Schema } from "effect"

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

export const Phase = Schema.TaggedUnion({
  Unknown: {},
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
  route: Schema.optionalKey(Route),
})
export type Observation = typeof Observation.Type

export const Terminal = Schema.TaggedUnion({
  Ended: { outcome: Outcome, cause: Cause },
  Shutdown: {},
})
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
  noted: Schema.optionalKey(Noted),
  continued: Schema.optionalKey(Schema.Int),
  sampled: Schema.optionalKey(Schema.String),
})
export type Projection = typeof Projection.Type

export const initial = (child: string, parent: string): Projection => ({ version: 1, child, parent, rev: 0 })

const Owner = { child: Schema.String, parent: Schema.String }
export const Fact = Schema.TaggedUnion({
  Execution: { ...Owner, segment: Segment, unfinished: Schema.Boolean },
  Diagnostic: { ...Owner, note: Noted },
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
  if (newest) next.segment = fact.segment
  if (newest && terminal?._tag === "Ended" && fact.unfinished) next.continued = point.seq
  return next
}

/** Fold only authenticated host facts for this child and parent, ordered by aggregate sequence. */
export const evolve = (state: Projection, fact: Fact): Projection => {
  if (fact.child !== state.child || fact.parent !== state.parent) return state
  return Match.value(fact).pipe(Match.tagsExhaustive({
    Execution: (execution) => withExecution(state, execution),
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
  readonly background?: "Shell" | "Child"
  readonly latch?: Extract<Phase, { readonly _tag: "Latched" }>
  readonly latchCancelled?: boolean
  readonly stopUncertain?: boolean
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
  if (applicable && state.segment) return orderedPhase(state, snapshot, state.segment)
  if (snapshot.running) return Phase.cases.Running.make({})
  if (snapshot.background) return Phase.cases.Continuing.make({ on: snapshot.background })
  if (snapshot.latch) return snapshot.latch
  if (snapshot.latchCancelled) return Phase.cases.Settled.make({ outcome: "interrupted", cause: "UserStop" })
  if (current || (state.segment && state.continued === state.segment.point.seq)) return Phase.cases.Unknown.make({})
  if (state.segment?.terminal?._tag === "Shutdown") return Phase.cases.Recovering.make({})
  if (snapshot.outcome) return Phase.cases.Settled.make({ outcome: snapshot.outcome, cause: "Unknown" })
  return Phase.cases.Unknown.make({})
}

const orderedPhase = (state: Projection, snapshot: Snapshot, segment: typeof Segment.Type): Phase => {
  const { terminal, point } = segment
  if (!terminal) return Phase.cases.Running.make({})
  if (terminal._tag === "Shutdown") return Phase.cases.Recovering.make({})
  if (snapshot.background) return Phase.cases.Continuing.make({ on: snapshot.background })
  if (state.continued === point.seq) return Phase.cases.Continuing.make({ on: "Wake" })
  return Phase.cases.Settled.make({ outcome: terminal.outcome, cause: terminal.cause, terminal: point })
}
