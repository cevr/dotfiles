import { Array as Arr, Data, Match, Option } from "effect"
import type { HarnessAdapter } from "./adapter.ts"
import { taskBrief } from "./prompt.ts"
import type { WakeLetter } from "./service.ts"
import { isLive, type PaneWorker, type PendingWake, pendingWakesOf, type QueuedTurn } from "./worker.ts"

export interface MachineConfig {
  readonly maxTransientErrors: number
  readonly confirmGoneCount: number
  readonly maxWakeAttempts: number
}

export const DEFAULT_MACHINE_CONFIG: MachineConfig = {
  maxTransientErrors: 5,
  confirmGoneCount: 2,
  maxWakeAttempts: 5,
}

/** Explicit worker state machine record: `worker` is durable; counters are per-actor runtime state. */
export interface MachineState {
  readonly worker: PaneWorker
  readonly sawWorking: boolean
  readonly idlePendingConfirm: boolean
  readonly consecutiveGone: number
  readonly consecutiveTransient: number
}

export const initialMachineState = (worker: PaneWorker, sawWorking = false): MachineState => ({
  worker,
  sawWorking,
  idlePendingConfirm: false,
  consecutiveGone: 0,
  consecutiveTransient: 0,
})

/** Inputs fed into the single transition function. */
export type MachineEvent = Data.TaggedEnum<{
  readonly ObserveScreen: { readonly screen: string; readonly now: number; readonly deliveryId: string }
  readonly IdleConfirmed: {
    readonly screen: string
    readonly resultFileAnswer: Option.Option<string>
    readonly now: number
    readonly deliveryId: string
  }
  readonly ProbeGone: {
    readonly tail: string
    readonly resultFileAnswer: Option.Option<string>
    readonly now: number
    readonly deliveryId: string
  }
  readonly TransientError: {
    readonly operation: string
    readonly message: string
    readonly now: number
    readonly deliveryId: string
  }
  readonly QueueFollowUp: {
    readonly prompt: string
    readonly resultFile: Option.Option<string>
    readonly now: number
  }
  readonly RequestSteer: {
    readonly prompt: string
    readonly resultFile: Option.Option<string>
    readonly screen: Option.Option<string>
    readonly now: number
  }
  readonly RestartPane: {
    readonly rexSessionId: string
    readonly newBlockId: string
    readonly cwd: string
    readonly addDirs: ReadonlyArray<string>
    readonly resultFile: string
    readonly now: number
  }
  readonly WakeDelivered: { readonly deliveryId: string; readonly now: number }
  readonly WakeFailed: { readonly deliveryId: string; readonly message: string; readonly now: number }
  readonly RestartWakeRetries: { readonly now: number }
  readonly Stop: { readonly close: boolean; readonly now: number }
}>

export const MachineEvent = Data.taggedEnum<MachineEvent>()

/** Effects emitted by `transition` for the single-writer actor interpreter (`model.ts`) to execute. */
export type MachineAction = Data.TaggedEnum<{
  readonly Persist: {}
  readonly FlushWake: {}
  readonly WritePane: { readonly chunks: ReadonlyArray<string> }
  readonly WaitQuiet: {}
  readonly ConfirmIdle: {}
  readonly ConfirmGone: {}
  readonly RetryTransient: {}
  readonly InterruptPane: { readonly close: boolean }
  readonly StopWatching: {}
}>

export const MachineAction = Data.taggedEnum<MachineAction>()

export interface TransitionResult {
  readonly state: MachineState
  readonly actions: ReadonlyArray<MachineAction>
}

const shortLines = (text: string, maxLines = 12): string =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-maxLines)
    .join("\n")

export const pendingTurnsOf = (worker: PaneWorker): ReadonlyArray<QueuedTurn> =>
  Option.getOrElse(Option.fromUndefinedOr(worker.pendingTurns), () => [])

export const deliveredWakesOf = (worker: PaneWorker): ReadonlyArray<string> =>
  Option.getOrElse(Option.fromUndefinedOr(worker.deliveredWakes), () => [])

