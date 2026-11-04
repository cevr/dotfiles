// The provider's quota over its auth plugin's quota RPC (quota.ts's
// `quotaProtocol`). The answers are untyped JSON: each reading is checked
// field by field, and a failure or a malformed answer is no reading.
import { Effect, Layer, Schedule, Stream } from "effect"
import type { PoolId } from "../account-pool.ts"
import { asReading } from "../quota.ts"
import { Quota, type PublishedReading } from "../service.ts"

/** The quota RPC of one pool's integration, as the plugin's RPC client calls it. */
export interface QuotaRpc {
  readonly reading: (input: { readonly credentialID: string }) => Effect.Effect<unknown, unknown>
  readonly usage: (input: { readonly credentialID: string }) => Effect.Effect<unknown, unknown>
  /** The payloads of its `reading` events. */
  readonly published: Stream.Stream<unknown, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** The reading an answer carries, if it carries one. */
const readingOf = (answer: unknown) => (isRecord(answer) ? asReading(answer.reading) : undefined)

/** How long a broken subscription waits before it subscribes again. */
const RESUBSCRIBE = "1 second"

const publishedOf = (data: unknown): ReadonlyArray<PublishedReading> => {
  if (!isRecord(data) || typeof data.credentialID !== "string") return []
  const reading = asReading(data.reading)
  return reading === undefined ? [] : [{ credentialID: data.credentialID, reading }]
}

export const layer = (rpc: (pool: PoolId) => QuotaRpc) =>
  Layer.succeed(Quota, {
    reading: Effect.fn("Quota.reading")(
      function* (pool: PoolId, credentialID: string) {
        return readingOf(yield* rpc(pool).reading({ credentialID }))
      },
      Effect.catchCause(() => Effect.succeed(undefined)),
    ),
    usage: Effect.fn("Quota.usage")(
      function* (pool: PoolId, credentialID: string) {
        return readingOf(yield* rpc(pool).usage({ credentialID }))
      },
      Effect.catchCause(() => Effect.succeed(undefined)),
    ),
    // A malformed reading is dropped; a broken subscription subscribes again.
    readings: (pool: PoolId) =>
      rpc(pool).published.pipe(
        Stream.flatMap((data) => Stream.fromIterable(publishedOf(data))),
        Stream.retry(Schedule.spaced(RESUBSCRIBE)),
        Stream.catchCause(() => Stream.empty),
      ),
  })
