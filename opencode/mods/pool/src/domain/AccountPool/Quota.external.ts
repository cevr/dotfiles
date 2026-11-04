import { Context, type Effect, type Stream } from "effect"
import type { PoolId } from "./AccountPool.id.ts"
import type { QuotaReading } from "../Quota.ts"

/**
 * The provider's quota, from its auth plugin. A failure, a timeout or a
 * malformed answer is no reading: the pool goes on without it.
 */
export class Quota extends Context.Service<
  Quota,
  {
    /** The newest reading the auth plugin holds of a login. */
    readonly reading: (pool: PoolId, credentialID: string) => Effect.Effect<QuotaReading | undefined>
    /** A fresh reading of a login's usage endpoint. */
    readonly usage: (pool: PoolId, credentialID: string) => Effect.Effect<QuotaReading | undefined>
    /** Readings the auth plugin publishes as they come. */
    readonly readings: (
      pool: PoolId,
    ) => Stream.Stream<{ readonly credentialID: string; readonly reading: QuotaReading }>
  }
>()("dotfiles-opencode/pool/Quota") {}
