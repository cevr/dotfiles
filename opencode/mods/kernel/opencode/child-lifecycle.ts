import type { Plugin } from "@opencode/plugin/effect"
import { DateTime, Effect, Match, Option, Schema, Semaphore, Stream, type Types } from "effect"
import { Diagnostic, Fact, Hold, Phase, Terminal, Undetermined, evolve, initial, observe, Projection, type Cause, type Snapshot } from "../child-lifecycle.ts"
import type { Observation } from "../child-lifecycle.ts"

type Info = Effect.Success<ReturnType<Plugin.Context["session"]["get"]>>
type Location = Pick<Info["location"], "directory" | "workspaceID">

const TYPES = [
  "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.step.failed", "session.retry.scheduled", "session.deleted",
  "shell.created", "shell.exited", "shell.deleted", "experimental.job.updated",
  "session.inbox.enqueued", "session.inbox.delivered", "session.inbox.cancelled",
] as const

const eventsOf = (ctx: Plugin.Context) => ctx.event.subscribe({ types: TYPES })
export { eventsOf }
export type Subscribe = (ctx: Plugin.Context) => Stream.Stream<unknown, unknown>

const Position = {
  id: Schema.String,
  created: Schema.Finite,
  // In-process ephemeral events can have an explicit undefined workspaceID;
  // the SDK's JSON stream omits it.
  location: Schema.optional(Schema.Struct({ directory: Schema.String, workspaceID: Schema.optional(Schema.String) })),
}
const Durable = { ...Position, durable: Schema.Struct({ aggregateID: Schema.String, seq: Schema.Int, version: Schema.Literal(1) }) }
const Session = { sessionID: Schema.String }
const ErrorType = Schema.Struct({ type: Schema.String })
const ExecutionEvent = Schema.Union([
  Schema.Struct({ ...Durable, type: Schema.Literal("session.execution.started"), data: Schema.Struct(Session) }),
  Schema.Struct({ ...Durable, type: Schema.Literal("session.execution.succeeded"), data: Schema.Struct(Session) }),
  Schema.Struct({ ...Durable, type: Schema.Literal("session.execution.failed"), data: Schema.Struct({ ...Session, error: ErrorType }) }),
  Schema.Struct({ ...Durable, type: Schema.Literal("session.execution.interrupted"), data: Schema.Struct({ ...Session, reason: Schema.Literals(["user", "shutdown", "superseded", "inactivity"]) }) }),
  Schema.Struct({ ...Durable, type: Schema.Literal("session.step.failed"), data: Schema.Struct({ ...Session, error: ErrorType }) }),
  Schema.Struct({ ...Durable, type: Schema.Literal("session.retry.scheduled"), data: Schema.Struct({ ...Session, error: ErrorType, attempt: Schema.Int, at: Schema.Finite }) }),
])
const InboxRef = { ...Session, inboxID: Schema.String }
const InboxEvent = Schema.Union([
  Schema.Struct({ ...Durable, type: Schema.Literal("session.inbox.enqueued"), data: Schema.Struct({
    ...InboxRef, item: Schema.Struct({
      type: Schema.Literal("synthetic"),
      payload: Schema.Struct({ metadata: Schema.Struct({ source: Schema.Literal("shell"), shellID: Schema.String }) }),
    }),
  }) }),
  Schema.Struct({ ...Durable, type: Schema.Literals(["session.inbox.delivered", "session.inbox.cancelled"]), data: Schema.Struct(InboxRef) }),
])
type InboxEvent = typeof InboxEvent.Type
const Event = Schema.Union([
  ExecutionEvent,
  InboxEvent,
  Schema.Struct({ ...Position, type: Schema.Literal("session.deleted"), data: Schema.Struct(Session) }),
  Schema.Struct({ ...Position, type: Schema.Literals(["shell.exited", "shell.deleted"]), data: Schema.Struct({ id: Schema.String }) }),
  Schema.Struct({ ...Position, type: Schema.Literal("shell.created"), data: Schema.Struct({ info: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    metadata: Schema.Struct({ sessionID: Schema.optionalKey(Schema.String), background: Schema.optionalKey(Schema.Boolean) }),
    time: Schema.Struct({ started: Schema.Finite }),
  }) }) }),
  Schema.Struct({ ...Position, type: Schema.Literal("experimental.job.updated"), data: Schema.Struct({ info: Schema.Struct({
    id: Schema.String, sessionID: Schema.String, kind: Schema.String, status: Schema.String,
    shellID: Schema.optionalKey(Schema.String),
    time: Schema.Struct({ started: Schema.Finite }),
  }) }) }),
])
type Event = typeof Event.Type
const decodeEvent = Schema.decodeUnknownResult(Event)
const isInboxEvent = (event: Event): event is InboxEvent =>
  event.type === "session.inbox.enqueued" || event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled"

