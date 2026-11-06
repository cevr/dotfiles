import { stepLogLaws } from "../laws.ts"
import * as MemoryStepLog from "./step-log.ts"

stepLogLaws("memory StepLog", (world) => MemoryStepLog.layer(world))
