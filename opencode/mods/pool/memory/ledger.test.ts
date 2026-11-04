import { ledgerLaws } from "../laws.ts"
import * as MemoryLedger from "./ledger.ts"

ledgerLaws("memory Ledger", () => MemoryLedger.layer())
