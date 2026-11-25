import { Array as Arr, Data, DateTime, Match, Option } from "effect"
import type { HarnessAdapter, UsageLimit } from "./adapter.ts"
import { taskBrief } from "./prompt.ts"
import type { WakeLetter } from "./service.ts"
import {
  type ActiveTurn,
  ClosePaneIntent,
  type DurableIntent,
  isLive,
  outboxOf,
  type PaneWorker,
  type PendingWake,
  pendingWakesOf,
  type QueuedTurn,
  SplitPaneIntent,
  TypeResumeIntent,
  TypeTurnIntent,
} from "./worker.ts"

const formatIsoMillis = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms))

export interface MachineConfig {
  readonly maxTransientErrors: number
  readonly confirmGoneCount: number
  readonly maxWakeAttempts: number
  readonly maxWriteAttempts: number
  readonly maxWrittenIdlePolls: number
}

export const DEFAULT_MACHINE_CONFIG: MachineConfig = {
  maxTransientErrors: 5,
  confirmGoneCount: 2,
  maxWakeAttempts: 5,
  maxWriteAttempts: 3,
  maxWrittenIdlePolls: 3,
}

/** Observed done answer captured on pass 1 of a typed active turn before quiet confirmation finishes. */
export interface ObservedDone {
  readonly turn: number
  readonly answer: string
}

/** Explicit worker state machine record: `worker` is durable; counters are per-actor runtime state. */
export interface MachineState {
  readonly worker: PaneWorker
  readonly sawWorking: boolean
  readonly idlePendingConfirm: boolean
  readonly consecutiveGone: number
  readonly consecutiveTransient: number
  readonly observedDone?: ObservedDone
}

export const activeTurnOf = (worker: PaneWorker): Option.Option<ActiveTurn> => {
  const explicit = Option.fromUndefinedOr(worker.activeTurn)
  if (Option.isSome(explicit)) return explicit
  if (worker.activeTurnTyped !== false && worker.state === "working") {
    return Option.some<ActiveTurn>({
      turn: worker.turn,
      brief: "",
      resultFile: worker.resultFile,
      mode: "submit",
      phase: "confirmed",
      writeAttempts: 1,
      writtenIdlePolls: 0,
      startedAt: worker.startedAt,
    })
  }
  return Option.none()
}

export const activeTurnTypedOf = (worker: PaneWorker): boolean =>
  Option.match(Option.fromUndefinedOr(worker.activeTurn), {
    onSome: (at) => at.phase === "written" || at.phase === "confirmed",
    onNone: () => Option.getOrElse(Option.fromUndefinedOr(worker.activeTurnTyped), () => true),
  })

export const initialMachineState = (worker: PaneWorker, sawWorking = false): MachineState => {
  const confirmed = Option.exists(activeTurnOf(worker), (at) => at.phase === "confirmed")
  return {
    worker,
    sawWorking: sawWorking || confirmed,
    idlePendingConfirm: false,
    consecutiveGone: 0,
    consecutiveTransient: 0,
  }
}

