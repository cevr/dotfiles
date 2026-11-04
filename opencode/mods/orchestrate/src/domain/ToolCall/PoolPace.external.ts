import { Context, type Effect } from "effect"
import type { Pace } from "../Pace.ts"

/**
 * The account pool's pace for one new agent on a provider. No answer (no
 * pool, a timeout, a failure) is undefined, and the agent starts: it fails open.
 */
export class PoolPace extends Context.Service<
  PoolPace,
  { readonly pace: (providerID: string) => Effect.Effect<Pace | undefined> }
>()("dotfiles-opencode/orchestrate/PoolPace") {}