const SessionID = Schema.String.check(Schema.isStartingWith("ses")).pipe(Schema.brand("SessionID"))
const sessionID = Schema.decodeUnknownOption(SessionID)
const readProjection = Schema.decodeUnknownOption(Projection)
const Mark = Schema.Struct({
  hold: Schema.Literals(["pace", "sabbath"]),
  opensAt: Schema.Finite,
  recheckAt: Schema.optionalKey(Schema.Finite),
  cancelledAt: Schema.optionalKey(Schema.Finite),
  failed: Schema.optionalKey(Schema.String),
})
const readMark = Schema.decodeUnknownOption(Mark)
const prefix = "child-lifecycle:"
const MAX_TRACKED = 512
const sampleKey = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({
  phase: Phase,
  diagnostic: Schema.optionalKey(Diagnostic),
})))

const holdOf = (hold: "pace" | "sabbath"): Hold => {
  if (hold === "pace") return Hold.cases.Pace.make({})
  return Hold.cases.Sabbath.make({})
}

const causeOf = (type: string): Cause => {
  switch (type) {
    case "provider.content-filter": return "PolicyDenied"
    case "permission.rejected": return "PermissionDenied"
    case "provider.quota":
    case "provider.free-limit":
    case "provider.budget-limit":
    case "provider.model-budget-limit":
    case "provider.go-limit":
    case "provider.chatgpt-limit":
    case "provider.chatgpt-workspace-limit": return "Quota"
    case "provider.rate-limit":
    case "provider.transport":
    case "provider.timeout":
    case "provider.unreachable": return "Transient"
    case "provider.auth":
    case "provider.internal":
    case "provider.invalid-output":
    case "provider.invalid-request": return "ProviderFailure"
    case "provider.unsupported-operation": return "UnsupportedCapability"
    default: return "Unknown"
  }
}

const executionFact = (
  event: typeof ExecutionEvent.Type,
  parent: string,
): Fact => {
  const child = event.data.sessionID
  const point = { id: event.id, seq: event.durable.seq, at: event.created }
  const execution = (terminal?: typeof Terminal.Type) => {
    if (terminal) return Fact.cases.Execution.make({ child, parent, segment: { point, terminal } })
    return Fact.cases.Execution.make({ child, parent, segment: { point } })
  }
  const note = (diagnostic: typeof Diagnostic.Type) => Fact.cases.Diagnostic.make({ child, parent, note: { point, diagnostic } })
  return Match.value(event).pipe(Match.discriminatorsExhaustive("type")({
    "session.step.failed": ({ data }) => note(Diagnostic.cases.StepError.make({ cause: causeOf(data.error.type) })),
    "session.retry.scheduled": ({ data }) => note(Diagnostic.cases.RetryScheduled.make({ at: data.at, attempt: data.attempt, cause: causeOf(data.error.type) })),
    "session.execution.started": () => execution(),
    "session.execution.succeeded": () => execution(Terminal.cases.Ended.make({ outcome: "succeeded", cause: "Unknown" })),
    "session.execution.failed": ({ data }) => execution(Terminal.cases.Ended.make({ outcome: "failed", cause: causeOf(data.error.type) })),
    "session.execution.interrupted": ({ data }) => execution(interrupted(data.reason)),
  }))
}

const interrupted = (reason: string): typeof Terminal.Type => {
  if (reason === "shutdown") return Terminal.cases.Shutdown.make({})
  if (reason === "user") return Terminal.cases.Ended.make({ outcome: "interrupted", cause: "UserStop" })
  return Terminal.cases.Ended.make({ outcome: "interrupted", cause: "Unknown" })
}