export const activeTurnTypedOf = (worker: PaneWorker): boolean =>
  Option.getOrElse(Option.fromUndefinedOr(worker.activeTurnTyped), () => true)

export const maxTurnOf = (worker: PaneWorker): number => {
  let max = worker.turn
  for (const item of pendingTurnsOf(worker)) {
    if (item.turn > max) max = item.turn
  }
  return max
}

export const nextRetryableWake = (worker: PaneWorker): Option.Option<PendingWake> =>
  Arr.findFirst(pendingWakesOf(worker), (wake) => wake.undelivered !== true)

export const hasUndeliveredWakes = (worker: PaneWorker): boolean =>
  pendingWakesOf(worker).some((wake) => wake.undelivered === true)

/** Derives a distinct per-turn result file path so concurrent/queued turns never collide on one path. */
export const turnResultFile = (basePath: string, turn: number): string => {
  const slash = basePath.lastIndexOf("/")
  const dot = basePath.lastIndexOf(".")
  if (dot > slash + 1) {
    const stem = basePath.slice(0, dot).replace(/\.t\d+$/, "")
    const ext = basePath.slice(dot)
    return `${stem}.t${turn}${ext}`
  }
  const stem = basePath.replace(/\.t\d+$/, "")
  return `${stem}.t${turn}`
}

const usedResultFiles = (worker: PaneWorker): ReadonlySet<string> => {
  const used = new Set<string>([worker.resultFile])
  for (const item of pendingTurnsOf(worker)) {
    used.add(item.resultFile)
  }
  return used
}

const resolveNextResultFile = (worker: PaneWorker, requested: Option.Option<string>, nextTurn: number): string => {
  const used = usedResultFiles(worker)
  if (Option.isSome(requested) && requested.value.trim().length > 0 && !used.has(requested.value)) {
    return requested.value
  }
  const base = Option.getOrElse(
    Option.filter(requested, (value) => value.trim().length > 0),
    () => worker.resultFile,
  )
  return turnResultFile(base, nextTurn)
}

export const wakeLetterOf = (wake: PendingWake): WakeLetter => ({
  id: wake.deliveryId,
  description: wake.description,
  text: wake.text,
  metadata: wake.metadata,
})

const sourceLabel = (fromFile: boolean): string => {
  if (fromFile) return "result-file"
  return "pane"
}

const updateLabel = (fromFile: boolean): string => {
  if (fromFile) return "wrote result file"
  return "turn finished"
}

const makeDoneWake = (worker: PaneWorker, answer: string, fromFile: boolean, deliveryId: string): PendingWake => ({
  deliveryId,
  turn: worker.turn,
  kind: "done",
  key: `${worker.id}:${worker.turn}:done`,
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
  attempts: 0,
})

const makeNeedsInputWake = (worker: PaneWorker, summary: string, tail: string, deliveryId: string): PendingWake => ({
  deliveryId,
  turn: worker.turn,
  kind: "needs_input",
  key: `${worker.id}:${worker.turn}:needs_input:${summary}`,
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
  attempts: 0,
})

const makePaneGoneWake = (worker: PaneWorker, reason: string, tail: string, deliveryId: string): PendingWake => {
  const cwd = Option.getOrElse(Option.fromUndefinedOr(worker.cwd), () => worker.directory)
  const lines = [
    `<pane-agent-result id="${worker.id}" harness="${worker.harness}" block="${worker.blockId}" state="pane_gone" turn="${worker.turn}">`,
    `${reason} Call pane_agent({ action: "restart", id: "${worker.id}" }) to resume this worker with --continue in ${cwd}.`,
  ]
  if (tail.length > 0) {
    lines.push("", "Last lines from the pane:", tail)
  }
  lines.push("</pane-agent-result>")
  return {
    deliveryId,
    turn: worker.turn,
    kind: "pane_gone",
    key: `${worker.id}:${worker.turn}:pane_gone`,
    description: `${worker.role} ${worker.harness} · ${worker.unit} · pane gone`,
    text: lines.join("\n"),
    metadata: {
      source: "pane-agent",
      workerId: worker.id,
      harness: worker.harness,
      blockId: worker.blockId,
      state: "pane_gone",
      turn: worker.turn,
    },
    attempts: 0,
  }
}

