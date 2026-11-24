// Run one law in a child by scripts/test-runner-bridges.test.ts.
import { Effect } from "effect"
import { riftsLaws } from "../mods/work/laws.ts"
import { hangGuard } from "./hang-guard.ts"

riftsLaws("Rifts bridge diagnostic witness", () => Effect.never, hangGuard("unit-law"))
