import {
  Array as Arr,
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberHandle,
  Layer,
  Match,
  Option,
  Predicate,
  Queue,
  Random,
  Ref,
  Scope,
  Semaphore,
} from "effect"
import { adapterFor, type Harness, type HarnessAdapter, type ResumeOptions, type StartOptions } from "./adapter.ts"
import {
  activeTurnOf,
  activeTurnTypedOf,
  DEFAULT_MACHINE_CONFIG,
  hasUndeliveredWakes,
  initialMachineState,
  type MachineAction,
  type MachineConfig,
  MachineEvent,
  type MachineState,
  nextRetryableWake,
  pendingTurnsOf,
  transition,
  wakeLetterOf,
} from "./machine.ts"
import { resumeBrief, taskBrief } from "./prompt.ts"
import {
  Notifier,
  type PaneLiveness,
  type PaneTarget,
  ResultFiles,
  type ResultReadFailed,
  RexClient,
  type RexError,
  type StoreConflict,
  StoreFailed,
  ToolTimedOut,
  WorkerCrashed,
  WorkerRejected,
  WorkerStore,
} from "./service.ts"
import {
  type ActiveTurn,
  type ClosePaneIntent,
  type DurableIntent,
  isLive,
  outboxOf,
  type PaneAnchor,
  type PaneWorker,
  type PaneWorkerView,
  parseDescription,
  pendingWakesOf,
  revisionOf,
  SplitPaneIntent,
  type StoreSnapshot,
  type TypeResumeIntent,
  type TypeTurnIntent,
  viewOf,
} from "./worker.ts"

export interface ModelConfig {
  readonly quietFor?: Duration.Input
  readonly pollTimeout?: Duration.Input
  readonly startupTimeout?: Duration.Input
  readonly pasteQuiet?: Duration.Input
  readonly retryDelay?: Duration.Input
  readonly maxWakeBackoff?: Duration.Input
  readonly maxStartupChecks?: number
  readonly maxTransientErrors?: number
  readonly confirmGoneCount?: number
  readonly maxWakeAttempts?: number
  readonly maxWriteAttempts?: number
  readonly maxWrittenIdlePolls?: number
  readonly storeDeadline?: Duration.Input
  readonly tailDeadline?: Duration.Input
  readonly askDeadline?: Duration.Input
  readonly readDeadline?: Duration.Input
  readonly writeDeadline?: Duration.Input
  readonly splitDeadline?: Duration.Input
  readonly closeDeadline?: Duration.Input
  readonly wakeDeadline?: Duration.Input
  readonly changedDeadline?: Duration.Input
  readonly binaryOverrides?: Readonly<Partial<Record<Harness, string>>>
}

export interface StartInput {
  readonly parentSessionID: string
  readonly directory: string
  readonly harness: Harness
  readonly description: string
  readonly prompt: string
  readonly resultFile: string
  readonly cwd?: string
  readonly addDirs?: ReadonlyArray<string>
  readonly rexSession?: string
  readonly rexBlock?: string
  readonly blockId?: string
  readonly skipPermissions?: boolean
}

export interface FollowUpInput {
  readonly parentSessionID: string
  readonly id: string
  readonly prompt: string
  readonly resultFile?: string
  readonly steer?: boolean
}

export interface RestartInput {
  readonly parentSessionID: string
  readonly id: string
  readonly prompt?: string
  readonly resultFile?: string
  readonly rexSession?: string
  readonly rexBlock?: string
}

export interface StopInput {
  readonly parentSessionID: string
  readonly id: string
  readonly close?: boolean
}

export type ModelError =
  | RexError
  | StoreFailed
  | StoreConflict
  | ResultReadFailed
  | WorkerRejected
  | WorkerCrashed
  | ToolTimedOut

export class PaneAgentModel extends Context.Service<
  PaneAgentModel,
  {
    readonly start: (input: StartInput) => Effect.Effect<PaneWorker, ModelError>
    readonly followUp: (input: FollowUpInput) => Effect.Effect<PaneWorker, ModelError>
    readonly restart: (input: RestartInput) => Effect.Effect<PaneWorker, ModelError>
    readonly stop: (input: StopInput) => Effect.Effect<PaneWorker, ModelError>
    readonly status: (parentSessionID: string, id: string) => Effect.Effect<PaneWorker, ModelError>
    readonly list: (parentSessionID: string) => Effect.Effect<ReadonlyArray<PaneWorker>, StoreFailed | WorkerCrashed | ToolTimedOut>
    readonly views: (parentSessionID: string) => Effect.Effect<ReadonlyArray<PaneWorkerView>, StoreFailed | WorkerCrashed | ToolTimedOut>
    readonly bindPane: (sessionID: string, anchor: PaneAnchor) => Effect.Effect<void, StoreFailed | WorkerCrashed | ToolTimedOut>
    readonly reattach: (directory: string) => Effect.Effect<ReadonlyArray<PaneWorker>, ModelError>
  }
>()("dotfiles-opencode/pane-agent/PaneAgentModel") {}

const DEFAULT_QUIET = Duration.seconds(2)
const DEFAULT_POLL_TIMEOUT = Duration.seconds(5)
const DEFAULT_PASTE_QUIET = Duration.millis(200)
const DEFAULT_MAX_WAKE_BACKOFF = Duration.seconds(30)
const DEFAULT_STORE_DEADLINE = Duration.seconds(2)
const DEFAULT_TAIL_DEADLINE = Duration.seconds(1)
const DEFAULT_READ_DEADLINE = Duration.seconds(5)
const DEFAULT_WRITE_DEADLINE = Duration.seconds(5)
const DEFAULT_SPLIT_DEADLINE = Duration.seconds(10)
const DEFAULT_CLOSE_DEADLINE = Duration.seconds(3)
const DEFAULT_WAKE_DEADLINE = Duration.seconds(5)
const DEFAULT_CHANGED_DEADLINE = Duration.seconds(1)
const MAX_ACTOR_RESTARTS = 3
const MAILBOX_CAPACITY = 128
const TAIL_BYTES = 16_384
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

const resolveDuration = (fallback: Duration.Duration, given?: Duration.Input): Duration.Duration =>
  Option.match(Option.fromUndefinedOr(given), {
    onNone: () => fallback,
    onSome: (input) => Duration.fromInputUnsafe(input),
  })

/** Sleeps while catching injected timer defects (never swallowing interrupts) so a faulty sleep never kills a race. */
const resilientSleep = (duration: Duration.Duration): Effect.Effect<void> => {
  if (Duration.isZero(duration)) return Effect.yieldNow
  return Effect.sleep(duration).pipe(
    Effect.catchDefect(() =>
      Effect.sleep(duration).pipe(Effect.catchDefect(() => Effect.yieldNow)),
    ),
  )
}

/** Background sleep immune to up to two simultaneous timer.sleep hangs or defects. */
const pauseFor = (delay: Duration.Duration): Effect.Effect<void> => {
  if (Duration.isZero(delay)) return Effect.yieldNow
  const backup1 = Duration.max(Duration.millis(10), Duration.times(delay, 2))
  const backup2 = Duration.max(Duration.millis(15), Duration.times(delay, 3))
  return Effect.raceFirst(resilientSleep(delay), Effect.raceFirst(resilientSleep(backup1), resilientSleep(backup2)))
}

type BoundedOutcome<A, E> = Data.TaggedEnum<{
  readonly Succeeded: { readonly value: A }
  readonly Failed: { readonly error: E }
  readonly TimedOut: { readonly deadlineMs: number }
  readonly Died: { readonly defect: string }
}>

interface BoundedOutcomeDef extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: BoundedOutcome<this["A"], this["B"]>
}

const BoundedOutcome = Data.taggedEnum<BoundedOutcomeDef>()

const exitToOutcome = <A, E>(exit: Exit.Exit<A, E>): BoundedOutcome<A, E> =>
  Exit.match(exit, {
    onSuccess: (value) => BoundedOutcome.Succeeded<A, E>({ value }),
    onFailure: (cause) =>
      Option.match(Cause.findErrorOption(cause), {
        onSome: (error) => BoundedOutcome.Failed<A, E>({ error }),
        onNone: () => BoundedOutcome.Died<A, E>({ defect: Cause.pretty(cause) }),
      }),
  })

/** Runs any effect under a strict deadline, immune to a simultaneous dependency hang and timer.sleep hang. */
const runBounded = <A, E>(
  deadline: Duration.Duration,
  effect: Effect.Effect<A, E>,
): Effect.Effect<BoundedOutcome<A, E>> => {
  const deadlineMs = Math.max(1, Math.round(Duration.toMillis(deadline)))
  const work: Effect.Effect<BoundedOutcome<A, E>> = Effect.exit(effect).pipe(Effect.map(exitToOutcome))
  const timer1: Effect.Effect<BoundedOutcome<A, E>> = resilientSleep(deadline).pipe(
    Effect.as<BoundedOutcome<A, E>>(BoundedOutcome.TimedOut<A, E>({ deadlineMs })),
  )
  const timer2: Effect.Effect<BoundedOutcome<A, E>> = resilientSleep(Duration.millis(deadlineMs + 5)).pipe(
    Effect.as<BoundedOutcome<A, E>>(BoundedOutcome.TimedOut<A, E>({ deadlineMs })),
  )
  return Effect.raceFirst(work, Effect.raceFirst(timer1, timer2))
}

const runToolBounded = runBounded

const computeBackoff = (base: Duration.Duration, cap: Duration.Duration, attempts: number): Duration.Duration => {
  if (attempts <= 0 || Duration.isZero(base)) return Duration.zero
  const factor = Math.min(32, 2 ** Math.max(0, attempts - 1))
  const scaledMs = Math.min(Duration.toMillis(cap), Duration.toMillis(base) * factor)
  return Duration.millis(scaledMs)
}

const targetOf = (worker: Pick<PaneWorker, "rexSessionId" | "blockId">): PaneTarget => ({
  sessionId: worker.rexSessionId,
  blockId: worker.blockId,
})

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "")

const parentDirOf = (file: string): Option.Option<string> => {
  const index = file.lastIndexOf("/")
  if (index <= 0) return Option.none()
  return Option.some(stripTrailingSlash(file.slice(0, index)))
}

const isWithin = (dir: string, root: string): boolean => dir === root || dir.startsWith(`${root}/`)

/** Computes deduplicated --add-dir entries outside cwd, including the result file's parent directory. */
export const computeAddDirs = (
  cwd: string,
  resultFile: string,
  explicit?: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const normCwd = stripTrailingSlash(cwd)
  const seen = new Set<string>()
  const out: Array<string> = []
  const add = (candidate: string) => {
    const clean = stripTrailingSlash(candidate.trim())
    if (clean.length === 0 || isWithin(clean, normCwd) || seen.has(clean)) return
    seen.add(clean)
    out.push(clean)
  }
  const given = Option.fromUndefinedOr(explicit)
  if (Option.isSome(given)) {
    for (const dir of given.value) add(dir)
  }
  const resultParent = parentDirOf(resultFile)
  if (Option.isSome(resultParent)) add(resultParent.value)
  return out
}

const shortLines = (text: string, maxLines = 12): string =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-maxLines)
    .join("\n")

const makeRandomToken = (prefix: string) =>
  Effect.gen(function* () {
    const n = yield* Random.nextIntBetween(0x100000, 0xffffff)
    return `${prefix}_${n.toString(36)}`
  })

/** Mints an OpenCode-compatible ascending `msg_` delivery id using Effect Clock and Random. */
const makeDeliveryIdMinter = Effect.gen(function* () {
  const seq = yield* Ref.make(0)
  return Effect.fn("PaneAgent.mintDeliveryId")(function* () {
    const now = yield* Clock.currentTimeMillis
    const counter = yield* Ref.updateAndGet(seq, (n) => (n + 1) % 0xfff)
    const value = BigInt(now) * 0x1000n + BigInt(counter + 1)
    let hex = ""
    for (let index = 0; index < 6; index++) {
      const byte = Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      hex += byte.toString(16).padStart(2, "0")
    }
    let suffix = ""
    for (let index = 0; index < 14; index++) {
      const idx = yield* Random.nextIntBetween(0, BASE62.length - 1)
      suffix += BASE62.charAt(idx)
    }
    return `msg_${hex}${suffix}`
  })
})

const buildStartOptions = (
  harness: Harness,
  addDirs: ReadonlyArray<string>,
  skipPermissions: boolean,
  overrides?: Readonly<Partial<Record<Harness, string>>>,
): StartOptions => {
  const binary = Option.flatMap(Option.fromUndefinedOr(overrides), (map) => Option.fromUndefinedOr(map[harness]))
  return Option.match(binary, {
    onNone: (): StartOptions => ({ addDirs, skipPermissions }),
    onSome: (value): StartOptions => ({ binary: value, addDirs, skipPermissions }),
  })
}

const buildResumeOptions = (
  harness: Harness,
  initialPrompt: string,
  addDirs: ReadonlyArray<string>,
  skipPermissions: boolean,
  overrides?: Readonly<Partial<Record<Harness, string>>>,
): ResumeOptions => {
  const binary = Option.flatMap(Option.fromUndefinedOr(overrides), (map) => Option.fromUndefinedOr(map[harness]))
  return Option.match(binary, {
    onNone: (): ResumeOptions => ({ initialPrompt, addDirs, skipPermissions }),
    onSome: (value): ResumeOptions => ({ binary: value, initialPrompt, addDirs, skipPermissions }),
  })
}

interface AnchorHints {
  readonly rexSession?: string
  readonly rexBlock?: string
}

const resolveAnchor = (hints: AnchorHints, saved: Option.Option<PaneAnchor>): Option.Option<PaneAnchor> => {
  const explicit = Option.all({
    session: Option.filter(Option.fromUndefinedOr(hints.rexSession), (s) => s.length > 0),
    block: Option.filter(Option.fromUndefinedOr(hints.rexBlock), (b) => b.length > 0),
  })
  if (Option.isSome(explicit)) return explicit
  return saved
}