const makeUnreachableWake = (worker: PaneWorker, reason: string, deliveryId: string): PendingWake => ({
  deliveryId,
  turn: worker.turn,
  kind: "rex_unreachable",
  key: `${worker.id}:${worker.turn}:rex_unreachable`,
  description: `${worker.role} ${worker.harness} · ${worker.unit} · rex unreachable`,
  text: [
    `<pane-agent-result id="${worker.id}" harness="${worker.harness}" block="${worker.blockId}" state="rex_unreachable" turn="${worker.turn}">`,
    `${reason} The pane was NOT marked gone; pane-agent will keep retrying when Rex answers again.`,
    "</pane-agent-result>",
  ].join("\n"),
  metadata: {
    source: "pane-agent",
    workerId: worker.id,
    harness: worker.harness,
    blockId: worker.blockId,
    state: "rex_unreachable",
    turn: worker.turn,
  },
  attempts: 0,
})

const withPendingWakes = (worker: PaneWorker, wakes: ReadonlyArray<PendingWake>): PaneWorker => {
  const { pendingWake: _legacy, ...rest } = worker
  return { ...rest, pendingWakes: [...wakes] }
}

/** Appends a wake to the ordered FIFO outbox if not already delivered or queued (never replaces an earlier wake). */
const enqueueWakeIfDue = (worker: PaneWorker, wake: PendingWake, terminal: boolean): PaneWorker => {
  const delivered = deliveredWakesOf(worker)
  if (delivered.includes(wake.key)) return worker
  if (terminal && worker.notifiedTurn >= wake.turn) return worker
  const existing = pendingWakesOf(worker)
  if (existing.some((item) => item.key === wake.key)) return worker
  return withPendingWakes(worker, [...existing, wake])
}

/** Keeps deliveredWakes bounded by pruning entries from turns strictly older than `notifiedTurn - 1`. */
const pruneDeliveredWakes = (keys: ReadonlyArray<string>, notifiedTurn: number): ReadonlyArray<string> => {
  const minTurn = notifiedTurn - 1
  if (minTurn <= 1) return keys
  return keys.filter((key) => {
    const parts = key.split(":")
    const turnPart = Option.fromUndefinedOr(parts[1])
    if (Option.isNone(turnPart)) return true
    const parsed = Number(turnPart.value)
    if (!Number.isFinite(parsed)) return true
    return parsed >= minTurn
  })
}

const settleDone = (
  state: MachineState,
  answer: string,
  fromFile: boolean,
  now: number,
  deliveryId: string,
): TransitionResult => {
  const base: PaneWorker = {
    ...state.worker,
    state: "done",
    update: updateLabel(fromFile),
    updatedAt: now,
    endedAt: now,
    activeTurnTyped: false,
    lastAnswer: answer,
  }
  const wake = makeDoneWake(base, answer, fromFile, deliveryId)
  const nextWorker = enqueueWakeIfDue(base, wake, true)
  const hasQueued = pendingTurnsOf(nextWorker).length > 0
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(nextRetryableWake(nextWorker))) {
    actions.push(MachineAction.FlushWake())
  }
  if (hasQueued) {
    actions.push(MachineAction.WaitQuiet())
  } else {
    actions.push(MachineAction.StopWatching())
  }
  return {
    state: {
      worker: nextWorker,
      sawWorking: false,
      idlePendingConfirm: false,
      consecutiveGone: 0,
      consecutiveTransient: 0,
    },
    actions,
  }
}

