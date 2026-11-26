import { Match, Option, Schema } from "effect"
import { Harness } from "./adapter.ts"

/** Worker lifecycle states persisted across server restarts. */
export const WORKER_STATES = [
  "starting",
  "working",
  "needs_input",
  "rex_unreachable",
  "wake_undelivered",
  "pane_gone",
  "done",
  "failed",
  "stopped",
] as const
export const WorkerState = Schema.Literals(WORKER_STATES)
export type WorkerState = typeof WorkerState.Type

/** Rex pane anchor recorded for an OpenCode session. */
export const PaneAnchor = Schema.Struct({
  session: Schema.String,
  block: Schema.String,
})
export type PaneAnchor = typeof PaneAnchor.Type

/** Queued turn waiting for the pane to be ready and idle before being typed. */
export const QueuedTurn = Schema.Struct({
  turn: Schema.Int,
  brief: Schema.String,
  resultFile: Schema.String,
  mode: Schema.Literals(["submit", "steer"]),
  queuedAt: Schema.Number,
})
export type QueuedTurn = typeof QueuedTurn.Type

/** Explicit lifecycle phase for an active typed turn (`intended -> written -> confirmed`, plus `ambiguous`). */
export const TurnPhase = Schema.Literals(["intended", "ambiguous", "written", "confirmed"])
export type TurnPhase = typeof TurnPhase.Type

/** Active turn record persisted atomically with durable outbox intents. */
export const ActiveTurn = Schema.Struct({
  turn: Schema.Int,
  brief: Schema.String,
  resultFile: Schema.String,
  mode: Schema.Literals(["submit", "steer"]),
  phase: TurnPhase,
  writeAttempts: Schema.Int,
  writtenIdlePolls: Schema.Int,
  startedAt: Schema.Number,
  chunkIndex: Schema.optionalKey(Schema.Int),
  lastWriteError: Schema.optionalKey(Schema.String),
  limitedResetAt: Schema.optionalKey(Schema.Number),
  sawLimitFrame: Schema.optionalKey(Schema.Boolean),
  resumeAttempted: Schema.optionalKey(Schema.Boolean),
  resumed: Schema.optionalKey(Schema.Boolean),
  observedPrompt: Schema.optionalKey(Schema.String),
})
export type ActiveTurn = typeof ActiveTurn.Type

/** Durable intent to open a right-split Rex pane (initial start or `--continue` restart). */
export const SplitPaneIntent = Schema.TaggedStruct("SplitPane", {
  intentId: Schema.String,
  reqId: Schema.String,
  ownerProc: Schema.String,
  sessionId: Schema.String,
  anchorBlockId: Schema.String,
  label: Schema.String,
  command: Schema.Array(Schema.String),
  cwd: Schema.String,
  forRestart: Schema.Boolean,
  resumedTurn: Schema.optionalKey(Schema.Int),
  resumedBrief: Schema.optionalKey(Schema.String),
  resumedResultFile: Schema.optionalKey(Schema.String),
  dispatched: Schema.Boolean,
  attempt: Schema.Int,
  createdAt: Schema.Number,
})
export type SplitPaneIntent = typeof SplitPaneIntent.Type

/** Durable intent to write a turn's chunks into the pane. */
export const TypeTurnIntent = Schema.TaggedStruct("TypeTurn", {
  intentId: Schema.String,
  ownerProc: Schema.String,
  turn: Schema.Int,
  mode: Schema.Literals(["submit", "steer"]),
  chunks: Schema.Array(Schema.String),
  chunkIndex: Schema.Int,
  attempt: Schema.Int,
  createdAt: Schema.Number,
})
export type TypeTurnIntent = typeof TypeTurnIntent.Type

/** Durable intent to resume a usage-limited turn with `"continue"` at or after `resetAt`. */
export const TypeResumeIntent = Schema.TaggedStruct("TypeResume", {
  intentId: Schema.String,
  ownerProc: Schema.String,
  turn: Schema.Int,
  resetAt: Schema.Number,
  chunks: Schema.Array(Schema.String),
  attempt: Schema.Int,
  createdAt: Schema.Number,
})
export type TypeResumeIntent = typeof TypeResumeIntent.Type

/** Durable intent to interrupt and optionally close an owned Rex pane. */
export const ClosePaneIntent = Schema.TaggedStruct("ClosePane", {
  intentId: Schema.String,
  ownerProc: Schema.String,
  sessionId: Schema.String,
  blockId: Schema.String,
  interruptFirst: Schema.Boolean,
  closeBlock: Schema.Boolean,
  createdAt: Schema.Number,
})
export type ClosePaneIntent = typeof ClosePaneIntent.Type

export const DurableIntent = Schema.Union([SplitPaneIntent, TypeTurnIntent, TypeResumeIntent, ClosePaneIntent])
export type DurableIntent = typeof DurableIntent.Type

