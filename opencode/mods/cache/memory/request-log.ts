// The ledger in memory, for the plugin's seam test: the lines it holds, each
// session's kept request, and a switch that makes every write fail.
import { Effect, Layer, Option } from "effect"
import type { Kept, LedgerLine } from "../request-log.ts"
import { LedgerUnavailable, RequestLog } from "../service.ts"

export interface MemoryLedger {
  readonly lines: Array<LedgerLine>
  readonly kept: Map<string, Kept>
  /** While true, appends and keeps fail as an unwritable file would. */
  broken: boolean
}

export const make = (): MemoryLedger => ({ lines: [], kept: new Map(), broken: false })

const broken = () => Effect.fail(new LedgerUnavailable({ message: "the ledger is broken" }))

export const layer = (ledger: MemoryLedger = make()) =>
  Layer.succeed(
    RequestLog,
    RequestLog.of({
      append: (line) =>
        ledger.broken
          ? broken()
          : Effect.sync(() => {
              ledger.lines.push(line)
            }),
      read: Effect.sync(() => [...ledger.lines]),
      keep: (sessionID, kept) =>
        ledger.broken
          ? broken()
          : Effect.sync(() => {
              ledger.kept.set(sessionID, kept)
            }),
      last: (sessionID) => Effect.sync(() => Option.fromNullishOr(ledger.kept.get(sessionID))),
    }),
  )
