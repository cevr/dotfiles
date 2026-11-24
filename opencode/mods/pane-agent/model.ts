import {
  Array as Arr,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Option,
  Random,
  Ref,
  Scope,
} from "effect"
import { adapterFor, type Harness, type HarnessAdapter, type ResumeOptions, type StartOptions } from "./adapter.ts"
import {
  activeTurnTypedOf,
  DEFAULT_MACHINE_CONFIG,
  initialMachineState,
  type MachineAction,
  type MachineConfig,
  MachineEvent,
  type MachineState,
  maxTurnOf,
  pendingTurnsOf,
  transition,
  wakeLetterOf,
} from "./machine.ts"
import { resumeBrief, taskBrief } from "./prompt.ts"
import {
  Notifier,
  type PaneTarget,
  ResultFiles,
  type ResultReadFailed,
  RexClient,
  type RexError,
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
  viewOf,
} from "./worker.ts"

export interface ModelConfig {
  readonly quietFor?: Duration.Input
  readonly pollTimeout?: Duration.Input
  readonly startupTimeout?: Duration.Input
  readonly pasteQuiet?: Duration.Input
  readonly retryDelay?: Duration.Input
  readonly maxStartupChecks?: number
  readonly maxTransientErrors?: number
  readonly confirmGoneCount?: number
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

export type ModelError = RexError | StoreFailed | ResultReadFailed | WorkerRejected

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
const DEFAULT_STARTUP_CHECKS = 30
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

const needsWatch = (worker: PaneWorker): boolean =>
  isLive(worker.state) ||
  pendingTurnsOf(worker).length > 0 ||
  Option.isSome(Option.fromUndefinedOr(worker.pendingWake))

const hasAction = (actions: ReadonlyArray<MachineAction>, tag: MachineAction["_tag"]): boolean =>
  actions.some((action) => action._tag === tag)

const makeModel = (config: ModelConfig = {}) =>
  Effect.gen(function* () {
    const rex = yield* RexClient
    const store = yield* WorkerStore
    const results = yield* ResultFiles
    const notifier = yield* Notifier
    const scope = yield* Scope.Scope
    const watchers = yield* FiberMap.make<string>()
    const mintDeliveryId = yield* makeDeliveryIdMinter

    const quietFor = resolveDuration(DEFAULT_QUIET, config.quietFor)
    const pollTimeout = resolveDuration(DEFAULT_POLL_TIMEOUT, config.pollTimeout)
    const pasteQuiet = resolveDuration(DEFAULT_PASTE_QUIET, config.pasteQuiet)
    const retryDelay = resolveDuration(pasteQuiet, config.retryDelay)
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
    }

    const readResultOrNone = (worker: PaneWorker) =>
      results.readComplete(worker.resultFile, worker.startedAt).pipe(
        Effect.orElseSucceed(() => Option.none<string>()),
      )

    const persistWorker = Effect.fn("PaneAgent.persistWorker")(function* (worker: PaneWorker) {
      yield* store.upsertWorker(worker)
      yield* notifier.changed(worker.parentSessionID)
    })

    const flushPendingWake = Effect.fn("PaneAgent.flushPendingWake")(function* (state: MachineState) {
      const pending = Option.fromUndefinedOr(state.worker.pendingWake)
      if (Option.isNone(pending)) return { state, delivered: true }
      const sendExit = yield* Effect.exit(
        notifier.wake(state.worker.parentSessionID, wakeLetterOf(pending.value)),
      )
      const now = yield* Clock.currentTimeMillis
      if (Exit.isSuccess(sendExit)) {
        const res = transition(
          state,
          MachineEvent.WakeDelivered({ now }),
          adapterFor(state.worker.harness),
          machineConfig,
        )
        yield* persistWorker(res.state.worker)
        return { state: res.state, delivered: true }
      }
      return { state, delivered: false }
    })

    const applyActions = Effect.fn("PaneAgent.applyActions")(function* (
      state: MachineState,
      actions: ReadonlyArray<MachineAction>,
    ) {
      let current = state
      const target = targetOf(current.worker)
      for (const action of actions) {
        if (action._tag === "WritePane") {
          yield* writeChunks(rex, target, action.chunks, pasteQuiet)
        } else if (action._tag === "Persist") {
          yield* persistWorker(current.worker)
        } else if (action._tag === "FlushWake") {
          const flushed = yield* flushPendingWake(current)
          current = flushed.state
        } else if (action._tag === "InterruptPane") {
          const adapter = adapterFor(current.worker.harness)
          yield* rex.write(target, adapter.interruptSequence).pipe(Effect.ignore)
          if (action.close) {
            yield* rex.close(target).pipe(Effect.ignore)
          }
        }
      }
      return current
    })

    const confirmDoubleGone = Effect.fn("PaneAgent.confirmDoubleGone")(function* (target: PaneTarget) {
      const first = yield* rex.alive(target)
      if (first !== "gone") return first
      yield* pauseFor(retryDelay)
      return yield* rex.alive(target)
    })

    const stepIdleConfirm = Effect.fn("PaneAgent.stepIdleConfirm")(function* (
      adapter: HarnessAdapter,
      state: MachineState,
    ) {
      const target = targetOf(state.worker)
      const waitRes = yield* Effect.result(rex.waitForQuiet(target, { quietFor, timeout: pollTimeout }))
      if (waitRes._tag === "Failure") {
        return { kind: "rex_err" as const, error: waitRes.failure, operation: "terminals.waitForQuiet", state }
      }
      const screenRes = yield* Effect.result(rex.read(target))
      if (screenRes._tag === "Failure") {
        return { kind: "rex_err" as const, error: screenRes.failure, operation: "terminals.read", state }
      }
      const fileAnswer = yield* readResultOrNone(state.worker)
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      const res = transition(
        state,
        MachineEvent.IdleConfirmed({ screen: screenRes.success, resultFileAnswer: fileAnswer, now, deliveryId }),
        adapter,
        machineConfig,
      )
      const next = yield* applyActions(res.state, res.actions)
      return { kind: "stepped" as const, state: next, actions: res.actions }
    })

    const handleRexFailure = Effect.fn("PaneAgent.handleRexFailure")(function* (
      adapter: HarnessAdapter,
      state: MachineState,
      operation: string,
      error: RexError,
      tail: string,
    ) {
      if (error._tag === "RexUnsupportedRevision") {
        return { state, stop: true, sleep: false }
      }
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      if (error._tag === "RexPaneGone") {
        const fileAnswer = yield* readResultOrNone(state.worker)
        const res = transition(
          state,
          MachineEvent.ProbeGone({ tail, resultFileAnswer: fileAnswer, now, deliveryId }),
          adapter,
          machineConfig,
        )
        const next = yield* applyActions(res.state, res.actions)
        return { state: next, stop: hasAction(res.actions, "StopWatching"), sleep: true }
      }
      const res = transition(
        state,
        MachineEvent.TransientError({ operation, message: error.message, now, deliveryId }),
        adapter,
        machineConfig,
      )
      const next = yield* applyActions(res.state, res.actions)
      return { state: next, stop: hasAction(res.actions, "StopWatching"), sleep: true }
    })

    const loadWorkerFromStore = Effect.fn("PaneAgent.loadWorkerFromStore")(function* (id: string) {
      const snap = yield* store.read()
      return Arr.findFirst(snap.workers, (worker) => worker.id === id)
    })

    const stepScreenObservation = Effect.fn("PaneAgent.stepScreenObservation")(function* (
      adapter: HarnessAdapter,
      state: MachineState,
      screen: string,
    ) {
      const now = yield* Clock.currentTimeMillis
      const deliveryId = yield* mintDeliveryId()
      const res = transition(state, MachineEvent.ObserveScreen({ screen, now, deliveryId }), adapter, machineConfig)
      const applyExit = yield* Effect.exit(applyActions(res.state, res.actions))
      if (Exit.isFailure(applyExit)) {
        return { kind: "apply_failed" as const, state }
      }
      return { kind: "ok" as const, state: applyExit.value, actions: res.actions }
    })

    const probeAfterQuiet = Effect.fn("PaneAgent.probeAfterQuiet")(function* (
      adapter: HarnessAdapter,
      state: MachineState,
      lastScreen: string,
    ) {
      const target = targetOf(state.worker)
      const livenessExit = yield* Effect.exit(rex.alive(target))
      if (Exit.isFailure(livenessExit)) return { state, stop: true }
      const liveness = livenessExit.value
      if (liveness === "gone") {
        const fileAnswer = yield* readResultOrNone(state.worker)
        const now = yield* Clock.currentTimeMillis
        const deliveryId = yield* mintDeliveryId()
        const res = transition(
          state,
          MachineEvent.ProbeGone({ tail: shortLines(lastScreen), resultFileAnswer: fileAnswer, now, deliveryId }),
          adapter,
          machineConfig,
        )
        const next = yield* applyActions(res.state, res.actions)
        if (hasAction(res.actions, "StopWatching")) return { state: next, stop: true }
        yield* pauseFor(retryDelay)
        return { state: next, stop: false }
      }
      if (liveness === "unknown") {
        const now = yield* Clock.currentTimeMillis
        const deliveryId = yield* mintDeliveryId()
        const res = transition(
          state,
          MachineEvent.TransientError({
            operation: "terminals.process",
            message: "Rex temporarily unreachable",
            now,
            deliveryId,
          }),
          adapter,
          machineConfig,
        )
        const next = yield* applyActions(res.state, res.actions)
        yield* pauseFor(retryDelay)
        return { state: next, stop: false }
      }
      yield* rex.waitForQuiet(target, { quietFor, timeout: pollTimeout }).pipe(Effect.ignore)
      return { state, stop: false }
    })

    const stepWatchIdle = Effect.fn("PaneAgent.stepWatchIdle")(function* (
      adapter: HarnessAdapter,
      state: MachineState,
    ) {
      const target = targetOf(state.worker)
      const confirmed = yield* stepIdleConfirm(adapter, state)
      if (confirmed.kind === "rex_err") {
        const handled = yield* handleRexFailure(adapter, state, confirmed.operation, confirmed.error, "")
        if (handled.sleep && !handled.stop) yield* pauseFor(retryDelay)
        return { state: handled.state, stop: handled.stop }
      }
      const next = confirmed.state
      if (hasAction(confirmed.actions, "StopWatching") && !needsWatch(next.worker)) {
        return { state: next, stop: true }
      }
      if (hasAction(confirmed.actions, "WaitQuiet")) {
        yield* rex.waitForQuiet(target, { quietFor: pasteQuiet, timeout: pollTimeout }).pipe(Effect.ignore)
      }
      return { state: next, stop: false }
    })

    const stepWatchScreen = Effect.fn("PaneAgent.stepWatchScreen")(function* (
      adapter: HarnessAdapter,
      state: MachineState,
    ) {
      const target = targetOf(state.worker)
      const screenResult = yield* Effect.result(rex.read(target))
      if (screenResult._tag === "Failure") {
        const handled = yield* handleRexFailure(adapter, state, "terminals.read", screenResult.failure, "")
        if (handled.sleep && !handled.stop) yield* pauseFor(retryDelay)
        return { state: handled.state, stop: handled.stop }
      }
      const observed = yield* stepScreenObservation(adapter, state, screenResult.success)
      if (observed.kind === "apply_failed") {
        yield* pauseFor(retryDelay)
        return { state, stop: false }
      }
      const next = observed.state
      if (hasAction(observed.actions, "ConfirmIdle") || hasAction(observed.actions, "WritePane")) {
        return { state: next, stop: false }
      }
      if (hasAction(observed.actions, "StopWatching") && !needsWatch(next.worker)) {
        return { state: next, stop: true }
      }
      return yield* probeAfterQuiet(adapter, next, screenResult.success)
    })

    const watchTurn = Effect.fn("PaneAgent.watchTurn")(function* (initial: PaneWorker, initialSawWorking = false) {
      const adapter = adapterFor(initial.harness)
      let state = initialMachineState(initial, initialSawWorking)

      while (true) {
        const freshOpt = yield* loadWorkerFromStore(state.worker.id).pipe(
          Effect.orElseSucceed(() => Option.none<PaneWorker>()),
        )
        if (Option.isSome(freshOpt)) {
          state = { ...state, worker: freshOpt.value }
        }
        if (Option.isSome(Option.fromUndefinedOr(state.worker.pendingWake))) {
          const flushed = yield* flushPendingWake(state)
          state = flushed.state
          if (!flushed.delivered) {
            yield* pauseFor(retryDelay)
            continue
          }
        }
        if (!needsWatch(state.worker)) return

        let outcome: { readonly state: MachineState; readonly stop: boolean }
        if (state.idlePendingConfirm) {
          outcome = yield* stepWatchIdle(adapter, state)
        } else {
          outcome = yield* stepWatchScreen(adapter, state)
        }
        state = outcome.state
        if (outcome.stop) return
      }
    })

    const launchWatcher = (worker: PaneWorker, initialSawWorking = false) =>
      FiberMap.run(
        watchers,
        worker.id,
        watchTurn(worker, initialSawWorking).pipe(
          Effect.catchCause((cause) => Effect.logDebug("pane-agent watcher ended with failure", cause)),
        ),
      ).pipe(Effect.provideService(Scope.Scope, scope))

    const ensureWatcher = Effect.fn("PaneAgent.ensureWatcher")(function* (worker: PaneWorker) {
      const alreadyRunning = yield* FiberMap.has(watchers, worker.id)
      if (!alreadyRunning) {
        yield* launchWatcher(worker)
      }
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
        activeTurnTyped: false,
        pendingTurns: [{ turn: 1, brief, resultFile: input.resultFile, mode: "submit", queuedAt: now }],
        deliveredWakes: [],
        startedAt: now,
        updatedAt: now,
      }
      yield* persistWorker(starting)

      let state = initialMachineState(starting)
      const target = targetOf(starting)

      for (let attempt = 0; attempt < maxStartupChecks; attempt++) {
        const screenResult = yield* Effect.result(rex.read(target))
        if (screenResult._tag === "Failure") {
          if (screenResult.failure._tag === "RexUnsupportedRevision") {
            return yield* Effect.fail(screenResult.failure)
          }
          const handled = yield* handleRexFailure(adapter, state, "terminals.read", screenResult.failure, "")
          state = handled.state
          if (handled.stop) return state.worker
          yield* pauseFor(retryDelay)
          continue
        }

        const stepNow = yield* Clock.currentTimeMillis
        const deliveryId = yield* mintDeliveryId()
        const res = transition(
          state,
          MachineEvent.ObserveScreen({ screen: screenResult.success, now: stepNow, deliveryId }),
          adapter,
          machineConfig,
        )
        state = yield* applyActions(res.state, res.actions)

        if (state.worker.state === "needs_input" || state.worker.state === "working") {
          yield* launchWatcher(state.worker)
          return state.worker
        }
        yield* rex.waitForQuiet(target, { quietFor: pasteQuiet, timeout: pollTimeout }).pipe(Effect.ignore)
      }

      yield* launchWatcher(state.worker)
      return state.worker
    })

