// The contracts the orchestrate model needs from outside, each with what its
// implementations owe (laws.ts). Implementations live in the folders named
// after their dependency: filestore/, opencode/, codex/ and memory/.
import { Context, type Effect } from "effect"
import type { CallLine } from "./call-line.ts"
import type { Windows } from "./compaction.ts"
import type { ModelRef, Pace } from "./pace.ts"

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
  }
>()("dotfiles-opencode/orchestrate/Sessions") {}

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
  }
>()("dotfiles-opencode/orchestrate/Models") {}

/**
 * The account pool's pace for one new agent on a provider. No answer (no
 * pool, a timeout, a failure) is undefined, and the agent starts: it fails open.
 */
export class PoolPace extends Context.Service<
  PoolPace,
  { readonly pace: (providerID: string) => Effect.Effect<Pace | undefined> }
>()("dotfiles-opencode/orchestrate/PoolPace") {}

/**
 * The Codex account's pace for one new agent: the orchestrate skill's
 * admission script, asked with the model id and the role (`none` for a
 * non-role agent). Only the script's own answer holds; anything else is
 * undefined and fails open.
 */
export class CodexAdmission extends Context.Service<
  CodexAdmission,
  { readonly admit: (model: string, role: string) => Effect.Effect<Pace | undefined> }
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
