import { requestLogLaws } from "../laws.ts"
import { layer } from "./request-log.ts"

requestLogLaws("the memory ledger", () => layer())
