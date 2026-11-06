// The contracts the orchestrate model needs from outside, each with what its
// implementations owe (laws.ts). Implementations live in the folders named
// after their dependency: filestore/, opencode/, codex/ and memory/.
import { Context, type Effect, Schema } from "effect"
import type { CallLine } from "./call-line.ts"
import type { Windows } from "./compaction.ts"
import type { ModelRef, PaceReply } from "./pace.ts"
import type { Hold } from "./tool-call.ts"

/** Where the call log's lines go, in order. Appending never fails: a lost line costs the pane a row, not the call. */
export class CallLog extends Context.Service<
  CallLog,
  { readonly append: (line: CallLine) => Effect.Effect<void> }
>()("dotfiles-opencode/orchestrate/CallLog") {}

/** What the host knows about a session. A session it cannot read answers undefined. */
export class Sessions extends Context.Service<
  Sessions,
  {
    /** The session's parent: set for a subagent's session. */
    readonly parentOf: (sessionID: string) => Effect.Effect<string | undefined>
    /** The agent the session runs as. */
    readonly agentOf: (sessionID: string) => Effect.Effect<string | undefined>
    /** Whether the session has run a turn, or is running one. A session it cannot read has not. */
    readonly startedOf: (sessionID: string) => Effect.Effect<boolean>
    /** When the session, a latched child that will still open, opens (epoch ms); none once it opened, was cancelled or failed. */
    readonly latchOf: (sessionID: string) => Effect.Effect<number | undefined>
  }
>()("dotfiles-opencode/orchestrate/Sessions") {}

/** A model the host offers: the variants it runs at, its family (such as `gpt-sol`), release (epoch ms) and status. */
export interface Offered extends ModelRef {
  readonly variants: ReadonlyArray<{ readonly id: string }>
  readonly family?: string
  readonly time?: { readonly released: number }
  readonly status?: string
}

/** The models a new subagent of a session could run on. Anything the host cannot answer is undefined. */
export class Models extends Context.Service<
  Models,
  {
    /**
     * The model an agent started from the session runs on, in the subagent
     * tool's order: the agent's own, else the session's, else the default.
     */
    readonly base: (sessionID: string, agentID: string) => Effect.Effect<ModelRef | undefined>
    /** That model at `variant` (`provider/id#variant`), when the model offers it. */
    readonly variant: (sessionID: string, agentID: string, variant: string) => Effect.Effect<string | undefined>
    /**
     * The newest model of `family` (such as `gpt-sol`) on one of `providers`
     * the session's host offers, as `provider/id#variant`, or `provider/id`
     * when it does not offer `variant`. Newest is the latest release; a
     * deprecated model is never one.
     */
    readonly newest: (sessionID: string, providers: ReadonlyArray<string>, family: string, variant: string) => Effect.Effect<string | undefined>
  }
>()("dotfiles-opencode/orchestrate/Models") {}

/**
 * The account pool's pace for one new agent on a provider. No answer (no
 * pool, a timeout, a failure, an answer that is not a pace) is `FailedOpen`
 * with the cause, and the agent starts: it fails open.
 */
export class PoolPace extends Context.Service<
  PoolPace,
  {
    readonly pace: (providerID: string) => Effect.Effect<PaceReply>
    /** A new agent started on the provider: the pool counts it until its spend shows. Telling never fails. */
    readonly started: (providerID: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/orchestrate/PoolPace") {}

/**
 * The Codex account's pace for one new agent: the orchestrate skill's
 * admission script, asked with the model id and the role (`none` for a
 * non-role agent). Only the script's own answer holds; anything else is
 * `FailedOpen` with the cause, and fails open.
 */
export class CodexAdmission extends Context.Service<
  CodexAdmission,
  { readonly admit: (model: string, role: string) => Effect.Effect<PaceReply> }
>()("dotfiles-opencode/orchestrate/CodexAdmission") {}

/**
 * The compaction window each agent kind runs at, as the orchestrate tuner's
 * compact.json says now. The tuner rewrites it about once a day; no file, or
 * a broken one, gives the defaults. Reading is synchronous at heart: the
 * host's agent transform runs it inside a synchronous callback.
 */
export class CompactionWindows extends Context.Service<
  CompactionWindows,
  { readonly read: Effect.Effect<Windows> }
>()("dotfiles-opencode/orchestrate/CompactionWindows") {}

/** A held subagent start, as the latch keeps it: the call as it was routed, what holds it, and when it is decided again. */
export interface LatchRequest {
  /** The parent: the session that made the call, whom the subagent's answer wakes. */
  readonly parent: string
  readonly from: string
  readonly messageID: string
  readonly callID: string
  readonly agent: string
  readonly description: string
  readonly prompt: string
  /** `provider/id#variant`: the model the child is made on and opened on. */
  readonly model?: string
  readonly hold: Hold
  readonly why: string
  /** Epoch ms on the system's clock, as the wakes keep time, even under a fixed `now`. */
  readonly opensAt: number
  /** Epoch ms on the system's clock, like `opensAt`. */
  readonly recheckAt: number
  /** Kept with the latch and handed back when it opens. */
  readonly context: { readonly [key: string]: Schema.Json }
}

/** A latched start, opening: the parent's call, and the child to prompt in the background. */
export interface LatchStart {
  readonly parent: string
  readonly from: string
  readonly messageID: string
  readonly callID: string
  readonly child: string
  readonly agent: string
  readonly description: string
  readonly prompt: string
  readonly model?: string
}

/** The latch could not be kept: no wakes to keep it, or they would not. */
export class LatchRefused extends Schema.TaggedError<LatchRefused>()("LatchRefused", { reason: Schema.String }) {}

/** The latched child could not be started. */
export class StartFailed extends Schema.TaggedError<StartFailed>()("StartFailed", { message: Schema.String }) {}

/**
 * Where a held start latches, and how a latched one starts.
 * - `latch`: keep the request as a latch of its parent, with its child
 *   session made and not prompted: the latch's id and child. The keeper
 *   decides it again at `recheckAt` through the orchestrate model's `openLatch`.
 * - `start`: prompt the latched child in the background with the request's
 *   prompt, as the subagent tool starts a background subagent; its answer
 *   wakes the parent.
 */
export class Latches extends Context.Service<
  Latches,
  {
    readonly latch: (request: LatchRequest) => Effect.Effect<{ readonly id: string; readonly child: string }, LatchRefused>
    readonly start: (start: LatchStart) => Effect.Effect<void, StartFailed>
  }
>()("dotfiles-opencode/orchestrate/Latches") {}