/** Inputs fed into the single transition function. */
export type MachineEvent = Data.TaggedEnum<{
  readonly ObserveScreen: {
    readonly screen: string
    readonly now: number
    readonly deliveryId: string
    readonly durableOutbox?: boolean
    readonly intentId?: string
    readonly ownerProc?: string
  }
  readonly IdleConfirmed: {
    readonly screen: string
    readonly priorScreen?: string
    readonly resultFileAnswer: Option.Option<string>
    readonly now: number
    readonly deliveryId: string
  }
  readonly ProbeGone: {
    readonly tail: string
    readonly lastScreen?: string
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
    readonly steer?: boolean
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
  readonly QueueRestart: {
    readonly rexSessionId: string
    readonly anchorBlockId: string
    readonly label: string
    readonly reqId: string
    readonly command: ReadonlyArray<string>
    readonly cwd: string
    readonly addDirs: ReadonlyArray<string>
    readonly resultFile: string
    readonly resumedBrief: string
    readonly splitIntentId: string
    readonly closeIntentId: Option.Option<string>
    readonly ownerProc: string
    readonly now: number
  }
  readonly MarkSplitDispatched: {
    readonly intentId: string
    readonly ownerProc: string
    readonly now: number
  }
  readonly SplitSucceeded: {
    readonly intentId: string
    readonly blockId: string
    readonly now: number
  }
  readonly SplitFailed: {
    readonly intentId: string
    readonly unknownOutcome: boolean
    readonly retryable: boolean
    readonly reason: string
    readonly now: number
    readonly deliveryId: string
    readonly extraDeliveryIds: ReadonlyArray<string>
  }
  readonly TypeTurnSucceeded: {
    readonly intentId: string
    readonly turn: number
    readonly now: number
  }
  readonly TypeTurnDeferredPrompt: {
    readonly intentId: string
    readonly summary: string
    readonly tail: string
    readonly now: number
    readonly deliveryId: string
  }
  readonly TypeTurnFailed: {
    readonly intentId: string
    readonly turn: number
    readonly chunkIndex: number
    readonly kind: "not_sent" | "ambiguous" | "unsupported" | "gone"
    readonly reason: string
    readonly now: number
    readonly deliveryId: string
  }
  readonly AmbiguousResolved: {
    readonly turn: number
    readonly outcome: "working" | "retry" | "not_typed"
    readonly reason: string
    readonly intentId: string
    readonly ownerProc: string
    readonly now: number
    readonly deliveryId: string
  }
  readonly TypeResumeSucceeded: {
    readonly intentId: string
    readonly turn: number
    readonly now: number
  }
  readonly TypeResumeDeferredPrompt: {
    readonly intentId: string
    readonly summary: string
    readonly tail: string
    readonly now: number
    readonly deliveryId: string
  }
  readonly TypeResumeFailed: {
    readonly intentId: string
    readonly turn: number
    readonly kind: "retry" | "ambiguous" | "not_typed"
    readonly reason: string
    readonly now: number
    readonly deliveryId: string
  }
  readonly SignInLimited: {
    readonly resetAt: number
    readonly now: number
    readonly deliveryId: string
  }
  readonly CloseCompleted: {
    readonly intentId: string
    readonly now: number
  }
  readonly WakeDelivered: { readonly deliveryId: string; readonly now: number }
  readonly WakeFailed: { readonly deliveryId: string; readonly message: string; readonly now: number }
  readonly RestartWakeRetries: { readonly now: number }
  readonly Stop: {
    readonly close: boolean
    readonly now: number
    readonly durableOutbox?: boolean
    readonly closeIntentId?: string
    readonly ownerProc?: string
    readonly lastScreen?: string
    readonly deliveryId?: string
    readonly extraDeliveryIds?: ReadonlyArray<string>
  }
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
  readonly WaitLimitReset: { readonly resetAt: number }
  readonly BroadcastLimit: { readonly resetAt: number }
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

export const maxTurnOf = (worker: PaneWorker): number => {
  let max = worker.turn
  const active = activeTurnOf(worker)
  if (Option.isSome(active) && active.value.turn > max) {
    max = active.value.turn
  }
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
  const active = activeTurnOf(worker)
  if (Option.isSome(active)) used.add(active.value.resultFile)
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

const makeDoneWake = (worker: PaneWorker, turn: number, answer: string, fromFile: boolean, deliveryId: string): PendingWake => ({
  deliveryId,
  turn,
  kind: "done",
  key: `${worker.id}:${turn}:done`,
  description: `${worker.role} ${worker.harness} · ${worker.unit} · done`,
  text: [
    `<pane-agent-result id="${worker.id}" harness="${worker.harness}" block="${worker.blockId}" state="done" turn="${turn}" source="${sourceLabel(fromFile)}">`,
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
    turn,
  },
  attempts: 0,
})

export const makeNotTypedWake = (
  worker: PaneWorker,
  turn: number,
  reason: string,
  deliveryId: string,
): PendingWake => ({
  deliveryId,
  turn,
  kind: "not_typed",
  key: `${worker.id}:${turn}:not_typed`,
  description: `${worker.role} ${worker.harness} · ${worker.unit} · turn ${turn} not typed`,
  text: [
    `<pane-agent-result state="not_typed" turn="${turn}">`,
    `Turn ${turn} was not typed: ${reason}`,
    "</pane-agent-result>",
  ].join("\n"),
  metadata: {
    source: "pane-agent",
    workerId: worker.id,
    harness: worker.harness,
    blockId: worker.blockId,
    state: "not_typed",
    turn,
  },
  attempts: 0,
})

const makeAnswerNotCapturedWake = (
  worker: PaneWorker,
  turn: number,
  reason: string,
  deliveryId: string,
): PendingWake => ({
  deliveryId,
  turn,
  kind: "answer_not_captured",
  key: `${worker.id}:${turn}:answer_not_captured`,
  description: `${worker.role} ${worker.harness} · ${worker.unit} · turn ${turn} answer not captured`,
  text: [
    `<pane-agent-result id="${worker.id}" harness="${worker.harness}" block="${worker.blockId}" state="answer_not_captured" turn="${turn}">`,
    `Turn ${turn} ended but its answer was not captured: ${reason}`,
    "</pane-agent-result>",
  ].join("\n"),
  metadata: {
    source: "pane-agent",
    workerId: worker.id,
    harness: worker.harness,
    blockId: worker.blockId,
    state: "answer_not_captured",
    turn,
  },
  attempts: 0,
})

const makeLimitedWake = (worker: PaneWorker, turn: number, resetAt: number, deliveryId: string): PendingWake => {
  const iso = formatIsoMillis(resetAt)
  return {
    deliveryId,
    turn,
    kind: "limited",
    key: `${worker.id}:${turn}:limited`,
    description: `${worker.role} ${worker.harness} · ${worker.unit} · usage limit`,
    text: [
      `<pane-agent-result state="limited" turn="${turn}" reset="${iso}">`,
      `Usage limit reached for ${worker.harness}; will resume after ${iso}.`,
      "</pane-agent-result>",
    ].join("\n"),
    metadata: {
      source: "pane-agent",
      workerId: worker.id,
      harness: worker.harness,
      blockId: worker.blockId,
      state: "limited",
      turn,
    },
    attempts: 0,
  }
}

const makeNeedsInputWake = (worker: PaneWorker, summary: string, tail: string, deliveryId: string): PendingWake => ({
  deliveryId,
  turn: worker.turn,
  kind: "needs_input",
  key: `${worker.id}:${worker.turn}:needs_input`,
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
  const held = pendingTurnsOf(worker).length
  const lines = [
    `<pane-agent-result id="${worker.id}" harness="${worker.harness}" block="${worker.blockId}" state="pane_gone" turn="${worker.turn}">`,
    `${reason} Call pane_agent({ action: "restart", id: "${worker.id}" }) to resume this worker with --continue in ${cwd}.`,
  ]
  if (held > 0) {
    lines.push(`${held} turn(s) held; restart to type them, or stop to drop them.`)
  }
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
      heldTurns: held,
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

export const makeFailedWake = (worker: PaneWorker, reason: string, deliveryId: string): PendingWake => ({
  deliveryId,
  turn: worker.turn,
  kind: "failed",
  key: `${worker.id}:${worker.turn}:failed`,
  description: `${worker.role} ${worker.harness} · ${worker.unit} · failed`,
  text: [
    `<pane-agent-result id="${worker.id}" harness="${worker.harness}" block="${worker.blockId}" state="failed" turn="${worker.turn}">`,
    reason,
    "</pane-agent-result>",
  ].join("\n"),
  metadata: {
    source: "pane-agent",
    workerId: worker.id,
    harness: worker.harness,
    blockId: worker.blockId,
    state: "failed",
    turn: worker.turn,
  },
  attempts: 0,
})

const withPendingWakes = (worker: PaneWorker, wakes: ReadonlyArray<PendingWake>): PaneWorker => {
  const { pendingWake: _legacy, ...rest } = worker
  return { ...rest, pendingWakes: [...wakes] }
}

const withoutActiveTurn = (worker: PaneWorker): PaneWorker => {
  const { activeTurn: _at, ...rest } = worker
  return { ...rest, activeTurnTyped: false }
}

const withOutbox = (worker: PaneWorker, outbox: ReadonlyArray<DurableIntent>): PaneWorker => ({
  ...worker,
  outbox: [...outbox],
})

const removeOutboxIntent = (worker: PaneWorker, intentId: string): PaneWorker =>
  withOutbox(
    worker,
    outboxOf(worker).filter((intent) => intent.intentId !== intentId),
  )

/** Appends a wake to the ordered FIFO outbox if not already delivered or queued (never replaces an earlier wake). */
export const enqueueWakeIfDue = (worker: PaneWorker, wake: PendingWake, terminal: boolean): PaneWorker => {
  const delivered = deliveredWakesOf(worker)
  if (delivered.includes(wake.key)) return worker
  if (terminal && worker.notifiedTurn >= wake.turn) return worker
  const existing = pendingWakesOf(worker)
  if (existing.some((item) => item.key === wake.key)) return worker
  return withPendingWakes(worker, [...existing, wake])
}

const settleDone = (
  state: MachineState,
  answer: string,
  fromFile: boolean,
  now: number,
  deliveryId: string,
): TransitionResult => {
  const hasQueued = pendingTurnsOf(state.worker).length > 0
  const turn = Option.match(activeTurnOf(state.worker), {
    onNone: () => state.worker.turn,
    onSome: (at) => at.turn,
  })
  const cleared = withoutActiveTurn(state.worker)
  let nextState: PaneWorker["state"] = "done"
  if (hasQueued) nextState = "starting"
  const base: PaneWorker = {
    ...cleared,
    state: nextState,
    update: updateLabel(fromFile),
    updatedAt: now,
    endedAt: now,
    lastAnswer: answer,
  }
  const wake = makeDoneWake(base, turn, answer, fromFile, deliveryId)
  const nextWorker = enqueueWakeIfDue(base, wake, true)
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(nextRetryableWake(nextWorker))) {
    actions.push(MachineAction.FlushWake())
  }
  if (!hasQueued) {
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

const settleAnswerNotCaptured = (
  state: MachineState,
  turn: number,
  reason: string,
  now: number,
  deliveryId: string,
): TransitionResult => {
  const hasQueued = pendingTurnsOf(state.worker).length > 0
  const cleared = withoutActiveTurn(state.worker)
  let nextState: PaneWorker["state"] = "done"
  if (hasQueued) nextState = "starting"
  const base: PaneWorker = {
    ...cleared,
    state: nextState,
    update: `turn ${turn} answer not captured`,
    updatedAt: now,
    endedAt: now,
  }
  const wake = makeAnswerNotCapturedWake(base, turn, reason, deliveryId)
  const nextWorker = enqueueWakeIfDue(base, wake, true)
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(nextRetryableWake(nextWorker))) {
    actions.push(MachineAction.FlushWake())
  }
  if (!hasQueued) {
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

const briefTokenOf = (brief: string): Option.Option<string> =>
  Option.fromNullishOr(/\bTK-[a-z0-9]+-\d+\b/.exec(brief)).pipe(
    Option.flatMap((m) => Option.fromUndefinedOr(m[0])),
  )

const screenBelongsToOtherTurn = (screen: string, active: ActiveTurn, adapter: HarnessAdapter): boolean => {
  const screenPrompt = adapter.readLastPrompt(screen)
  if (Option.isNone(screenPrompt)) return false
  const observed = Option.fromUndefinedOr(active.observedPrompt)
  if (Option.isSome(observed) && screenPrompt.value !== observed.value) return true
  const token = briefTokenOf(active.brief)
  if (Option.isSome(token) && !screenPrompt.value.includes(token.value)) return true
  return false
}

const withCapturedPrompt = (active: ActiveTurn, screen: string, adapter: HarnessAdapter): ActiveTurn => {
  if (Option.isSome(Option.fromUndefinedOr(active.observedPrompt))) return active
  const prompt = adapter.readLastPrompt(screen)
  if (Option.isNone(prompt)) return active
  return { ...active, observedPrompt: prompt.value }
}

const withoutObservedDone = (state: MachineState): MachineState => {
  const { observedDone: _od, ...rest } = state
  return rest
}

const observedDoneFor = (state: MachineState, turn: number): Option.Option<string> =>
  Option.fromUndefinedOr(state.observedDone).pipe(
    Option.filter((od) => od.turn === turn),
    Option.map((od) => od.answer),
  )

const enterNeedsInput = (
  state: MachineState,
  summary: string,
  tail: string,
  now: number,
  deliveryId: string,
): TransitionResult => {
  const key = `${state.worker.id}:${state.worker.turn}:needs_input`
  const alreadyHandled =
    deliveredWakesOf(state.worker).includes(key) ||
    pendingWakesOf(state.worker).some((item) => item.key === key)
  if (state.worker.state === "needs_input" && state.worker.update === summary && alreadyHandled) {
    return {
      state: { ...state, idlePendingConfirm: false, consecutiveGone: 0, consecutiveTransient: 0 },
      actions: [MachineAction.RetryTransient()],
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
  actions.push(MachineAction.RetryTransient())
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

const queuedUpdateLabel = (turn: number, mode: "submit" | "steer"): string => {
  if (mode === "steer") return "steered in Rex pane"
  if (turn > 1) return "queued follow-up running in Rex pane"
  return "running in Rex pane"
}

const submitNextQueued = (
  state: MachineState,
  nextTurn: QueuedTurn,
  rest: ReadonlyArray<QueuedTurn>,
  adapter: HarnessAdapter,
  now: number,
  durableOutbox: boolean,
  intentId: string,
  ownerProc: string,
): TransitionResult => {
  const chunks = chunksForTurn(adapter, nextTurn)
  const update = queuedUpdateLabel(nextTurn.turn, nextTurn.mode)
  const { endedAt: _cleared, ...base } = state.worker
  if (durableOutbox) {
    const activeTurn: ActiveTurn = {
      turn: nextTurn.turn,
      brief: nextTurn.brief,
      resultFile: nextTurn.resultFile,
      mode: nextTurn.mode,
      phase: "intended",
      writeAttempts: 1,
      writtenIdlePolls: 0,
      startedAt: now,
      chunkIndex: 0,
    }
    const intent = TypeTurnIntent.make({
      intentId,
      ownerProc,
      turn: nextTurn.turn,
      mode: nextTurn.mode,
      chunks: [...chunks],
      chunkIndex: 0,
      attempt: 1,
      createdAt: now,
    })
    const nextWorker: PaneWorker = {
      ...base,
      turn: nextTurn.turn,
      resultFile: nextTurn.resultFile,
      state: "starting",
      update,
      activeTurnTyped: false,
      activeTurn,
      outbox: [...outboxOf(base), intent],
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
      actions: [MachineAction.Persist()],
    }
  }
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

const enterUsageLimit = (
  state: MachineState,
  active: ActiveTurn,
  limit: UsageLimit,
  now: number,
  deliveryId: string,
  adapter: HarnessAdapter,
  durableOutbox: boolean,
  intentId: string,
  ownerProc: string,
): TransitionResult => {
  const existingReset = Option.getOrElse(Option.fromUndefinedOr(active.limitedResetAt), () => 0)
  let resetAt = existingReset
  if (active.sawLimitFrame !== true) {
    resetAt = Math.max(existingReset, limit.resetAt)
  }
  if (resetAt === 0) resetAt = limit.resetAt
  const alreadyPast = resetAt <= now && active.sawLimitFrame !== true
  const iso = formatIsoMillis(resetAt)

  // Already observed limit frame and now >= resetAt -> arm TypeResume once if not already attempted/resumed.
  if (active.sawLimitFrame === true && now >= resetAt && active.resumeAttempted !== true && active.resumed !== true) {
    const updatedActive: ActiveTurn = {
      ...active,
      limitedResetAt: resetAt,
      resumeAttempted: true,
    }
    const resumeChunks = adapter.formatSubmit("continue")
    const resumeIntent = TypeResumeIntent.make({
      intentId,
      ownerProc,
      turn: active.turn,
      resetAt,
      chunks: [...resumeChunks],
      attempt: 1,
      createdAt: now,
    })
    let nextOutbox = outboxOf(state.worker)
    if (durableOutbox) {
      nextOutbox = [...nextOutbox, resumeIntent]
    }
    const nextWorker: PaneWorker = {
      ...state.worker,
      state: "working",
      update: `resuming after usage limit (${iso})`,
      activeTurn: updatedActive,
      outbox: [...nextOutbox],
      updatedAt: now,
    }
    return {
      state: { ...state, worker: nextWorker, idlePendingConfirm: false, consecutiveGone: 0, consecutiveTransient: 0 },
      actions: [MachineAction.Persist()],
    }
  }

  // First time seeing limit frame (or waiting for resetAt)
  const updatedActive: ActiveTurn = {
    ...active,
    phase: "confirmed",
    limitedResetAt: resetAt,
    sawLimitFrame: true,
    resumeAttempted: active.resumeAttempted === true || alreadyPast,
  }
  const base: PaneWorker = {
    ...state.worker,
    state: "working",
    update: `limit until ${iso}`,
    activeTurn: updatedActive,
    updatedAt: now,
  }
  const wake = makeLimitedWake(base, active.turn, resetAt, deliveryId)
  const nextWorker = enqueueWakeIfDue(base, wake, false)
  const actions: Array<MachineAction> = []
  const changed =
    active.sawLimitFrame !== true ||
    existingReset !== resetAt ||
    pendingWakesOf(nextWorker).length !== pendingWakesOf(state.worker).length
  if (changed) {
    actions.push(MachineAction.Persist())
  }
  if (Option.isSome(nextRetryableWake(nextWorker))) {
    actions.push(MachineAction.FlushWake())
  }
  if (active.sawLimitFrame !== true) {
    actions.push(MachineAction.BroadcastLimit({ resetAt }))
  }
  if (updatedActive.resumeAttempted !== true && updatedActive.resumed !== true && resetAt > now) {
    actions.push(MachineAction.WaitLimitReset({ resetAt }))
  } else {
    actions.push(MachineAction.WaitQuiet())
  }
  return {
    state: {
      worker: nextWorker,
      sawWorking: true,
      idlePendingConfirm: false,
      consecutiveGone: 0,
      consecutiveTransient: 0,
    },
    actions,
  }
}

const recoveredStateFor = (worker: PaneWorker): PaneWorker["state"] => {
  if (activeTurnTypedOf(worker)) return "working"
  return "starting"
}

const tokenOfBrief = (brief: string): Option.Option<string> =>
  Option.fromNullishOr(/\bTK-[a-z0-9]+-\d+\b/.exec(brief)).pipe(Option.flatMap((m) => Option.fromUndefinedOr(m[0])))

const screenConfirmsWrittenTurn = (screen: string, active: ActiveTurn): boolean => {
  const token = tokenOfBrief(active.brief)
  if (Option.isSome(token) && screen.includes(token.value)) return true
  return false
}

const recoverFromUnreachable = (state: MachineState, now: number) => {
  let recoveredWorker = state.worker
  const persist: Array<MachineAction> = []
  if (state.worker.state === "rex_unreachable") {
    recoveredWorker = {
      ...state.worker,
      state: recoveredStateFor(state.worker),
      update: "running in Rex pane",
      updatedAt: now,
    }
    persist.push(MachineAction.Persist())
  }
  return {
    recovered: {
      ...state,
      worker: recoveredWorker,
      consecutiveGone: 0,
      consecutiveTransient: 0,
    },
    persist,
  }
}

const confirmActiveWorking = (
  recovered: MachineState,
  priorState: PaneWorker["state"],
  screen: string,
  now: number,
  adapter: HarnessAdapter,
): TransitionResult => {
  const curActive = Option.fromUndefinedOr(recovered.worker.activeTurn)
  const promptNewlyObserved =
    Option.isSome(curActive) &&
    Option.isNone(Option.fromUndefinedOr(curActive.value.observedPrompt)) &&
    Option.isSome(adapter.readLastPrompt(screen))
  const needsConfirmPersist =
    Option.exists(curActive, (at) => at.phase === "written") ||
    promptNewlyObserved ||
    recovered.worker.state === "needs_input" ||
    priorState === "rex_unreachable"
  const clearedState = withoutObservedDone(recovered)
  if (!needsConfirmPersist) {
    return {
      state: { ...clearedState, sawWorking: true, idlePendingConfirm: false },
      actions: [MachineAction.WaitQuiet()],
    }
  }
  const nextActive = Option.map(curActive, (at): ActiveTurn => ({
    ...withCapturedPrompt(at, screen, adapter),
    phase: "confirmed",
    writtenIdlePolls: 0,
  }))
  let nextUpdate = clearedState.worker.update
  if (clearedState.worker.state === "needs_input" || priorState === "rex_unreachable") {
    nextUpdate = "running in Rex pane"
  }
  const resumed: PaneWorker = {
    ...clearedState.worker,
    state: "working",
    update: nextUpdate,
    updatedAt: now,
    lastLines: shortLines(screen),
    ...Option.match(nextActive, {
      onNone: () => ({}),
      onSome: (activeTurn) => ({ activeTurn }),
    }),
  }
  return {
    state: { ...clearedState, worker: resumed, sawWorking: true, idlePendingConfirm: false },
    actions: [MachineAction.Persist(), MachineAction.WaitQuiet()],
  }
}

const observeTurnEnded = (
  recovered: MachineState,
  recoveredPersist: ReadonlyArray<MachineAction>,
  active: Option.Option<ActiveTurn>,
  screen: string,
  adapter: HarnessAdapter,
): TransitionResult => {
  if (!recovered.sawWorking && recovered.worker.state !== "working") {
    return { state: recovered, actions: [...recoveredPersist, MachineAction.WaitQuiet()] }
  }
  const confirmedDone =
    Option.isSome(active) &&
    (recovered.sawWorking || screenConfirmsWrittenTurn(screen, active.value))
  let nextState: MachineState = { ...recovered, idlePendingConfirm: true }
  if (confirmedDone) {
    nextState = {
      ...nextState,
      observedDone: { turn: active.value.turn, answer: adapter.readLastAnswer(screen) },
    }
  }
  return {
    state: nextState,
    actions: [...recoveredPersist, MachineAction.ConfirmIdle()],
  }
}

const handleObserveScreen = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "ObserveScreen" }>,
  adapter: HarnessAdapter,
): TransitionResult => {
  if (state.worker.state === "stopped") {
    return { state, actions: [MachineAction.StopWatching()] }
  }
  const durableOutbox = event.durableOutbox === true
  const intentId = Option.getOrElse(Option.fromUndefinedOr(event.intentId), () => "")
  const ownerProc = Option.getOrElse(Option.fromUndefinedOr(event.ownerProc), () => "")
  const { recovered, persist: recoveredPersist } = recoverFromUnreachable(state, event.now)

  // Single write gate: never type or settle while a human prompt is active.
  const needs = adapter.needsInput(event.screen)
  if (Option.isSome(needs)) {
    return enterNeedsInput(recovered, needs.value.summary, needs.value.tail, event.now, event.deliveryId)
  }

  // Check usage limit frame before idle/ready checks (SPEC v2 ruling 5).
  const active = activeTurnOf(recovered.worker)
  const limit = adapter.usageLimit(event.screen, event.now)
  if (Option.isSome(limit)) {
    if (Option.isSome(active) && (active.value.phase === "written" || active.value.phase === "confirmed")) {
      return enterUsageLimit(
        recovered,
        active.value,
        limit.value,
        event.now,
        event.deliveryId,
        adapter,
        durableOutbox,
        intentId,
        ownerProc,
      )
    }
    return {
      state: recovered,
      actions: [...recoveredPersist, MachineAction.WaitLimitReset({ resetAt: limit.value.resetAt })],
    }
  }

  // If a queued steer is at head of pendingTurns while a turn is STILL WORKING (not already ended), steer immediately!
  const queue = pendingTurnsOf(recovered.worker)
  const head = Arr.head(queue)
  const writeInFlight = Option.exists(active, (at) => at.phase === "intended" || at.phase === "ambiguous")
  const activeStillWorking = activeTurnTypedOf(recovered.worker) && !adapter.turnEnded(event.screen)
  if (durableOutbox && Option.isSome(head) && head.value.mode === "steer" && !writeInFlight && activeStillWorking) {
    return submitNextQueued(recovered, head.value, queue.slice(1), adapter, event.now, true, intentId, ownerProc)
  }

  // If no active turn is typed yet (startup or between queued turns), type head queued turn ONLY when readyForInput.
  if (!activeTurnTypedOf(recovered.worker)) {
    if (Option.isNone(head)) {
      return { state: recovered, actions: [...recoveredPersist, MachineAction.StopWatching()] }
    }
    if (!adapter.readyForInput(event.screen)) {
      return { state: recovered, actions: [...recoveredPersist, MachineAction.WaitQuiet()] }
    }
    return submitNextQueued(
      recovered,
      head.value,
      queue.slice(1),
      adapter,
      event.now,
      durableOutbox,
      intentId,
      ownerProc,
    )
  }

  // Active turn is typed (`written` or `confirmed`): check if another turn (e.g. human) overwrote our screen.
  if (Option.isSome(active) && screenBelongsToOtherTurn(event.screen, active.value, adapter)) {
    return {
      state: { ...recovered, idlePendingConfirm: true },
      actions: [...recoveredPersist, MachineAction.ConfirmIdle()],
    }
  }

  // Active turn is typed (`written` or `confirmed`): check if harness is still working or shows turnEnded.
  if (!adapter.turnEnded(event.screen)) {
    return confirmActiveWorking(recovered, state.worker.state, event.screen, event.now, adapter)
  }

  // turnEnded holds on pass 1: confirm across waitForQuiet before settling (B1).
  return observeTurnEnded(recovered, recoveredPersist, active, event.screen, adapter)
}

const confirmWorkingOnIdleCheck = (state: MachineState, screen: string, now: number, adapter: HarnessAdapter): TransitionResult => {
  const curActive = Option.fromUndefinedOr(state.worker.activeTurn)
  const promptNewlyObserved =
    Option.isSome(curActive) &&
    Option.isNone(Option.fromUndefinedOr(curActive.value.observedPrompt)) &&
    Option.isSome(adapter.readLastPrompt(screen))
  const nextActive = Option.map(curActive, (at): ActiveTurn => ({
    ...withCapturedPrompt(at, screen, adapter),
    phase: "confirmed",
    writtenIdlePolls: 0,
  }))
  const worker: PaneWorker = Option.match(nextActive, {
    onNone: () => state.worker,
    onSome: (activeTurn) => ({ ...state.worker, activeTurn, updatedAt: now }),
  })
  const actions: Array<MachineAction> = [MachineAction.WaitQuiet()]
  if (Option.exists(curActive, (a) => a.phase === "written") || promptNewlyObserved) {
    actions.unshift(MachineAction.Persist())
  }
  return {
    state: { ...withoutObservedDone(state), worker, sawWorking: true, idlePendingConfirm: false, consecutiveGone: 0, consecutiveTransient: 0 },
    actions,
  }
}

const resolveOverwrittenTurn = (
  state: MachineState,
  active: ActiveTurn,
  event: Extract<MachineEvent, { readonly _tag: "IdleConfirmed" }>,
  adapter: HarnessAdapter,
): TransitionResult => {
  if (Option.isSome(event.resultFileAnswer)) {
    return settleDone(state, event.resultFileAnswer.value, true, event.now, event.deliveryId)
  }
  const savedAnswer = observedDoneFor(state, active.turn)
  if (Option.isSome(savedAnswer)) {
    return settleDone(state, savedAnswer.value, false, event.now, event.deliveryId)
  }
  const prior = Option.fromUndefinedOr(event.priorScreen)
  if (
    Option.isSome(prior) &&
    adapter.turnEnded(prior.value) &&
    Option.isNone(adapter.needsInput(prior.value)) &&
    !screenBelongsToOtherTurn(prior.value, active, adapter)
  ) {
    return settleDone(state, adapter.readLastAnswer(prior.value), false, event.now, event.deliveryId)
  }
  return settleAnswerNotCaptured(
    state,
    active.turn,
    "pane was overwritten by another turn before a read observed its answer",
    event.now,
    event.deliveryId,
  )
}

const handleUnstartedWrittenTurn = (
  state: MachineState,
  current: ActiveTurn,
  now: number,
  deliveryId: string,
  config: MachineConfig,
): TransitionResult => {
  const polls = current.writtenIdlePolls + 1
  if (polls < config.maxWrittenIdlePolls || current.resumed === true) {
    const bumped: PaneWorker = {
      ...state.worker,
      activeTurn: { ...current, writtenIdlePolls: polls },
      updatedAt: now,
    }
    return {
      state: { ...state, worker: bumped, idlePendingConfirm: false, consecutiveGone: 0, consecutiveTransient: 0 },
      actions: [MachineAction.Persist(), MachineAction.WaitQuiet()],
    }
  }
  const nextPending = pendingTurnsOf(state.worker)
  let nextState: PaneWorker["state"] = "failed"
  if (nextPending.length > 0) nextState = "starting"
  const cleared = withoutActiveTurn(state.worker)
  const base: PaneWorker = {
    ...cleared,
    state: nextState,
    update: `turn ${current.turn} not started by harness after write`,
    updatedAt: now,
  }
  const wake = makeNotTypedWake(base, current.turn, "harness stayed idle without starting turn", deliveryId)
  const nextWorker = enqueueWakeIfDue(base, wake, true)
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(nextRetryableWake(nextWorker))) actions.push(MachineAction.FlushWake())
  if (nextPending.length > 0) actions.push(MachineAction.WaitQuiet())
  else actions.push(MachineAction.StopWatching())
  return {
    state: { ...state, worker: nextWorker, sawWorking: false, idlePendingConfirm: false },
    actions,
  }
}

const handleIdleConfirmed = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "IdleConfirmed" }>,
  adapter: HarnessAdapter,
  config: MachineConfig,
): TransitionResult => {
  if (state.worker.state === "stopped") {
    return { state, actions: [MachineAction.StopWatching()] }
  }
  const needs = adapter.needsInput(event.screen)
  if (Option.isSome(needs)) {
    return enterNeedsInput(state, needs.value.summary, needs.value.tail, event.now, event.deliveryId)
  }
  const limit = adapter.usageLimit(event.screen, event.now)
  const active = activeTurnOf(state.worker)
  if (Option.isSome(limit) && Option.isSome(active)) {
    return enterUsageLimit(state, active.value, limit.value, event.now, event.deliveryId, adapter, false, "", "")
  }
  if (activeTurnTypedOf(state.worker) && Option.isSome(active) && screenBelongsToOtherTurn(event.screen, active.value, adapter)) {
    return resolveOverwrittenTurn(state, active.value, event, adapter)
  }
  if (!adapter.turnEnded(event.screen)) {
    return confirmWorkingOnIdleCheck(state, event.screen, event.now, adapter)
  }
  if (!activeTurnTypedOf(state.worker)) {
    return {
      state: { ...state, idlePendingConfirm: false },
      actions: [MachineAction.WaitQuiet()],
    }
  }
  const echoedOnScreen = Option.exists(active, (at) => screenConfirmsWrittenTurn(event.screen, at))
  if (!state.sawWorking && Option.isNone(event.resultFileAnswer) && !echoedOnScreen) {
    const explicitActive = Option.fromUndefinedOr(state.worker.activeTurn)
    if (Option.isSome(explicitActive) && explicitActive.value.phase === "written") {
      return handleUnstartedWrittenTurn(state, explicitActive.value, event.now, event.deliveryId, config)
    }
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
  adapter: HarnessAdapter,
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
  const activeForScreen = activeTurnOf(state.worker)
  const savedDone = Option.flatMap(activeForScreen, (at) => observedDoneFor(state, at.turn))
  if (activeTurnTypedOf(state.worker) && Option.isSome(savedDone)) {
    return settleDone(state, savedDone.value, false, event.now, event.deliveryId)
  }
  const prevScreen = Option.fromUndefinedOr(event.lastScreen)
  const prevBelongsToOther = Option.exists(
    prevScreen,
    (scr) => Option.exists(activeForScreen, (at) => screenBelongsToOtherTurn(scr, at, adapter)),
  )
  if (
    activeTurnTypedOf(state.worker) &&
    state.sawWorking &&
    Option.isSome(prevScreen) &&
    !prevBelongsToOther &&
    adapter.turnEnded(prevScreen.value) &&
    Option.isNone(adapter.needsInput(prevScreen.value))
  ) {
    return settleDone(state, adapter.readLastAnswer(prevScreen.value), false, event.now, event.deliveryId)
  }
  const active = Option.fromUndefinedOr(state.worker.activeTurn)
  const untypedActive = Option.filter(active, (at) => at.phase === "intended" && at.resumed !== true)
  const heldWorker = Option.match(untypedActive, {
    onNone: () => withoutActiveTurn(state.worker),
    onSome: (at) => requeueActiveTurn(state.worker, at, event.now),
  })
  const cleanedOutbox = outboxOf(heldWorker).filter((i) => i._tag !== "TypeTurn" && i._tag !== "TypeResume")
  const base: PaneWorker = {
    ...withOutbox(heldWorker, cleanedOutbox),
    state: "pane_gone",
    update: "pane gone (use restart to resume with --continue)",
    updatedAt: event.now,
    endedAt: event.now,
    lastLines: event.tail,
  }
  let nextWorker = base
  const wake = makePaneGoneWake(nextWorker, "Rex pane closed or process exited.", event.tail, event.deliveryId)
  if (isLive(state.worker.state) || pendingTurnsOf(nextWorker).length > 0) {
    nextWorker = enqueueWakeIfDue(nextWorker, wake, false)
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
      state: { ...state, consecutiveTransient: nextTransient, consecutiveGone: 0, idlePendingConfirm: false },
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
  let mode: "submit" | "steer" = "submit"
  if (event.steer === true) mode = "steer"
  const queued: QueuedTurn = {
    turn: nextTurn,
    brief,
    resultFile: nextResultFile,
    mode,
    queuedAt: event.now,
  }
  const nextQueue = [...pendingTurnsOf(state.worker), queued]
  const wasSettled = state.worker.state === "done" || state.worker.state === "wake_undelivered"
  let nextState = state.worker.state
  let nextUpdate = state.worker.update
  if (wasSettled) {
    nextState = "starting"
    nextUpdate = "queued follow-up waiting to submit"
    if (mode === "steer") nextUpdate = "steered in Rex pane"
  }
  const { endedAt: _ea, ...base } = state.worker
  let kept: PaneWorker = state.worker
  if (wasSettled) kept = base
  const nextWorker: PaneWorker = {
    ...kept,
    state: nextState,
    update: nextUpdate,
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

const handleQueueRestart = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "QueueRestart" }>,
): TransitionResult => {
  const resumedTurn = state.worker.turn + 1
  const carried = carryPendingTurns(pendingTurnsOf(state.worker), resumedTurn)
  const intents: Array<DurableIntent> = []
  if (Option.isSome(event.closeIntentId) && state.worker.ownedBlock && state.worker.blockId.length > 0) {
    const closeIntent = ClosePaneIntent.make({
      intentId: event.closeIntentId.value,
      ownerProc: event.ownerProc,
      sessionId: state.worker.rexSessionId,
      blockId: state.worker.blockId,
      interruptFirst: false,
      closeBlock: true,
      createdAt: event.now,
    })
    intents.push(closeIntent)
  }
  const splitIntent = SplitPaneIntent.make({
    intentId: event.splitIntentId,
    reqId: event.reqId,
    ownerProc: event.ownerProc,
    sessionId: event.rexSessionId,
    anchorBlockId: event.anchorBlockId,
    label: event.label,
    command: [...event.command],
    cwd: event.cwd,
    forRestart: true,
    resumedTurn,
    resumedBrief: event.resumedBrief,
    resumedResultFile: event.resultFile,
    dispatched: false,
    attempt: 1,
    createdAt: event.now,
  })
  intents.push(splitIntent)
  const { endedAt: _ea, activeTurn: _at, ...keep } = state.worker
  const restarted: PaneWorker = {
    ...keep,
    cwd: event.cwd,
    addDirs: [...event.addDirs],
    skipPermissions: state.worker.skipPermissions !== false,
    rexSessionId: event.rexSessionId,
    blockId: "",
    ownedBlock: true,
    resultFile: event.resultFile,
    state: "starting",
    update: "restarting in Rex pane (--continue)",
    turn: resumedTurn,
    notifiedTurn: Math.max(state.worker.notifiedTurn, state.worker.turn),
    activeTurnTyped: false,
    outbox: intents,
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

const handleMarkSplitDispatched = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "MarkSplitDispatched" }>,
): TransitionResult => {
  const nextOutbox = outboxOf(state.worker).map((intent): DurableIntent => {
    if (intent._tag === "SplitPane" && intent.intentId === event.intentId) {
      return { ...intent, dispatched: true, ownerProc: event.ownerProc }
    }
    return intent
  })
  return {
    state: { ...state, worker: { ...withOutbox(state.worker, nextOutbox), updatedAt: event.now } },
    actions: [MachineAction.Persist()],
  }
}

const handleSplitSucceeded = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "SplitSucceeded" }>,
): TransitionResult => {
  const split = Arr.findFirst(
    outboxOf(state.worker),
    (intent): intent is SplitPaneIntent => intent._tag === "SplitPane" && intent.intentId === event.intentId,
  )
  if (Option.isNone(split)) return { state, actions: [] }
  const cleaned = removeOutboxIntent(state.worker, event.intentId)
  if (split.value.forRestart) {
    const turn = Option.getOrElse(Option.fromUndefinedOr(split.value.resumedTurn), () => state.worker.turn)
    const brief = Option.getOrElse(Option.fromUndefinedOr(split.value.resumedBrief), () => "")
    const resultFile = Option.getOrElse(
      Option.fromUndefinedOr(split.value.resumedResultFile),
      () => state.worker.resultFile,
    )
    const activeTurn: ActiveTurn = {
      turn,
      brief,
      resultFile,
      mode: "submit",
      phase: "written",
      writeAttempts: 1,
      writtenIdlePolls: 0,
      startedAt: event.now,
    }
    const nextWorker: PaneWorker = {
      ...cleaned,
      blockId: event.blockId,
      ownedBlock: true,
      state: "working",
      update: "restarted in Rex pane (--continue)",
      activeTurnTyped: true,
      activeTurn,
      startedAt: event.now,
      updatedAt: event.now,
    }
    return {
      state: {
        worker: nextWorker,
        sawWorking: false,
        idlePendingConfirm: false,
        consecutiveGone: 0,
        consecutiveTransient: 0,
      },
      actions: [MachineAction.Persist()],
    }
  }
  const nextWorker: PaneWorker = {
    ...cleaned,
    blockId: event.blockId,
    ownedBlock: true,
    state: "starting",
    update: `starting ${state.worker.harness} in Rex pane`,
    updatedAt: event.now,
  }
  return {
    state: { ...state, worker: nextWorker, consecutiveGone: 0, consecutiveTransient: 0 },
    actions: [MachineAction.Persist()],
  }
}

const handleSplitFailed = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "SplitFailed" }>,
): TransitionResult => {
  const split = Arr.findFirst(
    outboxOf(state.worker),
    (intent): intent is SplitPaneIntent => intent._tag === "SplitPane" && intent.intentId === event.intentId,
  )
  if (Option.isNone(split)) return { state, actions: [] }

  if (event.retryable && !event.unknownOutcome && split.value.attempt < 3) {
    const nextOutbox = outboxOf(state.worker).map((intent): DurableIntent => {
      if (intent._tag === "SplitPane" && intent.intentId === event.intentId) {
        return { ...intent, dispatched: false, attempt: intent.attempt + 1 }
      }
      return intent
    })
    return {
      state: { ...state, worker: { ...withOutbox(state.worker, nextOutbox), updatedAt: event.now } },
      actions: [MachineAction.Persist(), MachineAction.RetryTransient()],
    }
  }

  let updateMsg = `split failed: ${event.reason}`
  if (event.unknownOutcome) {
    updateMsg = `split result unknown: ${event.reason}`
  }
  const cleaned = removeOutboxIntent(withoutActiveTurn(state.worker), event.intentId)
  let nextWorker: PaneWorker = {
    ...cleaned,
    state: "failed",
    update: updateMsg,
    pendingTurns: [],
    updatedAt: event.now,
    endedAt: event.now,
  }

  // Report untyped turns via not_typed wakes (never for an unknown restart split whose -i may have started).
  const untypedTurns: Array<number> = []
  if (split.value.forRestart && !event.unknownOutcome) {
    const resumedTurn = Option.getOrElse(Option.fromUndefinedOr(split.value.resumedTurn), () => state.worker.turn)
    untypedTurns.push(resumedTurn)
  }
  for (const queued of pendingTurnsOf(state.worker)) {
    untypedTurns.push(queued.turn)
  }
  for (let i = 0; i < untypedTurns.length; i++) {
    const turnNum = Arr.get(untypedTurns, i)
    if (Option.isNone(turnNum)) continue
    const deliv = Option.getOrElse(Arr.get(event.extraDeliveryIds, i), () => `${event.deliveryId}_nt_${turnNum.value}`)
    const ntWake = makeNotTypedWake(nextWorker, turnNum.value, updateMsg, deliv)
    nextWorker = enqueueWakeIfDue(nextWorker, ntWake, false)
  }

  const failWake = makeFailedWake(nextWorker, updateMsg, event.deliveryId)
  nextWorker = enqueueWakeIfDue(nextWorker, failWake, false)

  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(nextRetryableWake(nextWorker))) actions.push(MachineAction.FlushWake())
  actions.push(MachineAction.StopWatching())
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

const handleTypeTurnSucceeded = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "TypeTurnSucceeded" }>,
): TransitionResult => {
  const cleaned = removeOutboxIntent(state.worker, event.intentId)
  const active = Option.fromUndefinedOr(cleaned.activeTurn)
  if (Option.isNone(active) || active.value.turn !== event.turn) {
    return {
      state: { ...state, worker: cleaned },
      actions: [MachineAction.Persist()],
    }
  }
  const nextActive: ActiveTurn = {
    ...active.value,
    phase: "written",
    writtenIdlePolls: 0,
    startedAt: event.now,
  }
  const nextWorker: PaneWorker = {
    ...cleaned,
    state: "working",
    update: queuedUpdateLabel(active.value.turn, active.value.mode),
    activeTurnTyped: true,
    activeTurn: nextActive,
    startedAt: event.now,
    updatedAt: event.now,
  }
  return {
    state: {
      worker: nextWorker,
      sawWorking: false,
      idlePendingConfirm: false,
      consecutiveGone: 0,
      consecutiveTransient: 0,
    },
    actions: [MachineAction.Persist()],
  }
}

const handleTypeTurnDeferredPrompt = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "TypeTurnDeferredPrompt" }>,
): TransitionResult => {
  const cleaned = removeOutboxIntent(state.worker, event.intentId)
  const active = Option.fromUndefinedOr(cleaned.activeTurn)
  let nextPending = pendingTurnsOf(cleaned)
  if (Option.isSome(active) && active.value.phase === "intended") {
    const putBack: QueuedTurn = {
      turn: active.value.turn,
      brief: active.value.brief,
      resultFile: active.value.resultFile,
      mode: active.value.mode,
      queuedAt: active.value.startedAt,
    }
    nextPending = [putBack, ...nextPending]
  }
  const restored: PaneWorker = {
    ...withoutActiveTurn(cleaned),
    pendingTurns: [...nextPending],
  }
  return enterNeedsInput({ ...state, worker: restored }, event.summary, event.tail, event.now, event.deliveryId)
}

