import { Context, type Duration, type Effect, Option, Schema } from "effect"
import type { PaneAnchor, PaneWorker, StoreSnapshot } from "./worker.ts"

/** Formats a clear single-sentence error naming both revisions when Rex updates past our SDK revision. */
export const formatUnsupportedRevision = (requiredRevision: number, serverRevision: Option.Option<number>): string =>
  Option.match(serverRevision, {
    onNone: () =>
      `Rex server API revision is incompatible with pane-agent (pane-agent requires API revision ${requiredRevision}; server revision was not reported). Update rex-sdk to match the running Rex server.`,
    onSome: (server) =>
      `Rex server API revision mismatch: pane-agent requires API revision ${requiredRevision}, but the running Rex server speaks API revision ${server}. Update rex-sdk to match the running Rex server.`,
  })

export class RexUnsupportedRevision extends Schema.TaggedError<RexUnsupportedRevision>()("RexUnsupportedRevision", {
  requiredRevision: Schema.Int,
  serverRevision: Schema.OptionFromOptionalKey(Schema.Int),
  message: Schema.String,
}) {}

export class RexUnavailable extends Schema.TaggedError<RexUnavailable>()("RexUnavailable", {
  message: Schema.String,
}) {}

export class RexPaneGone extends Schema.TaggedError<RexPaneGone>()("RexPaneGone", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class RexCallFailed extends Schema.TaggedError<RexCallFailed>()("RexCallFailed", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export type RexError = RexUnsupportedRevision | RexUnavailable | RexPaneGone | RexCallFailed

/** Three-way pane liveness answer: transient failures return "unknown", never "gone". */
export type PaneLiveness = "alive" | "gone" | "unknown"

export class StoreFailed extends Schema.TaggedError<StoreFailed>()("StoreFailed", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class ResultReadFailed extends Schema.TaggedError<ResultReadFailed>()("ResultReadFailed", {
  path: Schema.String,
  message: Schema.String,
}) {}

export class WakeFailed extends Schema.TaggedError<WakeFailed>()("WakeFailed", {
  sessionID: Schema.String,
  deliveryId: Schema.String,
  message: Schema.String,
}) {}

export class WorkerRejected extends Schema.TaggedError<WorkerRejected>()("WorkerRejected", {
  reason: Schema.String,
}) {}

export interface SplitRightInput {
  readonly sessionId: string
  readonly anchorBlockId: string
  readonly label: string
  readonly command: ReadonlyArray<string>
  readonly cwd: string
}

export interface PaneTarget {
  readonly sessionId: string
  readonly blockId: string
}

export interface QuietOptions {
  readonly quietFor: Duration.Input
  readonly timeout: Duration.Input
}

export interface OutputMatchOptions {
  readonly pattern: RegExp
  readonly timeout: Duration.Input
}

/** Narrow contract over Rex operations owned by `rex/client.ts`. */
export class RexClient extends Context.Service<
  RexClient,
  {
    readonly splitRight: (input: SplitRightInput) => Effect.Effect<string, RexError>
    readonly write: (target: PaneTarget, data: string) => Effect.Effect<void, RexError>
    readonly read: (target: PaneTarget) => Effect.Effect<string, RexError>
    readonly readTail: (target: PaneTarget, maxBytes?: number) => Effect.Effect<string, RexError>
    readonly waitForQuiet: (target: PaneTarget, options: QuietOptions) => Effect.Effect<void, RexError>
    readonly waitForOutput: (target: PaneTarget, options: OutputMatchOptions) => Effect.Effect<boolean, RexError>
    readonly alive: (target: PaneTarget) => Effect.Effect<PaneLiveness, RexUnsupportedRevision>
    readonly close: (target: PaneTarget) => Effect.Effect<void, RexError>
  }
>()("dotfiles-opencode/pane-agent/RexClient") {}

/** Persistent store of pane workers and session Rex anchors. */
export class WorkerStore extends Context.Service<
  WorkerStore,
  {
    readonly read: () => Effect.Effect<StoreSnapshot, StoreFailed>
    readonly write: (snapshot: StoreSnapshot) => Effect.Effect<void, StoreFailed>
    readonly upsertWorker: (worker: PaneWorker) => Effect.Effect<StoreSnapshot, StoreFailed>
    readonly saveAnchor: (sessionID: string, anchor: PaneAnchor) => Effect.Effect<StoreSnapshot, StoreFailed>
  }
>()("dotfiles-opencode/pane-agent/WorkerStore") {}

/** Deterministic result-file reader. */
export class ResultFiles extends Context.Service<
  ResultFiles,
  {
    /** Returns the trimmed text once the file exists, is non-empty, modified at/after minMtimeMs, and stable. */
    readonly readComplete: (path: string, minMtimeMs: number) => Effect.Effect<Option.Option<string>, ResultReadFailed>
  }
>()("dotfiles-opencode/pane-agent/ResultFiles") {}

/** Steered notification letter sent back to the orchestrator session. */
export interface WakeLetter {
  readonly id: string
  readonly description: string
  readonly text: string
  readonly metadata: Readonly<Record<string, string | number | boolean>>
}

/** Delivers completion / needs-input notices and change events to OpenCode. */
export class Notifier extends Context.Service<
  Notifier,
  {
    readonly wake: (sessionID: string, letter: WakeLetter) => Effect.Effect<void, WakeFailed>
    readonly changed: (sessionID: string) => Effect.Effect<void>
    readonly sessionDirectory: (sessionID: string) => Effect.Effect<Option.Option<string>>
  }
>()("dotfiles-opencode/pane-agent/Notifier") {}
