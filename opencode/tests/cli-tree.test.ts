/**
 * The development path of the plain-Bun commands (`mods/update/trees.ts` `COMMANDS`): each command's probes
 * run from this checkout, whose fork links stand in for an install (`scripts/link-fork.ts`). It proves the
 * declarations and the dev install, never the installed tree: that is `tests/cli-tree-installed.test.ts`,
 * which requires `TREE_OPENCODE`. This file reads no `TREE_OPENCODE`.
 *
 * @reads mods/update/trees.ts cmd/** mods/** scripts/daily.ts
 */
import { describe } from "effect-bun-test"
import { checkoutRoot, commandChecks } from "./cli-tree/run.ts"

describe("each plain-Bun command runs from this checkout (the development path)", () => {
  commandChecks(checkoutRoot)
})