const requeueActiveTurn = (worker: PaneWorker, active: ActiveTurn, now: number): PaneWorker => {
  let nextPending = pendingTurnsOf(worker)
  if (!nextPending.some((q) => q.turn === active.turn)) {
    const putBack: QueuedTurn = {
      turn: active.turn,
      brief: active.brief,
      resultFile: active.resultFile,
      mode: active.mode,
      queuedAt: active.startedAt,
    }
    nextPending = [putBack, ...nextPending]
  }
  return {
    ...withoutActiveTurn(worker),
    pendingTurns: [...nextPending],
    updatedAt: now,
  }
}

const failActiveTurnNotTyped = (
  state: MachineState,
  cleaned: PaneWorker,
  active: ActiveTurn,
  update: string,
  reason: string,
  now: number,
  deliveryId: string,
  stopOnQueued: boolean,
): TransitionResult => {
  const nextPending = pendingTurnsOf(cleaned)
  let nextState: PaneWorker["state"] = "failed"
  if (nextPending.length > 0) nextState = "starting"
  let base: PaneWorker = {
    ...withoutActiveTurn(cleaned),
    state: nextState,
    update,
    updatedAt: now,
  }
  if (stopOnQueued) {
    base = { ...base, endedAt: now }
  }
  const ntWake = makeNotTypedWake(base, active.turn, reason, deliveryId)
  const nextWorker = enqueueWakeIfDue(base, ntWake, true)
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(nextRetryableWake(nextWorker))) actions.push(MachineAction.FlushWake())
  if (!stopOnQueued && nextPending.length > 0) actions.push(MachineAction.RetryTransient())
  else actions.push(MachineAction.StopWatching())
  return { state: { ...state, worker: nextWorker, sawWorking: false }, actions }
}