const enterNeedsInput = (
  state: MachineState,
  summary: string,
  tail: string,
  now: number,
  deliveryId: string,
): TransitionResult => {
  const key = `${state.worker.id}:${state.worker.turn}:needs_input:${summary}`
  const alreadyHandled =
    deliveredWakesOf(state.worker).includes(key) ||
    pendingWakesOf(state.worker).some((item) => item.key === key)
  if (state.worker.state === "needs_input" && state.worker.update === summary && alreadyHandled) {
    return {
      state: { ...state, idlePendingConfirm: false, consecutiveGone: 0, consecutiveTransient: 0 },
      actions: [MachineAction.WaitQuiet()],
    }
  }
  const base: PaneWorker = {
    ...state.worker,
    state: "needs_input",
    update: summary,
    updatedAt: now,
    lastLines: tail,
  }
  const wake = makeNeedsInputWake(base, summary, tail, deliveryId)
  const nextWorker = enqueueWakeIfDue(base, wake, false)
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(nextRetryableWake(nextWorker))) {
    actions.push(MachineAction.FlushWake())
  }
  actions.push(MachineAction.WaitQuiet())
  return {
    state: {
      worker: nextWorker,
      sawWorking: state.sawWorking,
      idlePendingConfirm: false,
      consecutiveGone: 0,
      consecutiveTransient: 0,
    },
    actions,
  }
}

const chunksForTurn = (adapter: HarnessAdapter, turn: QueuedTurn): ReadonlyArray<string> => {
  if (turn.mode === "steer") return adapter.formatSteer(turn.brief)
  return adapter.formatSubmit(turn.brief)
}

const queuedUpdateLabel = (turn: number): string => {
  if (turn > 1) return "queued follow-up running in Rex pane"
  return "running in Rex pane"
}

const submitNextQueued = (
  state: MachineState,
  nextTurn: QueuedTurn,
  rest: ReadonlyArray<QueuedTurn>,
  adapter: HarnessAdapter,
  now: number,
): TransitionResult => {
  const chunks = chunksForTurn(adapter, nextTurn)
  const update = queuedUpdateLabel(nextTurn.turn)
  const { endedAt: _cleared, ...base } = state.worker
  const nextWorker: PaneWorker = {
    ...base,
    turn: nextTurn.turn,
    resultFile: nextTurn.resultFile,
    state: "working",
    update,
    activeTurnTyped: true,
    pendingTurns: [...rest],
    startedAt: now,
    updatedAt: now,
  }
  return {
    state: {
      worker: nextWorker,
      sawWorking: false,
      idlePendingConfirm: false,
      consecutiveGone: 0,
      consecutiveTransient: 0,
    },
    actions: [MachineAction.Persist(), MachineAction.WritePane({ chunks })],
  }
}

const recoveredStateFor = (worker: PaneWorker): PaneWorker["state"] => {
  if (activeTurnTypedOf(worker)) return "working"
  return "starting"
}

const handleObserveScreen = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "ObserveScreen" }>,
  adapter: HarnessAdapter,
): TransitionResult => {
  let recoveredWorker = state.worker
  const recoveredPersist: Array<MachineAction> = []
  if (state.worker.state === "rex_unreachable") {
    recoveredWorker = {
      ...state.worker,
      state: recoveredStateFor(state.worker),
      update: "running in Rex pane",
      updatedAt: event.now,
    }
    recoveredPersist.push(MachineAction.Persist())
  }
  const recovered: MachineState = {
    ...state,
    worker: recoveredWorker,
    consecutiveGone: 0,
    consecutiveTransient: 0,
  }

  // Single write gate: never type or settle while a human prompt is active.
  const needs = adapter.needsInput(event.screen)
  if (Option.isSome(needs)) {
    return enterNeedsInput(recovered, needs.value.summary, needs.value.tail, event.now, event.deliveryId)
  }

  // If no active turn is typed yet (startup or between queued turns), type the head queued turn ONLY when readyForInput.
  if (!activeTurnTypedOf(recovered.worker)) {
    const queue = pendingTurnsOf(recovered.worker)
    const head = Arr.head(queue)
    if (Option.isSome(head)) {
      if (!adapter.readyForInput(event.screen)) {
        return { state: recovered, actions: [...recoveredPersist, MachineAction.WaitQuiet()] }
      }
      return submitNextQueued(recovered, head.value, queue.slice(1), adapter, event.now)
    }
    return { state: recovered, actions: [...recoveredPersist, MachineAction.StopWatching()] }
  }

  // Active turn is typed: check if harness is still working or shows turnEnded.
  if (!adapter.turnEnded(event.screen)) {
    if (recovered.worker.state === "needs_input" || state.worker.state === "rex_unreachable") {
      const resumed: PaneWorker = {
        ...recovered.worker,
        state: "working",
        update: "running in Rex pane",
        updatedAt: event.now,
        lastLines: shortLines(event.screen),
      }
      return {
        state: { ...recovered, worker: resumed, sawWorking: true, idlePendingConfirm: false },
        actions: [MachineAction.Persist(), MachineAction.WaitQuiet()],
      }
    }
    return {
      state: { ...recovered, sawWorking: true, idlePendingConfirm: false },
      actions: [MachineAction.WaitQuiet()],
    }
  }

  // turnEnded holds on pass 1: confirm across waitForQuiet before settling (B1).
  if (recovered.sawWorking || recovered.worker.state === "working") {
    return {
      state: { ...recovered, idlePendingConfirm: true },
      actions: [...recoveredPersist, MachineAction.ConfirmIdle()],
    }
  }
  return { state: recovered, actions: [...recoveredPersist, MachineAction.WaitQuiet()] }
}

