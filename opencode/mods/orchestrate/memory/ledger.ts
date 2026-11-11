// The ledger held in memory: its lines in an array the caller may share. A
// second layer on the same array is the same ledger: another location's
// plugin copy, or the plugin after a restart.
import { Effect, Layer } from "effect"
import { DEFAULT_RETENTION, type Line, make, type Retention } from "../ledger.ts"
import type { Cadence } from "../machine.ts"
import { Ledger } from "../service.ts"

/** The bytes `lines` would take as JSONL. */
export const sizeOf = (lines: ReadonlyArray<unknown>): number => lines.reduce<number>((total, line) => total + (typeof line === "string" ? line : JSON.stringify(line)).length + 1, 0)

/** A ledger on `lines`: read at each decision, appended to, and replaced by a compaction. */
export const layer = (cadence: Cadence, lines: Array<unknown> = [], retention: Retention = DEFAULT_RETENTION) =>
  Layer.effect(
    Ledger,
    make(
      {
        key: lines,
        read: () => Effect.sync(() => [...lines]),
        append: (line: Line) => Effect.sync(() => void lines.push(line)),
        replace: (kept) => Effect.sync(() => void lines.splice(0, lines.length, ...kept)),
        size: () => Effect.sync(() => sizeOf(lines)),
      },
      cadence,
      retention,
    ),
  )