const handleTypeTurnFailed = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "TypeTurnFailed" }>,
  adapter: HarnessAdapter,
  config: MachineConfig,
): TransitionResult => {
  const cleaned = removeOutboxIntent(state.worker, event.intentId)
  const active = Option.fromUndefinedOr(cleaned.activeTurn)
  if (Option.isNone(active) || active.value.turn !== event.turn) {
    return { state: { ...state, worker: cleaned }, actions: [MachineAction.Persist()] }
  }

  if (event.kind === "gone") {
    const restored = requeueActiveTurn(cleaned, active.value, event.now)
    const probed = handleProbeGone(
      { ...state, worker: restored },
      MachineEvent.ProbeGone({ tail: "", resultFileAnswer: Option.none(), now: event.now, deliveryId: event.deliveryId }),
      adapter,
      config,
    )
    const actions: Array<MachineAction> = [...probed.actions]
    if (!actions.some((a) => a._tag === "Persist")) actions.unshift(MachineAction.Persist())
    return { state: probed.state, actions }
  }

  if (event.kind === "unsupported") {
    return failActiveTurnNotTyped(state, cleaned, active.value, event.reason, event.reason, event.now, event.deliveryId, true)
  }

  if (event.kind === "not_sent") {
    const nextAttempts = active.value.writeAttempts + 1
    if (nextAttempts > config.maxWriteAttempts) {
      return failActiveTurnNotTyped(
        state,
        cleaned,
        active.value,
        `turn ${active.value.turn} not typed: ${event.reason}`,
        event.reason,
        event.now,
        event.deliveryId,
        false,
      )
    }
    const nextActive: ActiveTurn = {
      ...active.value,
      phase: "ambiguous",
      chunkIndex: 0,
      lastWriteError: event.reason,
    }
    return {
      state: { ...state, worker: { ...cleaned, activeTurn: nextActive, updatedAt: event.now } },
      actions: [MachineAction.Persist(), MachineAction.RetryTransient()],
    }
  }

  // Ambiguous (transient / timeout / late / defect / partial chunk write)
  const nextActive: ActiveTurn = {
    ...active.value,
    phase: "ambiguous",
    chunkIndex: event.chunkIndex,
    lastWriteError: event.reason,
  }
  const nextWorker: PaneWorker = {
    ...cleaned,
    activeTurn: nextActive,
    updatedAt: event.now,
  }
  return {
    state: { ...state, worker: nextWorker },
    actions: [MachineAction.Persist()],
  }
}

