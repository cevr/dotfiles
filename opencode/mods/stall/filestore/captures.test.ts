import { spawnSync } from "bun"
import { Effect } from "effect"
import { capturesLaws } from "../laws.ts"
import { layer } from "./captures.ts"

// Each case's store is a directory inside a scratch directory, not made yet: the first write or
// listing makes it. The scratch directory goes with the case.
capturesLaws(
  "the file store",
  Effect.acquireRelease(
    Effect.sync(() => spawnSync(["mktemp", "-d", "-t", "stall-captures"]).stdout.toString().trim()),
    (dir) => Effect.sync(() => void spawnSync(["rm", "-rf", dir])),
  ).pipe(Effect.map((dir) => layer(`${dir}/log`))),
)