const snapshotOf = (info: Info, background: Snapshot["background"], stopUncertain: boolean): Snapshot => {
  const millis = (time: Info["time"]["busy"]) => Option.map(Option.fromUndefinedOr(time), DateTime.toEpochMillis)
  const busyAt = millis(info.time.busy)
  const idleAt = millis(info.time.idle)
  const running = Option.exists(busyAt, (at) => Option.isNone(idleAt) || at > idleAt.value)
  const value: Types.Mutable<Snapshot> = { running, stopUncertain }
  if (info.outcome) value.outcome = info.outcome
  if (Option.isSome(busyAt)) value.busyAt = busyAt.value
  if (Option.isSome(idleAt)) value.idleAt = idleAt.value
  if (background) value.background = background
  const mark = readMark(info.metadata?.latch)
  if (Option.isSome(mark)) {
    const { hold, opensAt, recheckAt, cancelledAt, failed } = mark.value
    value.latchCancelled = Option.isSome(Option.fromUndefinedOr(cancelledAt))
    if (!value.latchCancelled && Option.isNone(Option.fromUndefinedOr(failed))) {
      const times = { opensAt, hold: holdOf(hold) }
      const checked = Option.fromUndefinedOr(recheckAt)
      if (Option.isSome(checked)) value.latch = Phase.cases.Latched.make({ ...times, recheckAt: checked.value })
      else value.latch = Phase.cases.Latched.make(times)
    }
  }
  return value
}

const sameLocation = (actual: { readonly directory: string; readonly workspaceID?: string }, owner: Location) =>
  actual.directory === owner.directory && actual.workspaceID === owner.workspaceID

type Background = { readonly owner: string; readonly kind: "Shell" | "Child"; readonly running: boolean; readonly at: number; readonly backgrounded?: boolean; readonly native?: boolean }
type Inbox = { readonly child: string; readonly seq: number; readonly pending: boolean; readonly shellID?: string }