const handleIdleConfirmed = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "IdleConfirmed" }>,
  adapter: HarnessAdapter,
): TransitionResult => {
  const needs = adapter.needsInput(event.screen)
  if (Option.isSome(needs)) {
    return enterNeedsInput(state, needs.value.summary, needs.value.tail, event.now, event.deliveryId)
  }
  if (!adapter.turnEnded(event.screen)) {
    return {
      state: { ...state, sawWorking: true, idlePendingConfirm: false, consecutiveGone: 0, consecutiveTransient: 0 },
      actions: [MachineAction.WaitQuiet()],
    }
  }
  if (!activeTurnTypedOf(state.worker)) {
    return {
      state: { ...state, idlePendingConfirm: false },
      actions: [MachineAction.WaitQuiet()],
    }
  }
  if (!state.sawWorking && Option.isNone(event.resultFileAnswer)) {
    return {
      state: { ...state, idlePendingConfirm: false, consecutiveGone: 0, consecutiveTransient: 0 },
      actions: [MachineAction.WaitQuiet()],
    }
  }
  return Option.match(event.resultFileAnswer, {
    onSome: (answer) => settleDone(state, answer, true, event.now, event.deliveryId),
    onNone: () => settleDone(state, adapter.readLastAnswer(event.screen), false, event.now, event.deliveryId),
  })
}

const handleProbeGone = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "ProbeGone" }>,
  config: MachineConfig,
): TransitionResult => {
  const nextGone = state.consecutiveGone + 1
  if (nextGone < config.confirmGoneCount) {
    return {
      state: { ...state, consecutiveGone: nextGone, idlePendingConfirm: false },
      actions: [MachineAction.ConfirmGone()],
    }
  }
  if (activeTurnTypedOf(state.worker) && Option.isSome(event.resultFileAnswer)) {
    return settleDone(state, event.resultFileAnswer.value, true, event.now, event.deliveryId)
  }
  const base: PaneWorker = {
    ...state.worker,
    state: "pane_gone",
    update: "pane gone (use restart to resume with --continue)",
    updatedAt: event.now,
    endedAt: event.now,
    lastLines: event.tail,
  }
  const wake = makePaneGoneWake(base, "Rex pane closed or process exited.", event.tail, event.deliveryId)
  let nextWorker = base
  if (isLive(state.worker.state)) {
    nextWorker = enqueueWakeIfDue(base, wake, true)
  }
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(nextRetryableWake(nextWorker))) {
    actions.push(MachineAction.FlushWake())
  }
  actions.push(MachineAction.StopWatching())
  return {
    state: {
      worker: nextWorker,
      sawWorking: false,
      idlePendingConfirm: false,
      consecutiveGone: nextGone,
      consecutiveTransient: 0,
    },
    actions,
  }
}