const splitLabelFor = (harness: Harness, unit: string, reqId: string): string => {
  const suffix = `#${reqId}`
  const maxHead = Math.max(1, 48 - suffix.length)
  return `${harness}:${unit}`.slice(0, maxHead) + suffix
}

const needsPaneWork = (worker: PaneWorker): boolean =>
  outboxOf(worker).length > 0 ||
  (worker.state !== "pane_gone" &&
    worker.state !== "stopped" &&
    worker.state !== "failed" &&
    (isLive(worker.state) || pendingTurnsOf(worker).length > 0))

const hasAction = (actions: ReadonlyArray<MachineAction>, tag: MachineAction["_tag"]): boolean =>
  actions.some((action) => action._tag === tag)

const tokenOfBrief = (brief: string): Option.Option<string> =>
  Option.fromNullishOr(/\bTK-[a-z0-9]+-\d+\b/.exec(brief)).pipe(Option.flatMap((m) => Option.fromUndefinedOr(m[0])))

const screenMatchesSteer = (screen: string, active: ActiveTurn): boolean => {
  const token = tokenOfBrief(active.brief)
  if (Option.isSome(token)) return screen.includes(token.value)
  return true
}

const canFollowUpState = (state: PaneWorker["state"]): boolean =>
  state !== "stopped" && state !== "pane_gone" && state !== "failed"

const canRestartState = (state: PaneWorker["state"]): boolean =>
  state === "pane_gone" || state === "stopped" || state === "failed"

/** Messages processed serially by a worker's single supervised actor mailbox. */
type ActorMessage = Data.TaggedEnum<{
  readonly CmdFollowUp: {
    readonly input: FollowUpInput
    readonly reply: Deferred.Deferred<PaneWorker, ModelError>
  }
  readonly CmdRestart: {
    readonly input: RestartInput
    readonly anchor: PaneAnchor
    readonly reply: Deferred.Deferred<PaneWorker, ModelError>
  }
  readonly CmdStop: {
    readonly input: StopInput
    readonly reply: Deferred.Deferred<PaneWorker, ModelError>
  }
  readonly CmdStatus: {
    readonly parentSessionID: string
    readonly reply: Deferred.Deferred<PaneWorker, ModelError>
  }
  readonly CmdReattach: { readonly reply: Deferred.Deferred<PaneWorker, ModelError> }
  readonly CmdNudgeProbe: {}
  readonly SignInLimited: { readonly resetAt: number }
  readonly IoSplitResult: {
    readonly gen: number
    readonly intentId: string
    readonly outcome: BoundedOutcome<string, RexError>
  }
  readonly IoTypeTurnResult: {
    readonly gen: number
    readonly intentId: string
    readonly turn: number
    readonly result:
      | { readonly kind: "ok" }
      | { readonly kind: "prompt"; readonly summary: string; readonly tail: string }
      | { readonly kind: "failed"; readonly failKind: "not_sent" | "ambiguous" | "unsupported" | "gone"; readonly chunkIndex: number; readonly reason: string }
  }
  readonly IoTypeResumeResult: {
    readonly gen: number
    readonly intentId: string
    readonly turn: number
    readonly result:
      | { readonly kind: "ok" }
      | { readonly kind: "prompt"; readonly summary: string; readonly tail: string }
      | { readonly kind: "failed"; readonly failKind: "retry" | "ambiguous" | "not_typed"; readonly reason: string }
  }
  readonly IoAmbiguousResult: {
    readonly gen: number
    readonly turn: number
    readonly result:
      | { readonly kind: "working" }
      | { readonly kind: "retry"; readonly reason: string }
      | { readonly kind: "not_typed"; readonly reason: string }
      | { readonly kind: "screen"; readonly screen: string }
      | { readonly kind: "gone" }
      | { readonly kind: "defer" }
  }
  readonly IoCloseResult: { readonly gen: number; readonly intentId: string; readonly ok: boolean }
  readonly IoScreenRead: { readonly gen: number; readonly screen: string }
  readonly IoIdleConfirmed: {
    readonly gen: number
    readonly screen: string
    readonly resultFileAnswer: Option.Option<string>
  }
  readonly IoPaneFault: {
    readonly gen: number
    readonly operation: string
    readonly kind: "gone" | "transient" | "unsupported"
    readonly message: string
    readonly defect?: boolean
  }
  readonly IoQuietDone: { readonly gen: number; readonly liveness: PaneLiveness; readonly lastScreen: string }
  readonly IoGoneProbe: {
    readonly gen: number
    readonly liveness: PaneLiveness
    readonly tail: string
    readonly resultFileAnswer: Option.Option<string>
  }
  readonly IoRetryTick: { readonly gen: number }
  readonly IoRetryCommit: { readonly gen: number; readonly intentId: string }
  readonly IoPaneTaskExited: { readonly gen: number; readonly defect: Option.Option<string> }
  readonly IoPeerCheck: { readonly gen: number; readonly intentId: string; readonly expired: boolean }
  readonly IoWakeResult: { readonly gen: number; readonly deliveryId: string; readonly ok: boolean; readonly error: string }
  readonly IoWakeRetryCommit: { readonly gen: number; readonly deliveryId: string }
  readonly IoWakeTaskExited: { readonly gen: number; readonly deliveryId: string; readonly defect: Option.Option<string> }
}>

type AmbiguousOutcome = Extract<ActorMessage, { readonly _tag: "IoAmbiguousResult" }>["result"]

const ActorMessage = Data.taggedEnum<ActorMessage>()

type PaneIoMode = "read" | "confirm_idle" | "wait_quiet" | "confirm_gone" | "retry_delay" | "wait_limit"

interface ActorEntry {
  readonly mailbox: Queue.Queue<ActorMessage>
  readonly harness: Harness
  probePending: boolean
}

const isCommandWithReply = Predicate.or(
  Predicate.or(Predicate.isTagged("CmdFollowUp"), Predicate.isTagged("CmdRestart")),
  Predicate.or(
    Predicate.or(Predicate.isTagged("CmdStop"), Predicate.isTagged("CmdStatus")),
    Predicate.isTagged("CmdReattach"),
  ),
)

const isTerminalRexError = Predicate.or(
  Predicate.isTagged("RexPaneGone"),
  Predicate.isTagged("RexUnsupportedRevision"),
)

const isRetryableSplitRexError = Predicate.or(
  Predicate.isTagged("RexUnavailable"),
  Predicate.isTagged("RexPaneGone"),
)

const isWriteOrSplitIntent = Predicate.or(
  Predicate.isTagged("TypeTurn"),
  Predicate.isTagged("SplitPane"),
)

const isCompletionEvent = Predicate.or(
  Predicate.or(
    Predicate.or(Predicate.isTagged("TypeTurnSucceeded"), Predicate.isTagged("TypeTurnFailed")),
    Predicate.or(Predicate.isTagged("TypeTurnDeferredPrompt"), Predicate.isTagged("TypeResumeSucceeded")),
  ),
  Predicate.or(
    Predicate.or(
      Predicate.or(Predicate.isTagged("TypeResumeFailed"), Predicate.isTagged("TypeResumeDeferredPrompt")),
      Predicate.or(Predicate.isTagged("SplitSucceeded"), Predicate.isTagged("SplitFailed")),
    ),
    Predicate.or(
      Predicate.or(Predicate.isTagged("CloseCompleted"), Predicate.isTagged("AmbiguousResolved")),
      Predicate.or(Predicate.isTagged("WakeDelivered"), Predicate.isTagged("WakeFailed")),
    ),
  ),
)

interface PreWriteFailure {
  readonly failKind: "not_sent" | "unsupported" | "gone"
  readonly reason: string
}

interface PendingIntentCommit {
  readonly event: MachineEvent
  attempts: number
}

interface ActorRuntime {
  readonly id: string
  readonly entry: ActorEntry
  readonly mailbox: Queue.Queue<ActorMessage>
  readonly paneIo: FiberHandle.FiberHandle<void, never>
  readonly wakeIo: FiberHandle.FiberHandle<void, never>
  state: MachineState
  paneIoGen: number
  paneIoHandledGen: number
  paneIoRunning: boolean
  wakeIoGen: number
  wakeIoHandledGen: number
  wakeIoRunning: boolean
  nextPaneIo: PaneIoMode
  waitLimitUntil: number
  lastScreen: string
  needsReload: boolean
  freshFromStore: boolean
  needsInputPolls: number
  readonly pendingCommits: Map<string, PendingIntentCommit>
  readonly pendingWakeCommits: Map<string, PendingIntentCommit>
}

const failReplyOf = (msg: ActorMessage, workerId: string, reason: string): Effect.Effect<void> => {
  const err = new WorkerCrashed({ workerId, message: reason })
  if (isCommandWithReply(msg)) {
    return Deferred.fail(msg.reply, err).pipe(Effect.asVoid)
  }
  return Effect.void
}

