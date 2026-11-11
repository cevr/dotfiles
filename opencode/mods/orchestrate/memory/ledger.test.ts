import { DEFAULT_CADENCE } from "../machine.ts"
import { ledgerLaws } from "../laws.ts"
import * as MemoryLedger from "./ledger.ts"

ledgerLaws("memory Ledger", () => {
  const lines: Array<unknown> = []
  return {
    open: () => MemoryLedger.layer(DEFAULT_CADENCE, lines),
    lines: () => lines.filter((line): line is Record<string, unknown> => typeof line === "object" && line !== null),
    cut: () => void lines.push('{"kind":"UnitHand'),
  }
})