const handleTransientError = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "TransientError" }>,
  config: MachineConfig,
): TransitionResult => {
  const nextTransient = state.consecutiveTransient + 1
  if (nextTransient < config.maxTransientErrors) {
    return {
      state: { ...state, consecutiveTransient: nextTransient, idlePendingConfirm: false },
      actions: [MachineAction.RetryTransient()],
    }
  }
  const reason = `Rex ${event.operation} unreachable after ${nextTransient} attempts (${event.message}).`
  const already = state.worker.state === "rex_unreachable"
  const base: PaneWorker = {
    ...state.worker,
    state: "rex_unreachable",
    update: reason,
    updatedAt: event.now,
  }
  const wake = makeUnreachableWake(base, reason, event.deliveryId)
  const nextWorker = enqueueWakeIfDue(base, wake, false)
  const hasRetryable = Option.isSome(nextRetryableWake(nextWorker))
  const actions: Array<MachineAction> = []
  if (!already || hasRetryable) {
    actions.push(MachineAction.Persist())
    if (hasRetryable) actions.push(MachineAction.FlushWake())
  }
  actions.push(MachineAction.RetryTransient())
  return {
    state: {
      worker: nextWorker,
      sawWorking: state.sawWorking,
      idlePendingConfirm: false,
      consecutiveGone: state.consecutiveGone,
      consecutiveTransient: nextTransient,
    },
    actions,
  }
}

const handleQueueFollowUp = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "QueueFollowUp" }>,
): TransitionResult => {
  const nextTurn = maxTurnOf(state.worker) + 1
  const nextResultFile = resolveNextResultFile(state.worker, event.resultFile, nextTurn)
  const brief = taskBrief({ prompt: event.prompt, resultFile: nextResultFile, followUp: true })
  const queued: QueuedTurn = {
    turn: nextTurn,
    brief,
    resultFile: nextResultFile,
    mode: "submit",
    queuedAt: event.now,
  }
  const nextQueue = [...pendingTurnsOf(state.worker), queued]
  const nextWorker: PaneWorker = {
    ...state.worker,
    pendingTurns: nextQueue,
    updatedAt: event.now,
  }
  return {
    state: { ...state, worker: nextWorker },
    actions: [MachineAction.Persist()],
  }
}

const handleRequestSteer = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "RequestSteer" }>,
  adapter: HarnessAdapter,
): TransitionResult => {
  const nextTurn = maxTurnOf(state.worker) + 1
  const nextResultFile = resolveNextResultFile(state.worker, event.resultFile, nextTurn)
  const brief = taskBrief({ prompt: event.prompt, resultFile: nextResultFile, followUp: true })
  const screenBlocked =
    Option.isNone(event.screen) || Option.isSome(adapter.needsInput(event.screen.value))
  const hasQueued = pendingTurnsOf(state.worker).length > 0
  const turnReadyForSteer =
    (state.worker.state === "working" && activeTurnTypedOf(state.worker)) ||
    state.worker.state === "done" ||
    state.worker.state === "wake_undelivered"
  const canSteerNow = !screenBlocked && !hasQueued && turnReadyForSteer

  if (!canSteerNow) {
    const queued: QueuedTurn = {
      turn: nextTurn,
      brief,
      resultFile: nextResultFile,
      mode: "steer",
      queuedAt: event.now,
    }
    const nextWorker: PaneWorker = {
      ...state.worker,
      pendingTurns: [...pendingTurnsOf(state.worker), queued],
      updatedAt: event.now,
    }
    return {
      state: { ...state, worker: nextWorker },
      actions: [MachineAction.Persist()],
    }
  }

  const { endedAt: _cleared, ...base } = state.worker
  const steered: PaneWorker = {
    ...base,
    turn: nextTurn,
    resultFile: nextResultFile,
    state: "working",
    update: "steered in Rex pane",
    activeTurnTyped: true,
    startedAt: event.now,
    updatedAt: event.now,
  }
  return {
    state: {
      worker: steered,
      sawWorking: false,
      idlePendingConfirm: false,
      consecutiveGone: 0,
      consecutiveTransient: 0,
    },
    actions: [MachineAction.Persist(), MachineAction.WritePane({ chunks: adapter.formatSteer(brief) })],
  }
}

