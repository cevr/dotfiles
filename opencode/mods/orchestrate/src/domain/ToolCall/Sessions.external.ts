import { Context, type Effect } from "effect"

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