    const findOwnedWorker = Effect.fn("PaneAgent.findOwnedWorker")(function* (
      parentSessionID: string,
      id: string,
    ) {
      const snapshot = yield* store.read()
      const found = Arr.findFirst(snapshot.workers, (worker) => worker.id === id)
      if (Option.isNone(found)) {
        return yield* new WorkerRejected({ reason: `No pane worker found with id ${id}.` })
      }
      if (found.value.parentSessionID !== parentSessionID) {
        return yield* new WorkerRejected({ reason: `Pane worker ${id} belongs to another session.` })
      }
      return found.value
    })

    const markConfirmedGone = Effect.fn("PaneAgent.markConfirmedGone")(function* (worker: PaneWorker) {
      const adapter = adapterFor(worker.harness)
      const fileAnswer = yield* readResultOrNone(worker)
      let state = initialMachineState(worker)
      for (let count = 0; count < machineConfig.confirmGoneCount; count++) {
        const now = yield* Clock.currentTimeMillis
        const deliveryId = yield* mintDeliveryId()
        const res = transition(
          state,
          MachineEvent.ProbeGone({ tail: "", resultFileAnswer: fileAnswer, now, deliveryId }),
          adapter,
          machineConfig,
        )
        state = yield* applyActions(res.state, res.actions)
      }
      return state.worker
    })