const handleAmbiguousResolved = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "AmbiguousResolved" }>,
  adapter: HarnessAdapter,
  config: MachineConfig,
): TransitionResult => {
  const active = Option.fromUndefinedOr(state.worker.activeTurn)
  if (Option.isNone(active) || active.value.turn !== event.turn) {
    return { state, actions: [] }
  }

  if (event.outcome === "working") {
    const confirmed: ActiveTurn = {
      ...active.value,
      phase: "confirmed",
      writtenIdlePolls: 0,
    }
    const nextWorker: PaneWorker = {
      ...state.worker,
      state: "working",
      update: queuedUpdateLabel(active.value.turn, active.value.mode),
      activeTurnTyped: true,
      activeTurn: confirmed,
      updatedAt: event.now,
    }
    return {
      state: {
        worker: nextWorker,
        sawWorking: true,
        idlePendingConfirm: false,
        consecutiveGone: 0,
        consecutiveTransient: 0,
      },
      actions: [MachineAction.Persist()],
    }
  }

  const nextAttempts = active.value.writeAttempts + 1
  if (event.outcome === "retry" && nextAttempts <= config.maxWriteAttempts) {
    const chunks = chunksForTurn(adapter, {
      turn: active.value.turn,
      brief: active.value.brief,
      resultFile: active.value.resultFile,
      mode: active.value.mode,
      queuedAt: active.value.startedAt,
    })
    const intent = TypeTurnIntent.make({
      intentId: event.intentId,
      ownerProc: event.ownerProc,
      turn: active.value.turn,
      mode: active.value.mode,
      chunks: [...chunks],
      chunkIndex: 0,
      attempt: nextAttempts,
      createdAt: event.now,
    })
    const retried: ActiveTurn = {
      ...active.value,
      phase: "intended",
      writeAttempts: nextAttempts,
      chunkIndex: 0,
    }
    const nextWorker: PaneWorker = {
      ...state.worker,
      state: "starting",
      activeTurnTyped: false,
      activeTurn: retried,
      outbox: [...outboxOf(state.worker), intent],
      updatedAt: event.now,
    }
    return {
      state: { ...state, worker: nextWorker },
      actions: [MachineAction.Persist()],
    }
  }

  // Terminal not_typed (never emit not_typed if a limited turn was already resumed — ruling 8)
  const nextPending = pendingTurnsOf(state.worker)
  let nextState: PaneWorker["state"] = "failed"
  if (nextPending.length > 0) nextState = "starting"
  const base: PaneWorker = {
    ...withoutActiveTurn(state.worker),
    state: nextState,
    update: `turn ${active.value.turn} not typed: ${event.reason}`,
    updatedAt: event.now,
  }
  let nextWorker = base
  if (active.value.resumed !== true) {
    const ntWake = makeNotTypedWake(base, active.value.turn, event.reason, event.deliveryId)
    nextWorker = enqueueWakeIfDue(base, ntWake, true)
  }
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(nextRetryableWake(nextWorker))) actions.push(MachineAction.FlushWake())
  if (nextPending.length > 0) actions.push(MachineAction.WaitQuiet())
  else actions.push(MachineAction.StopWatching())
  return {
    state: { ...state, worker: nextWorker, sawWorking: false, idlePendingConfirm: false },
    actions,
  }
}