/** Durable wake outbox record persisted before sending so crashes/failures retry with the same id. */
export const PendingWake = Schema.Struct({
  deliveryId: Schema.String,
  turn: Schema.Int,
  kind: Schema.Literals([
    "done",
    "not_typed",
    "answer_not_captured",
    "limited",
    "needs_input",
    "pane_gone",
    "rex_unreachable",
    "failed",
  ]),
  key: Schema.String,
  description: Schema.String,
  text: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  attempts: Schema.optionalKey(Schema.Int),
  undelivered: Schema.optionalKey(Schema.Boolean),
  lastError: Schema.optionalKey(Schema.String),
})
export type PendingWake = typeof PendingWake.Type

/** Persisted record for a pane worker, sufficient to re-attach or restart after pane loss. */
export const PaneWorker = Schema.Struct({
  id: Schema.String,
  parentSessionID: Schema.String,
  directory: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  addDirs: Schema.optionalKey(Schema.Array(Schema.String)),
  skipPermissions: Schema.optionalKey(Schema.Boolean),
  harness: Harness,
  role: Schema.String,
  unit: Schema.String,
  rexSessionId: Schema.String,
  blockId: Schema.String,
  ownedBlock: Schema.Boolean,
  resultFile: Schema.String,
  state: WorkerState,
  update: Schema.String,
  turn: Schema.Int,
  notifiedTurn: Schema.Int,
  revision: Schema.optionalKey(Schema.Int),
  activeTurnTyped: Schema.optionalKey(Schema.Boolean),
  activeTurn: Schema.optionalKey(ActiveTurn),
  outbox: Schema.optionalKey(Schema.Array(DurableIntent)),
  pendingTurns: Schema.optionalKey(Schema.Array(QueuedTurn)),
  pendingWake: Schema.optionalKey(PendingWake),
  pendingWakes: Schema.optionalKey(Schema.Array(PendingWake)),
  deliveredWakes: Schema.optionalKey(Schema.Array(Schema.String)),
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
  endedAt: Schema.optionalKey(Schema.Number),
  lastLines: Schema.optionalKey(Schema.String),
  lastAnswer: Schema.optionalKey(Schema.String),
})
export type PaneWorker = typeof PaneWorker.Type

export const STORE_VERSION = 2

/** Snapshot persisted in the store. */
export const StoreSnapshot = Schema.Struct({
  version: Schema.optionalKey(Schema.Int),
  workers: Schema.Array(PaneWorker),
  anchors: Schema.Record(Schema.String, PaneAnchor),
})
export type StoreSnapshot = typeof StoreSnapshot.Type

export const EMPTY_SNAPSHOT: StoreSnapshot = { version: STORE_VERSION, workers: [], anchors: {} }

export const revisionOf = (worker: PaneWorker): number =>
  Option.getOrElse(Option.fromUndefinedOr(worker.revision), () => 0)

export const outboxOf = (worker: PaneWorker): ReadonlyArray<DurableIntent> =>
  Option.getOrElse(Option.fromUndefinedOr(worker.outbox), () => [])

export const pendingWakesOf = (worker: PaneWorker): ReadonlyArray<PendingWake> => {
  const list = Option.getOrElse(Option.fromUndefinedOr(worker.pendingWakes), () => [])
  const legacy = Option.fromUndefinedOr(worker.pendingWake)
  if (Option.isNone(legacy)) return list
  if (list.some((item) => item.deliveryId === legacy.value.deliveryId || item.key === legacy.value.key)) {
    return list
  }
  return [legacy.value, ...list]
}

/** Public view returned over the PANE_AGENT RPC for Prime rows and Queue live state. */
export const PaneWorkerView = Schema.Struct({
  id: Schema.String,
  parentSessionID: Schema.String,
  harness: Harness,
  role: Schema.String,
  unit: Schema.String,
  blockId: Schema.String,
  rexSessionId: Schema.String,
  resultFile: Schema.String,
  state: WorkerState,
  update: Schema.String,
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
  endedAt: Schema.optionalKey(Schema.Number),
  lastLines: Schema.optionalKey(Schema.String),
})
export type PaneWorkerView = typeof PaneWorkerView.Type

export const viewOf = (worker: PaneWorker): PaneWorkerView => {
  const base = {
    id: worker.id,
    parentSessionID: worker.parentSessionID,
    harness: worker.harness,
    role: worker.role,
    unit: worker.unit,
    blockId: worker.blockId,
    rexSessionId: worker.rexSessionId,
    resultFile: worker.resultFile,
    state: worker.state,
    update: worker.update,
    startedAt: worker.startedAt,
    updatedAt: worker.updatedAt,
  }
  const withEnded = Option.match(Option.fromUndefinedOr(worker.endedAt), {
    onNone: () => base,
    onSome: (endedAt) => ({ ...base, endedAt }),
  })
  return Option.match(Option.fromUndefinedOr(worker.lastLines), {
    onNone: () => withEnded,
    onSome: (lastLines) => ({ ...withEnded, lastLines }),
  })
}