    const followUp = Effect.fn("PaneAgent.followUp")(function* (input: FollowUpInput) {
      const existing = yield* findOwnedWorker(input.parentSessionID, input.id)
      const target = targetOf(existing)
      const liveness = yield* confirmDoubleGone(target)
      if (liveness === "gone") {
        yield* FiberMap.remove(watchers, existing.id)
        yield* markConfirmedGone(existing)
        return yield* new WorkerRejected({
          reason: `Pane ${existing.blockId} for worker ${existing.id} is gone; call pane_agent({ action: "restart", id: "${existing.id}" }) to resume it with --continue.`,
        })
      }

      const adapter = adapterFor(existing.harness)
      const now = yield* Clock.currentTimeMillis
      const requestedFile = Option.fromUndefinedOr(input.resultFile)

      if (input.steer === true) {
        const screenOpt = yield* rex.read(target).pipe(Effect.option)
        const res = transition(
          initialMachineState(existing),
          MachineEvent.RequestSteer({ prompt: input.prompt, resultFile: requestedFile, screen: screenOpt, now }),
          adapter,
          machineConfig,
        )
        if (hasAction(res.actions, "WritePane")) {
          yield* FiberMap.remove(watchers, existing.id)
          const next = yield* applyActions(res.state, res.actions)
          yield* launchWatcher(next.worker)
          return next.worker
        }
        const next = yield* applyActions(res.state, res.actions)
        yield* ensureWatcher(next.worker)
        return next.worker
      }

      // Queued follow-up: append turn in order without killing an active turn or writing into a prompt.
      const queuedRes = transition(
        initialMachineState(existing),
        MachineEvent.QueueFollowUp({ prompt: input.prompt, resultFile: requestedFile, now }),
        adapter,
        machineConfig,
      )
      let state = yield* applyActions(queuedRes.state, queuedRes.actions)

      // When worker is idle (done) and no turn is active, run one ObserveScreen step through the single write gate.
      if (existing.state === "done" && !activeTurnTypedOf(existing)) {
        const screenResult = yield* Effect.result(rex.read(target))
        if (screenResult._tag === "Success") {
          const stepNow = yield* Clock.currentTimeMillis
          const deliveryId = yield* mintDeliveryId()
          const obs = transition(
            state,
            MachineEvent.ObserveScreen({ screen: screenResult.success, now: stepNow, deliveryId }),
            adapter,
            machineConfig,
          )
          state = yield* applyActions(obs.state, obs.actions)
        }
        yield* launchWatcher(state.worker)
        return state.worker
      }

      yield* ensureWatcher(state.worker)
      return state.worker
    })