const makeModel = (config: ModelConfig = {}) =>
  Effect.gen(function* () {
    const rex = yield* RexClient
    const store = yield* WorkerStore
    const results = yield* ResultFiles
    const notifier = yield* Notifier
    const scope = yield* Scope.Scope
    const procId = yield* makeRandomToken("proc")
    const actors = yield* Ref.make<ReadonlyMap<string, ActorEntry>>(new Map())
    const crashCounts = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
    const actorCreateLock = yield* Semaphore.make(1)
    const mintDeliveryId = yield* makeDeliveryIdMinter
    const changedIo = yield* FiberHandle.make<void, never>().pipe(Effect.provideService(Scope.Scope, scope))

    const quietFor = resolveDuration(DEFAULT_QUIET, config.quietFor)
    const pollTimeout = resolveDuration(DEFAULT_POLL_TIMEOUT, config.pollTimeout)
    const pasteQuiet = resolveDuration(DEFAULT_PASTE_QUIET, config.pasteQuiet)
    const retryDelay = resolveDuration(pasteQuiet, config.retryDelay)
    const maxWakeBackoff = resolveDuration(DEFAULT_MAX_WAKE_BACKOFF, config.maxWakeBackoff)
    const storeDeadline = resolveDuration(DEFAULT_STORE_DEADLINE, config.storeDeadline)
    const tailDeadline = resolveDuration(DEFAULT_TAIL_DEADLINE, config.tailDeadline)
    const askDeadline = resolveDuration(Duration.times(storeDeadline, 2), config.askDeadline)
    const readDeadline = resolveDuration(DEFAULT_READ_DEADLINE, config.readDeadline)
    const writeDeadline = resolveDuration(DEFAULT_WRITE_DEADLINE, config.writeDeadline)
    const splitDeadline = resolveDuration(DEFAULT_SPLIT_DEADLINE, config.splitDeadline)
    const closeDeadline = resolveDuration(DEFAULT_CLOSE_DEADLINE, config.closeDeadline)
    const wakeDeadline = resolveDuration(DEFAULT_WAKE_DEADLINE, config.wakeDeadline)
    const changedDeadline = resolveDuration(DEFAULT_CHANGED_DEADLINE, config.changedDeadline)

    const machineConfig: MachineConfig = {
      maxTransientErrors: Option.getOrElse(
        Option.fromUndefinedOr(config.maxTransientErrors),
        () => DEFAULT_MACHINE_CONFIG.maxTransientErrors,
      ),
      confirmGoneCount: Option.getOrElse(
        Option.fromUndefinedOr(config.confirmGoneCount),
        () => DEFAULT_MACHINE_CONFIG.confirmGoneCount,
      ),
      maxWakeAttempts: Option.getOrElse(
        Option.fromUndefinedOr(config.maxWakeAttempts),
        () => DEFAULT_MACHINE_CONFIG.maxWakeAttempts,
      ),
      maxWriteAttempts: Option.getOrElse(
        Option.fromUndefinedOr(config.maxWriteAttempts),
        () => DEFAULT_MACHINE_CONFIG.maxWriteAttempts,
      ),
      maxWrittenIdlePolls: Option.getOrElse(
        Option.fromUndefinedOr(config.maxWrittenIdlePolls),
        () => DEFAULT_MACHINE_CONFIG.maxWrittenIdlePolls,
      ),
    }

    const scheduleChanged = (sessionID: string) =>
      FiberHandle.run(
        changedIo,
        runBounded(changedDeadline, notifier.changed(sessionID)).pipe(Effect.asVoid),
      ).pipe(Effect.asVoid)

    const boundedStoreRead = Effect.fn("PaneAgent.boundedStoreRead")(function* (
      workerId = "*",
    ): Effect.fn.Return<StoreSnapshot, StoreFailed | ToolTimedOut | WorkerCrashed> {
      const out = yield* runToolBounded(storeDeadline, store.read())
      if (out._tag === "Succeeded") return out.value
      if (out._tag === "Failed") return yield* out.error
      if (out._tag === "TimedOut") {
        return yield* new ToolTimedOut({
          operation: "store.read",
          workerId,
          deadlineMs: out.deadlineMs,
          message: `Store read timed out after ${out.deadlineMs}ms`,
        })
      }
      return yield* new WorkerCrashed({ workerId, message: `Store read died: ${out.defect}` })
    })

    const lateWriteMatched = (found: PaneWorker, next: PaneWorker, expectedRev: number): boolean => {
      if (revisionOf(found) <= expectedRev) return false
      if (found.updatedAt === next.updatedAt) return true
      const lastNext = Arr.last(pendingTurnsOf(next))
      if (Option.isSome(lastNext)) {
        const queuedMatch = pendingTurnsOf(found).some((q) => q.brief === lastNext.value.brief)
        const activeMatch = Option.exists(activeTurnOf(found), (a) => a.brief === lastNext.value.brief)
        if (queuedMatch || activeMatch || found.turn >= lastNext.value.turn) return true
      }
      if (expectedRev === 0) return true
      return false
    }

    const verifyLateUpsert = Effect.fn("PaneAgent.verifyLateUpsert")(function* (
      next: PaneWorker,
      expectedRev: number,
    ) {
      const waitMs = Math.max(10, Math.round(Duration.toMillis(retryDelay) * 2))
      yield* pauseFor(Duration.millis(waitMs))
      for (let attempt = 0; attempt < 2; attempt++) {
        const snapOut = yield* runBounded(storeDeadline, store.read())
        if (snapOut._tag !== "Succeeded") continue
        const found = Arr.findFirst(snapOut.value.workers, (w) => w.id === next.id)
        if (Option.isSome(found) && lateWriteMatched(found.value, next, expectedRev)) {
          return found
        }
        return Option.none<PaneWorker>()
      }
      return Option.none<PaneWorker>()
    })

    const boundedUpsert = Effect.fn("PaneAgent.boundedUpsert")(function* (
      next: PaneWorker,
      expectedRev: number,
      notifyChanged = true,
    ): Effect.fn.Return<PaneWorker, StoreFailed | StoreConflict | ToolTimedOut | WorkerCrashed> {
      const out = yield* runToolBounded(storeDeadline, store.upsertWorker(next, expectedRev))
      if (out._tag === "Succeeded") {
        const saved = Arr.findFirst(out.value.workers, (w) => w.id === next.id)
        if (notifyChanged) yield* scheduleChanged(next.parentSessionID)
        return Option.getOrElse(saved, () => ({ ...next, revision: expectedRev + 1 }))
      }
      if (out._tag === "Failed") {
        if (out.error._tag === "StoreConflict") {
          return yield* out.error
        }
        // Verify whether a late store.write actually landed before reporting failure (preserves I2).
        const landed = yield* verifyLateUpsert(next, expectedRev)
        if (Option.isSome(landed)) {
          yield* scheduleChanged(next.parentSessionID)
          return landed.value
        }
        return yield* out.error
      }
      if (out._tag === "TimedOut") {
        return yield* new ToolTimedOut({
          operation: "store.write",
          workerId: next.id,
          deadlineMs: out.deadlineMs,
          message: `Store write timed out after ${out.deadlineMs}ms`,
        })
      }
      return yield* new WorkerCrashed({ workerId: next.id, message: `Store write died: ${out.defect}` })
    })

    const readResultOrNone = (worker: PaneWorker) =>
      runBounded(readDeadline, results.readComplete(worker.resultFile, worker.startedAt)).pipe(
        Effect.map((out) => {
          if (out._tag === "Succeeded") return out.value
          return Option.none<string>()
        }),
      )

    const offerMsg = (mailbox: Queue.Queue<ActorMessage>, msg: ActorMessage) =>
      Queue.offer(mailbox, msg).pipe(Effect.asVoid)

    const cancelPaneIo = Effect.fn("PaneAgent.cancelPaneIo")(function* (rt: ActorRuntime) {
      rt.paneIoGen += 1
      rt.paneIoRunning = false
      rt.entry.probePending = false
      yield* FiberHandle.clear(rt.paneIo)
    })

    const broadcastLimit = Effect.fn("PaneAgent.broadcastLimit")(function* (
      sourceId: string,
      harness: Harness,
      resetAt: number,
    ) {
      const map = yield* Ref.get(actors)
      for (const [id, entry] of map) {
        if (id === sourceId || entry.harness !== harness) continue
        yield* Effect.forkIn(
          offerMsg(entry.mailbox, ActorMessage.SignInLimited({ resetAt })).pipe(Effect.ignore),
          scope,
        )
      }
    })

    const launchWakeIo = (
      rt: ActorRuntime,
      deliveryId: string,
      makeTask: (gen: number) => Effect.Effect<void>,
    ) => {
      rt.wakeIoGen += 1
      const gen = rt.wakeIoGen
      rt.wakeIoRunning = true
      return FiberHandle.run(
        rt.wakeIo,
        Effect.suspend(() => makeTask(gen)).pipe(
          Effect.onExit((exit) => {
            if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
              return offerMsg(
                rt.mailbox,
                ActorMessage.IoWakeTaskExited({ gen, deliveryId, defect: Option.some(Cause.pretty(exit.cause)) }),
              ).pipe(Effect.ignore)
            }
            return offerMsg(
              rt.mailbox,
              ActorMessage.IoWakeTaskExited({ gen, deliveryId, defect: Option.none() }),
            ).pipe(Effect.ignore)
          }),
          Effect.ignore,
        ),
      )
    }

    const commitBackoffDelay = (attempts: number): Duration.Duration => {
      const base = Duration.max(Duration.millis(1), retryDelay)
      const cap = Duration.max(Duration.millis(25), Duration.min(maxWakeBackoff, Duration.millis(250)))
      return computeBackoff(base, cap, attempts)
    }

    const scheduleWakeIo = Effect.fn("PaneAgent.scheduleWakeIo")(function* (rt: ActorRuntime) {
      if (rt.wakeIoRunning) return
      const nextWake = nextRetryableWake(rt.state.worker)
      if (Option.isNone(nextWake)) {
        rt.pendingWakeCommits.clear()
        return
      }
      const wake = nextWake.value
      const pendingCommit = Option.fromUndefinedOr(rt.pendingWakeCommits.get(wake.deliveryId))
      if (Option.isSome(pendingCommit)) {
        const delay = commitBackoffDelay(pendingCommit.value.attempts)
        yield* launchWakeIo(rt, wake.deliveryId, (gen) =>
          Effect.gen(function* () {
            yield* pauseFor(delay)
            yield* offerMsg(rt.mailbox, ActorMessage.IoWakeRetryCommit({ gen, deliveryId: wake.deliveryId }))
          }),
        )
        return
      }
      const sessionID = rt.state.worker.parentSessionID
      const attempts = Option.getOrElse(Option.fromUndefinedOr(wake.attempts), () => 0)
      const delay = computeBackoff(retryDelay, maxWakeBackoff, attempts)
      yield* launchWakeIo(rt, wake.deliveryId, (gen) =>
        Effect.gen(function* () {
          yield* pauseFor(delay)
          const out = yield* runBounded(wakeDeadline, notifier.wake(sessionID, wakeLetterOf(wake)))
          if (out._tag === "Succeeded") {
            yield* offerMsg(rt.mailbox, ActorMessage.IoWakeResult({ gen, deliveryId: wake.deliveryId, ok: true, error: "" }))
            return
          }
          let errorText = "wake failed"
          if (out._tag === "Failed") errorText = out.error.message
          else if (out._tag === "TimedOut") errorText = `wake timed out after ${out.deadlineMs}ms`
          else errorText = `wake died: ${out.defect}`
          yield* offerMsg(rt.mailbox, ActorMessage.IoWakeResult({ gen, deliveryId: wake.deliveryId, ok: false, error: errorText }))
        }),
      )
    })

    const runCloseIntent = Effect.fn("PaneAgent.runCloseIntent")(function* (
      rt: ActorRuntime,
      gen: number,
      intent: ClosePaneIntent,
      adapter: HarnessAdapter,
    ) {
      const target: PaneTarget = { sessionId: intent.sessionId, blockId: intent.blockId }
      if (intent.interruptFirst) {
        // Safety gate (I5): only send Esc when screen is readable, not showing a human prompt, and turn is running.
        const screenOut = yield* runBounded(readDeadline, rex.read(target))
        if (
          screenOut._tag === "Succeeded" &&
          Option.isNone(adapter.needsInput(screenOut.value)) &&
          !adapter.turnEnded(screenOut.value)
        ) {
          yield* runBounded(closeDeadline, rex.write(target, adapter.interruptSequence))
        }
      }
      if (intent.closeBlock) {
        const closeOut = yield* runBounded(closeDeadline, rex.close(target))
        const ok =
          closeOut._tag === "Succeeded" ||
          (closeOut._tag === "Failed" && closeOut.error._tag === "RexPaneGone")
        yield* offerMsg(rt.mailbox, ActorMessage.IoCloseResult({ gen, intentId: intent.intentId, ok }))
        return
      }
      yield* offerMsg(rt.mailbox, ActorMessage.IoCloseResult({ gen, intentId: intent.intentId, ok: true }))
    })

    const runSplitIntent = Effect.fn("PaneAgent.runSplitIntent")(function* (
      rt: ActorRuntime,
      gen: number,
      intent: SplitPaneIntent,
    ) {
      const out = yield* runBounded(
        splitDeadline,
        rex.splitRight({
          sessionId: intent.sessionId,
          anchorBlockId: intent.anchorBlockId,
          label: intent.label,
          command: intent.command,
          cwd: intent.cwd,
        }),
      )
      yield* offerMsg(rt.mailbox, ActorMessage.IoSplitResult({ gen, intentId: intent.intentId, outcome: out }))
    })

    const classifyPreWriteError = (out: BoundedOutcome<string, RexError>): PreWriteFailure => {
      if (out._tag === "Failed") {
        if (out.error._tag === "RexPaneGone") return { failKind: "gone", reason: out.error.message }
        if (out.error._tag === "RexUnsupportedRevision") return { failKind: "unsupported", reason: out.error.message }
        return { failKind: "not_sent", reason: out.error.message }
      }
      if (out._tag === "TimedOut") return { failKind: "not_sent", reason: `pre-write read timed out (${out.deadlineMs}ms)` }
      return { failKind: "not_sent", reason: "pre-write read died" }
    }

    const writeIntentChunks = Effect.fn("PaneAgent.writeIntentChunks")(function* (
      target: PaneTarget,
      chunks: ReadonlyArray<string>,
      startIndex: number,
    ) {
      for (let i = startIndex; i < chunks.length; i++) {
        const chunk = Arr.get(chunks, i)
        if (Option.isNone(chunk)) continue
        const out = yield* runBounded(writeDeadline, rex.write(target, chunk.value))
        if (out._tag !== "Succeeded") {
          return { ok: false as const, index: i, outcome: out }
        }
        if (i + 1 < chunks.length && !Duration.isZero(pasteQuiet)) {
          yield* runBounded(writeDeadline, rex.waitForQuiet(target, { quietFor: pasteQuiet, timeout: writeDeadline }))
        }
      }
      return { ok: true as const }
    })

    const runTypeTurnIntent = Effect.fn("PaneAgent.runTypeTurnIntent")(function* (
      rt: ActorRuntime,
      gen: number,
      intent: TypeTurnIntent,
      worker: PaneWorker,
      adapter: HarnessAdapter,
    ) {
      const target = targetOf(worker)
      const preRead = yield* runBounded(readDeadline, rex.read(target))
      if (preRead._tag !== "Succeeded") {
        const classified = classifyPreWriteError(preRead)
        yield* offerMsg(
          rt.mailbox,
          ActorMessage.IoTypeTurnResult({
            gen,
            intentId: intent.intentId,
            turn: intent.turn,
            result: { kind: "failed", failKind: classified.failKind, chunkIndex: 0, reason: classified.reason },
          }),
        )
        return
      }
      const needs = adapter.needsInput(preRead.value)
      if (Option.isSome(needs)) {
        yield* offerMsg(
          rt.mailbox,
          ActorMessage.IoTypeTurnResult({
            gen,
            intentId: intent.intentId,
            turn: intent.turn,
            result: { kind: "prompt", summary: needs.value.summary, tail: needs.value.tail },
          }),
        )
        return
      }
      const written = yield* writeIntentChunks(target, intent.chunks, intent.chunkIndex)
      if (written.ok) {
        yield* offerMsg(
          rt.mailbox,
          ActorMessage.IoTypeTurnResult({ gen, intentId: intent.intentId, turn: intent.turn, result: { kind: "ok" } }),
        )
        return
      }
      let failKind: "not_sent" | "ambiguous" | "unsupported" | "gone" = "ambiguous"
      let reason = "write failed"
      if (written.outcome._tag === "Failed") {
        reason = written.outcome.error.message
        if (written.index === 0 && written.outcome.error._tag === "RexPaneGone") failKind = "gone"
        else if (written.index === 0 && written.outcome.error._tag === "RexUnsupportedRevision") failKind = "unsupported"
        else if (written.index === 0 && written.outcome.error._tag === "RexUnavailable") failKind = "not_sent"
      } else if (written.outcome._tag === "TimedOut") {
        reason = `write timed out after ${written.outcome.deadlineMs}ms`
      } else {
        reason = `write died: ${written.outcome.defect}`
      }
      yield* offerMsg(
        rt.mailbox,
        ActorMessage.IoTypeTurnResult({
          gen,
          intentId: intent.intentId,
          turn: intent.turn,
          result: { kind: "failed", failKind, chunkIndex: written.index, reason },
        }),
      )
    })

    const runTypeResumeIntent = Effect.fn("PaneAgent.runTypeResumeIntent")(function* (
      rt: ActorRuntime,
      gen: number,
      intent: TypeResumeIntent,
      worker: PaneWorker,
      adapter: HarnessAdapter,
    ) {
      const now = yield* Clock.currentTimeMillis
      if (now < intent.resetAt) {
        yield* pauseFor(Duration.millis(intent.resetAt - now))
      }
      const target = targetOf(worker)
      const preRead = yield* runBounded(readDeadline, rex.read(target))
      if (preRead._tag !== "Succeeded") {
        let failKind: "retry" | "not_typed" = "retry"
        let reason = "read failed before resume"
        if (preRead._tag === "Failed") {
          reason = preRead.error.message
          if (isTerminalRexError(preRead.error)) {
            failKind = "not_typed"
          }
        }
        yield* offerMsg(
          rt.mailbox,
          ActorMessage.IoTypeResumeResult({
            gen,
            intentId: intent.intentId,
            turn: intent.turn,
            result: { kind: "failed", failKind, reason },
          }),
        )
        return
      }
      const needs = adapter.needsInput(preRead.value)
      if (Option.isSome(needs)) {
        yield* offerMsg(
          rt.mailbox,
          ActorMessage.IoTypeResumeResult({
            gen,
            intentId: intent.intentId,
            turn: intent.turn,
            result: { kind: "prompt", summary: needs.value.summary, tail: needs.value.tail },
          }),
        )
        return
      }
      const checkNow = yield* Clock.currentTimeMillis
      if (!adapter.turnEnded(preRead.value) && Option.isNone(adapter.usageLimit(preRead.value, checkNow))) {
        yield* offerMsg(
          rt.mailbox,
          ActorMessage.IoTypeResumeResult({ gen, intentId: intent.intentId, turn: intent.turn, result: { kind: "ok" } }),
        )
        return
      }
      const written = yield* writeIntentChunks(target, intent.chunks, 0)
      if (written.ok) {
        yield* offerMsg(
          rt.mailbox,
          ActorMessage.IoTypeResumeResult({ gen, intentId: intent.intentId, turn: intent.turn, result: { kind: "ok" } }),
        )
        return
      }
      let failKind: "retry" | "ambiguous" | "not_typed" = "ambiguous"
      let reason = "resume write failed"
      if (written.outcome._tag === "Failed") {
        reason = written.outcome.error.message
        if (written.index === 0 && isTerminalRexError(written.outcome.error)) {
          failKind = "not_typed"
        } else if (written.index === 0 && written.outcome.error._tag === "RexUnavailable") {
          failKind = "retry"
        }
      } else if (written.outcome._tag === "TimedOut") {
        reason = `resume write timed out (${written.outcome.deadlineMs}ms)`
      }
      yield* offerMsg(
        rt.mailbox,
        ActorMessage.IoTypeResumeResult({
          gen,
          intentId: intent.intentId,
          turn: intent.turn,
          result: { kind: "failed", failKind, reason },
        }),
      )
    })

    const emitAmbiguousResult = (rt: ActorRuntime, gen: number, turn: number, result: AmbiguousOutcome) =>
      offerMsg(rt.mailbox, ActorMessage.IoAmbiguousResult({ gen, turn, result }))

    const classifyAmbiguousRexFailure = (out: BoundedOutcome<unknown, RexError>): AmbiguousOutcome => {
      if (out._tag === "Failed" && out.error._tag === "RexPaneGone") return { kind: "gone" }
      return { kind: "defer" }
    }

    const resolveAmbiguousAfterProbe = Effect.fn("PaneAgent.resolveAmbiguousAfterProbe")(function* (
      rt: ActorRuntime,
      gen: number,
      target: PaneTarget,
      active: ActiveTurn,
      adapter: HarnessAdapter,
    ) {
      let submitKey = "\r"
      if (active.mode === "steer") submitKey = "\x1bm"
      const probeWrite = yield* runBounded(writeDeadline, rex.write(target, submitKey))
      if (probeWrite._tag !== "Succeeded") {
        yield* emitAmbiguousResult(rt, gen, active.turn, classifyAmbiguousRexFailure(probeWrite))
        return
      }
      const read2 = yield* runBounded(readDeadline, rex.read(target))
      if (read2._tag !== "Succeeded") {
        yield* emitAmbiguousResult(rt, gen, active.turn, { kind: "defer" })
        return
      }
      const now2 = yield* Clock.currentTimeMillis
      if (Option.isSome(adapter.usageLimit(read2.value, now2))) {
        yield* emitAmbiguousResult(rt, gen, active.turn, { kind: "screen", screen: read2.value })
        return
      }
      const isWorking2 = !adapter.turnEnded(read2.value) && (active.mode === "submit" || screenMatchesSteer(read2.value, active))
      if (isWorking2) {
        yield* emitAmbiguousResult(rt, gen, active.turn, { kind: "working" })
        return
      }
      const chunkIdx = Option.getOrElse(Option.fromUndefinedOr(active.chunkIndex), () => 0)
      const lastErr = Option.getOrElse(Option.fromUndefinedOr(active.lastWriteError), () => "write failed")
      if (chunkIdx > 0) {
        yield* emitAmbiguousResult(rt, gen, active.turn, { kind: "defer" })
        return
      }
      yield* emitAmbiguousResult(rt, gen, active.turn, { kind: "retry", reason: lastErr })
    })

    const runResolveAmbiguous = Effect.fn("PaneAgent.runResolveAmbiguous")(function* (
      rt: ActorRuntime,
      gen: number,
      worker: PaneWorker,
      active: ActiveTurn,
      adapter: HarnessAdapter,
    ) {
      const target = targetOf(worker)
      // Wait long enough for any late write (LATE_LAND_MS = 5ms) to settle before probing the pane.
      const settleMs = Math.max(15, Math.round(Duration.toMillis(retryDelay) * 3))
      yield* pauseFor(Duration.millis(settleMs))
      const read1 = yield* runBounded(readDeadline, rex.read(target))
      if (read1._tag !== "Succeeded") {
        yield* emitAmbiguousResult(rt, gen, active.turn, classifyAmbiguousRexFailure(read1))
        return
      }
      const now = yield* Clock.currentTimeMillis
      if (Option.isSome(adapter.needsInput(read1.value)) || Option.isSome(adapter.usageLimit(read1.value, now))) {
        yield* emitAmbiguousResult(rt, gen, active.turn, { kind: "screen", screen: read1.value })
        return
      }
      const token = tokenOfBrief(active.brief)
      const echoedAlready = Option.isSome(token) && read1.value.includes(token.value)
      const fileAlready = Option.isSome(yield* readResultOrNone(worker))
      const isWorking1 =
        (!adapter.turnEnded(read1.value) && (active.mode === "submit" || screenMatchesSteer(read1.value, active))) ||
        echoedAlready ||
        fileAlready
      if (isWorking1) {
        yield* emitAmbiguousResult(rt, gen, active.turn, { kind: "working" })
        return
      }
      yield* resolveAmbiguousAfterProbe(rt, gen, target, active, adapter)
    })

    const runPeerWait = Effect.fn("PaneAgent.runPeerWait")(function* (
      rt: ActorRuntime,
      gen: number,
      intent: DurableIntent,
    ) {
      let deadline = Duration.min(writeDeadline, Duration.millis(25))
      if (intent._tag === "SplitPane") deadline = splitDeadline
      const stepMs = Math.max(5, Math.round(Duration.toMillis(retryDelay)))
      const totalMs = Math.max(stepMs, Math.round(Duration.toMillis(deadline)))
      for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
        yield* pauseFor(Duration.millis(stepMs))
        const snapOut = yield* runBounded(storeDeadline, store.read())
        if (snapOut._tag === "Succeeded") {
          const found = Arr.findFirst(snapOut.value.workers, (w) => w.id === rt.id)
          if (Option.isSome(found) && !outboxOf(found.value).some((i) => i.intentId === intent.intentId)) {
            yield* offerMsg(rt.mailbox, ActorMessage.IoPeerCheck({ gen, intentId: intent.intentId, expired: false }))
            return
          }
        }
      }
      yield* offerMsg(rt.mailbox, ActorMessage.IoPeerCheck({ gen, intentId: intent.intentId, expired: true }))
    })

    const mapRexOutcomeToFault = (
      gen: number,
      operation: string,
      out: BoundedOutcome<unknown, RexError>,
    ): ActorMessage => {
      if (out._tag === "Failed") {
        if (out.error._tag === "RexPaneGone") {
          return ActorMessage.IoPaneFault({ gen, operation, kind: "gone", message: out.error.message })
        }
        if (out.error._tag === "RexUnsupportedRevision") {
          return ActorMessage.IoPaneFault({ gen, operation, kind: "unsupported", message: out.error.message })
        }
        return ActorMessage.IoPaneFault({ gen, operation, kind: "transient", message: out.error.message })
      }
      if (out._tag === "TimedOut") {
        return ActorMessage.IoPaneFault({ gen, operation, kind: "transient", message: `timed out after ${out.deadlineMs}ms` })
      }
      if (out._tag === "Died") {
        return ActorMessage.IoPaneFault({
          gen,
          operation,
          kind: "transient",
          message: `defect: ${out.defect}`,
          defect: true,
        })
      }
      return ActorMessage.IoPaneFault({ gen, operation, kind: "transient", message: "unexpected outcome" })
    }

    const runObserveTask = Effect.fn("PaneAgent.runObserveTask")(function* (
      rt: ActorRuntime,
      gen: number,
      mode: PaneIoMode,
      worker: PaneWorker,
      lastScreen: string,
      waitLimitUntil: number,
    ) {
      const target = targetOf(worker)
      if (mode === "wait_limit") {
        const now = yield* Clock.currentTimeMillis
        const remaining = waitLimitUntil - now
        if (remaining > 0) {
          yield* pauseFor(Duration.millis(remaining))
        }
        yield* offerMsg(rt.mailbox, ActorMessage.IoRetryTick({ gen }))
        return
      }
      if (mode === "confirm_idle") {
        const waitBudget = Duration.max(pollTimeout, Duration.millis(25))
        const waitOut = yield* runBounded(waitBudget, rex.waitForQuiet(target, { quietFor, timeout: pollTimeout }))
        if (waitOut._tag !== "Succeeded") {
          yield* offerMsg(rt.mailbox, mapRexOutcomeToFault(gen, "terminals.waitForQuiet", waitOut))
          return
        }
        const readOut = yield* runBounded(readDeadline, rex.read(target))
        if (readOut._tag !== "Succeeded") {
          yield* offerMsg(rt.mailbox, mapRexOutcomeToFault(gen, "terminals.read", readOut))
          return
        }
        const fileAnswer = yield* readResultOrNone(worker)
        yield* offerMsg(rt.mailbox, ActorMessage.IoIdleConfirmed({ gen, screen: readOut.value, resultFileAnswer: fileAnswer }))
        return
      }
      if (mode === "confirm_gone") {
        yield* pauseFor(retryDelay)
        const aliveOut = yield* runBounded(readDeadline, rex.alive(target))
        if (aliveOut._tag !== "Succeeded") {
          yield* offerMsg(rt.mailbox, mapRexOutcomeToFault(gen, "terminals.process", aliveOut))
          return
        }
        const fileAnswer = yield* readResultOrNone(worker)
        yield* offerMsg(
          rt.mailbox,
          ActorMessage.IoGoneProbe({
            gen,
            liveness: aliveOut.value,
            tail: shortLines(lastScreen),
            resultFileAnswer: fileAnswer,
          }),
        )
        return
      }
      if (mode === "retry_delay") {
        let delay = retryDelay
        if (worker.state === "needs_input") {
          rt.needsInputPolls += 1
          delay = computeBackoff(retryDelay, Duration.max(Duration.millis(100), pollTimeout), rt.needsInputPolls)
        } else {
          rt.needsInputPolls = 0
        }
        yield* pauseFor(delay)
        yield* offerMsg(rt.mailbox, ActorMessage.IoRetryTick({ gen }))
        return
      }
      if (mode === "wait_quiet") {
        const aliveOut = yield* runBounded(readDeadline, rex.alive(target))
        if (aliveOut._tag !== "Succeeded") {
          yield* offerMsg(rt.mailbox, mapRexOutcomeToFault(gen, "terminals.process", aliveOut))
          return
        }
        if (aliveOut.value === "alive") {
          const waitBudget = Duration.max(pollTimeout, Duration.millis(25))
          yield* runBounded(waitBudget, rex.waitForQuiet(target, { quietFor, timeout: pollTimeout }))
        }
        yield* offerMsg(rt.mailbox, ActorMessage.IoQuietDone({ gen, liveness: aliveOut.value, lastScreen }))
        return
      }
      const screenOut = yield* runBounded(readDeadline, rex.read(target))
      if (screenOut._tag !== "Succeeded") {
        yield* offerMsg(rt.mailbox, mapRexOutcomeToFault(gen, "terminals.read", screenOut))
        return
      }
      yield* offerMsg(rt.mailbox, ActorMessage.IoScreenRead({ gen, screen: screenOut.value }))
    })

    const reloadWorker = Effect.fn("PaneAgent.reloadWorker")(function* (rt: ActorRuntime) {
      const snapOut = yield* runBounded(storeDeadline, store.read())
      if (snapOut._tag !== "Succeeded") {
        rt.needsReload = true
        return Option.none<PaneWorker>()
      }
      const found = Arr.findFirst(snapOut.value.workers, (w) => w.id === rt.id)
      if (Option.isSome(found)) {
        rt.state = initialMachineState(found.value, activeTurnTypedOf(found.value))
        rt.needsReload = false
      }
      return found
    })

    const applyPostCommitActions = Effect.fn("PaneAgent.applyPostCommitActions")(function* (
      rt: ActorRuntime,
      nextWorker: PaneWorker,
      actions: ReadonlyArray<MachineAction>,
    ) {
      updateNextPaneIo(rt, actions)
      for (const action of actions) {
        if (action._tag === "BroadcastLimit") {
          yield* broadcastLimit(rt.id, nextWorker.harness, action.resetAt)
        }
      }
      if (hasAction(actions, "FlushWake")) {
        yield* scheduleWakeIo(rt)
      }
    })

    const handleInternalPersistFailure = Effect.fn("PaneAgent.handleInternalPersistFailure")(function* (
      rt: ActorRuntime,
      failure: StoreFailed | StoreConflict | ToolTimedOut | WorkerCrashed,
      canRetry: boolean,
    ): Effect.fn.Return<boolean> {
      if (failure._tag === "StoreConflict") {
        yield* reloadWorker(rt)
        if (canRetry) return true
        rt.nextPaneIo = "read"
        return false
      }
      // Never sleep inside the actor mailbox loop on store outage: keep tool calls within bound B
      // and let the background runner retry on bounded backoff (N1).
      rt.nextPaneIo = "retry_delay"
      return false
    })

    const applyInternalTransition = Effect.fn("PaneAgent.applyInternalTransition")(function* (
      rt: ActorRuntime,
      event: MachineEvent,
    ) {
      const retryOnConflict = isCompletionEvent(event)
      const notifyChanged = event._tag !== "MarkSplitDispatched"
      let maxAttempts = 1
      if (retryOnConflict) maxAttempts = 5
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const prevWorker = rt.state.worker
        const adapter = adapterFor(prevWorker.harness)
        const res = transition(rt.state, event, adapter, machineConfig)
        let nextWorker = res.state.worker

        if (hasAction(res.actions, "Persist")) {
          const saved = yield* Effect.result(boundedUpsert(nextWorker, revisionOf(prevWorker), notifyChanged))
          if (saved._tag === "Failure") {
            const shouldRetry = yield* handleInternalPersistFailure(
              rt,
              saved.failure,
              retryOnConflict && attempt + 1 < maxAttempts,
            )
            if (shouldRetry) continue
            return Option.none<ReadonlyArray<MachineAction>>()
          }
          nextWorker = saved.success
        }

        rt.state = { ...res.state, worker: nextWorker }
        rt.freshFromStore = false
        yield* applyPostCommitActions(rt, nextWorker, res.actions)
        return Option.some(res.actions)
      }
      return Option.none<ReadonlyArray<MachineAction>>()
    })

    const pruneStalePendingCommits = (rt: ActorRuntime): void => {
      if (rt.pendingCommits.size === 0) return
      const liveIds = new Set(outboxOf(rt.state.worker).map((i) => i.intentId))
      for (const key of rt.pendingCommits.keys()) {
        if (!liveIds.has(key)) rt.pendingCommits.delete(key)
      }
    }

    const commitIntentCompletion = Effect.fn("PaneAgent.commitIntentCompletion")(function* (
      rt: ActorRuntime,
      intentId: string,
      event: MachineEvent,
    ) {
      const existing = rt.pendingCommits.get(intentId)
      const entry: PendingIntentCommit = Option.getOrElse(Option.fromUndefinedOr(existing), () => ({
        event,
        attempts: 0,
      }))
      rt.pendingCommits.set(intentId, entry)
      const applied = yield* applyInternalTransition(rt, entry.event)
      if (Option.isSome(applied) || !outboxOf(rt.state.worker).some((i) => i.intentId === intentId)) {
        rt.pendingCommits.delete(intentId)
        return true
      }
      entry.attempts += 1
      return false
    })

    const updateNextPaneIo = (rt: ActorRuntime, actions: ReadonlyArray<MachineAction>): void => {
      const limitAction = Arr.findFirst(
        actions,
        (action): action is Extract<MachineAction, { readonly _tag: "WaitLimitReset" }> => action._tag === "WaitLimitReset",
      )
      if (Option.isSome(limitAction)) {
        rt.nextPaneIo = "wait_limit"
        rt.waitLimitUntil = limitAction.value.resetAt
        return
      }
      if (hasAction(actions, "ConfirmIdle")) {
        rt.nextPaneIo = "confirm_idle"
      } else if (hasAction(actions, "ConfirmGone")) {
        rt.nextPaneIo = "confirm_gone"
      } else if (hasAction(actions, "RetryTransient")) {
        rt.nextPaneIo = "retry_delay"
      } else if (hasAction(actions, "WaitQuiet")) {
        rt.nextPaneIo = "wait_quiet"
      } else {
        rt.nextPaneIo = "read"
      }
    }

    const launchPaneIo = (rt: ActorRuntime, makeTask: (gen: number) => Effect.Effect<void>) => {
      rt.paneIoGen += 1
      const gen = rt.paneIoGen
      rt.paneIoRunning = true
      return FiberHandle.run(
        rt.paneIo,
        Effect.suspend(() => makeTask(gen)).pipe(
          Effect.onExit((exit) => {
            if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
              return offerMsg(
                rt.mailbox,
                ActorMessage.IoPaneTaskExited({ gen, defect: Option.some(Cause.pretty(exit.cause)) }),
              ).pipe(Effect.ignore)
            }
            return offerMsg(rt.mailbox, ActorMessage.IoPaneTaskExited({ gen, defect: Option.none() })).pipe(
              Effect.ignore,
            )
          }),
          Effect.ignore,
        ),
      )
    }

    const scheduleOutboxIntent = Effect.fn("PaneAgent.scheduleOutboxIntent")(function* (
      rt: ActorRuntime,
      intent: DurableIntent,
      worker: PaneWorker,
      adapter: HarnessAdapter,
    ) {
      pruneStalePendingCommits(rt)
      const pending = Option.fromUndefinedOr(rt.pendingCommits.get(intent.intentId))
      if (Option.isSome(pending)) {
        // An intent for another pane behind a pending store commit is not blocked by it (N1).
        const otherPaneClose = Arr.findFirst(
          outboxOf(worker).slice(1),
          (item): item is ClosePaneIntent =>
            item._tag === "ClosePane" &&
            item.blockId !== worker.blockId &&
            !rt.pendingCommits.has(item.intentId),
        )
        if (Option.isSome(otherPaneClose)) {
          yield* launchPaneIo(rt, (gen) => runCloseIntent(rt, gen, otherPaneClose.value, adapter))
          return
        }
        const delay = commitBackoffDelay(pending.value.attempts)
        yield* launchPaneIo(rt, (gen) =>
          Effect.gen(function* () {
            yield* pauseFor(delay)
            yield* offerMsg(rt.mailbox, ActorMessage.IoRetryCommit({ gen, intentId: intent.intentId }))
          }),
        )
        return
      }
      if (intent._tag === "SplitPane" && !intent.dispatched) {
        const now = yield* Clock.currentTimeMillis
        const marked = yield* applyInternalTransition(
          rt,
          MachineEvent.MarkSplitDispatched({ intentId: intent.intentId, ownerProc: procId, now }),
        )
        if (Option.isNone(marked)) {
          yield* launchPaneIo(rt, (gen) => runObserveTask(rt, gen, "retry_delay", rt.state.worker, rt.lastScreen, 0))
          return
        }
        const updated = Arr.findFirst(
          outboxOf(rt.state.worker),
          (i): i is SplitPaneIntent => i._tag === "SplitPane" && i.intentId === intent.intentId,
        )
        if (Option.isSome(updated)) {
          yield* launchPaneIo(rt, (gen) => runSplitIntent(rt, gen, updated.value))
        }
        return
      }
      if (intent._tag !== "ClosePane" && intent.ownerProc !== procId) {
        yield* launchPaneIo(rt, (gen) => runPeerWait(rt, gen, intent))
        return
      }
      if (intent._tag === "ClosePane") {
        yield* launchPaneIo(rt, (gen) => runCloseIntent(rt, gen, intent, adapter))
        return
      }
      if (intent._tag === "SplitPane") {
        yield* launchPaneIo(rt, (gen) => runSplitIntent(rt, gen, intent))
        return
      }
      if (intent._tag === "TypeTurn") {
        yield* launchPaneIo(rt, (gen) => runTypeTurnIntent(rt, gen, intent, worker, adapter))
        return
      }
      yield* launchPaneIo(rt, (gen) => runTypeResumeIntent(rt, gen, intent, worker, adapter))
    })

    const needsConfirmGone = (rt: ActorRuntime): boolean =>
      rt.nextPaneIo === "confirm_gone" &&
      rt.state.worker.blockId.length > 0 &&
      rt.state.worker.state !== "pane_gone" &&
      rt.state.worker.state !== "stopped" &&
      rt.state.worker.state !== "failed"

    const schedulePaneIo = Effect.fn("PaneAgent.schedulePaneIo")(function* (rt: ActorRuntime) {
      if (rt.paneIoRunning) return
      const worker = rt.state.worker
      if (!needsPaneWork(worker) && !needsConfirmGone(rt)) return
      const adapter = adapterFor(worker.harness)
      const headIntent = Arr.head(outboxOf(worker))

      // Priority 1: Execute durable outbox intent FIFO.
      if (Option.isSome(headIntent)) {
        yield* scheduleOutboxIntent(rt, headIntent.value, worker, adapter)
        return
      }

      if (worker.blockId.length === 0) return

      // Priority 2: Resolve ambiguous active turn via evidence-first probe.
      const active = activeTurnOf(worker)
      if (Option.isSome(active) && active.value.phase === "ambiguous") {
        yield* launchPaneIo(rt, (gen) => runResolveAmbiguous(rt, gen, worker, active.value, adapter))
        return
      }

      // Priority 3: Observe screen / wait quiet / confirm idle / confirm gone / wait limit reset.
      const mode = rt.nextPaneIo
      if (mode === "confirm_gone") rt.entry.probePending = true
      yield* launchPaneIo(rt, (gen) => runObserveTask(rt, gen, mode, worker, rt.lastScreen, rt.waitLimitUntil))
    })

    /** Syncs actor state from store if another process advanced the revision. */
    const syncFromStoreIfNewer = Effect.fn("PaneAgent.syncFromStoreIfNewer")(function* (rt: ActorRuntime) {
      const snapOut = yield* runBounded(storeDeadline, store.read())
      if (snapOut._tag !== "Succeeded") return
      const found = Arr.findFirst(snapOut.value.workers, (w) => w.id === rt.id)
      if (Option.isSome(found) && revisionOf(found.value) > revisionOf(rt.state.worker)) {
        yield* cancelPaneIo(rt)
        rt.state = initialMachineState(found.value, activeTurnTypedOf(found.value))
        rt.needsReload = false
      }
    })

    /** Applies a command transition; on StoreConflict always reloads fresh state so the actor is never wedged. */
    const applyCommandTransition = Effect.fn("PaneAgent.applyCommandTransition")(function* (
      rt: ActorRuntime,
      validate: (worker: PaneWorker) => Effect.Effect<void, ModelError>,
      makeEvent: (worker: PaneWorker, now: number) => Effect.Effect<MachineEvent>,
    ): Effect.fn.Return<PaneWorker, ModelError> {
      if (rt.needsReload || (!rt.freshFromStore && !isLive(rt.state.worker.state))) {
        yield* syncFromStoreIfNewer(rt)
      }
      rt.freshFromStore = false
      const prevWorker = rt.state.worker
      yield* validate(prevWorker)
      const now = yield* Clock.currentTimeMillis
      const event = yield* makeEvent(prevWorker, now)
      const adapter = adapterFor(prevWorker.harness)
      const res = transition(rt.state, event, adapter, machineConfig)
      const savedRes = yield* Effect.result(boundedUpsert(res.state.worker, revisionOf(prevWorker)))
      if (savedRes._tag === "Success") {
        rt.state = { ...res.state, worker: savedRes.success }
        if (hasAction(res.actions, "FlushWake")) yield* scheduleWakeIo(rt)
        return savedRes.success
      }
      if (savedRes.failure._tag === "StoreConflict") {
        yield* reloadWorker(rt)
        yield* cancelPaneIo(rt)
        yield* schedulePaneIo(rt)
        yield* scheduleWakeIo(rt)
      }
      return yield* savedRes.failure
    })

    const handleCmdFollowUp = Effect.fn("PaneAgent.handleCmdFollowUp")(function* (
      rt: ActorRuntime,
      input: FollowUpInput,
    ): Effect.fn.Return<PaneWorker, ModelError> {
      const saved = yield* applyCommandTransition(
        rt,
        (worker) => {
          if (worker.parentSessionID !== input.parentSessionID) {
            return Effect.fail(new WorkerRejected({ reason: `Pane worker ${input.id} belongs to another session.` }))
          }
          if (!canFollowUpState(worker.state)) {
            return Effect.fail(
              new WorkerRejected({
                reason: `Pane worker ${worker.id} is ${worker.state}; call pane_agent({ action: "restart", id: "${worker.id}" }) to resume it.`,
              }),
            )
          }
          return Effect.void
        },
        (_worker, now) =>
          Effect.succeed(
            MachineEvent.QueueFollowUp({
              prompt: input.prompt,
              resultFile: Option.fromUndefinedOr(input.resultFile),
              steer: input.steer === true,
              now,
            }),
          ),
      )
      // If idle/waiting, wake paneRunner immediately so the queued turn or steer is picked up without delay.
      if (input.steer === true || rt.nextPaneIo === "wait_quiet" || rt.nextPaneIo === "retry_delay") {
        if (!outboxOf(saved).some(isWriteOrSplitIntent)) {
          yield* cancelPaneIo(rt)
          rt.nextPaneIo = "read"
        }
      }
      yield* schedulePaneIo(rt)
      return saved
    })

    const handleCmdRestart = Effect.fn("PaneAgent.handleCmdRestart")(function* (
      rt: ActorRuntime,
      input: RestartInput,
      anchor: PaneAnchor,
    ): Effect.fn.Return<PaneWorker, ModelError> {
      const saved = yield* applyCommandTransition(
        rt,
        (worker) => {
          if (worker.parentSessionID !== input.parentSessionID) {
            return Effect.fail(new WorkerRejected({ reason: `Pane worker ${input.id} belongs to another session.` }))
          }
          if (!canRestartState(worker.state)) {
            return Effect.fail(
              new WorkerRejected({
                reason: `Pane ${worker.blockId} for worker ${worker.id} is still alive; use follow_up or steer instead of restart.`,
              }),
            )
          }
          return Effect.void
        },
        (worker, now) =>
          Effect.gen(function* () {
            const adapter = adapterFor(worker.harness)
            const workerCwd = Option.getOrElse(Option.fromUndefinedOr(worker.cwd), () => worker.directory)
            const nextResultFile = Option.getOrElse(
              Option.filter(Option.fromUndefinedOr(input.resultFile), (f) => f.trim().length > 0),
              () => worker.resultFile,
            )
            const nextAddDirs = computeAddDirs(workerCwd, nextResultFile, worker.addDirs)
            const skipPermissions = worker.skipPermissions !== false
            const briefInput = Option.match(Option.fromUndefinedOr(input.prompt), {
              onNone: () => ({ resultFile: nextResultFile }),
              onSome: (prompt) => ({ prompt, resultFile: nextResultFile }),
            })
            const brief = resumeBrief(briefInput)
            const command = adapter.resumeCommand(
              buildResumeOptions(worker.harness, brief, nextAddDirs, skipPermissions, config.binaryOverrides),
            )
            const reqId = yield* makeRandomToken("rq")
            const splitIntentId = yield* makeRandomToken("sp")
            let closeIntentId: Option.Option<string> = Option.none()
            if (worker.ownedBlock && worker.blockId.length > 0 && worker.state !== "pane_gone") {
              closeIntentId = Option.some(yield* makeRandomToken("cl"))
            }
            return MachineEvent.QueueRestart({
              rexSessionId: anchor.session,
              anchorBlockId: anchor.block,
              label: splitLabelFor(worker.harness, worker.unit, reqId),
              reqId,
              command,
              cwd: workerCwd,
              addDirs: nextAddDirs,
              resultFile: nextResultFile,
              resumedBrief: brief,
              splitIntentId,
              closeIntentId,
              ownerProc: procId,
              now,
            })
          }),
      )
      yield* cancelPaneIo(rt)
      rt.nextPaneIo = "read"
      yield* schedulePaneIo(rt)
      yield* scheduleWakeIo(rt)
      return saved
    })

    const handleCmdStop = Effect.fn("PaneAgent.handleCmdStop")(function* (
      rt: ActorRuntime,
      input: StopInput,
    ): Effect.fn.Return<PaneWorker, ModelError> {
      const saved = yield* applyCommandTransition(
        rt,
        (worker) => {
          if (worker.parentSessionID !== input.parentSessionID) {
            return Effect.fail(new WorkerRejected({ reason: `Pane worker ${input.id} belongs to another session.` }))
          }
          return Effect.void
        },
        (worker, now) =>
          Effect.gen(function* () {
            const closeIntentId = yield* makeRandomToken("cl")
            const deliveryId = yield* mintDeliveryId()
            const extraDeliveryIds: Array<string> = []
            for (let i = 0; i < pendingTurnsOf(worker).length; i++) {
              extraDeliveryIds.push(yield* mintDeliveryId())
            }
            return MachineEvent.Stop({
              close: input.close === true,
              closeIntentId,
              ownerProc: procId,
              lastScreen: rt.lastScreen,
              deliveryId,
              extraDeliveryIds,
              now,
            })
          }),
      )
      yield* cancelPaneIo(rt)
      yield* schedulePaneIo(rt)
      return saved
    })

    const handleCmdStatus = Effect.fn("PaneAgent.handleCmdStatus")(function* (
      rt: ActorRuntime,
      parentSessionID: string,
    ): Effect.fn.Return<PaneWorker, ModelError> {
      yield* syncFromStoreIfNewer(rt)
      if (rt.state.worker.parentSessionID !== parentSessionID) {
        return yield* new WorkerRejected({ reason: `Pane worker ${rt.id} belongs to another session.` })
      }
      return rt.state.worker
    })

    const handleCmdReattach = Effect.fn("PaneAgent.handleCmdReattach")(function* (
      rt: ActorRuntime,
    ): Effect.fn.Return<PaneWorker, ModelError> {
      yield* syncFromStoreIfNewer(rt)
      // Reset undelivered wake retries (keeping exact same deliveryId).
      if (pendingWakesOf(rt.state.worker).length > 0) {
        const now = yield* Clock.currentTimeMillis
        yield* applyInternalTransition(rt, MachineEvent.RestartWakeRetries({ now }))
      }
      rt.nextPaneIo = "read"
      yield* schedulePaneIo(rt)
      yield* scheduleWakeIo(rt)
      return rt.state.worker
    })

    const handleIoSplitResult = Effect.fn("PaneAgent.handleIoSplitResult")(function* (
      rt: ActorRuntime,
      intentId: string,
      outcome: BoundedOutcome<string, RexError>,
    ) {
      const now = yield* Clock.currentTimeMillis
      if (outcome._tag === "Succeeded") {
        yield* commitIntentCompletion(rt, intentId, MachineEvent.SplitSucceeded({ intentId, blockId: outcome.value, now }))
        rt.nextPaneIo = "read"
        yield* schedulePaneIo(rt)
        return
      }
      const deliveryId = yield* mintDeliveryId()
      const extraCount = pendingTurnsOf(rt.state.worker).length + 1
      const extraDeliveryIds: Array<string> = []
      for (let i = 0; i < extraCount; i++) {
        extraDeliveryIds.push(yield* mintDeliveryId())
      }
      let unknownOutcome = true
      let retryable = false
      let reason = "split failed"
      if (outcome._tag === "Failed") {
        reason = outcome.error.message
        if (outcome.error._tag === "RexUnsupportedRevision") {
          unknownOutcome = false
          retryable = false
        } else if (isRetryableSplitRexError(outcome.error)) {
          unknownOutcome = false
          retryable = true
        }
      } else if (outcome._tag === "TimedOut") {
        reason = `split timed out after ${outcome.deadlineMs}ms`
      } else {
        reason = `split died: ${outcome.defect}`
      }
      yield* commitIntentCompletion(
        rt,
        intentId,
        MachineEvent.SplitFailed({
          intentId,
          unknownOutcome,
          retryable,
          reason,
          now,
          deliveryId,
          extraDeliveryIds,
        }),
      )
      yield* schedulePaneIo(rt)
    })

    const handleIoPaneFault = Effect.fn("PaneAgent.handleIoPaneFault")(function* (
      rt: ActorRuntime,
      operation: string,
      kind: "gone" | "transient" | "unsupported",
      message: string,
      defect = false,
    ) {
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      if (kind === "gone") {
        const fileAnswer = yield* readResultOrNone(rt.state.worker)
        yield* applyInternalTransition(
          rt,
          MachineEvent.ProbeGone({
            tail: shortLines(rt.lastScreen),
            lastScreen: rt.lastScreen,
            resultFileAnswer: fileAnswer,
            now,
            deliveryId,
          }),
        )
        yield* schedulePaneIo(rt)
        return
      }
      yield* applyInternalTransition(
        rt,
        MachineEvent.TransientError({ operation, message, now, deliveryId, defect }),
      )
      yield* schedulePaneIo(rt)
    })

    const handleIoQuietDone = Effect.fn("PaneAgent.handleIoQuietDone")(function* (
      rt: ActorRuntime,
      liveness: PaneLiveness,
      lastScreen: string,
    ) {
      if (liveness === "alive") {
        rt.nextPaneIo = "read"
        yield* schedulePaneIo(rt)
        return
      }
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      if (liveness === "gone") {
        const fileAnswer = yield* readResultOrNone(rt.state.worker)
        yield* applyInternalTransition(
          rt,
          MachineEvent.ProbeGone({
            tail: shortLines(lastScreen),
            lastScreen,
            resultFileAnswer: fileAnswer,
            now,
            deliveryId,
          }),
        )
      } else {
        yield* applyInternalTransition(
          rt,
          MachineEvent.TransientError({
            operation: "terminals.process",
            message: "Rex temporarily unreachable",
            now,
            deliveryId,
          }),
        )
      }
      yield* schedulePaneIo(rt)
    })

    const handleIoGoneProbe = Effect.fn("PaneAgent.handleIoGoneProbe")(function* (
      rt: ActorRuntime,
      liveness: PaneLiveness,
      tail: string,
      resultFileAnswer: Option.Option<string>,
    ) {
      rt.entry.probePending = false
      if (liveness === "alive") {
        rt.state = { ...rt.state, consecutiveGone: 0, consecutiveTransient: 0 }
        rt.nextPaneIo = "read"
        yield* schedulePaneIo(rt)
        return
      }
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      if (liveness === "gone") {
        yield* applyInternalTransition(
          rt,
          MachineEvent.ProbeGone({ tail, lastScreen: rt.lastScreen, resultFileAnswer, now, deliveryId }),
        )
      } else {
        yield* applyInternalTransition(
          rt,
          MachineEvent.TransientError({
            operation: "terminals.process",
            message: "Rex temporarily unreachable",
            now,
            deliveryId,
          }),
        )
      }
      yield* schedulePaneIo(rt)
    })

    const handleIoPeerCheck = Effect.fn("PaneAgent.handleIoPeerCheck")(function* (
      rt: ActorRuntime,
      intentId: string,
      expired: boolean,
    ) {
      yield* syncFromStoreIfNewer(rt)
      const stillThere = Arr.findFirst(outboxOf(rt.state.worker), (i) => i.intentId === intentId)
      if (Option.isNone(stillThere) || !expired) {
        rt.nextPaneIo = "read"
        yield* schedulePaneIo(rt)
        return
      }
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      const intent = stillThere.value
      if (intent._tag === "SplitPane") {
        const extraDeliveryIds: Array<string> = []
        for (let i = 0; i <= pendingTurnsOf(rt.state.worker).length; i++) {
          extraDeliveryIds.push(yield* mintDeliveryId())
        }
        yield* applyInternalTransition(
          rt,
          MachineEvent.SplitFailed({
            intentId,
            unknownOutcome: true,
            retryable: false,
            reason: "split result unknown after previous process exited",
            now,
            deliveryId,
            extraDeliveryIds,
          }),
        )
      } else if (intent._tag === "TypeTurn") {
        yield* applyInternalTransition(
          rt,
          MachineEvent.TypeTurnFailed({
            intentId,
            turn: intent.turn,
            chunkIndex: intent.chunkIndex,
            kind: "ambiguous",
            reason: "previous process did not complete write",
            now,
            deliveryId,
          }),
        )
      } else if (intent._tag === "TypeResume") {
        yield* applyInternalTransition(
          rt,
          MachineEvent.TypeResumeFailed({
            intentId,
            turn: intent.turn,
            kind: "ambiguous",
            reason: "previous process did not complete resume",
            now,
            deliveryId,
          }),
        )
      }
      yield* schedulePaneIo(rt)
    })

    const completeCommand = (
      reply: Deferred.Deferred<PaneWorker, ModelError>,
      effect: Effect.Effect<PaneWorker, ModelError>,
    ) =>
      Effect.exit(effect).pipe(
        Effect.flatMap((exit) =>
          Exit.match(exit, {
            onSuccess: (worker) => Deferred.succeed(reply, worker),
            onFailure: (cause) =>
              Option.match(Cause.findErrorOption(cause), {
                onSome: (err) => Deferred.fail(reply, err),
                onNone: () => Deferred.fail(reply, new WorkerCrashed({ workerId: "*", message: Cause.pretty(cause) })),
              }),
          }),
        ),
        Effect.asVoid,
      )

    const handleIoTypeTurnResult = Effect.fn("PaneAgent.handleIoTypeTurnResult")(function* (
      rt: ActorRuntime,
      msg: Extract<ActorMessage, { readonly _tag: "IoTypeTurnResult" }>,
    ) {
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      if (msg.result.kind === "ok") {
        yield* commitIntentCompletion(
          rt,
          msg.intentId,
          MachineEvent.TypeTurnSucceeded({ intentId: msg.intentId, turn: msg.turn, now }),
        )
      } else if (msg.result.kind === "prompt") {
        yield* commitIntentCompletion(
          rt,
          msg.intentId,
          MachineEvent.TypeTurnDeferredPrompt({
            intentId: msg.intentId,
            summary: msg.result.summary,
            tail: msg.result.tail,
            now,
            deliveryId,
          }),
        )
      } else {
        yield* commitIntentCompletion(
          rt,
          msg.intentId,
          MachineEvent.TypeTurnFailed({
            intentId: msg.intentId,
            turn: msg.turn,
            chunkIndex: msg.result.chunkIndex,
            kind: msg.result.failKind,
            reason: msg.result.reason,
            now,
            deliveryId,
          }),
        )
      }
      yield* schedulePaneIo(rt)
    })

    const handleIoTypeResumeResult = Effect.fn("PaneAgent.handleIoTypeResumeResult")(function* (
      rt: ActorRuntime,
      msg: Extract<ActorMessage, { readonly _tag: "IoTypeResumeResult" }>,
    ) {
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      if (msg.result.kind === "ok") {
        yield* commitIntentCompletion(
          rt,
          msg.intentId,
          MachineEvent.TypeResumeSucceeded({ intentId: msg.intentId, turn: msg.turn, now }),
        )
      } else if (msg.result.kind === "prompt") {
        yield* commitIntentCompletion(
          rt,
          msg.intentId,
          MachineEvent.TypeResumeDeferredPrompt({
            intentId: msg.intentId,
            summary: msg.result.summary,
            tail: msg.result.tail,
            now,
            deliveryId,
          }),
        )
      } else {
        yield* commitIntentCompletion(
          rt,
          msg.intentId,
          MachineEvent.TypeResumeFailed({
            intentId: msg.intentId,
            turn: msg.turn,
            kind: msg.result.failKind,
            reason: msg.result.reason,
            now,
            deliveryId,
          }),
        )
      }
      yield* schedulePaneIo(rt)
    })

    const handleIoAmbiguousResult = Effect.fn("PaneAgent.handleIoAmbiguousResult")(function* (
      rt: ActorRuntime,
      msg: Extract<ActorMessage, { readonly _tag: "IoAmbiguousResult" }>,
    ) {
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      if (msg.result.kind === "screen") {
        rt.lastScreen = msg.result.screen
        const intentId = yield* makeRandomToken("tt")
        yield* applyInternalTransition(
          rt,
          MachineEvent.ObserveScreen({
            screen: msg.result.screen,
            now,
            deliveryId,
            intentId,
            ownerProc: procId,
          }),
        )
      } else if (msg.result.kind === "gone") {
        const fileAnswer = yield* readResultOrNone(rt.state.worker)
        yield* applyInternalTransition(
          rt,
          MachineEvent.ProbeGone({ tail: shortLines(rt.lastScreen), resultFileAnswer: fileAnswer, now, deliveryId }),
        )
      } else if (msg.result.kind === "defer") {
        rt.nextPaneIo = "retry_delay"
      } else {
        const intentId = yield* makeRandomToken("tt")
        let reason = ""
        if (msg.result.kind === "retry" || msg.result.kind === "not_typed") reason = msg.result.reason
        yield* applyInternalTransition(
          rt,
          MachineEvent.AmbiguousResolved({
            turn: msg.turn,
            outcome: msg.result.kind,
            reason,
            intentId,
            ownerProc: procId,
            now,
            deliveryId,
          }),
        )
      }
      yield* schedulePaneIo(rt)
    })

    const handleIoScreenRead = Effect.fn("PaneAgent.handleIoScreenRead")(function* (rt: ActorRuntime, screen: string) {
      rt.lastScreen = screen
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      const intentId = yield* makeRandomToken("tt")
      yield* applyInternalTransition(
        rt,
        MachineEvent.ObserveScreen({
          screen,
          now,
          deliveryId,
          intentId,
          ownerProc: procId,
        }),
      )
      yield* schedulePaneIo(rt)
    })

    const commitWakeCompletion = Effect.fn("PaneAgent.commitWakeCompletion")(function* (
      rt: ActorRuntime,
      deliveryId: string,
      event: MachineEvent,
    ) {
      const existing = rt.pendingWakeCommits.get(deliveryId)
      const entry: PendingIntentCommit = Option.getOrElse(Option.fromUndefinedOr(existing), () => ({
        event,
        attempts: 0,
      }))
      rt.pendingWakeCommits.set(deliveryId, entry)
      const applied = yield* applyInternalTransition(rt, entry.event)
      if (Option.isSome(applied) || !pendingWakesOf(rt.state.worker).some((w) => w.deliveryId === deliveryId)) {
        rt.pendingWakeCommits.delete(deliveryId)
        return true
      }
      entry.attempts += 1
      return false
    })

    const handleIoWakeResult = Effect.fn("PaneAgent.handleIoWakeResult")(function* (
      rt: ActorRuntime,
      msg: Extract<ActorMessage, { readonly _tag: "IoWakeResult" }>,
    ) {
      if (msg.gen !== rt.wakeIoGen) return
      rt.wakeIoHandledGen = msg.gen
      rt.wakeIoRunning = false
      const now = yield* Clock.currentTimeMillis
      if (msg.ok) {
        yield* commitWakeCompletion(rt, msg.deliveryId, MachineEvent.WakeDelivered({ deliveryId: msg.deliveryId, now }))
      } else {
        yield* applyInternalTransition(
          rt,
          MachineEvent.WakeFailed({ deliveryId: msg.deliveryId, message: msg.error, now }),
        )
      }
      yield* schedulePaneIo(rt)
      yield* scheduleWakeIo(rt)
    })

    const handleIoWakeRetryCommit = Effect.fn("PaneAgent.handleIoWakeRetryCommit")(function* (
      rt: ActorRuntime,
      msg: Extract<ActorMessage, { readonly _tag: "IoWakeRetryCommit" }>,
    ) {
      if (msg.gen !== rt.wakeIoGen) return
      rt.wakeIoHandledGen = msg.gen
      rt.wakeIoRunning = false
      const entry = Option.fromUndefinedOr(rt.pendingWakeCommits.get(msg.deliveryId))
      if (Option.isSome(entry) && pendingWakesOf(rt.state.worker).some((w) => w.deliveryId === msg.deliveryId)) {
        yield* commitWakeCompletion(rt, msg.deliveryId, entry.value.event)
      } else {
        rt.pendingWakeCommits.delete(msg.deliveryId)
      }
      yield* schedulePaneIo(rt)
      yield* scheduleWakeIo(rt)
    })

    const handleIoWakeTaskExited = Effect.fn("PaneAgent.handleIoWakeTaskExited")(function* (
      rt: ActorRuntime,
      msg: Extract<ActorMessage, { readonly _tag: "IoWakeTaskExited" }>,
    ) {
      if (msg.gen !== rt.wakeIoGen) return
      if (Option.isNone(msg.defect) && rt.wakeIoHandledGen === msg.gen) return
      rt.wakeIoRunning = false
      if (Option.isSome(msg.defect)) {
        const now = yield* Clock.currentTimeMillis
        yield* applyInternalTransition(
          rt,
          MachineEvent.WakeFailed({ deliveryId: msg.deliveryId, message: `wake defect: ${msg.defect.value}`, now }),
        )
      }
      yield* scheduleWakeIo(rt)
    })

    const processPaneIoMessage = Effect.fn("PaneAgent.processPaneIoMessage")(function* (
      rt: ActorRuntime,
      msg: Exclude<
        ActorMessage,
        {
          readonly _tag:
            | "CmdFollowUp"
            | "CmdRestart"
            | "CmdStop"
            | "CmdStatus"
            | "CmdReattach"
            | "CmdNudgeProbe"
            | "SignInLimited"
            | "IoWakeResult"
            | "IoWakeRetryCommit"
            | "IoWakeTaskExited"
        }
      >,
    ) {
      if (msg.gen !== rt.paneIoGen) return
      if (msg._tag === "IoPaneTaskExited") {
        if (Option.isNone(msg.defect) && rt.paneIoHandledGen === msg.gen) return
        rt.paneIoRunning = false
        if (Option.isSome(msg.defect)) {
          yield* handleIoPaneFault(rt, "pane.runner", "transient", `defect: ${msg.defect.value}`, true)
          return
        }
        rt.nextPaneIo = "retry_delay"
        yield* schedulePaneIo(rt)
        return
      }
      rt.paneIoHandledGen = msg.gen
      rt.paneIoRunning = false
      yield* Match.value(msg).pipe(
        Match.tagsExhaustive({
          IoSplitResult: (m) => handleIoSplitResult(rt, m.intentId, m.outcome),
          IoTypeTurnResult: (m) => handleIoTypeTurnResult(rt, m),
          IoTypeResumeResult: (m) => handleIoTypeResumeResult(rt, m),
          IoAmbiguousResult: (m) => handleIoAmbiguousResult(rt, m),
          IoCloseResult: (m) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              if (m.ok) {
                yield* commitIntentCompletion(rt, m.intentId, MachineEvent.CloseCompleted({ intentId: m.intentId, now }))
              } else {
                rt.nextPaneIo = "retry_delay"
              }
              yield* schedulePaneIo(rt)
            }),
          IoScreenRead: (m) => handleIoScreenRead(rt, m.screen),
          IoIdleConfirmed: (m) =>
            Effect.gen(function* () {
              const priorScreen = rt.lastScreen
              rt.lastScreen = m.screen
              const now = yield* Clock.currentTimeMillis
              const deliveryId = yield* mintDeliveryId()
              yield* applyInternalTransition(
                rt,
                MachineEvent.IdleConfirmed({
                  screen: m.screen,
                  priorScreen,
                  resultFileAnswer: m.resultFileAnswer,
                  now,
                  deliveryId,
                }),
              )
              yield* schedulePaneIo(rt)
            }),
          IoPaneFault: (m) => handleIoPaneFault(rt, m.operation, m.kind, m.message, m.defect === true),
          IoQuietDone: (m) => handleIoQuietDone(rt, m.liveness, m.lastScreen),
          IoGoneProbe: (m) => handleIoGoneProbe(rt, m.liveness, m.tail, m.resultFileAnswer),
          IoRetryTick: () =>
            Effect.gen(function* () {
              rt.nextPaneIo = "read"
              yield* schedulePaneIo(rt)
            }),
          IoRetryCommit: (m) =>
            Effect.gen(function* () {
              const entry = Option.fromUndefinedOr(rt.pendingCommits.get(m.intentId))
              if (Option.isSome(entry) && outboxOf(rt.state.worker).some((i) => i.intentId === m.intentId)) {
                yield* commitIntentCompletion(rt, m.intentId, entry.value.event)
              } else {
                rt.pendingCommits.delete(m.intentId)
              }
              yield* schedulePaneIo(rt)
            }),
          IoPeerCheck: (m) => handleIoPeerCheck(rt, m.intentId, m.expired),
        }),
      )
    })

    const processIoMessage = Effect.fn("PaneAgent.processIoMessage")(function* (
      rt: ActorRuntime,
      msg: Exclude<
        ActorMessage,
        { readonly _tag: "CmdFollowUp" | "CmdRestart" | "CmdStop" | "CmdStatus" | "CmdReattach" | "CmdNudgeProbe" | "SignInLimited" }
      >,
    ) {
      if (msg._tag === "IoWakeResult") {
        yield* handleIoWakeResult(rt, msg)
        return
      }
      if (msg._tag === "IoWakeRetryCommit") {
        yield* handleIoWakeRetryCommit(rt, msg)
        return
      }
      if (msg._tag === "IoWakeTaskExited") {
        yield* handleIoWakeTaskExited(rt, msg)
        return
      }
      yield* processPaneIoMessage(rt, msg)
    })

    const processMessage = Effect.fn("PaneAgent.processMessage")(function* (rt: ActorRuntime, msg: ActorMessage) {
      if (msg._tag === "CmdFollowUp") {
        yield* completeCommand(msg.reply, handleCmdFollowUp(rt, msg.input))
        return
      }
      if (msg._tag === "CmdRestart") {
        yield* completeCommand(msg.reply, handleCmdRestart(rt, msg.input, msg.anchor))
        return
      }
      if (msg._tag === "CmdStop") {
        yield* completeCommand(msg.reply, handleCmdStop(rt, msg.input))
        return
      }
      if (msg._tag === "CmdStatus") {
        yield* completeCommand(msg.reply, handleCmdStatus(rt, msg.parentSessionID))
        return
      }
      if (msg._tag === "CmdReattach") {
        yield* completeCommand(msg.reply, handleCmdReattach(rt))
        return
      }
      if (msg._tag === "CmdNudgeProbe") {
        if (rt.entry.probePending || !isLive(rt.state.worker.state) && rt.state.worker.state !== "done") return
        yield* cancelPaneIo(rt)
        const now = yield* Clock.currentTimeMillis
        const deliveryId = yield* mintDeliveryId()
        const fileAnswer = yield* readResultOrNone(rt.state.worker)
        yield* applyInternalTransition(
          rt,
          MachineEvent.ProbeGone({ tail: shortLines(rt.lastScreen), resultFileAnswer: fileAnswer, now, deliveryId }),
        )
        yield* schedulePaneIo(rt)
        return
      }
      if (msg._tag === "SignInLimited") {
        const now = yield* Clock.currentTimeMillis
        const deliveryId = yield* mintDeliveryId()
        yield* applyInternalTransition(rt, MachineEvent.SignInLimited({ resetAt: msg.resetAt, now, deliveryId }))
        return
      }
      yield* processIoMessage(rt, msg)
    })

    const isQuiescent = (rt: ActorRuntime): boolean =>
      !needsPaneWork(rt.state.worker) &&
      !needsConfirmGone(rt) &&
      Option.isNone(nextRetryableWake(rt.state.worker)) &&
      rt.pendingCommits.size === 0 &&
      rt.pendingWakeCommits.size === 0 &&
      !rt.paneIoRunning &&
      !rt.wakeIoRunning

    const spawnActor = Effect.fn("PaneAgent.spawnActor")(function* (
      worker: PaneWorker,
      initialSawWorking: boolean,
      freshFromStore = false,
    ): Effect.fn.Return<ActorEntry> {
      const mailbox = yield* Queue.bounded<ActorMessage>(MAILBOX_CAPACITY)
      const paneIo = yield* FiberHandle.make<void, never>().pipe(Effect.provideService(Scope.Scope, scope))
      const wakeIo = yield* FiberHandle.make<void, never>().pipe(Effect.provideService(Scope.Scope, scope))
      const entry: ActorEntry = { mailbox, harness: worker.harness, probePending: false }
      const rt: ActorRuntime = {
        id: worker.id,
        entry,
        mailbox,
        paneIo,
        wakeIo,
        state: initialMachineState(worker, initialSawWorking),
        paneIoGen: 1,
        paneIoHandledGen: 0,
        paneIoRunning: false,
        wakeIoGen: 1,
        wakeIoHandledGen: 0,
        wakeIoRunning: false,
        nextPaneIo: "read",
        waitLimitUntil: 0,
        lastScreen: Option.getOrElse(Option.fromUndefinedOr(worker.lastLines), () => ""),
        needsReload: false,
        freshFromStore,
        needsInputPolls: 0,
        pendingCommits: new Map(),
        pendingWakeCommits: new Map(),
      }

      const cleanup = (exit: Exit.Exit<void, unknown>) =>
        Effect.gen(function* () {
          yield* Ref.update(actors, (prev) => {
            const current = prev.get(worker.id)
            if (current !== entry) return prev
            const next = new Map(prev)
            next.delete(worker.id)
            return next
          })
          yield* FiberHandle.clear(paneIo)
          yield* FiberHandle.clear(wakeIo)
          const pending = yield* Queue.clear(mailbox)
          let reason = "actor stopped"
          if (Exit.isFailure(exit)) reason = Cause.pretty(exit.cause)
          for (const queued of pending) {
            yield* failReplyOf(queued, worker.id, reason)
          }
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
            const crashes = yield* Ref.modify(crashCounts, (prev) => {
              const count = Option.getOrElse(Option.fromUndefinedOr(prev.get(worker.id)), () => 0) + 1
              return [count, new Map([...prev, [worker.id, count]])] as const
            })
            if (crashes <= MAX_ACTOR_RESTARTS && needsPaneWork(rt.state.worker)) {
              yield* Effect.forkIn(
                Effect.gen(function* () {
                  yield* pauseFor(retryDelay)
                  const snapOut = yield* runBounded(storeDeadline, store.read())
                  if (snapOut._tag !== "Succeeded") return
                  const found = Arr.findFirst(snapOut.value.workers, (w) => w.id === worker.id)
                  if (Option.isSome(found) && needsPaneWork(found.value)) {
                    yield* actorCreateLock.withPermits(1)(
                      Effect.gen(function* () {
                        const existing = (yield* Ref.get(actors)).get(worker.id)
                        if (Option.isSome(Option.fromUndefinedOr(existing))) return
                        yield* spawnActor(found.value, activeTurnTypedOf(found.value))
                      }),
                    )
                  }
                }).pipe(Effect.catchDefect(() => Effect.void)),
                scope,
              )
            }
          }
        })

      yield* Effect.forkIn(
        Effect.gen(function* () {
          yield* schedulePaneIo(rt)
          yield* scheduleWakeIo(rt)
          while (true) {
            if (isQuiescent(rt)) {
              const size = yield* Queue.size(mailbox)
              if (size === 0) break
            }
            const msg = yield* Queue.take(mailbox)
            const stepExit = yield* Effect.exit(processMessage(rt, msg))
            if (Exit.isFailure(stepExit)) {
              yield* failReplyOf(msg, worker.id, Cause.pretty(stepExit.cause))
              if (!Cause.hasInterruptsOnly(stepExit.cause)) {
                return yield* Effect.failCause(stepExit.cause)
              }
              return
            }
          }
        }).pipe(Effect.onExit(cleanup), Effect.catchDefect(() => Effect.void)),
        scope,
      )
      yield* Ref.update(actors, (prev) => new Map([...prev, [worker.id, entry]]))
      return entry
    })

    const getOrSpawnActor = Effect.fn("PaneAgent.getOrSpawnActor")(function* (
      id: string,
      initialSawWorking = false,
      knownWorker: Option.Option<PaneWorker> = Option.none(),
    ): Effect.fn.Return<ActorEntry, StoreFailed | WorkerRejected | WorkerCrashed | ToolTimedOut> {
      return yield* actorCreateLock.withPermits(1)(
        Effect.gen(function* () {
          const map = yield* Ref.get(actors)
          const existing = Option.fromUndefinedOr(map.get(id))
          if (Option.isSome(existing)) return existing.value
          if (Option.isSome(knownWorker)) {
            return yield* spawnActor(knownWorker.value, initialSawWorking)
          }
          const snap = yield* boundedStoreRead(id)
          const stored = Arr.findFirst(snap.workers, (w) => w.id === id)
          if (Option.isNone(stored)) {
            return yield* new WorkerRejected({ reason: `No pane worker found with id ${id}.` })
          }
          return yield* spawnActor(stored.value, initialSawWorking, true)
        }),
      )
    })

    const askActor = Effect.fn("PaneAgent.askActor")(function* (
      id: string,
      operation: string,
      makeMsg: (reply: Deferred.Deferred<PaneWorker, ModelError>) => ActorMessage,
      initialSawWorking = false,
      knownWorker: Option.Option<PaneWorker> = Option.none(),
    ): Effect.fn.Return<PaneWorker, ModelError> {
      const out = yield* runToolBounded(
        askDeadline,
        Effect.gen(function* () {
          const entry = yield* getOrSpawnActor(id, initialSawWorking, knownWorker)
          const reply = yield* Deferred.make<PaneWorker, ModelError>()
          yield* offerMsg(entry.mailbox, makeMsg(reply))
          return yield* Deferred.await(reply)
        }),
      )
      if (out._tag === "Succeeded") return out.value
      if (out._tag === "Failed") return yield* out.error
      if (out._tag === "TimedOut") {
        return yield* new ToolTimedOut({
          operation,
          workerId: id,
          deadlineMs: out.deadlineMs,
          message: `Pane worker ${operation} timed out after ${out.deadlineMs}ms`,
        })
      }
      return yield* new WorkerCrashed({ workerId: id, message: out.defect })
    })

    const nudgeProbe = (id: string) =>
      Effect.forkIn(
        Effect.gen(function* () {
          const entry = yield* getOrSpawnActor(id, true).pipe(Effect.option)
          if (Option.isNone(entry)) return
          if (entry.value.probePending) return
          const size = yield* Queue.size(entry.value.mailbox)
          if (size >= MAILBOX_CAPACITY - 4) return
          yield* Queue.offer(entry.value.mailbox, ActorMessage.CmdNudgeProbe())
        }).pipe(Effect.catchDefect(() => Effect.void)),
        scope,
      ).pipe(Effect.asVoid)

    const start = Effect.fn("PaneAgent.start")(function* (input: StartInput): Effect.fn.Return<PaneWorker, ModelError> {
      const adapter = adapterFor(input.harness)
      const explicitBlock = Option.filter(Option.fromUndefinedOr(input.blockId), (b) => b.length > 0)
      const explicitSession = Option.filter(Option.fromUndefinedOr(input.rexSession), (s) => s.length > 0)
      const explicitAnchor = resolveAnchor(input, Option.none())

      let savedAnchor: Option.Option<PaneAnchor> = Option.none()
      if (Option.isNone(explicitAnchor) && !(Option.isSome(explicitBlock) && Option.isSome(explicitSession))) {
        const snapshot = yield* boundedStoreRead("*")
        savedAnchor = Option.fromUndefinedOr(snapshot.anchors[input.parentSessionID])
      }
      const anchor = resolveAnchor(input, savedAnchor)

      const resolvedCwd = Option.getOrElse(Option.fromUndefinedOr(input.cwd), () => input.directory)
      const resolvedAddDirs = computeAddDirs(resolvedCwd, input.resultFile, input.addDirs)
      const skipPermissions = input.skipPermissions !== false
      const { role, unit } = parseDescription(input.description)
      const now = yield* Clock.currentTimeMillis
      const id = yield* makeRandomToken("pa")
      const brief = taskBrief({ prompt: input.prompt, resultFile: input.resultFile })

      let rexSessionId = ""
      let blockId = ""
      let ownedBlock = true
      const outbox: Array<DurableIntent> = []

      if (Option.isSome(explicitBlock)) {
        const sessionId = Option.orElse(explicitSession, () => Option.map(anchor, (a) => a.session))
        if (Option.isNone(sessionId)) {
          return yield* new WorkerRejected({
            reason: "Cannot target an existing block without a Rex session id (pass rexSession or bind a Rex pane).",
          })
        }
        rexSessionId = sessionId.value
        blockId = explicitBlock.value
        ownedBlock = false
      } else {
        if (Option.isNone(anchor)) {
          return yield* new WorkerRejected({
            reason: "No Rex pane anchor is known for this session; open OpenCode inside Rex or pass rexSession and rexBlock.",
          })
        }
        rexSessionId = anchor.value.session
        const command = adapter.command(
          buildStartOptions(input.harness, resolvedAddDirs, skipPermissions, config.binaryOverrides),
        )
        const reqId = yield* makeRandomToken("rq")
        const intentId = yield* makeRandomToken("sp")
        const splitIntent = SplitPaneIntent.make({
          intentId,
          reqId,
          ownerProc: procId,
          sessionId: anchor.value.session,
          anchorBlockId: anchor.value.block,
          label: splitLabelFor(input.harness, unit, reqId),
          command: [...command],
          cwd: resolvedCwd,
          forRestart: false,
          dispatched: false,
          attempt: 1,
          createdAt: now,
        })
        outbox.push(splitIntent)
      }

      const starting: PaneWorker = {
        id,
        parentSessionID: input.parentSessionID,
        directory: input.directory,
        cwd: resolvedCwd,
        addDirs: [...resolvedAddDirs],
        skipPermissions,
        harness: input.harness,
        role,
        unit,
        rexSessionId,
        blockId,
        ownedBlock,
        resultFile: input.resultFile,
        state: "starting",
        update: `starting ${input.harness} in Rex pane`,
        turn: 1,
        notifiedTurn: 0,
        revision: 0,
        activeTurnTyped: false,
        outbox,
        pendingTurns: [{ turn: 1, brief, resultFile: input.resultFile, mode: "submit", queuedAt: now }],
        pendingWakes: [],
        deliveredWakes: [],
        startedAt: now,
        updatedAt: now,
      }
      const created = yield* boundedUpsert(starting, 0)
      yield* actorCreateLock.withPermits(1)(spawnActor(created, false))
      return created
    })

    const followUp = Effect.fn("PaneAgent.followUp")(function* (input: FollowUpInput) {
      return yield* askActor(input.id, "follow_up", (reply) => ActorMessage.CmdFollowUp({ input, reply }))
    })

    const restart = Effect.fn("PaneAgent.restart")(function* (input: RestartInput): Effect.fn.Return<PaneWorker, ModelError> {
      const out = yield* runToolBounded(
        askDeadline,
        Effect.gen(function* () {
          const explicitAnchor = resolveAnchor(input, Option.none())
          let anchor = explicitAnchor
          if (Option.isNone(anchor)) {
            const snapshot = yield* boundedStoreRead(input.id)
            const savedAnchor = Option.fromUndefinedOr(snapshot.anchors[input.parentSessionID])
            anchor = resolveAnchor(input, savedAnchor)
          }
          if (Option.isNone(anchor)) {
            return yield* new WorkerRejected({
              reason: "No Rex pane anchor is known for this session; open OpenCode inside Rex or pass rexSession and rexBlock.",
            })
          }
          const resolvedAnchor = anchor.value
          return yield* askActor(input.id, "restart", (reply) =>
            ActorMessage.CmdRestart({ input, anchor: resolvedAnchor, reply }),
          )
        }),
      )
      if (out._tag === "Succeeded") return out.value
      if (out._tag === "Failed") return yield* out.error
      if (out._tag === "TimedOut") {
        return yield* new ToolTimedOut({
          operation: "restart",
          workerId: input.id,
          deadlineMs: out.deadlineMs,
          message: `Pane worker restart timed out after ${out.deadlineMs}ms`,
        })
      }
      return yield* new WorkerCrashed({ workerId: input.id, message: out.defect })
    })

    const stop = Effect.fn("PaneAgent.stop")(function* (input: StopInput) {
      return yield* askActor(input.id, "stop", (reply) => ActorMessage.CmdStop({ input, reply }))
    })

    const status = Effect.fn("PaneAgent.status")(function* (
      parentSessionID: string,
      id: string,
    ): Effect.fn.Return<PaneWorker, ModelError> {
      const map = yield* Ref.get(actors)
      let worker: PaneWorker
      if (map.has(id)) {
        worker = yield* askActor(id, "status", (reply) => ActorMessage.CmdStatus({ parentSessionID, reply }))
      } else {
        const snap = yield* boundedStoreRead(id)
        const found = Arr.findFirst(snap.workers, (w) => w.id === id)
        if (Option.isNone(found)) {
          return yield* new WorkerRejected({ reason: `No pane worker found with id ${id}.` })
        }
        if (found.value.parentSessionID !== parentSessionID) {
          return yield* new WorkerRejected({ reason: `Pane worker ${id} belongs to another session.` })
        }
        worker = found.value
      }

      const expectsPane =
        worker.blockId.length > 0 &&
        worker.state !== "stopped" &&
        worker.state !== "pane_gone" &&
        worker.state !== "failed"
      if (!expectsPane) return worker

      const tailOut = yield* runBounded(tailDeadline, rex.readTail(targetOf(worker), TAIL_BYTES))
      if (tailOut._tag === "Succeeded") {
        return { ...worker, lastLines: shortLines(tailOut.value) }
      }
      if (tailOut._tag === "Failed" && tailOut.error._tag === "RexPaneGone") {
        yield* nudgeProbe(id)
      }
      return worker
    })

    const list = Effect.fn("PaneAgent.list")(function* (parentSessionID: string) {
      const snapshot = yield* boundedStoreRead("*")
      return snapshot.workers.filter((worker) => worker.parentSessionID === parentSessionID)
    })

    const views = Effect.fn("PaneAgent.views")(function* (parentSessionID: string) {
      const workers = yield* list(parentSessionID)
      return workers.map(viewOf)
    })

    const bindPane = Effect.fn("PaneAgent.bindPane")(function* (sessionID: string, anchor: PaneAnchor) {
      const out = yield* runBounded(storeDeadline, store.saveAnchor(sessionID, anchor))
      if (out._tag === "Succeeded") return
      if (out._tag === "Failed") return yield* out.error
      if (out._tag === "TimedOut") {
        return yield* new ToolTimedOut({
          operation: "bindPane",
          workerId: "*",
          deadlineMs: out.deadlineMs,
          message: `saveAnchor timed out after ${out.deadlineMs}ms`,
        })
      }
      return yield* new WorkerCrashed({ workerId: "*", message: out.defect })
    })

    const needsReattach = (worker: PaneWorker): boolean =>
      needsPaneWork(worker) || pendingWakesOf(worker).length > 0 || hasUndeliveredWakes(worker)

    const retryReattachInBackground = (directory: string) =>
      Effect.forkIn(
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 5; attempt++) {
            yield* pauseFor(Duration.max(Duration.millis(20), retryDelay))
            const snapOut = yield* runBounded(storeDeadline, store.read())
            if (snapOut._tag !== "Succeeded") continue
            const candidates = snapOut.value.workers.filter((w) => w.directory === directory && needsReattach(w))
            yield* Effect.forEach(
              candidates,
              (worker) =>
                askActor(
                  worker.id,
                  "reattach",
                  (reply) => ActorMessage.CmdReattach({ reply }),
                  activeTurnTypedOf(worker),
                  Option.some(worker),
                ).pipe(Effect.option),
              { concurrency: 16 },
            )
            return
          }
        }).pipe(Effect.catchDefect(() => Effect.void)),
        scope,
      ).pipe(Effect.asVoid)

    const reattach = Effect.fn("PaneAgent.reattach")(function* (directory: string): Effect.fn.Return<ReadonlyArray<PaneWorker>, ModelError> {
      const snapRes = yield* Effect.result(boundedStoreRead("*"))
      if (snapRes._tag === "Failure") {
        yield* retryReattachInBackground(directory)
        return yield* snapRes.failure
      }
      const snapshot = snapRes.success
      const candidates = snapshot.workers.filter((worker) => worker.directory === directory && needsReattach(worker))
      const resultsOut = yield* Effect.forEach(
        candidates,
        (worker) =>
          askActor(
            worker.id,
            "reattach",
            (reply) => ActorMessage.CmdReattach({ reply }),
            activeTurnTypedOf(worker),
            Option.some(worker),
          ).pipe(Effect.option),
        { concurrency: 16 },
      )
      return resultsOut.flatMap((item) => Option.toArray(item))
    })

    return PaneAgentModel.of({
      start,
      followUp,
      restart,
      stop,
      status,
      list,
      views,
      bindPane,
      reattach,
    })
  })

export const layer = (config: ModelConfig = {}) => Layer.effect(PaneAgentModel, makeModel(config))
