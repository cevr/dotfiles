import { Array as Arr, Data, Match, Option } from "effect"
import type { HarnessAdapter } from "./adapter.ts"
import { taskBrief } from "./prompt.ts"
import type { WakeLetter } from "./service.ts"
import { isLive, type PaneWorker, type PendingWake, type QueuedTurn } from "./worker.ts"

export interface MachineConfig {
  readonly maxTransientErrors: number
  readonly confirmGoneCount: number
}

export const DEFAULT_MACHINE_CONFIG: MachineConfig = {
  maxTransientErrors: 5,
  confirmGoneCount: 2,
}

/** Explicit worker state machine record: `worker` is durable; counters are per-watcher runtime state. */
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
  readonly WakeDelivered: { readonly now: number }
  readonly WakeFailed: { readonly message: string; readonly now: number }
  readonly Stop: { readonly close: boolean; readonly now: number }
}>

export const MachineEvent = Data.taggedEnum<MachineEvent>()

/** Effects emitted by `transition` for the runtime interpreter (`model.ts`) to execute. */
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
})

const attachWakeIfDue = (worker: PaneWorker, wake: PendingWake, terminal: boolean): PaneWorker => {
  const delivered = deliveredWakesOf(worker)
  if (delivered.includes(wake.key)) return worker
  if (terminal && worker.notifiedTurn >= wake.turn) return worker
  const existing = Option.fromUndefinedOr(worker.pendingWake)
  if (Option.isSome(existing) && existing.value.key === wake.key) return worker
  return { ...worker, pendingWake: wake }
}

const withoutPendingWake = (worker: PaneWorker): PaneWorker => {
  const { pendingWake: _removed, ...rest } = worker
  return rest
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
  const nextWorker = attachWakeIfDue(base, wake, true)
  const hasQueued = pendingTurnsOf(nextWorker).length > 0
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(Option.fromUndefinedOr(nextWorker.pendingWake))) {
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
  const alreadyBlocked =
    state.worker.state === "needs_input" &&
    state.worker.update === summary &&
    deliveredWakesOf(state.worker).includes(key) &&
    Option.isNone(Option.fromUndefinedOr(state.worker.pendingWake))
  if (alreadyBlocked) {
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
  const nextWorker = attachWakeIfDue(base, wake, false)
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(Option.fromUndefinedOr(nextWorker.pendingWake))) {
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
  // Confirmed gone by second typed gone probe: settle with result file only if an active typed turn produced one.
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
    nextWorker = attachWakeIfDue(base, wake, true)
  }
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(Option.fromUndefinedOr(nextWorker.pendingWake))) {
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
  const nextWorker = attachWakeIfDue(base, wake, false)
  const hasWake = Option.isSome(Option.fromUndefinedOr(nextWorker.pendingWake))
  const actions: Array<MachineAction> = []
  if (!already || hasWake) {
    actions.push(MachineAction.Persist())
    if (hasWake) actions.push(MachineAction.FlushWake())
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
    (state.worker.state === "working" && activeTurnTypedOf(state.worker)) || state.worker.state === "done"
  const canSteerNow = !screenBlocked && !hasQueued && turnReadyForSteer

  if (!canSteerNow) {
    // Single write gate: never write into a prompt or drop an unsent initial task; queue in order instead.
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

const handleWakeDelivered = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "WakeDelivered" }>,
): TransitionResult => {
  const pending = Option.fromUndefinedOr(state.worker.pendingWake)
  if (Option.isNone(pending)) {
    return { state, actions: [] }
  }
  const delivered = deliveredWakesOf(state.worker)
  let nextDelivered = delivered
  if (!delivered.includes(pending.value.key)) {
    nextDelivered = [...delivered, pending.value.key]
  }
  const isTurnTerminal =
    pending.value.kind === "done" || pending.value.kind === "pane_gone" || pending.value.kind === "failed"
  let nextNotifiedTurn = state.worker.notifiedTurn
  if (isTurnTerminal) {
    nextNotifiedTurn = Math.max(state.worker.notifiedTurn, pending.value.turn)
  }
  const nextWorker: PaneWorker = {
    ...withoutPendingWake(state.worker),
    deliveredWakes: nextDelivered,
    notifiedTurn: nextNotifiedTurn,
    updatedAt: event.now,
  }
  return {
    state: { ...state, worker: nextWorker },
    actions: [MachineAction.Persist()],
  }
}

const handleStop = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "Stop" }>,
): TransitionResult => {
  const stopped: PaneWorker = {
    ...withoutPendingWake(state.worker),
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
    Match.tag("WakeDelivered", (ev) => handleWakeDelivered(state, ev)),
    Match.tag("WakeFailed", () => ({ state, actions: [MachineAction.RetryTransient()] })),
    Match.tag("Stop", (ev) => handleStop(state, ev)),
    Match.exhaustive,
  )