    const restart = Effect.fn("PaneAgent.restart")(function* (input: RestartInput) {
      const existing = yield* findOwnedWorker(input.parentSessionID, input.id)
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

      yield* FiberMap.remove(watchers, existing.id)
      if (existing.ownedBlock) {
        yield* rex.close(targetOf(existing)).pipe(Effect.ignore)
      }

      const adapter = adapterFor(existing.harness)
      const workerCwd = Option.getOrElse(Option.fromUndefinedOr(existing.cwd), () => existing.directory)
      const nextTurn = maxTurnOf(existing) + 1
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
      const now = yield* Clock.currentTimeMillis
      const newBlockId = yield* rex.splitRight({
        sessionId: anchor.value.session,
        anchorBlockId: anchor.value.block,
        label: `${existing.harness}:${existing.unit}`.slice(0, 48),
        command,
        cwd: workerCwd,
      })
      const { pendingWake: _pw, endedAt: _ea, ...keep } = existing
      const restarted: PaneWorker = {
        ...keep,
        cwd: workerCwd,
        addDirs: nextAddDirs,
        skipPermissions,
        rexSessionId: anchor.value.session,
        blockId: newBlockId,
        ownedBlock: true,
        resultFile: nextResultFile,
        state: "working",
        update: "restarted in Rex pane (--continue)",
        turn: nextTurn,
        notifiedTurn: nextTurn - 1,
        activeTurnTyped: true,
        pendingTurns: [],
        startedAt: now,
        updatedAt: now,
      }
      yield* persistWorker(restarted)
      yield* launchWatcher(restarted)
      return restarted
    })

