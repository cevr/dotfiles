// The ledger in memory, for the plugin's seam test: the lines it holds, and a
// switch that makes every append fail.
import { Effect, Layer } from "effect"
import type { LedgerLine } from "../request-log.ts"
import { LedgerUnavailable, RequestLog } from "../service.ts"

export interface MemoryLedger {
  readonly lines: Array<LedgerLine>
  /** While true, appends fail as an unwritable file would. */
  broken: boolean
}

export const make = (): MemoryLedger => ({ lines: [], broken: false })

export const layer = (ledger: MemoryLedger = make()) =>
  Layer.succeed(
    RequestLog,
    RequestLog.of({
      append: (line) =>
        ledger.broken
          ? Effect.fail(new LedgerUnavailable({ message: "the ledger is broken" }))
          : Effect.sync(() => {
              ledger.lines.push(line)
            }),
      read: Effect.sync(() => [...ledger.lines]),
    }),
  )