/** One location-bound subscriber and persisted projection; neither schedules work nor sends notices. */
export const make = Effect.fn("ChildLifecycle.make")(function* (ctx: Plugin.Context, subscribe: Subscribe) {
  const lock = yield* Semaphore.make(1)
  const current = new Set<string>()
  const starts = new Map<string, number>()
  const active = new Set<string>()
  const parents = new Map<string, string>()
  const background = new Map<string, Background>()
  const inbox = new Map<string, Inbox>()
  const stopping = new Map<string, number>()
  const { directory, workspaceID } = ctx.location
  const workspace = Option.getOrElse(Option.map(Option.fromUndefinedOr(workspaceID), String), () => "")
  const keyOf = (child: string) => `${prefix}${directory.length}:${directory}:${workspace}:${child}`

  const load = (child: string, parent: string) =>
    ctx.storage.get(keyOf(child)).pipe(
      Effect.map((value) => Option.getOrElse(Option.filter(readProjection(value), (seen) => seen.child === child && seen.parent === parent), () => initial(child, parent))),
    )
  const save = (current: Projection, next: Projection) =>
    Option.match(Option.filter(Option.some(current.rev), (rev) => rev > 0), {
      onNone: () => ctx.storage.setIf(keyOf(current.child), next),
      onSome: (rev) => ctx.storage.setIf(keyOf(current.child), next, rev),
    })
  const infoOf = Effect.fn("ChildLifecycle.info")(function* (child: string) {
    const id = yield* Effect.fromOption(sessionID(child))
    const info = yield* ctx.session.get({ sessionID: id })
    if (!sameLocation(info.location, ctx.location)) return yield* Effect.fail("unowned location")
    if (info.parentID) parents.set(child, info.parentID)
    return info
  })
  const ownedBy = (owner: string, child: string): boolean => {
    let id = owner
    for (let depth = 0; depth < 32; depth++) {
      const parent = parents.get(id)
      if (!parent) return false
      if (parent === child) return true
      id = parent
    }
    return false
  }
  const liveWork = (child: string) => {
    const own = background.values().find((job) => job.owner === child && job.running)
    if (own) return own.kind
    if (active.values().some((id) => ownedBy(id, child))) return "Child"
    if (background.values().some((job) => job.running && ownedBy(job.owner, child))) return "Child"
    if (inbox.values().some((item) => item.pending && item.child === child)) return "Wake"
    if (inbox.values().some((item) => item.pending && ownedBy(item.child, child))) return "Child"
  }

  const job = (id: string, updated: Background) => {
    const old = background.get(id)
    if (old && old.owner !== updated.owner) return
    if (old?.native && !updated.native) {
      // Job completion can precede shell.exited. It marks ownership but
      // cannot remove a native process from the live shell registry.
      if (updated.backgrounded) background.set(id, { ...old, backgrounded: true })
      return
    }
    if (old && (old.at > updated.at || (!old.running && old.at === updated.at))) return
    background.set(id, { ...old, ...updated })
    if (background.size > MAX_TRACKED) {
      const evict = background.entries().find(([, item]) => !item.running)
      if (evict) background.delete(evict[0])
    }
  }
  const releaseShell = (id: string) => {
    const old = background.get(id)
    if (old) job(id, { ...old, running: false })
  }

  const shellExit = Effect.fn("ChildLifecycle.shellExit")(function* (shellID: string, id: string, at: number) {
    const shell = background.get(shellID)
    releaseShell(shellID)
    if (!shell?.backgrounded) return
    if (shell.native && !shell.running) return
    const child = shell.owner
    if (!current.has(child) || inbox.values().some((item) => item.child === child && item.shellID === shellID)) return
    const parent = parents.get(child)
    if (!parent) return
    const state = yield* load(child, parent)
    const { segment } = state
    if (segment?.terminal?._tag !== "Ended" || segment.terminal.outcome !== "failed") return
    const exits = state.exits ?? []
    if (exits.some((item) => item.shellID === shellID)) return
    const reason = Undetermined.make({ shellID, exit: { id, at } })
    yield* save(state, { ...state, rev: state.rev + 1, exits: [...exits, reason] })
  })

  const registerWork = Effect.fn("ChildLifecycle.registerWork")(function* (id: string, work: Background) {
    const info = yield* infoOf(work.owner).pipe(Effect.option)
    if (Option.exists(info, (owner) => Boolean(owner.parentID))) job(id, work)
  })

  const forget = Effect.fn("ChildLifecycle.forget")(function* (child: string) {
    current.delete(child)
    starts.delete(child)
    active.delete(child)
    parents.delete(child)
    stopping.delete(child)
    for (const [id, item] of background) if (item.owner === child) background.delete(id)
    for (const [id, item] of inbox) if (item.child === child) inbox.delete(id)
    yield* ctx.storage.remove(keyOf(child))
  })

  const absorb = Effect.fn("ChildLifecycle.absorb")(function* (event: typeof ExecutionEvent.Type) {
    const child = event.data.sessionID
    if (event.durable.aggregateID !== child) return
    const found = yield* infoOf(child).pipe(Effect.option)
    if (Option.isNone(found) || !found.value.parentID) return
    const parent = found.value.parentID
    yield* record(child, parent, executionFact(event, parent))
  })

  const updateInbox = Effect.fn("ChildLifecycle.updateInbox")(function* (event: InboxEvent) {
    const { sessionID: child, inboxID } = event.data
    const { aggregateID, seq } = event.durable
    if (aggregateID !== child) return
    const existing = inbox.get(inboxID)
    if (existing && (existing.child !== child || existing.seq >= seq)) return
    const found = yield* infoOf(child).pipe(Effect.option)
    if (Option.isNone(found) || !found.value.parentID) return
    const pending = event.type === "session.inbox.enqueued"
    if (event.type === "session.inbox.enqueued") {
      const { shellID } = event.data.item.payload.metadata
      const state = yield* load(child, found.value.parentID)
      if (state.exits?.some((item) => item.shellID === shellID)) {
        yield* save(state, { ...state, rev: state.rev + 1, exits: state.exits.filter((item) => item.shellID !== shellID) })
      }
      inbox.set(inboxID, { child, seq, pending, shellID })
    } else {
      inbox.set(inboxID, { ...existing, child, seq, pending })
    }
    if (inbox.size > MAX_TRACKED) {
      const closed = inbox.entries().find(([, item]) => !item.pending)
      if (closed) inbox.delete(closed[0])
    }
  })

  const fold = Effect.fn("ChildLifecycle.fold")(function* (event: Event) {
    if (event.location && !sameLocation(event.location, ctx.location)) return
    if (isInboxEvent(event)) return yield* updateInbox(event)
    if ("durable" in event) return yield* absorb(event)
    switch (event.type) {
      case "shell.created": {
        const { id, time, metadata, status } = event.data.info
        // A native shell can publish globally from its process scope. Its
        // host-issued session ID is revalidated in this location before use.
        if (!metadata.sessionID) return
        return yield* registerWork(id, { owner: metadata.sessionID, kind: "Shell", running: status === "running", at: time.started, native: true, backgrounded: metadata.background === true })
      }
      case "shell.exited":
        return yield* shellExit(event.data.id, event.id, event.created)
      case "shell.deleted":
        releaseShell(event.data.id)
        return
      case "experimental.job.updated": {
        const item = event.data.info
        if (item.kind === "shell") {
          if (!item.shellID) return
          return yield* registerWork(item.shellID, { owner: item.sessionID, kind: "Shell", running: item.status === "running", at: item.time.started, backgrounded: true })
        }
        return yield* registerWork(item.id, { owner: item.sessionID, kind: "Child", running: item.status === "running", at: item.time.started })
      }
      case "session.deleted": {
        if (event.location) return yield* forget(event.data.sessionID)
      }
    }
  })

  const record = Effect.fn("ChildLifecycle.record")(function* (child: string, parent: string, fact: Fact) {
    const state = yield* load(child, parent)
    const next = evolve(state, fact)
    if (next === state) return
    const written = yield* save(state, next)
    if (!written) return
    if (next.start && next.start !== state.start) starts.set(child, next.start.seq)
    if (next.segment === state.segment) return
    // Seeing a late diagnostic after activation does not validate a stored terminal.
    current.add(child)
    if (next.segment?.terminal) active.delete(child)
    else active.add(child)
    if (current.size > MAX_TRACKED) {
      for (const obsolete of current) {
        current.delete(obsolete)
        starts.delete(obsolete)
        active.delete(obsolete)
        break
      }
    }
  })

  const stream = subscribe(ctx).pipe(
    Stream.filterMap(decodeEvent),
    Stream.runForEach((event) => lock.withPermits(1)(fold(event))),
    Effect.ensuring(Effect.sync(() => { current.clear(); starts.clear(); background.clear(); inbox.clear(); active.clear() })),
    Effect.catchCause(() => Effect.logWarning("subagents: lifecycle subscriber stopped; using coarse session snapshots")),
  )
  yield* Effect.forkScoped(stream, { startImmediately: true })

  const sample = Effect.fn("ChildLifecycle.sample")(function* (state: Projection, view: Observation) {
    // Background and latch observations can change without a durable
    // execution event. Advance their read revision, not the host sequence.
    const sampled = sampleKey(view)
    if (sampled === state.sampled) return view
    const rev = state.rev + 1
    if (yield* save(state, { ...state, rev, sampled })) return { ...view, revision: rev }
    const latest = yield* load(state.child, state.parent)
    return { version: 1 as const, child: state.child, revision: latest.rev, phase: Phase.cases.Unknown.make({}) }
  })

  const read = Effect.fn("ChildLifecycle.read")(function* (child: string) {
    return yield* lock.withPermits(1)(Effect.gen(function* () {
      const info = yield* infoOf(child)
      if (!info.parentID) return { info, observation: Option.none() }
      const state = yield* load(child, info.parentID)
      const snapshot = snapshotOf(info, liveWork(child), false)
      // A terminal observed after restart cannot use an older saved start as
      // its identity. The pinned host tells us only the terminal's own seq.
      const fresh = current.has(child) && Boolean(state.start && starts.get(child) === state.start.seq)
      const lastStop = Option.fromUndefinedOr(stopping.get(child))
      const observed = observe(state, snapshot, fresh)
      if (Option.isNone(lastStop)) return { info, observation: Option.some(yield* sample(state, observed)) }
      const phase = observed.phase
      if (phase._tag === "Settled" && phase.terminal && phase.terminal.seq > lastStop.value) {
        stopping.delete(child)
        return { info, observation: Option.some(yield* sample(state, observed)) }
      }
      return { info, observation: Option.some(yield* sample(state, observe(state, { ...snapshot, stopUncertain: true }, fresh))) }
    })).pipe(Effect.option)
  })

  return {
    read,
    stopUncertain: (child: string, observed: Option.Option<Observation>) =>
      lock.withPermits(1)(Effect.sync(() => {
        const before = Option.getOrElse(Option.fromUndefinedOr(stopping.get(child)), () => -1)
        const phase = Option.map(observed, (value) => value.phase)
        const terminal = Option.flatMap(phase, (value) => {
          if (value._tag === "Settled") return Option.fromUndefinedOr(value.terminal)
          return Option.none()
        })
        const seq = Option.getOrElse(Option.map(terminal, (point) => point.seq), () => -1)
        stopping.set(child, Math.max(seq, before))
      })),
  }
})

export type ChildLifecycle = Effect.Success<ReturnType<typeof make>>
