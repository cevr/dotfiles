// The pool's pace held in memory: OpenCode's pool pace (opencode/pool-pace.ts)
// over a pool that answers from a record by provider.
import { Effect } from "effect"
import * as OpenCodePoolPace from "../opencode/pool-pace.ts"
import type { Pace } from "../pace.ts"

/** The pool's answer per provider; a provider it has none for is unpaced. */
export const layer = (answers: Readonly<Record<string, Pace>>) =>
  OpenCodePoolPace.layer(({ providerID }) => Effect.succeed(Object.hasOwn(answers, providerID) ? answers[providerID] : undefined))
