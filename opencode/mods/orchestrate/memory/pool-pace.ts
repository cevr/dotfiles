// The pool's pace held in memory: OpenCode's pool pace (opencode/pool-pace.ts)
// over a pool that answers from a record by provider, and keeps the providers
// it is told of in `started`, in order.
import { Effect } from "effect"
import * as OpenCodePoolPace from "../opencode/pool-pace.ts"
import type { Pace } from "../pace.ts"

/** What the pool answers for a provider it does not hold (the pool mod's `UNPOOLED`). */
export const UNPOOLED: Pace = { ok: true, measured: false, reason: "provider is not pooled" }

/** The pool's answer per provider; a provider it has none for is unpooled, as the pool answers. */
export const layer = (answers: Readonly<Record<string, Pace>>, started: Array<string> = []) =>
  OpenCodePoolPace.layer(
    ({ providerID }) => Effect.succeed(Object.hasOwn(answers, providerID) ? answers[providerID] : UNPOOLED),
    ({ providerID }) => Effect.sync(() => started.push(providerID)),
  )