/** Renumbers carried pendingTurns sequentially after `resumedTurn` so turn ids stay strictly ascending (Q1). */
const carryPendingTurns = (
  carried: ReadonlyArray<QueuedTurn>,
  resumedTurn: number,
): ReadonlyArray<QueuedTurn> =>
  carried.map((item, idx) => ({
    ...item,
    turn: resumedTurn + idx + 1,
  }))

const handleRestartPane = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "RestartPane" }>,
): TransitionResult => {
  const resumedTurn = state.worker.turn + 1
  const carried = carryPendingTurns(pendingTurnsOf(state.worker), resumedTurn)
  const { endedAt: _ea, ...keep } = state.worker
  const restarted: PaneWorker = {
    ...keep,
    cwd: event.cwd,
    addDirs: [...event.addDirs],
    skipPermissions: state.worker.skipPermissions !== false,
    rexSessionId: event.rexSessionId,
    blockId: event.newBlockId,
    ownedBlock: true,
    resultFile: event.resultFile,
    state: "working",
    update: "restarted in Rex pane (--continue)",
    turn: resumedTurn,
    notifiedTurn: Math.max(state.worker.notifiedTurn, state.worker.turn),
    activeTurnTyped: true,
    pendingTurns: [...carried],
    startedAt: event.now,
    updatedAt: event.now,
  }
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(nextRetryableWake(restarted))) {
    actions.push(MachineAction.FlushWake())
  }
  return {
    state: {
      worker: restarted,
      sawWorking: false,
      idlePendingConfirm: false,
      consecutiveGone: 0,
      consecutiveTransient: 0,
    },
    actions,
  }
}

const handleWakeDelivered = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "WakeDelivered" }>,
): TransitionResult => {
  const wakes = pendingWakesOf(state.worker)
  const matched = Arr.findFirst(wakes, (item) => item.deliveryId === event.deliveryId)
  if (Option.isNone(matched)) {
    return { state, actions: [] }
  }
  const remaining = wakes.filter((item) => item.deliveryId !== event.deliveryId)
  const delivered = deliveredWakesOf(state.worker)
  let nextDelivered = delivered
  if (!delivered.includes(matched.value.key)) {
    nextDelivered = [...delivered, matched.value.key]
  }
  const isTurnTerminal =
    matched.value.kind === "done" || matched.value.kind === "pane_gone" || matched.value.kind === "failed"
  let nextNotifiedTurn = state.worker.notifiedTurn
  if (isTurnTerminal) {
    nextNotifiedTurn = Math.max(state.worker.notifiedTurn, matched.value.turn)
  }
  const prunedDelivered = pruneDeliveredWakes(nextDelivered, nextNotifiedTurn)
  let nextState = state.worker.state
  let nextUpdate = state.worker.update
  if (state.worker.state === "wake_undelivered" && !remaining.some((item) => item.undelivered === true)) {
    if (matched.value.kind === "pane_gone") {
      nextState = "pane_gone"
      nextUpdate = "pane gone (use restart to resume with --continue)"
    } else if (matched.value.kind === "failed") {
      nextState = "failed"
      nextUpdate = "failed"
    } else {
      nextState = "done"
      nextUpdate = "turn finished"
    }
  }
  const nextWorker: PaneWorker = {
    ...withPendingWakes(state.worker, remaining),
    state: nextState,
    update: nextUpdate,
    deliveredWakes: [...prunedDelivered],
    notifiedTurn: nextNotifiedTurn,
    updatedAt: event.now,
  }
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(nextRetryableWake(nextWorker))) {
    actions.push(MachineAction.FlushWake())
  }
  return {
    state: { ...state, worker: nextWorker },
    actions,
  }
}

