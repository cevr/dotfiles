/**
 * The development path of the plain-Bun commands (`mods/update/trees.ts` `COMMANDS`): each command's probes
 * run from this checkout, whose fork links stand in for an install (`scripts/link-fork.ts`). It proves the
 * declarations and the dev install, never the installed tree: that is `tests/cli-tree-installed.test.ts`,
 * which requires `TREE_OPENCODE`. This file reads no `TREE_OPENCODE`.
 *
 */
// @reads cmd/digest/{devices,pair,export}.ts cmd/image/{key,run}.ts cmd/mail/pair.ts cmd/memory/cli.ts cmd/rex/show.ts cmd/update/handoff.ts cmd/wake/{backstop,job}.ts scripts/daily.ts mods/kernel/worker/program.ts
import { describe } from "effect-bun-test"
import { checkoutRoot, commandChecks } from "./cli-tree/run.ts"
import { matchingInput } from "./read-path.ts"

describe("each plain-Bun command runs from this checkout (the development path)", () => {
  commandChecks(checkoutRoot, (file) => matchingInput("{cmd/digest/devices.ts,cmd/digest/pair.ts,cmd/digest/export.ts,cmd/image/key.ts,cmd/image/run.ts,cmd/mail/pair.ts,cmd/memory/cli.ts,cmd/rex/show.ts,cmd/update/handoff.ts,cmd/wake/backstop.ts,cmd/wake/job.ts,scripts/daily.ts,mods/kernel/worker/program.ts}", file))
})