export const isLive = (state: WorkerState): boolean =>
  state === "starting" || state === "working" || state === "needs_input" || state === "rex_unreachable"

/** Subagent-row shape projected from a pane worker (matches `@dotfiles/opencode-subagents/subagent-row`). */
export interface ProjectedRow {
  readonly id: string
  readonly depth: number
  readonly role: string
  readonly tone: "planner" | "implementor" | "verifier" | "worker" | "general" | "other"
  readonly model: { readonly name: string }
  readonly unit: string
  readonly state: "working" | "waiting" | "blocked" | "latched" | "done" | "failed" | "cancelled" | "idle" | "unknown"
  readonly update: string
  readonly since?: number
  readonly heard?: number
  readonly ended?: number
}

const KNOWN_TONES = new Set<ProjectedRow["tone"]>(["planner", "implementor", "verifier", "worker", "general"])

const toneOf = (role: string): ProjectedRow["tone"] => {
  if (role === "planner" || role === "implementor" || role === "verifier" || role === "worker" || role === "general") {
    if (KNOWN_TONES.has(role)) return role
  }
  return "other"
}

const rowStateOf = (state: WorkerState): ProjectedRow["state"] =>
  Match.value(state).pipe(
    Match.when("starting", () => "working" as const),
    Match.when("working", () => "working" as const),
    Match.when("needs_input", () => "blocked" as const),
    Match.when("rex_unreachable", () => "blocked" as const),
    Match.when("wake_undelivered", () => "blocked" as const),
    Match.when("pane_gone", () => "blocked" as const),
    Match.when("done", () => "done" as const),
    Match.when("failed", () => "failed" as const),
    Match.when("stopped", () => "cancelled" as const),
    Match.exhaustive,
  )

/** Maps a pane worker view into a subagent row with the harness name in the model column. */
export const rowOf = (worker: PaneWorkerView): ProjectedRow => {
  const mapped = rowStateOf(worker.state)
  const base: ProjectedRow = {
    id: worker.id,
    depth: 0,
    role: worker.role,
    tone: toneOf(worker.role),
    model: { name: worker.harness },
    unit: worker.unit,
    state: mapped,
    update: worker.update,
  }
  if (isLive(worker.state)) {
    return { ...base, since: worker.startedAt, heard: worker.updatedAt }
  }
  return Option.match(Option.fromUndefinedOr(worker.endedAt), {
    onNone: () => ({ ...base, ended: worker.updatedAt }),
    onSome: (ended) => ({ ...base, ended }),
  })
}

export interface ParsedDescription {
  readonly role: string
  readonly unit: string
}

/** Parse `<role> <unit>` from a start description; defaults role to `"worker"`. */
export const parseDescription = (description: string): ParsedDescription => {
  const trimmed = description.trim()
  const matched = Option.fromNullishOr(/^(planner|implementor|verifier|worker|general)\s+(.+)$/i.exec(trimmed))
  return Option.match(matched, {
    onSome: (match): ParsedDescription => ({
      role: Option.getOrElse(Option.fromUndefinedOr(match[1]), () => "worker").toLowerCase(),
      unit: Option.getOrElse(Option.fromUndefinedOr(match[2]), () => trimmed).trim(),
    }),
    onNone: (): ParsedDescription => {
      if (trimmed.length > 0) return { role: "worker", unit: trimmed }
      return { role: "worker", unit: "pane-agent" }
    },
  })
}

export const RowsRequest = Schema.Struct({ sessionID: Schema.String })
export const RowsReply = Schema.Struct({ workers: Schema.Array(PaneWorkerView) })
export type RowsReply = typeof RowsReply.Type

export const BindPaneRequest = Schema.Struct({
  sessionID: Schema.String,
  rexSession: Schema.String,
  rexBlock: Schema.String,
})
export type BindPaneRequest = typeof BindPaneRequest.Type

const textField = { type: "string" } as const

/** RPC contract served by `cmd/pane-agent/server.ts`. */
export const PANE_AGENT = {
  id: "dotfiles-opencode.pane-agent",
  methods: {
    rows: {
      input: { type: "object", properties: { sessionID: textField }, required: ["sessionID"] },
      output: { type: "object" },
    },
    bindPane: {
      input: {
        type: "object",
        properties: { sessionID: textField, rexSession: textField, rexBlock: textField },
        required: ["sessionID", "rexSession", "rexBlock"],
      },
      output: { type: "object" },
    },
  },
  events: {
    changed: { schema: { type: "object", properties: { sessionID: textField }, required: ["sessionID"] } },
  },
} as const

/** Event type emitted over OpenCode's RPC event stream whenever pane worker state changes. */
export const CHANGED = `rpc.${PANE_AGENT.id}.changed`
