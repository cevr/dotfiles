import type { Plugin } from "@opencode/plugin/effect"
import { Array as Arr, DateTime, Effect, Match, Option, Predicate, Ref, Schema, Semaphore, Stream, type Types } from "effect"
import { Diagnostic, Fact, Hold, Phase, Terminal, Undetermined, decide, evolve, executionActive, initial, present, Projection, workEvidence, type Cause, type Snapshot, type WorkEvidence } from "../child-lifecycle.ts"
import { RowFact } from "../child-row.ts"
import { Observation } from "../child-lifecycle.ts"
import { readMark, MarkRead } from "../../wake/latch.ts"
import { CHILD_ROWS } from "./child-row.ts"

type Info = Effect.Success<ReturnType<Plugin.Context["session"]["get"]>>
type Location = Pick<Info["location"], "directory" | "workspaceID">

const TYPES = [
  "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.step.failed", "session.retry.scheduled", "session.deleted",
  "shell.created", "shell.exited", "shell.deleted", "experimental.job.updated",
  "session.inbox.enqueued", "session.inbox.delivered", "session.inbox.cancelled",
  "permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled",
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
const AttentionEvent = Schema.Union([
  Schema.Struct({ ...Position, type: Schema.Literal("permission.asked"), data: Schema.Struct({ ...Session, id: Schema.String }) }),
  Schema.Struct({ ...Position, type: Schema.Literal("permission.replied"), data: Schema.Struct({ ...Session, requestID: Schema.String }) }),
  Schema.Struct({ ...Position, type: Schema.Literal("form.created"), data: Schema.Struct({ form: Schema.Struct({ ...Session, id: Schema.String }) }) }),
  Schema.Struct({ ...Position, type: Schema.Literals(["form.replied", "form.cancelled"]), data: Schema.Struct({ ...Session, id: Schema.String }) }),
])
type AttentionEvent = typeof AttentionEvent.Type
const Event = Schema.Union([
  ExecutionEvent,
  InboxEvent,
  AttentionEvent,
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
export const decodeEvent = Schema.decodeUnknownResult(Event)
const isInboxEvent = (event: Event): event is InboxEvent =>
  event.type === "session.inbox.enqueued" || event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled"

const toAttention = (event: AttentionEvent) => {
  const at = event.created
  switch (event.type) {
    case "permission.asked": return { child: event.data.sessionID, id: event.data.id, kind: "permission" as const, at, open: true }
    case "permission.replied": return { child: event.data.sessionID, id: event.data.requestID, kind: "permission" as const, at, open: false }
    case "form.created": return { child: event.data.form.sessionID, id: event.data.form.id, kind: "question" as const, at, open: true }
    default: return { child: event.data.sessionID, id: event.data.id, kind: "question" as const, at, open: false }
  }
}

const SessionID = Schema.String.check(Schema.isStartingWith("ses")).pipe(Schema.brand("SessionID"))
const sessionID = Schema.decodeUnknownOption(SessionID)
const readProjection = Schema.decodeUnknownOption(Projection)
const prefix = "child-lifecycle:"
const sampleKey = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({
  view: Observation.mapFields(({ version, child, started, phase, diagnostic, basis }) => ({ version, child, started, phase, diagnostic, basis })),
  mark: MarkRead, at: Schema.Finite, attention: Schema.optionalKey(Schema.Literals(["permission", "question"])),
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

export const executionFact = (
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

export const inboxFact = (event: InboxEvent, parent: string): Fact =>
  Fact.cases.Inbox.make({
    child: event.data.sessionID, parent, id: event.data.inboxID, seq: event.durable.seq,
    ...inboxShell(event),
  })
const inboxShell = (event: InboxEvent) => {
  if (event.type === "session.inbox.enqueued") return { shellID: event.data.item.payload.metadata.shellID }
  if (event.type === "session.inbox.cancelled") return { disposition: "cancelled" as const }
  return { disposition: "delivered" as const }
}

export const durableFact = (event: Event, parent: string): Option.Option<Fact> => {
  if (!("durable" in event) || event.durable.aggregateID !== event.data.sessionID) return Option.none()
  if (isInboxEvent(event)) return Option.some(inboxFact(event, parent))
  return Option.some(executionFact(event, parent))
}

const interrupted = (reason: string): typeof Terminal.Type => {
  if (reason === "shutdown") return Terminal.cases.Shutdown.make({})
  if (reason === "user") return Terminal.cases.Ended.make({ outcome: "interrupted", cause: "UserStop" })
  return Terminal.cases.Ended.make({ outcome: "interrupted", cause: "Unknown" })
}

const snapshotOf = (info: Info, mark: MarkRead): Snapshot => {
  const millis = (time: Info["time"]["busy"]) => Option.map(Option.fromUndefinedOr(time), DateTime.toEpochMillis)
  const busyAt = millis(info.time.busy)
  const idleAt = millis(info.time.idle)
  const running = Option.exists(busyAt, (at) => Option.isNone(idleAt) || at > idleAt.value)
  const value: Types.Mutable<Snapshot> = { running }
  if (info.outcome) value.outcome = info.outcome
  if (Option.isSome(busyAt)) value.busyAt = busyAt.value
  if (Option.isSome(idleAt)) value.idleAt = idleAt.value
  if (mark._tag === "Readable") {
    const { hold, opensAt, recheckAt, cancelledAt, failed } = mark.mark
    value.latchCancelled = Option.isSome(Option.fromUndefinedOr(cancelledAt))
    value.latchFailed = Option.isSome(Option.fromUndefinedOr(failed))
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

type Work = typeof Fact.cases.Work.Type.work

const oldFact = (view: Observation) => {
  const { phase } = view
  if (phase._tag === "Unknown" && phase.reason)
    return RowFact.cases.ShellResultUndetermined.make({ at: phase.reason.exit.at })
  if (view.basis === "current" && phase._tag === "Settled" && phase.outcome === "failed" && phase.terminal)
    return RowFact.cases.Failed.make({ at: phase.terminal.at })
  return RowFact.cases.NoFact.make({})
}

const rowAt = (view: Observation, snapshot: Snapshot, mark: MarkRead, created: number) => {
  const { phase } = view
  if (phase._tag === "Latched" && mark._tag === "Readable") return mark.mark.at
  if (phase._tag === "Unknown" && phase.reason) return phase.reason.exit.at
  if (phase._tag === "Settled") {
    if (phase.terminal) return phase.terminal.at
    return Option.getOrElse(Option.orElse(
      Option.flatMap(Option.liftPredicate(mark, (mark) => mark._tag === "Readable"), ({ mark }) => Option.fromUndefinedOr(mark.cancelledAt)),
      () => Option.fromUndefinedOr(snapshot.idleAt),
    ), () => created)
  }
  if (phase._tag === "Continuing") return Option.getOrElse(Option.fromUndefinedOr(snapshot.idleAt), () => created)
  return Option.getOrElse(Option.fromUndefinedOr(snapshot.busyAt), () => created)
}

export const ownerAnswer = (view: Observation, mark: MarkRead, at: number, revision: number) => ({
  child: view.child, mark, at, fact: oldFact(view),
  observation: { ...view, revision, basis: Option.getOrElse(Option.fromUndefinedOr(view.basis), () => "current" as const) },
})

/** One location-bound subscriber and persisted projection; neither schedules work nor sends notices. */
export const make = Effect.fn("ChildLifecycle.make")(function* (ctx: Plugin.Context, subscribe: Subscribe) {
  const lock = yield* Semaphore.make(1)
  const announce = yield* Ref.make<(child: string, revision?: number) => Effect.Effect<void>>(() => Effect.void)
  const { directory, workspaceID } = ctx.location
  const workspace = Option.getOrElse(Option.map(Option.fromUndefinedOr(workspaceID), String), () => "")
  const locationPrefix = `${prefix}${directory.length}:${directory}:${workspace}:`
  const keyOf = (child: string) => `${locationPrefix}${child}`
  const epoch = `${locationPrefix}activation`
  const lastEpoch = yield* ctx.storage.get(epoch)
  const readEpoch = Schema.decodeUnknownOption(Schema.Int)
  const activation = 1 + Option.getOrElse(readEpoch(lastEpoch), () => 0)
  yield* ctx.storage.set(epoch, activation)

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
    return info
  })

  const findStored = Effect.fn("ChildLifecycle.findStored")(function* (matches: (state: Projection) => boolean) {
    let page = yield* ctx.storage.scan({ prefix: locationPrefix, limit: 128 })
    while (true) {
      for (const entry of page.entries) {
        const state = readProjection(entry.value)
        if (Option.exists(state, matches)) return state
      }
      const after = Option.fromUndefinedOr(page.next)
      if (Option.isNone(after)) return Option.none<Projection>()
      page = yield* ctx.storage.scan({ prefix: locationPrefix, after: after.value, limit: 128 })
    }
  })

  const ownerOfShell = (id: string) => findStored(({ work, shellOwners }) =>
    Boolean(work?.[id]?.running || (shellOwners && Object.hasOwn(shellOwners, id))),
  )

  const ownedBy = Effect.fn("ChildLifecycle.ownedBy")(function* (parent: string, child: string) {
    let id = parent
    for (let depth = 0; depth < 32; depth++) {
      if (id === child) return true
      const found = yield* infoOf(id).pipe(Effect.option)
      if (Option.isNone(found) || !found.value.parentID) return false
      id = found.value.parentID
    }
    return false
  })
  const isLive = Predicate.or(Predicate.isTagged("Running"), Predicate.isTagged("Continuing"))
  const liveDescendant = Effect.fn("ChildLifecycle.liveDescendant")(function* (candidate: Projection, child: string) {
    const work = workEvidence(candidate)
    if (candidate.child === child || !(executionActive(candidate) || Option.isSome(work))) return Option.none<WorkEvidence>()
    if (!(yield* ownedBy(candidate.parent, child))) return Option.none<WorkEvidence>()
    const info = yield* infoOf(candidate.child).pipe(Effect.option)
    if (Option.isNone(info)) return Option.none<WorkEvidence>()
    const snapshot = snapshotOf(info.value, readMark(info.value.metadata))
    const choice = decide(candidate, snapshot, activation, work)
    if (!isLive(choice.phase)) return Option.none<WorkEvidence>()
    return Option.some<WorkEvidence>({ kind: "Child", facts: choice.facts })
  })
  const childWork = Effect.fn("ChildLifecycle.childWork")(function* (child: string) {
    let page = yield* ctx.storage.scan({ prefix: locationPrefix, limit: 128 })
    while (true) {
      for (const entry of page.entries) {
        const decoded = readProjection(entry.value)
        if (Option.isNone(decoded)) continue
        const live = yield* liveDescendant(decoded.value, child)
        if (Option.isSome(live)) return live
      }
      const after = Option.fromUndefinedOr(page.next)
      if (Option.isNone(after)) return Option.none<WorkEvidence>()
      page = yield* ctx.storage.scan({ prefix: locationPrefix, after: after.value, limit: 128 })
    }
  })

  const shellExit = Effect.fn("ChildLifecycle.shellExit")(function* (shellID: string, id: string, at: number) {
    const owner = yield* ownerOfShell(shellID)
    if (Option.isNone(owner)) return
    const { child, shellOwners } = owner.value
    const info = yield* infoOf(child).pipe(Effect.option)
    if (Option.isNone(info) || !info.value.parentID) return
    const parent = info.value.parentID
    if (shellOwners && Object.hasOwn(shellOwners, shellID)) {
      const reason = Undetermined.make({ shellID, exit: { id, at } })
      yield* record(child, parent, Fact.cases.Exit.make({ child, parent, reason }))
    } else yield* record(child, parent, Fact.cases.ShellRemoved.make({ child, parent, id: shellID }))
  })

  const registerWork = Effect.fn("ChildLifecycle.registerWork")(function* (child: string, id: string, work: Work) {
    const info = yield* infoOf(child).pipe(Effect.option)
    if (Option.isNone(info) || !info.value.parentID) return
    const parent = info.value.parentID
    yield* record(child, parent, Fact.cases.Work.make({ child, parent, id, work }))
  })

  const deleteShell = Effect.fn("ChildLifecycle.deleteShell")(function* (id: string) {
    const owner = yield* ownerOfShell(id)
    if (Option.isNone(owner)) return
    const { child } = owner.value
    const found = yield* infoOf(child).pipe(Effect.option)
    if (Option.isNone(found) || !found.value.parentID) return
    const parent = found.value.parentID
    yield* record(child, parent, Fact.cases.ShellRemoved.make({ child, parent, id }))
  })

  const forget = Effect.fn("ChildLifecycle.forget")(function* (child: string) {
    const prior = readProjection(yield* ctx.storage.get(keyOf(child)))
    yield* ctx.storage.remove(keyOf(child))
    if (Option.isSome(prior)) yield* invalidate(prior.value.parent)
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
    const { sessionID: child } = event.data
    const { aggregateID } = event.durable
    if (aggregateID !== child) return
    const found = yield* infoOf(child).pipe(Effect.option)
    if (Option.isNone(found) || !found.value.parentID) return
    const parent = found.value.parentID
    yield* record(child, parent, inboxFact(event, parent))
  })
  const attention = Effect.fn("ChildLifecycle.attention")(function* (event: AttentionEvent) {
    const request = toAttention(event)
    const found = yield* infoOf(request.child).pipe(Effect.option)
    if (Option.isNone(found) || !found.value.parentID) return
    const parent = found.value.parentID
    yield* record(request.child, parent, Fact.cases.Attention.make({ ...request, parent }))
  })

  const fold = Effect.fn("ChildLifecycle.fold")(function* (event: Event) {
    if (event.location && !sameLocation(event.location, ctx.location)) return
    if (isInboxEvent(event)) return yield* updateInbox(event)
    if ("durable" in event) return yield* absorb(event)
    switch (event.type) {
      case "permission.asked":
      case "permission.replied":
      case "form.created":
      case "form.replied":
      case "form.cancelled":
        return yield* attention(event)
      case "shell.created": {
        const { id, time, metadata, status } = event.data.info
        // A native shell can publish globally from its process scope. Its
        // host-issued session ID is revalidated in this location before use.
        if (!metadata.sessionID) return
        return yield* registerWork(metadata.sessionID, id, { kind: "Shell", running: status === "running", at: time.started, native: true, backgrounded: metadata.background === true })
      }
      case "shell.exited":
        return yield* shellExit(event.data.id, event.id, event.created)
      case "shell.deleted":
        return yield* deleteShell(event.data.id)
      case "experimental.job.updated": {
        const item = event.data.info
        if (item.kind === "shell") {
          if (!item.shellID) return
          return yield* registerWork(item.sessionID, item.shellID, { kind: "Shell", running: item.status === "running", at: item.time.started, native: false, backgrounded: true })
        }
        return yield* registerWork(item.sessionID, item.id, { kind: "Child", running: item.status === "running", at: item.time.started, native: false, backgrounded: false })
      }
      case "session.deleted": {
        if (event.location) return yield* forget(event.data.sessionID)
      }
    }
  })

  const record = Effect.fn("ChildLifecycle.record")(function* (child: string, parent: string, fact: Fact) {
    const state = yield* load(child, parent)
    const next = evolve(state, { ...fact, seenIn: activation })
    if (next === state) return
    const written = yield* save(state, next)
    if (!written) return
    const publish = yield* Ref.get(announce)
    yield* publish(child, next.rev)
    yield* invalidate(parent)
  })

  const invalidate = Effect.fn("ChildLifecycle.invalidate")(function* (ancestor: string) {
    const publish = yield* Ref.get(announce)
    for (let depth = 0; depth < 32; depth++) {
      const found = yield* infoOf(ancestor).pipe(Effect.option)
      if (Option.isNone(found) || !found.value.parentID) return
      yield* publish(ancestor)
      ancestor = found.value.parentID
    }
  })

  const sample = Effect.fn("ChildLifecycle.sample")(function* (state: Projection, view: Observation, mark: MarkRead, at: number, attention?: "permission" | "question") {
    const sampled = sampleKey({ view, mark, at, ...Option.match(Option.fromUndefinedOr(attention), { onNone: () => ({}), onSome: (attention) => ({ attention }) }) })
    if (sampled === state.sampled) return state.rev
    const rev = state.rev + 1
    if (yield* save(state, { ...state, rev, sampled })) return rev
    return yield* Effect.fail("lifecycle revision changed")
  })

  const readOwner = Effect.fn("ChildLifecycle.readOwner")(function* (child: string) {
    const info = yield* infoOf(child)
    if (!info.parentID) return { info, answer: Option.none() }
    const state = yield* load(child, info.parentID)
    let background = workEvidence(state)
    if (Option.isNone(background) && !executionActive(state)) background = yield* childWork(child)
    const mark = readMark(info.metadata)
    const snapshot = snapshotOf(info, mark)
    const observed = present(state, { ...snapshot, stopUncertain: Option.isSome(Option.fromUndefinedOr(state.stopAfter)) }, activation, background)
    const created = Option.getOrElse(Option.map(Option.fromUndefinedOr(info.time.created), DateTime.toEpochMillis), () => 0)
    const at = rowAt(observed, snapshot, mark, created)
    const requests = Object.values(Option.getOrElse(Option.fromUndefinedOr(state.attention), () => ({})))
    const waiting = Option.map(Option.fromUndefinedOr(requests.find((item) => item.open)), ({ kind }) => kind)
    const revision = yield* sample(state, observed, mark, at, Option.getOrUndefined(waiting))
    const value = ownerAnswer(observed, mark, at, revision)
    const answer = Option.map(Option.some(value), (value) => ({
      ...value,
      ...Option.match(waiting, { onNone: () => ({}), onSome: (attention) => ({ attention }) }),
    }))
    return { info, answer }
  })

  const read = Effect.fn("ChildLifecycle.read")((child: string) => lock.withPermits(1)(readOwner(child)).pipe(
    Effect.map(({ info, answer }) => ({ info, observation: Option.map(answer, ({ observation }) => observation) })),
    Effect.option,
  ))
  const rows = yield* ctx.rpc.register(CHILD_ROWS, {
    read: ({ children }) => lock.withPermits(1)(
      Effect.forEach(children, (child) => readOwner(child).pipe(
        Effect.map(({ answer }) => answer),
        Effect.orElseSucceed(() => Option.none()),
      )).pipe(Effect.map((rows) => ({ rows: Arr.getSomes(rows) }))),
    ),
  }).pipe(Effect.orDie)
  yield* Ref.set(announce, (child, revision) => rows.events.emit("changed", {
    child, ...Option.match(Option.fromUndefinedOr(revision), { onNone: () => ({}), onSome: (revision) => ({ revision }) }),
  }).pipe(Effect.ignore))
  const stream = subscribe(ctx).pipe(
    Stream.filterMap(decodeEvent),
    Stream.runForEach((event) => lock.withPermits(1)(fold(event))),
    Effect.catchCause(() => Effect.logWarning("subagents: lifecycle subscriber stopped; retaining the last observed host facts")),
  )
  yield* Effect.forkScoped(stream, { startImmediately: true })

  return {
    read,
    parent: (child: string) => infoOf(child).pipe(
      Effect.map(({ parentID }) => Option.map(Option.fromUndefinedOr(parentID), String)),
      Effect.option,
    ),
    stopUncertain: (child: string, seq: number) =>
      lock.withPermits(1)(Effect.gen(function* () {
        const found = yield* infoOf(child).pipe(Effect.option)
        if (Option.isNone(found) || !found.value.parentID) return
        yield* record(child, found.value.parentID, Fact.cases.StopRequested.make({ child, parent: found.value.parentID, seq }))
      })),
  }
})

export type ChildLifecycle = Effect.Success<ReturnType<typeof make>>
