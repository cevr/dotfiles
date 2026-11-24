// Run in a child by scripts/test-runner-bridges.test.ts, not as a passing suite.
import { Effect } from "effect"
import { hangGuard } from "../tests/hang-guard.ts"
import { effectTest } from "./effect-test.ts"

effectTest("TUI bridge diagnostic witness", Effect.never, hangGuard("unit-law"))
