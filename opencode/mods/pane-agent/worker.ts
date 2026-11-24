import { Match, Option, Schema } from "effect"
import { Harness } from "./adapter.ts"

/** Worker lifecycle states persisted across server restarts. */
export const WORKER_STATES = [
  "starting",
  "working",
  "needs_input",
  "rex_unreachable",
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

/** Durable wake outbox record persisted before sending so crashes/failures retry with the same id. */
export const PendingWake = Schema.Struct({
  deliveryId: Schema.String,
  turn: Schema.Int,
  kind: Schema.Literals(["done", "needs_input", "pane_gone", "rex_unreachable", "failed"]),
  key: Schema.String,
  description: Schema.String,
  text: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
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
  activeTurnTyped: Schema.optionalKey(Schema.Boolean),
  pendingTurns: Schema.optionalKey(Schema.Array(QueuedTurn)),
  pendingWake: Schema.optionalKey(PendingWake),
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
