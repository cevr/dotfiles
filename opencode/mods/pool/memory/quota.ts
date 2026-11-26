// The provider's quota held in memory: each pool's readings by login, as the
// auth plugin holds them now (both `reading` and `usage` answer them; `usage`
// of a login with none answers it unread), the readings it publishes, per
// pool, and what a claim answers (the test's `claim`, which may change the
// readings as a provider's reset would). The plugin's seam tests run on it.
import { Effect, Layer, Option, Queue, Result, Stream } from "effect"
import type { PoolId } from "../account-pool.ts"
import { type ClaimAnswer, type QuotaReading, unread, type UsageRead } from "../quota.ts"
import { Quota, type PublishedReading } from "../service.ts"

/** A claim as the memory quota is asked it. */
export type MemoryClaim = (pool: PoolId, input: { readonly credentialID: string; readonly creditID: string; readonly requestID: string }) => ClaimAnswer

export const layer = (
  readings: ReadonlyMap<PoolId, ReadonlyMap<string, QuotaReading>>,
  published: ReadonlyMap<PoolId, Queue.Dequeue<PublishedReading>> = new Map(),
  claim: MemoryClaim = () => ({ outcome: "failed", message: "no claim in memory" }),
  usage?: Quota["Service"]["usage"],
) => {
  const read = (pool: PoolId, credentialID: string) => Effect.sync(() =>
    Option.getOrUndefined(Option.map(Option.fromUndefinedOr(readings.get(pool)), (known) => known.get(credentialID))),
  )
  return Layer.succeed(Quota, {
    reading: read,
    usage: Option.getOrElse(Option.fromUndefinedOr(usage), () => (pool: PoolId, credentialID: string) =>
      Effect.map(read(pool, credentialID), (reading) =>
        Option.match(Option.fromUndefinedOr(reading), { onNone: () => unread("unknown"), onSome: (known): UsageRead => Result.succeed(known) }))),
    readings: (pool: PoolId) => {
      const queue = published.get(pool)
      return queue === undefined ? Stream.empty : Stream.fromQueue(queue)
    },
    claim: (pool, input) => Effect.sync(() => claim(pool, input)),
  })
}
