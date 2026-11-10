// The provider's quota held in memory: each pool's readings by login, as the
// auth plugin holds them now (both `reading` and `usage` answer them), the
// readings it publishes, per pool, and what a claim answers (the test's
// `claim`, which may change the readings as a provider's reset would). The
// plugin's seam tests run on it.
import { Effect, Layer, Queue, Stream } from "effect"
import type { PoolId } from "../account-pool.ts"
import type { ClaimAnswer, QuotaReading } from "../quota.ts"
import { Quota, type PublishedReading } from "../service.ts"

/** A claim as the memory quota is asked it. */
export type MemoryClaim = (pool: PoolId, input: { readonly credentialID: string; readonly creditID: string; readonly requestID: string }) => ClaimAnswer

export const layer = (
  readings: ReadonlyMap<PoolId, ReadonlyMap<string, QuotaReading>>,
  published: ReadonlyMap<PoolId, Queue.Dequeue<PublishedReading>> = new Map(),
  claim: MemoryClaim = () => ({ outcome: "failed", message: "no claim in memory" }),
) => {
  const read = (pool: PoolId, credentialID: string) => Effect.sync(() => readings.get(pool)?.get(credentialID))
  return Layer.succeed(Quota, {
    reading: read,
    usage: read,
    readings: (pool: PoolId) => {
      const queue = published.get(pool)
      return queue === undefined ? Stream.empty : Stream.fromQueue(queue)
    },
    claim: (pool, input) => Effect.sync(() => claim(pool, input)),
  })
}