const handleTypeResumeSucceeded = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "TypeResumeSucceeded" }>,
): TransitionResult => {
  const cleaned = removeOutboxIntent(state.worker, event.intentId)
  const active = Option.fromUndefinedOr(cleaned.activeTurn)
  if (Option.isNone(active) || active.value.turn !== event.turn) {
    return { state: { ...state, worker: cleaned }, actions: [MachineAction.Persist()] }
  }
  const { limitedResetAt: _lr, ...restActive } = active.value
  const resumed: ActiveTurn = {
    ...restActive,
    phase: "written",
    sawLimitFrame: false,
    resumeAttempted: true,
    resumed: true,
    writtenIdlePolls: 0,
  }
  const nextWorker: PaneWorker = {
    ...cleaned,
    state: "working",
    update: "resumed after usage limit",
    activeTurnTyped: true,
    activeTurn: resumed,
    updatedAt: event.now,
  }
  return {
    state: {
      worker: nextWorker,
      sawWorking: false,
      idlePendingConfirm: false,
      consecutiveGone: 0,
      consecutiveTransient: 0,
    },
    actions: [MachineAction.Persist()],
  }
}

const handleTypeResumeDeferredPrompt = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "TypeResumeDeferredPrompt" }>,
): TransitionResult => {
  const cleaned = removeOutboxIntent(state.worker, event.intentId)
  const active = Option.fromUndefinedOr(cleaned.activeTurn)
  const updated: PaneWorker = Option.match(active, {
    onNone: () => cleaned,
    onSome: (at) => ({ ...cleaned, activeTurn: { ...at, resumeAttempted: false } }),
  })
  return enterNeedsInput({ ...state, worker: updated }, event.summary, event.tail, event.now, event.deliveryId)
}

