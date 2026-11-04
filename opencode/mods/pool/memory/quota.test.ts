import { quotaLaws } from "../laws.ts"
import * as MemoryQuota from "./quota.ts"

quotaLaws("memory Quota", (world) => MemoryQuota.layer(world.readings, world.published))