const handleWakeFailed = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "WakeFailed" }>,
  config: MachineConfig,
): TransitionResult => {
  const wakes = pendingWakesOf(state.worker)
  const exists = wakes.some((item) => item.deliveryId === event.deliveryId)
  if (!exists) return { state, actions: [] }

  const updatedWakes = wakes.map((item): PendingWake => {
    if (item.deliveryId !== event.deliveryId) return item
    const attempts = Option.getOrElse(Option.fromUndefinedOr(item.attempts), () => 0) + 1
    if (attempts >= config.maxWakeAttempts) {
      return { ...item, attempts, undelivered: true, lastError: event.message }
    }
    return { ...item, attempts, lastError: event.message }
  })

  const stillHasRetryable = updatedWakes.some((item) => item.undelivered !== true)
  const hasAnyUndelivered = updatedWakes.some((item) => item.undelivered === true)
  const noActiveOrQueuedWork = !isLive(state.worker.state) && pendingTurnsOf(state.worker).length === 0

  let nextState = state.worker.state
  let nextUpdate = state.worker.update
  if (!stillHasRetryable && hasAnyUndelivered && noActiveOrQueuedWork && state.worker.state !== "stopped") {
    nextState = "wake_undelivered"
    nextUpdate = `wake undelivered after ${config.maxWakeAttempts} attempts (${event.message})`
  }

  const nextWorker: PaneWorker = {
    ...withPendingWakes(state.worker, updatedWakes),
    state: nextState,
    update: nextUpdate,
    updatedAt: event.now,
  }
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (stillHasRetryable) {
    actions.push(MachineAction.FlushWake())
  }
  return {
    state: { ...state, worker: nextWorker },
    actions,
  }
}

const handleRestartWakeRetries = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "RestartWakeRetries" }>,
): TransitionResult => {
  const wakes = pendingWakesOf(state.worker)
  if (wakes.length === 0) return { state, actions: [] }
  const reset = wakes.map((item): PendingWake => {
    const { undelivered: _u, lastError: _e, ...base } = item
    return { ...base, attempts: 0 }
  })
  const nextWorker: PaneWorker = {
    ...withPendingWakes(state.worker, reset),
    updatedAt: event.now,
  }
  return {
    state: { ...state, worker: nextWorker },
    actions: [MachineAction.Persist(), MachineAction.FlushWake()],
  }
}

const handleStop = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "Stop" }>,
): TransitionResult => {
  const stopped: PaneWorker = {
    ...withPendingWakes(state.worker, []),
    state: "stopped",
    update: "stopped",
    pendingTurns: [],
    activeTurnTyped: false,
    updatedAt: event.now,
    endedAt: event.now,
    notifiedTurn: maxTurnOf(state.worker),
  }
  return {
    state: {
      worker: stopped,
      sawWorking: false,
      idlePendingConfirm: false,
      consecutiveGone: 0,
      consecutiveTransient: 0,
    },
    actions: [
      MachineAction.InterruptPane({ close: event.close && state.worker.ownedBlock }),
      MachineAction.Persist(),
      MachineAction.StopWatching(),
    ],
  }
}

/** Single pure transition function governing every pane worker state, write gate, wake outbox, and error path. */
export const transition = (
  state: MachineState,
  event: MachineEvent,
  adapter: HarnessAdapter,
  config: MachineConfig = DEFAULT_MACHINE_CONFIG,
): TransitionResult =>
  Match.value(event).pipe(
    Match.tag("ObserveScreen", (ev) => handleObserveScreen(state, ev, adapter)),
    Match.tag("IdleConfirmed", (ev) => handleIdleConfirmed(state, ev, adapter)),
    Match.tag("ProbeGone", (ev) => handleProbeGone(state, ev, config)),
    Match.tag("TransientError", (ev) => handleTransientError(state, ev, config)),
    Match.tag("QueueFollowUp", (ev) => handleQueueFollowUp(state, ev)),
    Match.tag("RequestSteer", (ev) => handleRequestSteer(state, ev, adapter)),
    Match.tag("RestartPane", (ev) => handleRestartPane(state, ev)),
    Match.tag("WakeDelivered", (ev) => handleWakeDelivered(state, ev)),
    Match.tag("WakeFailed", (ev) => handleWakeFailed(state, ev, config)),
    Match.tag("RestartWakeRetries", (ev) => handleRestartWakeRetries(state, ev)),
    Match.tag("Stop", (ev) => handleStop(state, ev)),
    Match.exhaustive,
  )