    const stop = Effect.fn("PaneAgent.stop")(function* (input: StopInput) {
      const existing = yield* findOwnedWorker(input.parentSessionID, input.id)
      yield* FiberMap.remove(watchers, existing.id)
      const now = yield* Clock.currentTimeMillis
      const res = transition(
        initialMachineState(existing),
        MachineEvent.Stop({ close: input.close === true, now }),
        adapterFor(existing.harness),
        machineConfig,
      )
      const next = yield* applyActions(res.state, res.actions)
      return next.worker
    })

    const status = Effect.fn("PaneAgent.status")(function* (parentSessionID: string, id: string) {
      const existing = yield* findOwnedWorker(parentSessionID, id)
      const target = targetOf(existing)
      const expectsPane =
        existing.state !== "stopped" && existing.state !== "pane_gone" && existing.state !== "failed"
      if (expectsPane) {
        const liveness = yield* confirmDoubleGone(target)
        if (liveness === "gone") {
          yield* FiberMap.remove(watchers, existing.id)
          return yield* markConfirmedGone(existing)
        }
      }
      const tailOpt = yield* rex.readTail(target, TAIL_BYTES).pipe(Effect.option)
      if (Option.isNone(tailOpt)) return existing
      return { ...existing, lastLines: shortLines(tailOpt.value) }
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

    const reattachOne = Effect.fn("PaneAgent.reattachOne")(function* (worker: PaneWorker) {
      let state = initialMachineState(worker)
      // Step 1 (R1): flush any persisted pending wake with its original deliveryId before anything else.
      if (Option.isSome(Option.fromUndefinedOr(state.worker.pendingWake))) {
        const flushed = yield* flushPendingWake(state)
        state = flushed.state
        if (!flushed.delivered) {
          yield* launchWatcher(state.worker, activeTurnTypedOf(state.worker))
          return state.worker
        }
      }
      if (!isLive(state.worker.state) && pendingTurnsOf(state.worker).length === 0) {
        return state.worker
      }

      const target = targetOf(state.worker)
      const liveness = yield* confirmDoubleGone(target)
      if (liveness === "unknown") {
        // B3: transient Rex outage during reattach NEVER marks a live worker pane_gone.
        yield* launchWatcher(state.worker, activeTurnTypedOf(state.worker))
        return state.worker
      }
      if (liveness === "gone") {
        return yield* markConfirmedGone(state.worker)
      }

      const adapter = adapterFor(state.worker.harness)
      const screenOpt = yield* rex.read(target).pipe(Effect.option)
      if (Option.isSome(screenOpt) && activeTurnTypedOf(state.worker) && adapter.turnEnded(screenOpt.value)) {
        const confirmed = yield* stepIdleConfirm(adapter, { ...state, sawWorking: true, idlePendingConfirm: true })
        if (confirmed.kind === "stepped") {
          state = confirmed.state
          if (needsWatch(state.worker)) {
            yield* launchWatcher(state.worker, false)
          }
          return state.worker
        }
      }

      yield* launchWatcher(state.worker, activeTurnTypedOf(state.worker))
      return state.worker
    })

    const reattach = Effect.fn("PaneAgent.reattach")(function* (directory: string) {
      const snapshot = yield* store.read()
      const candidates = snapshot.workers.filter((worker) => worker.directory === directory && needsWatch(worker))
      const resultsOut: Array<PaneWorker> = []
      for (const worker of candidates) {
        const next = yield* reattachOne(worker)
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