const handleTypeResumeFailed = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "TypeResumeFailed" }>,
): TransitionResult => {
  const cleaned = removeOutboxIntent(state.worker, event.intentId)
  const active = Option.fromUndefinedOr(cleaned.activeTurn)
  if (Option.isNone(active) || active.value.turn !== event.turn) {
    return { state: { ...state, worker: cleaned }, actions: [MachineAction.Persist()] }
  }

  if (event.kind === "retry") {
    const reset: ActiveTurn = { ...active.value, resumeAttempted: false }
    return {
      state: { ...state, worker: { ...cleaned, activeTurn: reset, updatedAt: event.now } },
      actions: [MachineAction.Persist(), MachineAction.RetryTransient()],
    }
  }

  if (event.kind === "ambiguous") {
    const amb: ActiveTurn = { ...active.value, phase: "ambiguous", lastWriteError: event.reason }
    return {
      state: { ...state, worker: { ...cleaned, activeTurn: amb, updatedAt: event.now } },
      actions: [MachineAction.Persist()],
    }
  }

  // Terminal not_typed for failed resume (only when !resumed, per ruling 8)
  const nextPending = pendingTurnsOf(cleaned)
  let nextState: PaneWorker["state"] = "failed"
  if (nextPending.length > 0) nextState = "starting"
  const base: PaneWorker = {
    ...withoutActiveTurn(cleaned),
    state: nextState,
    update: `resume after limit failed: ${event.reason}`,
    updatedAt: event.now,
  }
  let nextWorker = base
  if (active.value.resumed !== true) {
    const ntWake = makeNotTypedWake(base, active.value.turn, `failed to resume after usage limit (${event.reason})`, event.deliveryId)
    nextWorker = enqueueWakeIfDue(base, ntWake, true)
  }
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(nextRetryableWake(nextWorker))) actions.push(MachineAction.FlushWake())
  if (nextPending.length > 0) actions.push(MachineAction.WaitQuiet())
  else actions.push(MachineAction.StopWatching())
  return { state: { ...state, worker: nextWorker, sawWorking: false }, actions }
}

