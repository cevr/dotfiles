import { Context, type Effect } from "effect"
import type { PoolId } from "./AccountPool.id.ts"
import type { Event, LedgerState } from "./AccountPool.aggregate.ts"

/**
 * Where a pool keeps what the next process needs: its holds, readings and
 * priced steps. A failed read starts the pool empty; a failed write is lost.
 */
export class Ledger extends Context.Service<
  Ledger,
  {
    readonly restore: (pool: PoolId) => Effect.Effect<LedgerState>
    /** Write what `events` change in the ledger. */
    readonly record: (pool: PoolId, events: ReadonlyArray<Event>) => Effect.Effect<void>
  }
>()("dotfiles-opencode/pool/Ledger") {}
