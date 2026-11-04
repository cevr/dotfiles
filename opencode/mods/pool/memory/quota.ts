// The provider's quota held in memory: each pool's readings by login, as the
// auth plugin holds them now (both `reading` and `usage` answer them), and the
// readings it publishes, per pool. The plugin's seam tests run on it.
import { Effect, Layer, Queue, Stream } from "effect"
import type { PoolId } from "../account-pool.ts"
import type { QuotaReading } from "../quota.ts"
import { Quota, type PublishedReading } from "../service.ts"

export const layer = (
  readings: ReadonlyMap<PoolId, ReadonlyMap<string, QuotaReading>>,
  published: ReadonlyMap<PoolId, Queue.Dequeue<PublishedReading>> = new Map(),
) => {
  const read = (pool: PoolId, credentialID: string) => Effect.sync(() => readings.get(pool)?.get(credentialID))
  return Layer.succeed(Quota, {
    reading: read,
    usage: read,
    readings: (pool: PoolId) => {
      const queue = published.get(pool)
      return queue === undefined ? Stream.empty : Stream.fromQueue(queue)
    },
  })
}
