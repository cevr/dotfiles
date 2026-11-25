import {
  Array as Arr,
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  FiberHandle,
  Layer,
  Match,
  Option,
  Queue,
  Random,
  Ref,
  Scope,
  Semaphore,
} from "effect"
import { adapterFor, type Harness, type HarnessAdapter, type ResumeOptions, type StartOptions } from "./adapter.ts"
import {
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
  type StoreFailed,
  WorkerRejected,
  WorkerStore,
} from "./service.ts"
import {
  isLive,
  type PaneAnchor,
  type PaneWorker,
  type PaneWorkerView,
  parseDescription,
  pendingWakesOf,
  revisionOf,
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

export type ModelError = RexError | StoreFailed | StoreConflict | ResultReadFailed | WorkerRejected

export class PaneAgentModel extends Context.Service<
  PaneAgentModel,
  {
    readonly start: (input: StartInput) => Effect.Effect<PaneWorker, ModelError>
    readonly followUp: (input: FollowUpInput) => Effect.Effect<PaneWorker, ModelError>
    readonly restart: (input: RestartInput) => Effect.Effect<PaneWorker, ModelError>
    readonly stop: (input: StopInput) => Effect.Effect<PaneWorker, ModelError>
    readonly status: (parentSessionID: string, id: string) => Effect.Effect<PaneWorker, ModelError>
    readonly list: (parentSessionID: string) => Effect.Effect<ReadonlyArray<PaneWorker>, StoreFailed>
    readonly views: (parentSessionID: string) => Effect.Effect<ReadonlyArray<PaneWorkerView>, StoreFailed>
    readonly bindPane: (sessionID: string, anchor: PaneAnchor) => Effect.Effect<void, StoreFailed>
    readonly reattach: (directory: string) => Effect.Effect<ReadonlyArray<PaneWorker>, ModelError>
  }
>()("dotfiles-opencode/pane-agent/PaneAgentModel") {}

const DEFAULT_QUIET = Duration.seconds(2)
const DEFAULT_POLL_TIMEOUT = Duration.seconds(5)
const DEFAULT_PASTE_QUIET = Duration.millis(200)
const DEFAULT_MAX_WAKE_BACKOFF = Duration.seconds(30)
const DEFAULT_STARTUP_CHECKS = 5
const TAIL_BYTES = 16_384
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

type RexClientApi = Effect.Success<typeof RexClient>

const resolveDuration = (fallback: Duration.Duration, given?: Duration.Input): Duration.Duration =>
  Option.match(Option.fromUndefinedOr(given), {
    onNone: () => fallback,
    onSome: (input) => Duration.fromInputUnsafe(input),
  })

const pauseFor = (delay: Duration.Duration): Effect.Effect<void> => {
  if (Duration.isZero(delay)) return Effect.yieldNow
  return Effect.sleep(delay)
}

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

const makeWorkerId = Effect.fn("PaneAgent.makeWorkerId")(function* () {
  const n = yield* Random.nextIntBetween(0x100000, 0xffffff)
  return `pa_${n.toString(36)}`
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

const writeChunks = (
  rex: RexClientApi,
  target: PaneTarget,
  chunks: ReadonlyArray<string>,
  pasteQuiet: Duration.Duration,
) =>
  Effect.gen(function* () {
    for (let index = 0; index < chunks.length; index++) {
      const chunk = Arr.get(chunks, index)
      if (Option.isNone(chunk)) continue
      yield* rex.write(target, chunk.value)
      if (index + 1 < chunks.length) {
        yield* rex.waitForQuiet(target, { quietFor: pasteQuiet, timeout: Duration.seconds(2) })
      }
    }
  })

const needsPaneWork = (worker: PaneWorker): boolean =>
  isLive(worker.state) || pendingTurnsOf(worker).length > 0

const hasAction = (actions: ReadonlyArray<MachineAction>, tag: MachineAction["_tag"]): boolean =>
  actions.some((action) => action._tag === tag)

/** Messages processed serially by a worker's single actor mailbox. */
type ActorMessage = Data.TaggedEnum<{
  readonly CmdAwaitStart: { readonly reply: Deferred.Deferred<PaneWorker, ModelError> }
  readonly CmdFollowUp: {
    readonly input: FollowUpInput
    readonly reply: Deferred.Deferred<PaneWorker, ModelError>
  }
  readonly CmdRestart: {
    readonly input: RestartInput
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
  readonly IoScreenRead: { readonly gen: number; readonly screen: string }
  readonly IoIdleConfirmed: {
    readonly gen: number
    readonly screen: string
    readonly resultFileAnswer: Option.Option<string>
  }
  readonly IoRexError: { readonly gen: number; readonly operation: string; readonly error: RexError }
  readonly IoQuietDone: { readonly gen: number; readonly liveness: PaneLiveness; readonly lastScreen: string }
  readonly IoGoneProbe: {
    readonly gen: number
    readonly liveness: PaneLiveness
    readonly tail: string
    readonly resultFileAnswer: Option.Option<string>
  }
  readonly IoRetryTick: { readonly gen: number }
  readonly IoWakeResult: {
    readonly deliveryId: string
    readonly ok: boolean
    readonly error: string
  }
}>

const ActorMessage = Data.taggedEnum<ActorMessage>()

type PaneIoMode = "read" | "confirm_idle" | "wait_quiet" | "confirm_gone" | "retry_delay"

interface ActorRuntime {
  readonly id: string
  readonly mailbox: Queue.Queue<ActorMessage>
  readonly paneIo: FiberHandle.FiberHandle<void, never>
  readonly wakeIo: FiberHandle.FiberHandle<void, never>
  state: MachineState
  paneIoGen: number
  paneIoRunning: boolean
  wakeIoRunning: boolean
  nextPaneIo: PaneIoMode
  lastScreen: string
}

const makeModel = (config: ModelConfig = {}) =>
  Effect.gen(function* () {
    const rex = yield* RexClient
    const store = yield* WorkerStore
    const results = yield* ResultFiles
    const notifier = yield* Notifier
    const scope = yield* Scope.Scope
    const actors = yield* Ref.make<ReadonlyMap<string, Queue.Queue<ActorMessage>>>(new Map())
    const actorCreateLock = yield* Semaphore.make(1)
    const mintDeliveryId = yield* makeDeliveryIdMinter

    const quietFor = resolveDuration(DEFAULT_QUIET, config.quietFor)
    const pollTimeout = resolveDuration(DEFAULT_POLL_TIMEOUT, config.pollTimeout)
    const pasteQuiet = resolveDuration(DEFAULT_PASTE_QUIET, config.pasteQuiet)
    const retryDelay = resolveDuration(pasteQuiet, config.retryDelay)
    const maxWakeBackoff = resolveDuration(DEFAULT_MAX_WAKE_BACKOFF, config.maxWakeBackoff)
    const maxStartupChecks = Option.getOrElse(
      Option.fromUndefinedOr(config.maxStartupChecks),
      () => DEFAULT_STARTUP_CHECKS,
    )
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
    }

    const readResultOrNone = (worker: PaneWorker) =>
      results.readComplete(worker.resultFile, worker.startedAt).pipe(
        Effect.orElseSucceed(() => Option.none<string>()),
      )

    const findWorkerInStore = Effect.fn("PaneAgent.findWorkerInStore")(function* (id: string) {
      const snap = yield* store.read()
      return Arr.findFirst(snap.workers, (worker) => worker.id === id)
    })

    /** CAS-persists the worker's next state using expectedRevision = revisionOf(prev). */
    const casPersist = Effect.fn("PaneAgent.casPersist")(function* (
      prev: PaneWorker,
      next: PaneWorker,
    ): Effect.fn.Return<PaneWorker, StoreFailed | StoreConflict> {
      const expected = revisionOf(prev)
      const snap = yield* store.upsertWorker(next, expected)
      yield* notifier.changed(next.parentSessionID)
      const saved = Arr.findFirst(snap.workers, (w) => w.id === next.id)
      return Option.getOrElse(saved, () => ({ ...next, revision: expected + 1 }))
    })

    const confirmDoubleGone = Effect.fn("PaneAgent.confirmDoubleGone")(function* (target: PaneTarget) {
      const first = yield* rex.alive(target)
      if (first !== "gone") return first
      yield* pauseFor(retryDelay)
      return yield* rex.alive(target)
    })

    const offerMsg = (mailbox: Queue.Queue<ActorMessage>, msg: ActorMessage) =>
      Queue.offer(mailbox, msg).pipe(Effect.asVoid)

    const cancelPaneIo = Effect.fn("PaneAgent.cancelPaneIo")(function* (rt: ActorRuntime) {
      rt.paneIoGen += 1
      rt.paneIoRunning = false
      yield* FiberHandle.clear(rt.paneIo)
    })

    const scheduleWakeIo = Effect.fn("PaneAgent.scheduleWakeIo")(function* (rt: ActorRuntime) {
      if (rt.wakeIoRunning) return
      const nextWake = nextRetryableWake(rt.state.worker)
      if (Option.isNone(nextWake)) return
      const wake = nextWake.value
      const sessionID = rt.state.worker.parentSessionID
      const attempts = Option.getOrElse(Option.fromUndefinedOr(wake.attempts), () => 0)
      const delay = computeBackoff(retryDelay, maxWakeBackoff, attempts)
      rt.wakeIoRunning = true
      yield* FiberHandle.run(
        rt.wakeIo,
        Effect.gen(function* () {
          yield* pauseFor(delay)
          const res = yield* Effect.result(notifier.wake(sessionID, wakeLetterOf(wake)))
          if (res._tag === "Success") {
            yield* offerMsg(rt.mailbox, ActorMessage.IoWakeResult({ deliveryId: wake.deliveryId, ok: true, error: "" }))
          } else {
            yield* offerMsg(
              rt.mailbox,
              ActorMessage.IoWakeResult({ deliveryId: wake.deliveryId, ok: false, error: res.failure.message }),
            )
          }
        }).pipe(Effect.catchCause((cause) => Effect.logDebug("pane-agent wake io ended", cause))),
      )
    })

    const runPaneIoTask = Effect.fn("PaneAgent.runPaneIoTask")(function* (
      rt: ActorRuntime,
      gen: number,
      mode: PaneIoMode,
      worker: PaneWorker,
      lastScreen: string,
    ) {
      const target = targetOf(worker)
      if (mode === "confirm_idle") {
        const waitRes = yield* Effect.result(rex.waitForQuiet(target, { quietFor, timeout: pollTimeout }))
        if (waitRes._tag === "Failure") {
          yield* offerMsg(rt.mailbox, ActorMessage.IoRexError({ gen, operation: "terminals.waitForQuiet", error: waitRes.failure }))
          return
        }
        const readRes = yield* Effect.result(rex.read(target))
        if (readRes._tag === "Failure") {
          yield* offerMsg(rt.mailbox, ActorMessage.IoRexError({ gen, operation: "terminals.read", error: readRes.failure }))
          return
        }
        const fileAnswer = yield* readResultOrNone(worker)
        yield* offerMsg(rt.mailbox, ActorMessage.IoIdleConfirmed({ gen, screen: readRes.success, resultFileAnswer: fileAnswer }))
        return
      }
      if (mode === "confirm_gone") {
        yield* pauseFor(retryDelay)
        const aliveRes = yield* Effect.result(rex.alive(target))
        if (aliveRes._tag === "Failure") {
          yield* offerMsg(rt.mailbox, ActorMessage.IoRexError({ gen, operation: "terminals.process", error: aliveRes.failure }))
          return
        }
        const fileAnswer = yield* readResultOrNone(worker)
        yield* offerMsg(
          rt.mailbox,
          ActorMessage.IoGoneProbe({ gen, liveness: aliveRes.success, tail: shortLines(lastScreen), resultFileAnswer: fileAnswer }),
        )
        return
      }
      if (mode === "retry_delay") {
        yield* pauseFor(retryDelay)
        yield* offerMsg(rt.mailbox, ActorMessage.IoRetryTick({ gen }))
        return
      }
      if (mode === "wait_quiet") {
        const aliveRes = yield* Effect.result(rex.alive(target))
        if (aliveRes._tag === "Failure") {
          yield* offerMsg(rt.mailbox, ActorMessage.IoRexError({ gen, operation: "terminals.process", error: aliveRes.failure }))
          return
        }
        if (aliveRes.success === "alive") {
          yield* rex.waitForQuiet(target, { quietFor, timeout: pollTimeout }).pipe(Effect.ignore)
        }
        yield* offerMsg(rt.mailbox, ActorMessage.IoQuietDone({ gen, liveness: aliveRes.success, lastScreen }))
        return
      }
      const screenRes = yield* Effect.result(rex.read(target))
      if (screenRes._tag === "Failure") {
        yield* offerMsg(rt.mailbox, ActorMessage.IoRexError({ gen, operation: "terminals.read", error: screenRes.failure }))
        return
      }
      yield* offerMsg(rt.mailbox, ActorMessage.IoScreenRead({ gen, screen: screenRes.success }))
    })

    const schedulePaneIo = Effect.fn("PaneAgent.schedulePaneIo")(function* (rt: ActorRuntime) {
      if (rt.paneIoRunning) return
      if (!needsPaneWork(rt.state.worker)) return
      const gen = rt.paneIoGen
      const mode = rt.nextPaneIo
      const worker = rt.state.worker
      const lastScreen = rt.lastScreen
      rt.paneIoRunning = true
      yield* FiberHandle.run(
        rt.paneIo,
        runPaneIoTask(rt, gen, mode, worker, lastScreen).pipe(
          Effect.catchCause((cause) => Effect.logDebug("pane-agent pane io ended", cause)),
        ),
      )
    })

    /** Applies transition actions inside the single actor loop; CAS-persists before writes/replies. */
    const applyActorTransition = Effect.fn("PaneAgent.applyActorTransition")(function* (
      rt: ActorRuntime,
      event: MachineEvent,
      autoScheduleWake = true,
    ): Effect.fn.Return<ReadonlyArray<MachineAction>, ModelError> {
      const prevWorker = rt.state.worker
      const adapter = adapterFor(prevWorker.harness)
      const res = transition(rt.state, event, adapter, machineConfig)
      let nextWorker = res.state.worker
      const target = targetOf(nextWorker)

      for (const action of res.actions) {
        if (action._tag === "Persist") {
          nextWorker = yield* casPersist(prevWorker, nextWorker)
        } else if (action._tag === "WritePane") {
          yield* writeChunks(rex, target, action.chunks, pasteQuiet)
        } else if (action._tag === "InterruptPane") {
          yield* rex.write(target, adapter.interruptSequence).pipe(Effect.ignore)
          if (action.close) {
            yield* rex.close(target).pipe(Effect.ignore)
          }
        }
      }

      rt.state = { ...res.state, worker: nextWorker }
      if (hasAction(res.actions, "ConfirmIdle")) {
        rt.nextPaneIo = "confirm_idle"
      } else if (hasAction(res.actions, "ConfirmGone")) {
        rt.nextPaneIo = "confirm_gone"
      } else if (hasAction(res.actions, "RetryTransient")) {
        rt.nextPaneIo = "retry_delay"
      } else if (hasAction(res.actions, "WaitQuiet")) {
        rt.nextPaneIo = "wait_quiet"
      } else {
        rt.nextPaneIo = "read"
      }
      if (autoScheduleWake && hasAction(res.actions, "FlushWake")) {
        yield* scheduleWakeIo(rt)
      }
      return res.actions
    })

    const reloadOnConflict = Effect.fn("PaneAgent.reloadOnConflict")(function* (rt: ActorRuntime) {
      const fresh = yield* findWorkerInStore(rt.id).pipe(Effect.orElseSucceed(() => Option.none<PaneWorker>()))
      if (Option.isSome(fresh)) {
        rt.state = initialMachineState(fresh.value, activeTurnTypedOf(fresh.value))
      }
    })

    const applyActorTransitionOrReload = Effect.fn("PaneAgent.applyActorTransitionOrReload")(function* (
      rt: ActorRuntime,
      event: MachineEvent,
    ) {
      const res = yield* Effect.result(applyActorTransition(rt, event))
      if (res._tag === "Success") return Option.some(res.success)
      if (res.failure._tag === "StoreConflict") {
        yield* reloadOnConflict(rt)
        rt.nextPaneIo = "read"
      } else {
        rt.nextPaneIo = "retry_delay"
      }
      return Option.none<ReadonlyArray<MachineAction>>()
    })

    /** Performs one immediate non-blocking wake delivery attempt; on failure hands off to wakeIo backoff. */
    const flushWakeOnce = Effect.fn("PaneAgent.flushWakeOnce")(function* (rt: ActorRuntime) {
      if (rt.wakeIoRunning) return
      const nextWake = nextRetryableWake(rt.state.worker)
      if (Option.isNone(nextWake)) return
      const wake = nextWake.value
      const res = yield* Effect.result(notifier.wake(rt.state.worker.parentSessionID, wakeLetterOf(wake)))
      const now = yield* Clock.currentTimeMillis
      if (res._tag === "Success") {
        yield* applyActorTransitionOrReload(rt, MachineEvent.WakeDelivered({ deliveryId: wake.deliveryId, now }))
      } else {
        yield* applyActorTransitionOrReload(
          rt,
          MachineEvent.WakeFailed({ deliveryId: wake.deliveryId, message: res.failure.message, now }),
        )
      }
      yield* scheduleWakeIo(rt)
    })

    const markConfirmedGoneInActor = Effect.fn("PaneAgent.markConfirmedGoneInActor")(function* (rt: ActorRuntime) {
      yield* cancelPaneIo(rt)
      const fileAnswer = yield* readResultOrNone(rt.state.worker)
      for (let count = 0; count < machineConfig.confirmGoneCount; count++) {
        const now = yield* Clock.currentTimeMillis
        const deliveryId = yield* mintDeliveryId()
        yield* applyActorTransition(
          rt,
          MachineEvent.ProbeGone({ tail: shortLines(rt.lastScreen), resultFileAnswer: fileAnswer, now, deliveryId }),
          false,
        )
      }
      yield* flushWakeOnce(rt)
      return rt.state.worker
    })

    const startupErrorEvent = (error: RexError, now: number, deliveryId: string): MachineEvent => {
      if (error._tag === "RexPaneGone") {
        return MachineEvent.ProbeGone({ tail: "", resultFileAnswer: Option.none(), now, deliveryId })
      }
      return MachineEvent.TransientError({
        operation: "terminals.read",
        message: error.message,
        now,
        deliveryId,
      })
    }

    const stepStartAttempt = Effect.fn("PaneAgent.stepStartAttempt")(function* (rt: ActorRuntime) {
      const target = targetOf(rt.state.worker)
      const screenRes = yield* Effect.result(rex.read(target))
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      if (screenRes._tag === "Failure") {
        if (screenRes.failure._tag === "RexUnsupportedRevision") {
          const err: ModelError = screenRes.failure
          return { kind: "fail" as const, error: err }
        }
        const applied = yield* Effect.result(
          applyActorTransition(rt, startupErrorEvent(screenRes.failure, now, deliveryId), false),
        )
        if (applied._tag === "Failure") return { kind: "fail" as const, error: applied.failure }
        if (hasAction(applied.success, "StopWatching")) {
          yield* flushWakeOnce(rt)
          return { kind: "done" as const }
        }
        yield* pauseFor(retryDelay)
        return { kind: "continue" as const }
      }

      rt.lastScreen = screenRes.success
      const applied = yield* Effect.result(
        applyActorTransition(rt, MachineEvent.ObserveScreen({ screen: screenRes.success, now, deliveryId }), false),
      )
      if (applied._tag === "Failure") return { kind: "fail" as const, error: applied.failure }
      if (rt.state.worker.state === "needs_input" || rt.state.worker.state === "working") {
        if (rt.state.worker.state === "needs_input") {
          yield* flushWakeOnce(rt)
          rt.nextPaneIo = "retry_delay"
        } else {
          rt.nextPaneIo = "read"
        }
        yield* schedulePaneIo(rt)
        return { kind: "done" as const }
      }
      yield* rex.waitForQuiet(target, { quietFor: pasteQuiet, timeout: pollTimeout }).pipe(Effect.ignore)
      return { kind: "continue" as const }
    })

    const handleCmdAwaitStart = Effect.fn("PaneAgent.handleCmdAwaitStart")(function* (
      rt: ActorRuntime,
      reply: Deferred.Deferred<PaneWorker, ModelError>,
    ) {
      for (let attempt = 0; attempt < maxStartupChecks; attempt++) {
        const step = yield* stepStartAttempt(rt)
        if (step.kind === "fail") {
          yield* Deferred.fail(reply, step.error)
          return
        }
        if (step.kind === "done") {
          yield* Deferred.succeed(reply, rt.state.worker)
          return
        }
      }
      rt.nextPaneIo = "read"
      yield* schedulePaneIo(rt)
      yield* Deferred.succeed(reply, rt.state.worker)
    })

    const handleCmdFollowUp = Effect.fn("PaneAgent.handleCmdFollowUp")(function* (
      rt: ActorRuntime,
      input: FollowUpInput,
    ): Effect.fn.Return<PaneWorker, ModelError> {
      if (rt.state.worker.parentSessionID !== input.parentSessionID) {
        return yield* new WorkerRejected({ reason: `Pane worker ${input.id} belongs to another session.` })
      }
      const target = targetOf(rt.state.worker)
      const liveness = yield* confirmDoubleGone(target)
      if (liveness === "gone") {
        yield* markConfirmedGoneInActor(rt)
        return yield* new WorkerRejected({
          reason: `Pane ${rt.state.worker.blockId} for worker ${rt.state.worker.id} is gone; call pane_agent({ action: "restart", id: "${rt.state.worker.id}" }) to resume it with --continue.`,
        })
      }

      const now = yield* Clock.currentTimeMillis
      const requestedFile = Option.fromUndefinedOr(input.resultFile)

      if (input.steer === true) {
        const screenOpt = yield* rex.read(target).pipe(Effect.option)
        const actions = yield* applyActorTransition(
          rt,
          MachineEvent.RequestSteer({ prompt: input.prompt, resultFile: requestedFile, screen: screenOpt, now }),
        )
        if (hasAction(actions, "WritePane")) {
          yield* cancelPaneIo(rt)
          rt.nextPaneIo = "read"
        }
        yield* schedulePaneIo(rt)
        return rt.state.worker
      }

      const wasIdle =
        (rt.state.worker.state === "done" || rt.state.worker.state === "wake_undelivered") &&
        !activeTurnTypedOf(rt.state.worker)
      yield* applyActorTransition(
        rt,
        MachineEvent.QueueFollowUp({ prompt: input.prompt, resultFile: requestedFile, now }),
      )

      if (wasIdle) {
        const screenRes = yield* Effect.result(rex.read(target))
        if (screenRes._tag === "Success") {
          rt.lastScreen = screenRes.success
          const stepNow = yield* Clock.currentTimeMillis
          const deliveryId = yield* mintDeliveryId()
          yield* applyActorTransition(
            rt,
            MachineEvent.ObserveScreen({ screen: screenRes.success, now: stepNow, deliveryId }),
          )
        }
        yield* cancelPaneIo(rt)
        rt.nextPaneIo = "read"
      }

      yield* schedulePaneIo(rt)
      return rt.state.worker
    })

    const handleCmdRestart = Effect.fn("PaneAgent.handleCmdRestart")(function* (
      rt: ActorRuntime,
      input: RestartInput,
    ): Effect.fn.Return<PaneWorker, ModelError> {
      const existing = rt.state.worker
      if (existing.parentSessionID !== input.parentSessionID) {
        return yield* new WorkerRejected({ reason: `Pane worker ${input.id} belongs to another session.` })
      }
      const liveness = yield* rex.alive(targetOf(existing))
      const canRestart =
        existing.state === "pane_gone" ||
        existing.state === "stopped" ||
        existing.state === "failed" ||
        liveness === "gone"
      if (!canRestart) {
        return yield* new WorkerRejected({
          reason: `Pane ${existing.blockId} for worker ${existing.id} is still alive; use follow_up or steer instead of restart.`,
        })
      }

      const snapshot = yield* store.read()
      const savedAnchor = Option.fromUndefinedOr(snapshot.anchors[input.parentSessionID])
      const anchor = resolveAnchor(input, savedAnchor)
      if (Option.isNone(anchor)) {
        return yield* new WorkerRejected({
          reason: "No Rex pane anchor is known for this session; open OpenCode inside Rex or pass rexSession and rexBlock.",
        })
      }

      yield* cancelPaneIo(rt)
      if (existing.ownedBlock) {
        yield* rex.close(targetOf(existing)).pipe(Effect.ignore)
      }

      const adapter = adapterFor(existing.harness)
      const workerCwd = Option.getOrElse(Option.fromUndefinedOr(existing.cwd), () => existing.directory)
      const nextResultFile = Option.getOrElse(
        Option.filter(Option.fromUndefinedOr(input.resultFile), (f) => f.trim().length > 0),
        () => existing.resultFile,
      )
      const nextAddDirs = computeAddDirs(workerCwd, nextResultFile, existing.addDirs)
      const skipPermissions = existing.skipPermissions !== false
      const briefInput = Option.match(Option.fromUndefinedOr(input.prompt), {
        onNone: () => ({ resultFile: nextResultFile }),
        onSome: (prompt) => ({ prompt, resultFile: nextResultFile }),
      })
      const brief = resumeBrief(briefInput)
      const command = adapter.resumeCommand(
        buildResumeOptions(existing.harness, brief, nextAddDirs, skipPermissions, config.binaryOverrides),
      )
      const newBlockId = yield* rex.splitRight({
        sessionId: anchor.value.session,
        anchorBlockId: anchor.value.block,
        label: `${existing.harness}:${existing.unit}`.slice(0, 48),
        command,
        cwd: workerCwd,
      })

      const now = yield* Clock.currentTimeMillis
      yield* applyActorTransition(
        rt,
        MachineEvent.RestartPane({
          rexSessionId: anchor.value.session,
          newBlockId,
          cwd: workerCwd,
          addDirs: nextAddDirs,
          resultFile: nextResultFile,
          now,
        }),
      )
      rt.nextPaneIo = "read"
      yield* schedulePaneIo(rt)
      yield* scheduleWakeIo(rt)
      return rt.state.worker
    })

    const handleCmdStop = Effect.fn("PaneAgent.handleCmdStop")(function* (
      rt: ActorRuntime,
      input: StopInput,
    ): Effect.fn.Return<PaneWorker, ModelError> {
      if (rt.state.worker.parentSessionID !== input.parentSessionID) {
        return yield* new WorkerRejected({ reason: `Pane worker ${input.id} belongs to another session.` })
      }
      yield* cancelPaneIo(rt)
      const now = yield* Clock.currentTimeMillis
      yield* applyActorTransition(rt, MachineEvent.Stop({ close: input.close === true, now }))
      return rt.state.worker
    })

    const handleCmdStatus = Effect.fn("PaneAgent.handleCmdStatus")(function* (
      rt: ActorRuntime,
      parentSessionID: string,
    ): Effect.fn.Return<PaneWorker, ModelError> {
      if (rt.state.worker.parentSessionID !== parentSessionID) {
        return yield* new WorkerRejected({ reason: `Pane worker ${rt.id} belongs to another session.` })
      }
      const existing = rt.state.worker
      const target = targetOf(existing)
      const expectsPane =
        existing.state !== "stopped" &&
        existing.state !== "pane_gone" &&
        existing.state !== "failed" &&
        existing.state !== "wake_undelivered"
      if (expectsPane) {
        const liveness = yield* confirmDoubleGone(target)
        if (liveness === "gone") {
          return yield* markConfirmedGoneInActor(rt)
        }
      }
      const tailOpt = yield* rex.readTail(target, TAIL_BYTES).pipe(Effect.option)
      if (Option.isNone(tailOpt)) return rt.state.worker
      return { ...rt.state.worker, lastLines: shortLines(tailOpt.value) }
    })

    const handleCmdReattach = Effect.fn("PaneAgent.handleCmdReattach")(function* (
      rt: ActorRuntime,
    ): Effect.fn.Return<PaneWorker, ModelError> {
      if (pendingWakesOf(rt.state.worker).length > 0) {
        const now = yield* Clock.currentTimeMillis
        yield* applyActorTransition(rt, MachineEvent.RestartWakeRetries({ now }), false)
        yield* flushWakeOnce(rt)
      }
      if (!needsPaneWork(rt.state.worker)) {
        return rt.state.worker
      }
      const target = targetOf(rt.state.worker)
      const liveness = yield* confirmDoubleGone(target)
      if (liveness === "unknown") {
        rt.nextPaneIo = "retry_delay"
        yield* schedulePaneIo(rt)
        return rt.state.worker
      }
      if (liveness === "gone") {
        return yield* markConfirmedGoneInActor(rt)
      }
      const adapter = adapterFor(rt.state.worker.harness)
      const screenOpt = yield* rex.read(target).pipe(Effect.option)
      if (Option.isSome(screenOpt) && activeTurnTypedOf(rt.state.worker) && adapter.turnEnded(screenOpt.value)) {
        rt.state = { ...rt.state, sawWorking: true, idlePendingConfirm: true }
        yield* rex.waitForQuiet(target, { quietFor, timeout: pollTimeout }).pipe(Effect.ignore)
        const afterOpt = yield* rex.read(target).pipe(Effect.option)
        if (Option.isSome(afterOpt)) {
          const fileAnswer = yield* readResultOrNone(rt.state.worker)
          const now = yield* Clock.currentTimeMillis
          const deliveryId = yield* mintDeliveryId()
          yield* applyActorTransition(
            rt,
            MachineEvent.IdleConfirmed({ screen: afterOpt.value, resultFileAnswer: fileAnswer, now, deliveryId }),
            false,
          )
          yield* flushWakeOnce(rt)
        }
      }
      if (rt.state.worker.state === "needs_input") {
        rt.nextPaneIo = "retry_delay"
      } else {
        rt.nextPaneIo = "read"
      }
      yield* schedulePaneIo(rt)
      return rt.state.worker
    })

    const handleIoRexError = Effect.fn("PaneAgent.handleIoRexError")(function* (
      rt: ActorRuntime,
      operation: string,
      error: RexError,
    ) {
      if (error._tag === "RexUnsupportedRevision") return
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      if (error._tag === "RexPaneGone") {
        const fileAnswer = yield* readResultOrNone(rt.state.worker)
        yield* applyActorTransitionOrReload(
          rt,
          MachineEvent.ProbeGone({ tail: shortLines(rt.lastScreen), resultFileAnswer: fileAnswer, now, deliveryId }),
        )
        yield* schedulePaneIo(rt)
        return
      }
      yield* applyActorTransitionOrReload(
        rt,
        MachineEvent.TransientError({ operation, message: error.message, now, deliveryId }),
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
        yield* applyActorTransitionOrReload(
          rt,
          MachineEvent.ProbeGone({ tail: shortLines(lastScreen), resultFileAnswer: fileAnswer, now, deliveryId }),
        )
      } else {
        yield* applyActorTransitionOrReload(
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
      if (liveness === "alive") {
        rt.state = { ...rt.state, consecutiveGone: 0, consecutiveTransient: 0 }
        rt.nextPaneIo = "read"
        yield* schedulePaneIo(rt)
        return
      }
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      if (liveness === "gone") {
        yield* applyActorTransitionOrReload(
          rt,
          MachineEvent.ProbeGone({ tail, resultFileAnswer, now, deliveryId }),
        )
      } else {
        yield* applyActorTransitionOrReload(
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

    const completeCommand = (
      reply: Deferred.Deferred<PaneWorker, ModelError>,
      effect: Effect.Effect<PaneWorker, ModelError>,
    ) =>
      Effect.result(effect).pipe(
        Effect.flatMap((res) => {
          if (res._tag === "Success") return Deferred.succeed(reply, res.success)
          return Deferred.fail(reply, res.failure)
        }),
        Effect.asVoid,
      )

    const processMessage = Effect.fn("PaneAgent.processMessage")(function* (rt: ActorRuntime, msg: ActorMessage) {
      yield* Match.value(msg).pipe(
        Match.tag("CmdAwaitStart", (ev) => handleCmdAwaitStart(rt, ev.reply)),
        Match.tag("CmdFollowUp", (ev) => completeCommand(ev.reply, handleCmdFollowUp(rt, ev.input))),
        Match.tag("CmdRestart", (ev) => completeCommand(ev.reply, handleCmdRestart(rt, ev.input))),
        Match.tag("CmdStop", (ev) => completeCommand(ev.reply, handleCmdStop(rt, ev.input))),
        Match.tag("CmdStatus", (ev) => completeCommand(ev.reply, handleCmdStatus(rt, ev.parentSessionID))),
        Match.tag("CmdReattach", (ev) => completeCommand(ev.reply, handleCmdReattach(rt))),
        Match.tag("IoScreenRead", (ev) =>
          Effect.gen(function* () {
            if (ev.gen !== rt.paneIoGen) return
            rt.paneIoRunning = false
            rt.lastScreen = ev.screen
            const now = yield* Clock.currentTimeMillis
            const deliveryId = yield* mintDeliveryId()
            yield* applyActorTransitionOrReload(rt, MachineEvent.ObserveScreen({ screen: ev.screen, now, deliveryId }))
            yield* schedulePaneIo(rt)
          }),
        ),
        Match.tag("IoIdleConfirmed", (ev) =>
          Effect.gen(function* () {
            if (ev.gen !== rt.paneIoGen) return
            rt.paneIoRunning = false
            rt.lastScreen = ev.screen
            const now = yield* Clock.currentTimeMillis
            const deliveryId = yield* mintDeliveryId()
            yield* applyActorTransitionOrReload(
              rt,
              MachineEvent.IdleConfirmed({ screen: ev.screen, resultFileAnswer: ev.resultFileAnswer, now, deliveryId }),
            )
            yield* schedulePaneIo(rt)
          }),
        ),
        Match.tag("IoRexError", (ev) =>
          Effect.gen(function* () {
            if (ev.gen !== rt.paneIoGen) return
            rt.paneIoRunning = false
            yield* handleIoRexError(rt, ev.operation, ev.error)
          }),
        ),
        Match.tag("IoQuietDone", (ev) =>
          Effect.gen(function* () {
            if (ev.gen !== rt.paneIoGen) return
            rt.paneIoRunning = false
            yield* handleIoQuietDone(rt, ev.liveness, ev.lastScreen)
          }),
        ),
        Match.tag("IoGoneProbe", (ev) =>
          Effect.gen(function* () {
            if (ev.gen !== rt.paneIoGen) return
            rt.paneIoRunning = false
            yield* handleIoGoneProbe(rt, ev.liveness, ev.tail, ev.resultFileAnswer)
          }),
        ),
        Match.tag("IoRetryTick", (ev) =>
          Effect.gen(function* () {
            if (ev.gen !== rt.paneIoGen) return
            rt.paneIoRunning = false
            rt.nextPaneIo = "read"
            yield* schedulePaneIo(rt)
          }),
        ),
        Match.tag("IoWakeResult", (ev) =>
          Effect.gen(function* () {
            rt.wakeIoRunning = false
            const now = yield* Clock.currentTimeMillis
            if (ev.ok) {
              yield* applyActorTransitionOrReload(rt, MachineEvent.WakeDelivered({ deliveryId: ev.deliveryId, now }))
            } else {
              yield* applyActorTransitionOrReload(
                rt,
                MachineEvent.WakeFailed({ deliveryId: ev.deliveryId, message: ev.error, now }),
              )
            }
            yield* scheduleWakeIo(rt)
          }),
        ),
        Match.exhaustive,
      )
    })

    const spawnActor = Effect.fn("PaneAgent.spawnActor")(function* (worker: PaneWorker, initialSawWorking: boolean) {
      const mailbox = yield* Queue.unbounded<ActorMessage>()
      const paneIo = yield* FiberHandle.make<void, never>().pipe(Effect.provideService(Scope.Scope, scope))
      const wakeIo = yield* FiberHandle.make<void, never>().pipe(Effect.provideService(Scope.Scope, scope))
      const rt: ActorRuntime = {
        id: worker.id,
        mailbox,
        paneIo,
        wakeIo,
        state: initialMachineState(worker, initialSawWorking),
        paneIoGen: 1,
        paneIoRunning: false,
        wakeIoRunning: false,
        nextPaneIo: "read",
        lastScreen: Option.getOrElse(Option.fromUndefinedOr(worker.lastLines), () => ""),
      }
      yield* Effect.forkIn(
        Effect.gen(function* () {
          while (true) {
            const msg = yield* Queue.take(mailbox)
            yield* processMessage(rt, msg)
          }
        }).pipe(Effect.catchCause((cause) => Effect.logDebug("pane-agent actor ended", cause))),
        scope,
      )
      yield* Ref.update(actors, (prev) => new Map([...prev, [worker.id, mailbox]]))
      return mailbox
    })

    const getOrSpawnActor = Effect.fn("PaneAgent.getOrSpawnActor")(function* (
      id: string,
      initialSawWorking = false,
    ): Effect.fn.Return<Queue.Queue<ActorMessage>, StoreFailed | WorkerRejected> {
      return yield* actorCreateLock.withPermits(1)(
        Effect.gen(function* () {
          const map = yield* Ref.get(actors)
          const existing = Option.fromUndefinedOr(map.get(id))
          if (Option.isSome(existing)) return existing.value
          const stored = yield* findWorkerInStore(id)
          if (Option.isNone(stored)) {
            return yield* new WorkerRejected({ reason: `No pane worker found with id ${id}.` })
          }
          return yield* spawnActor(stored.value, initialSawWorking)
        }),
      )
    })

    const askActor = Effect.fn("PaneAgent.askActor")(function* (
      id: string,
      makeMsg: (reply: Deferred.Deferred<PaneWorker, ModelError>) => ActorMessage,
      initialSawWorking = false,
    ): Effect.fn.Return<PaneWorker, ModelError> {
      const mailbox = yield* getOrSpawnActor(id, initialSawWorking)
      const reply = yield* Deferred.make<PaneWorker, ModelError>()
      yield* offerMsg(mailbox, makeMsg(reply))
      return yield* Deferred.await(reply)
    })

    const openOrSelectPane = Effect.fn("PaneAgent.openOrSelectPane")(function* (
      input: StartInput,
      adapter: HarnessAdapter,
      unit: string,
      resolvedCwd: string,
      resolvedAddDirs: ReadonlyArray<string>,
      skipPermissions: boolean,
      savedAnchor: Option.Option<PaneAnchor>,
    ) {
      const explicitBlock = Option.filter(Option.fromUndefinedOr(input.blockId), (b) => b.length > 0)
      const anchor = resolveAnchor(input, savedAnchor)
      if (Option.isSome(explicitBlock)) {
        const sessionId = Option.orElse(
          Option.filter(Option.fromUndefinedOr(input.rexSession), (s) => s.length > 0),
          () => Option.map(anchor, (a) => a.session),
        )
        if (Option.isNone(sessionId)) {
          return yield* new WorkerRejected({
            reason: "Cannot target an existing block without a Rex session id (pass rexSession or bind a Rex pane).",
          })
        }
        return { rexSessionId: sessionId.value, blockId: explicitBlock.value, ownedBlock: false }
      }
      if (Option.isNone(anchor)) {
        return yield* new WorkerRejected({
          reason: "No Rex pane anchor is known for this session; open OpenCode inside Rex or pass rexSession and rexBlock.",
        })
      }
      const command = adapter.command(
        buildStartOptions(input.harness, resolvedAddDirs, skipPermissions, config.binaryOverrides),
      )
      const blockId = yield* rex.splitRight({
        sessionId: anchor.value.session,
        anchorBlockId: anchor.value.block,
        label: `${input.harness}:${unit}`.slice(0, 48),
        command,
        cwd: resolvedCwd,
      })
      return { rexSessionId: anchor.value.session, blockId, ownedBlock: true }
    })

    const start = Effect.fn("PaneAgent.start")(function* (input: StartInput) {
      const adapter = adapterFor(input.harness)
      const snapshot = yield* store.read()
      const savedAnchor = Option.fromUndefinedOr(snapshot.anchors[input.parentSessionID])
      const resolvedCwd = Option.getOrElse(Option.fromUndefinedOr(input.cwd), () => input.directory)
      const resolvedAddDirs = computeAddDirs(resolvedCwd, input.resultFile, input.addDirs)
      const skipPermissions = input.skipPermissions !== false
      const { role, unit } = parseDescription(input.description)
      const now = yield* Clock.currentTimeMillis
      const id = yield* makeWorkerId()
      const opened = yield* openOrSelectPane(
        input,
        adapter,
        unit,
        resolvedCwd,
        resolvedAddDirs,
        skipPermissions,
        savedAnchor,
      )

      const brief = taskBrief({ prompt: input.prompt, resultFile: input.resultFile })
      const starting: PaneWorker = {
        id,
        parentSessionID: input.parentSessionID,
        directory: input.directory,
        cwd: resolvedCwd,
        addDirs: resolvedAddDirs,
        skipPermissions,
        harness: input.harness,
        role,
        unit,
        rexSessionId: opened.rexSessionId,
        blockId: opened.blockId,
        ownedBlock: opened.ownedBlock,
        resultFile: input.resultFile,
        state: "starting",
        update: `starting ${input.harness} in Rex pane`,
        turn: 1,
        notifiedTurn: 0,
        revision: 0,
        activeTurnTyped: false,
        pendingTurns: [{ turn: 1, brief, resultFile: input.resultFile, mode: "submit", queuedAt: now }],
        pendingWakes: [],
        deliveredWakes: [],
        startedAt: now,
        updatedAt: now,
      }
      const created = yield* casPersist(starting, starting)
      const mailbox = yield* actorCreateLock.withPermits(1)(spawnActor(created, false))
      const reply = yield* Deferred.make<PaneWorker, ModelError>()
      yield* offerMsg(mailbox, ActorMessage.CmdAwaitStart({ reply }))
      return yield* Deferred.await(reply)
    })

    const followUp = Effect.fn("PaneAgent.followUp")(function* (input: FollowUpInput) {
      return yield* askActor(input.id, (reply) => ActorMessage.CmdFollowUp({ input, reply }))
    })

    const restart = Effect.fn("PaneAgent.restart")(function* (input: RestartInput) {
      return yield* askActor(input.id, (reply) => ActorMessage.CmdRestart({ input, reply }))
    })

    const stop = Effect.fn("PaneAgent.stop")(function* (input: StopInput) {
      return yield* askActor(input.id, (reply) => ActorMessage.CmdStop({ input, reply }))
    })

    const status = Effect.fn("PaneAgent.status")(function* (parentSessionID: string, id: string) {
      return yield* askActor(id, (reply) => ActorMessage.CmdStatus({ parentSessionID, reply }))
    })

    const list = Effect.fn("PaneAgent.list")(function* (parentSessionID: string) {
      const snapshot = yield* store.read()
      return snapshot.workers.filter((worker) => worker.parentSessionID === parentSessionID)
    })

    const views = Effect.fn("PaneAgent.views")(function* (parentSessionID: string) {
      const workers = yield* list(parentSessionID)
      return workers.map(viewOf)
    })

    const bindPane = Effect.fn("PaneAgent.bindPane")(function* (sessionID: string, anchor: PaneAnchor) {
      yield* store.saveAnchor(sessionID, anchor)
    })

    const needsReattach = (worker: PaneWorker): boolean =>
      needsPaneWork(worker) || pendingWakesOf(worker).length > 0 || hasUndeliveredWakes(worker)

    const reattach = Effect.fn("PaneAgent.reattach")(function* (directory: string) {
      const snapshot = yield* store.read()
      const candidates = snapshot.workers.filter((worker) => worker.directory === directory && needsReattach(worker))
      const resultsOut: Array<PaneWorker> = []
      for (const worker of candidates) {
        const next = yield* askActor(
          worker.id,
          (reply) => ActorMessage.CmdReattach({ reply }),
          activeTurnTypedOf(worker),
        )
        resultsOut.push(next)
      }
      return resultsOut
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