const handleSignInLimited = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "SignInLimited" }>,
): TransitionResult => {
  const active = Option.fromUndefinedOr(state.worker.activeTurn)
  if (Option.isNone(active)) return { state, actions: [] }
  if (active.value.phase !== "written" && active.value.phase !== "confirmed") return { state, actions: [] }
  if (active.value.resumed === true) return { state, actions: [] }
  const prevReset = Option.getOrElse(Option.fromUndefinedOr(active.value.limitedResetAt), () => 0)
  const resetAt = Math.max(prevReset, event.resetAt)
  const iso = formatIsoMillis(resetAt)
  const updatedActive: ActiveTurn = {
    ...active.value,
    limitedResetAt: resetAt,
  }
  const base: PaneWorker = {
    ...state.worker,
    state: "working",
    update: `limit until ${iso}`,
    activeTurn: updatedActive,
    updatedAt: event.now,
  }
  const wake = makeLimitedWake(base, active.value.turn, resetAt, event.deliveryId)
  const nextWorker = enqueueWakeIfDue(base, wake, false)
  const actions: Array<MachineAction> = [MachineAction.Persist()]
  if (Option.isSome(nextRetryableWake(nextWorker))) actions.push(MachineAction.FlushWake())
  return { state: { ...state, worker: nextWorker }, actions }
}

const handleCloseCompleted = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "CloseCompleted" }>,
): TransitionResult => {
  const cleaned = removeOutboxIntent(state.worker, event.intentId)
  return {
    state: { ...state, worker: { ...cleaned, updatedAt: event.now } },
    actions: [MachineAction.Persist()],
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
    matched.value.kind === "done" ||
    matched.value.kind === "not_typed" ||
    matched.value.kind === "answer_not_captured" ||
    matched.value.kind === "pane_gone" ||
    matched.value.kind === "failed"
  let nextNotifiedTurn = state.worker.notifiedTurn
  if (isTurnTerminal) {
    nextNotifiedTurn = Math.max(state.worker.notifiedTurn, matched.value.turn)
  }
  let nextState = state.worker.state
  let nextUpdate = state.worker.update
  if (state.worker.state === "wake_undelivered" && !remaining.some((item) => item.undelivered === true)) {
    if (matched.value.kind === "pane_gone") {
      nextState = "pane_gone"
      nextUpdate = "pane gone (use restart to resume with --continue)"
    } else if (matched.value.kind === "failed" || matched.value.kind === "not_typed") {
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
    deliveredWakes: [...nextDelivered],
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
  const noActiveOrQueuedWork =
    !isLive(state.worker.state) && pendingTurnsOf(state.worker).length === 0 && outboxOf(state.worker).length === 0

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

const settlePendingIdleOnStop = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "Stop" }>,
  adapter: HarnessAdapter,
): PaneWorker => {
  const screenOpt = Option.fromUndefinedOr(event.lastScreen)
  const deliveryOpt = Option.fromUndefinedOr(event.deliveryId)
  if (!state.idlePendingConfirm || !state.sawWorking || !activeTurnTypedOf(state.worker)) return state.worker
  if (Option.isNone(screenOpt) || Option.isNone(deliveryOpt)) return state.worker
  if (!adapter.turnEnded(screenOpt.value)) return state.worker
  if (Option.exists(activeTurnOf(state.worker), (at) => screenBelongsToOtherTurn(screenOpt.value, at, adapter))) {
    return state.worker
  }
  const turn = Option.match(activeTurnOf(state.worker), {
    onNone: () => state.worker.turn,
    onSome: (at) => at.turn,
  })
  let answer = adapter.readLastAnswer(screenOpt.value)
  if (answer.length === 0) answer = shortLines(screenOpt.value)
  const wake = makeDoneWake(state.worker, turn, answer, false, deliveryOpt.value)
  return enqueueWakeIfDue(state.worker, wake, true)
}

const reportHeldTurnsOnStop = (
  worker: PaneWorker,
  event: Extract<MachineEvent, { readonly _tag: "Stop" }>,
): PaneWorker => {
  if (worker.state !== "pane_gone") return worker
  const held = pendingTurnsOf(worker)
  if (held.length === 0) return worker
  const extras = Option.getOrElse(Option.fromUndefinedOr(event.extraDeliveryIds), () => [])
  const fallbackBase = Option.getOrElse(Option.fromUndefinedOr(event.deliveryId), () => `stop_${event.now}`)
  let next = worker
  for (let i = 0; i < held.length; i++) {
    const turn = Arr.get(held, i)
    if (Option.isNone(turn)) continue
    const delId = Option.getOrElse(Arr.get(extras, i), () => `${fallbackBase}_held_${turn.value.turn}`)
    const wake = makeNotTypedWake(next, turn.value.turn, "stopped while the pane was gone", delId)
    next = enqueueWakeIfDue(next, wake, false)
  }
  return next
}

const handleStop = (
  state: MachineState,
  event: Extract<MachineEvent, { readonly _tag: "Stop" }>,
  adapter: HarnessAdapter,
): TransitionResult => {
  const withSettled = reportHeldTurnsOnStop(settlePendingIdleOnStop(state, event, adapter), event)
  const shouldClose = event.close && withSettled.ownedBlock
  const hasBlock = withSettled.blockId.length > 0
  const intents: Array<DurableIntent> = []
  if (event.durableOutbox === true && hasBlock) {
    const closeIntent = ClosePaneIntent.make({
      intentId: Option.getOrElse(Option.fromUndefinedOr(event.closeIntentId), () => "close"),
      ownerProc: Option.getOrElse(Option.fromUndefinedOr(event.ownerProc), () => ""),
      sessionId: withSettled.rexSessionId,
      blockId: withSettled.blockId,
      interruptFirst: true,
      closeBlock: shouldClose,
      createdAt: event.now,
    })
    intents.push(closeIntent)
  }
  const preservedWakes = pendingWakesOf(withSettled).filter(
    (w) =>
      w.kind === "done" ||
      w.kind === "not_typed" ||
      w.kind === "answer_not_captured" ||
      w.kind === "limited",
  )
  const stopped: PaneWorker = {
    ...withPendingWakes(withoutActiveTurn(withSettled), preservedWakes),
    state: "stopped",
    update: "stopped",
    pendingTurns: [],
    outbox: intents,
    updatedAt: event.now,
    endedAt: event.now,
    notifiedTurn: maxTurnOf(withSettled),
  }
  const stopActions: Array<MachineAction> = [MachineAction.Persist(), MachineAction.StopWatching()]
  if (Option.isSome(nextRetryableWake(stopped))) {
    stopActions.push(MachineAction.FlushWake())
  }
  if (event.durableOutbox === true) {
    return {
      state: {
        worker: stopped,
        sawWorking: false,
        idlePendingConfirm: false,
        consecutiveGone: 0,
        consecutiveTransient: 0,
      },
      actions: stopActions,
    }
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
      MachineAction.InterruptPane({ close: shouldClose }),
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
    Match.tagsExhaustive({
      ObserveScreen: (ev) => handleObserveScreen(state, ev, adapter),
      IdleConfirmed: (ev) => handleIdleConfirmed(state, ev, adapter, config),
      ProbeGone: (ev) => handleProbeGone(state, ev, adapter, config),
      TransientError: (ev) => handleTransientError(state, ev, config),
      QueueFollowUp: (ev) => handleQueueFollowUp(state, ev),
      RequestSteer: (ev) => handleRequestSteer(state, ev, adapter),
      RestartPane: (ev) => handleRestartPane(state, ev),
      QueueRestart: (ev) => handleQueueRestart(state, ev),
      MarkSplitDispatched: (ev) => handleMarkSplitDispatched(state, ev),
      SplitSucceeded: (ev) => handleSplitSucceeded(state, ev),
      SplitFailed: (ev) => handleSplitFailed(state, ev),
      TypeTurnSucceeded: (ev) => handleTypeTurnSucceeded(state, ev),
      TypeTurnDeferredPrompt: (ev) => handleTypeTurnDeferredPrompt(state, ev),
      TypeTurnFailed: (ev) => handleTypeTurnFailed(state, ev, adapter, config),
      AmbiguousResolved: (ev) => handleAmbiguousResolved(state, ev, adapter, config),
      TypeResumeSucceeded: (ev) => handleTypeResumeSucceeded(state, ev),
      TypeResumeDeferredPrompt: (ev) => handleTypeResumeDeferredPrompt(state, ev),
      TypeResumeFailed: (ev) => handleTypeResumeFailed(state, ev),
      SignInLimited: (ev) => handleSignInLimited(state, ev),
      CloseCompleted: (ev) => handleCloseCompleted(state, ev),
      WakeDelivered: (ev) => handleWakeDelivered(state, ev),
      WakeFailed: (ev) => handleWakeFailed(state, ev, config),
      RestartWakeRetries: (ev) => handleRestartWakeRetries(state, ev),
      Stop: (ev) => handleStop(state, ev, adapter),
    }),
  )
