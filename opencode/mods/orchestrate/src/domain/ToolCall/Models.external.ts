import { Context, type Effect } from "effect"
import type { ModelRef } from "../Pace.ts"

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
