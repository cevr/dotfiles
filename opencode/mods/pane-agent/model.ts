import { Array as Arr, Clock, Context, Duration, Effect, FiberMap, Layer, Option, Random, Ref, Scope } from "effect"
import { adapterFor, type Harness, type HarnessAdapter } from "./adapter.ts"
import { taskBrief } from "./prompt.ts"
import {
  Notifier,
  type PaneTarget,
  ResultFiles,
  RexClient,
  type RexError,
  type StoreFailed,
  WorkerRejected,
  WorkerStore,
  type ResultReadFailed,
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
  readonly maxStartupChecks?: number
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
  readonly rexSession?: string
  readonly rexBlock?: string
  readonly blockId?: string
  readonly dangerousSkipPermissions?: boolean
}

export interface FollowUpInput {
  readonly parentSessionID: string
  readonly id: string
  readonly prompt: string
  readonly resultFile?: string
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

type RexClientApi = Effect.Success<typeof RexClient>
type WorkerStoreApi = Effect.Success<typeof WorkerStore>
type NotifierApi = Effect.Success<typeof Notifier>

const resolveDuration = (fallback: Duration.Duration, given?: Duration.Input): Duration.Duration =>
  Option.match(Option.fromUndefinedOr(given), {
    onNone: () => fallback,
    onSome: (input) => Duration.fromInputUnsafe(input),
  })

const targetOf = (worker: Pick<PaneWorker, "rexSessionId" | "blockId">): PaneTarget => ({
  sessionId: worker.rexSessionId,
  blockId: worker.blockId,
})

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

const sourceLabel = (fromFile: boolean): string => {
  if (fromFile) return "result-file"
  return "pane"
}

const updateLabel = (fromFile: boolean): string => {
  if (fromFile) return "wrote result file"
  return "turn finished"
}

const doneLetter = (worker: PaneWorker, answer: string, fromFile: boolean) => ({
  id: `msg_pa_${worker.id}_t${worker.turn}_done`,
  description: `${worker.role} ${worker.harness} · ${worker.unit} · done`,
  text: [
    `<pane-agent-result id="${worker.id}" harness="${worker.harness}" block="${worker.blockId}" state="done" turn="${worker.turn}" source="${sourceLabel(fromFile)}">`,
    `Result file: ${worker.resultFile}`,
    "",
    answer,
    "</pane-agent-result>",
  ].join("\n"),
  metadata: {
    source: "pane-agent",
    workerId: worker.id,
    harness: worker.harness,
    blockId: worker.blockId,
    state: "done",
    turn: worker.turn,
  },
})

const needsInputLetter = (worker: PaneWorker, summary: string, tail: string) => ({
  id: `msg_pa_${worker.id}_t${worker.turn}_needs_input`,
  description: `${worker.role} ${worker.harness} · ${worker.unit} · needs input`,
  text: [
    `<pane-agent-result id="${worker.id}" harness="${worker.harness}" block="${worker.blockId}" state="needs_input" turn="${worker.turn}">`,
    `Pane worker needs human input (${summary}).`,
    "Last lines from the pane:",
    tail,
    "</pane-agent-result>",
  ].join("\n"),
  metadata: {
    source: "pane-agent",
    workerId: worker.id,
    harness: worker.harness,
    blockId: worker.blockId,
    state: "needs_input",
    turn: worker.turn,
  },
})

const failedLetter = (worker: PaneWorker, reason: string, tail: string) => {
  const lines = [
    `<pane-agent-result id="${worker.id}" harness="${worker.harness}" block="${worker.blockId}" state="failed" turn="${worker.turn}">`,
    reason,
  ]
  if (tail.length > 0) {
    lines.push("", "Last lines from the pane:", tail)
  }
  lines.push("</pane-agent-result>")
  return {
    id: `msg_pa_${worker.id}_t${worker.turn}_failed`,
    description: `${worker.role} ${worker.harness} · ${worker.unit} · failed`,
    text: lines.join("\n"),
    metadata: {
      source: "pane-agent",
      workerId: worker.id,
      harness: worker.harness,
      blockId: worker.blockId,
      state: "failed",
      turn: worker.turn,
    },
  }
}

const buildStartOptions = (
  harness: Harness,
  overrides?: Readonly<Partial<Record<Harness, string>>>,
  dangerousSkipPermissions?: boolean,
) => {
  const binary = Option.flatMap(Option.fromUndefinedOr(overrides), (map) => Option.fromUndefinedOr(map[harness]))
  const withBin = Option.match(binary, {
    onNone: () => ({}),
    onSome: (value) => ({ binary: value }),
  })
  if (dangerousSkipPermissions === true) {
    return { ...withBin, dangerousSkipPermissions: true }
  }
  return withBin
}

const resolveAnchor = (
  input: StartInput,
  saved: Option.Option<PaneAnchor>,
): Option.Option<PaneAnchor> => {
  const explicit = Option.all({
    session: Option.filter(Option.fromUndefinedOr(input.rexSession), (s) => s.length > 0),
    block: Option.filter(Option.fromUndefinedOr(input.rexBlock), (b) => b.length > 0),
  })
  if (Option.isSome(explicit)) return explicit
  return saved
}

const submitToPane = (
  rex: RexClientApi,
  adapter: HarnessAdapter,
  target: PaneTarget,
  text: string,
  pasteQuiet: Duration.Duration,
) =>
  Effect.gen(function* () {
    const chunks = adapter.formatSubmit(text)
    for (let index = 0; index < chunks.length; index++) {
      const chunk = Arr.get(chunks, index)
      if (Option.isNone(chunk)) continue
      yield* rex.write(target, chunk.value)
      if (index + 1 < chunks.length) {
        yield* rex.waitForQuiet(target, { quietFor: pasteQuiet, timeout: Duration.seconds(2) })
      }
    }
  })

const settleResult = (
  store: WorkerStoreApi,
  notifier: NotifierApi,
  worker: PaneWorker,
  answer: string,
  fromFile: boolean,
  now: number,
) =>
  Effect.gen(function* () {
    const next: PaneWorker = {
      ...worker,
      state: "done",
      update: updateLabel(fromFile),
      updatedAt: now,
      endedAt: now,
      notifiedTurn: worker.turn,
      lastAnswer: answer,
    }
    yield* store.upsertWorker(next)
    yield* notifier.changed(worker.parentSessionID)
    if (worker.notifiedTurn < worker.turn) {
      yield* notifier.wake(worker.parentSessionID, doneLetter(next, answer, fromFile))
    }
    return next
  })

const settleFailure = (
  store: WorkerStoreApi,
  notifier: NotifierApi,
  worker: PaneWorker,
  reason: string,
  tail: string,
  now: number,
) =>
  Effect.gen(function* () {
    const next: PaneWorker = {
      ...worker,
      state: "failed",
      update: reason,
      updatedAt: now,
      endedAt: now,
      notifiedTurn: worker.turn,
      lastLines: tail,
    }
    yield* store.upsertWorker(next)
    yield* notifier.changed(worker.parentSessionID)
    if (worker.notifiedTurn < worker.turn) {
      yield* notifier.wake(worker.parentSessionID, failedLetter(next, reason, tail))
    }
    return next
  })

const makeModel = (config: ModelConfig = {}) =>
  Effect.gen(function* () {
    const rex = yield* RexClient
    const store = yield* WorkerStore
    const results = yield* ResultFiles
    const notifier = yield* Notifier
    const scope = yield* Scope.Scope
    const watchers = yield* FiberMap.make<string>()
    const needsNotified = yield* Ref.make<ReadonlySet<string>>(new Set())

    const quietFor = resolveDuration(DEFAULT_QUIET, config.quietFor)
    const pollTimeout = resolveDuration(DEFAULT_POLL_TIMEOUT, config.pollTimeout)
    const pasteQuiet = resolveDuration(DEFAULT_PASTE_QUIET, config.pasteQuiet)
    const maxStartupChecks = Option.getOrElse(Option.fromUndefinedOr(config.maxStartupChecks), () => DEFAULT_STARTUP_CHECKS)

    const markNeedsInput = Effect.fn("PaneAgent.markNeedsInput")(function* (
      worker: PaneWorker,
      summary: string,
      tail: string,
    ) {
      const now = yield* Clock.currentTimeMillis
      const key = `${worker.id}:${worker.turn}:${summary}`
      const seen = yield* Ref.get(needsNotified)
      const next: PaneWorker = {
        ...worker,
        state: "needs_input",
        update: summary,
        updatedAt: now,
        lastLines: tail,
      }
      yield* store.upsertWorker(next)
      yield* notifier.changed(worker.parentSessionID)
      if (!seen.has(key)) {
        yield* Ref.update(needsNotified, (prev) => new Set([...prev, key]))
        yield* notifier.wake(worker.parentSessionID, needsInputLetter(next, summary, tail))
      }
      return next
    })

    const waitReady = Effect.fn("PaneAgent.waitReady")(function* (
      adapter: HarnessAdapter,
      target: PaneTarget,
    ) {
      for (let attempt = 0; attempt < maxStartupChecks; attempt++) {
        const screen = yield* rex.read(target)
        const needs = adapter.needsInput(screen)
        if (Option.isSome(needs)) {
          return { kind: "needs_input" as const, needs: needs.value }
        }
        if (adapter.readyForInput(screen)) {
          return { kind: "ready" as const }
        }
        const running = yield* rex.alive(target)
        if (!running) {
          return { kind: "exited" as const, tail: shortLines(screen) }
        }
        yield* rex.waitForQuiet(target, { quietFor: pasteQuiet, timeout: pollTimeout })
      }
      const finalScreen = yield* rex.read(target)
      return { kind: "timeout" as const, tail: shortLines(finalScreen) }
    })

    const readResultOrNone = (worker: PaneWorker) =>
      results.readComplete(worker.resultFile, worker.startedAt).pipe(
        Effect.orElseSucceed(() => Option.none<string>()),
      )

    const confirmIdleAndSettle = Effect.fn("PaneAgent.confirmIdleAndSettle")(function* (
      adapter: HarnessAdapter,
      target: PaneTarget,
      current: PaneWorker,
    ) {
      yield* rex.waitForQuiet(target, { quietFor, timeout: pollTimeout }).pipe(Effect.ignore)
      const fileAfter = yield* readResultOrNone(current)
      if (Option.isSome(fileAfter)) {
        const now = yield* Clock.currentTimeMillis
        yield* settleResult(store, notifier, current, fileAfter.value, true, now)
        return { kind: "done" as const }
      }
      const screenAfter = yield* rex.read(target).pipe(Effect.option)
      if (Option.isNone(screenAfter)) return { kind: "continue" as const, worker: current }
      const needsAfter = adapter.needsInput(screenAfter.value)
      if (Option.isSome(needsAfter)) {
        const blocked = yield* markNeedsInput(current, needsAfter.value.summary, needsAfter.value.tail)
        return { kind: "continue" as const, worker: blocked }
      }
      if (adapter.turnEnded(screenAfter.value)) {
        const now = yield* Clock.currentTimeMillis
        yield* settleResult(store, notifier, current, adapter.readLastAnswer(screenAfter.value), false, now)
        return { kind: "done" as const }
      }
      return { kind: "continue" as const, worker: current }
    })

    interface WatchLoopState {
      readonly worker: PaneWorker
      readonly pendingBrief: Option.Option<string>
      readonly sawWorking: boolean
    }

    const handleScreen = Effect.fn("PaneAgent.handleScreen")(function* (
      adapter: HarnessAdapter,
      target: PaneTarget,
      state: WatchLoopState,
      screen: string,
    ) {
      const needs = adapter.needsInput(screen)
      if (Option.isSome(needs)) {
        const blocked = yield* markNeedsInput(state.worker, needs.value.summary, needs.value.tail)
        return { kind: "continue" as const, state: { ...state, worker: blocked }, wait: true }
      }
      if (Option.isSome(state.pendingBrief)) {
        if (!adapter.readyForInput(screen)) return { kind: "continue" as const, state, wait: true }
        const startedAt = yield* Clock.currentTimeMillis
        yield* submitToPane(rex, adapter, target, state.pendingBrief.value, pasteQuiet).pipe(Effect.ignore)
        const working: PaneWorker = {
          ...state.worker,
          state: "working",
          update: "running in Rex pane",
          startedAt,
          updatedAt: startedAt,
        }
        yield* store.upsertWorker(working)
        yield* notifier.changed(working.parentSessionID)
        return { kind: "continue" as const, state: { worker: working, pendingBrief: Option.none(), sawWorking: false }, wait: true }
      }
      if (!adapter.turnEnded(screen)) {
        let nextWorker = state.worker
        if (nextWorker.state === "needs_input") {
          const now = yield* Clock.currentTimeMillis
          nextWorker = { ...nextWorker, state: "working", update: "running in Rex pane", updatedAt: now, lastLines: shortLines(screen) }
          yield* store.upsertWorker(nextWorker)
          yield* notifier.changed(nextWorker.parentSessionID)
        }
        return { kind: "continue" as const, state: { ...state, worker: nextWorker, sawWorking: true }, wait: false }
      }
      if (state.sawWorking || state.worker.state === "working") {
        const verdict = yield* confirmIdleAndSettle(adapter, target, state.worker)
        if (verdict.kind === "done") return { kind: "done" as const }
        return { kind: "continue" as const, state: { ...state, worker: verdict.worker }, wait: false }
      }
      return { kind: "continue" as const, state, wait: false }
    })

    const watchTurn = Effect.fn("PaneAgent.watchTurn")(function* (
      initial: PaneWorker,
      initialPendingBrief: Option.Option<string>,
    ) {
      const adapter = adapterFor(initial.harness)
      const target = targetOf(initial)
      let state: WatchLoopState = { worker: initial, pendingBrief: initialPendingBrief, sawWorking: false }

      while (true) {
        if (Option.isNone(state.pendingBrief)) {
          const fileAnswer = yield* readResultOrNone(state.worker)
          if (Option.isSome(fileAnswer)) {
            const now = yield* Clock.currentTimeMillis
            yield* settleResult(store, notifier, state.worker, fileAnswer.value, true, now)
            return
          }
        }
        const screenOpt = yield* rex.read(target).pipe(Effect.option)
        if (Option.isNone(screenOpt)) {
          const now = yield* Clock.currentTimeMillis
          yield* settleFailure(store, notifier, state.worker, "Rex pane is no longer reachable", "", now)
          return
        }
        const step = yield* handleScreen(adapter, target, state, screenOpt.value)
        if (step.kind === "done") return
        state = step.state
        if (step.wait) {
          yield* rex.waitForQuiet(target, { quietFor, timeout: pollTimeout }).pipe(Effect.ignore)
          continue
        }
        const stillAlive = yield* rex.alive(target).pipe(Effect.orElseSucceed(() => false))
        if (!stillAlive) {
          const finalFile = yield* readResultOrNone(state.worker)
          const now = yield* Clock.currentTimeMillis
          if (Option.isSome(finalFile)) {
            yield* settleResult(store, notifier, state.worker, finalFile.value, true, now)
            return
          }
          yield* settleFailure(store, notifier, state.worker, "Pane process exited before finishing turn", shortLines(screenOpt.value), now)
          return
        }
        yield* rex.waitForQuiet(target, { quietFor, timeout: pollTimeout }).pipe(Effect.ignore)
      }
    })

    const launchWatcher = (worker: PaneWorker, pendingBrief: Option.Option<string> = Option.none()) =>
      FiberMap.run(
        watchers,
        worker.id,
        watchTurn(worker, pendingBrief).pipe(
          Effect.catchCause((cause) => Effect.logDebug("pane-agent watcher ended with failure", cause)),
        ),
      ).pipe(Effect.provideService(Scope.Scope, scope))

    const openOrSelectPane = Effect.fn("PaneAgent.openOrSelectPane")(function* (
      input: StartInput,
      adapter: HarnessAdapter,
      unit: string,
      resolvedCwd: string,
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
      const command = adapter.command(buildStartOptions(input.harness, config.binaryOverrides, input.dangerousSkipPermissions))
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
      const { role, unit } = parseDescription(input.description)
      const now = yield* Clock.currentTimeMillis
      const id = yield* makeWorkerId()
      const opened = yield* openOrSelectPane(input, adapter, unit, resolvedCwd, savedAnchor)

      const target: PaneTarget = { sessionId: opened.rexSessionId, blockId: opened.blockId }
      const starting: PaneWorker = {
        id,
        parentSessionID: input.parentSessionID,
        directory: input.directory,
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
        startedAt: now,
        updatedAt: now,
      }
      yield* store.upsertWorker(starting)
      yield* notifier.changed(input.parentSessionID)

      const brief = taskBrief({ prompt: input.prompt, resultFile: input.resultFile })
      const readiness = yield* waitReady(adapter, target)
      if (readiness.kind === "needs_input") {
        const blocked = yield* markNeedsInput(starting, readiness.needs.summary, readiness.needs.tail)
        yield* launchWatcher(blocked, Option.some(brief))
        return blocked
      }
      if (readiness.kind === "exited") {
        return yield* settleFailure(store, notifier, starting, `${input.harness} exited before becoming ready for input`, readiness.tail, yield* Clock.currentTimeMillis)
      }
      if (readiness.kind === "timeout") {
        return yield* settleFailure(store, notifier, starting, `${input.harness} did not become ready for input`, readiness.tail, yield* Clock.currentTimeMillis)
      }

      const turnStartedAt = yield* Clock.currentTimeMillis
      yield* submitToPane(rex, adapter, target, brief, pasteQuiet)
      const working: PaneWorker = {
        ...starting,
        state: "working",
        update: "running in Rex pane",
        startedAt: turnStartedAt,
        updatedAt: turnStartedAt,
      }
      yield* store.upsertWorker(working)
      yield* notifier.changed(input.parentSessionID)
      yield* launchWatcher(working)
      return working
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

    const followUp = Effect.fn("PaneAgent.followUp")(function* (input: FollowUpInput) {
      const existing = yield* findOwnedWorker(input.parentSessionID, input.id)
      const target = targetOf(existing)
      const isAlive = yield* rex.alive(target)
      if (!isAlive) {
        return yield* new WorkerRejected({
          reason: `Pane ${existing.blockId} for worker ${existing.id} is no longer running; start a new pane worker instead.`,
        })
      }
      yield* FiberMap.remove(watchers, existing.id)
      const adapter = adapterFor(existing.harness)
      const nextResultFile = Option.getOrElse(Option.fromUndefinedOr(input.resultFile), () => existing.resultFile)
      const brief = taskBrief({ prompt: input.prompt, resultFile: nextResultFile, followUp: true })
      const now = yield* Clock.currentTimeMillis
      yield* submitToPane(rex, adapter, target, brief, pasteQuiet)
      const next: PaneWorker = {
        ...existing,
        resultFile: nextResultFile,
        state: "working",
        update: "running follow-up in Rex pane",
        turn: existing.turn + 1,
        startedAt: now,
        updatedAt: now,
      }
      yield* store.upsertWorker(next)
      yield* notifier.changed(existing.parentSessionID)
      yield* launchWatcher(next)
      return next
    })

    const stop = Effect.fn("PaneAgent.stop")(function* (input: StopInput) {
      const existing = yield* findOwnedWorker(input.parentSessionID, input.id)
      yield* FiberMap.remove(watchers, existing.id)
      const target = targetOf(existing)
      const adapter = adapterFor(existing.harness)
      const isAlive = yield* rex.alive(target).pipe(Effect.orElseSucceed(() => false))
      if (isAlive) {
        yield* rex.write(target, adapter.interruptSequence).pipe(Effect.ignore)
        if (input.close === true && existing.ownedBlock) {
          yield* rex.close(target).pipe(Effect.ignore)
        }
      }
      const now = yield* Clock.currentTimeMillis
      const stopped: PaneWorker = {
        ...existing,
        state: "stopped",
        update: "stopped",
        updatedAt: now,
        endedAt: now,
        notifiedTurn: existing.turn,
      }
      yield* store.upsertWorker(stopped)
      yield* notifier.changed(existing.parentSessionID)
      return stopped
    })

    const status = Effect.fn("PaneAgent.status")(function* (parentSessionID: string, id: string) {
      const existing = yield* findOwnedWorker(parentSessionID, id)
      const tailOpt = yield* rex.readTail(targetOf(existing), TAIL_BYTES).pipe(Effect.option)
      if (Option.isNone(tailOpt)) return existing
      const lines = shortLines(tailOpt.value)
      return { ...existing, lastLines: lines }
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

    const reattach = Effect.fn("PaneAgent.reattach")(function* (directory: string) {
      const snapshot = yield* store.read()
      const liveWorkers = snapshot.workers.filter((worker) => worker.directory === directory && isLive(worker.state))
      const resultsOut: Array<PaneWorker> = []
      for (const worker of liveWorkers) {
        const fileAnswer = yield* results.readComplete(worker.resultFile, worker.startedAt).pipe(
          Effect.orElseSucceed(() => Option.none<string>()),
        )
        if (Option.isSome(fileAnswer)) {
          const now = yield* Clock.currentTimeMillis
          const done = yield* settleResult(store, notifier, worker, fileAnswer.value, true, now)
          resultsOut.push(done)
          continue
        }
        const isAlive = yield* rex.alive(targetOf(worker)).pipe(Effect.orElseSucceed(() => false))
        if (isAlive) {
          yield* launchWatcher(worker)
          resultsOut.push(worker)
        } else {
          const now = yield* Clock.currentTimeMillis
          const failed = yield* settleFailure(store, notifier, worker, "Rex pane is no longer running after restart", "", now)
          resultsOut.push(failed)
        }
      }
      return resultsOut
    })

    return PaneAgentModel.of({
      start,
      followUp,
      stop,
      status,
      list,
      views,
      bindPane,
      reattach,
    })
  })

export const layer = (config: ModelConfig = {}) => Layer.effect(PaneAgentModel, makeModel(config))
