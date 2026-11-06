// The runs over a stand-in for the status plugin's RPC: the laws, and the
// answers that give no runs (no plugin, a failure, an answer that is not one).
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { runsLaws } from "../laws.ts"
import { Runs } from "../service.ts"
import * as OpenCodeRuns from "./runs.ts"

runsLaws("OpenCode's Runs", (world) =>
  OpenCodeRuns.layer(() =>
    world === "unreadable"
      ? Effect.fail(new Error("no server for dotfiles-opencode.status"))
      : // The status plugin's answer, with the fields this reader does not read.
        Effect.succeed({ agents: [], errors: [], runs: world.map((run) => ({ ...run, units: run.units.map((unit) => ({ ...unit, round: "1", since: unit.since ?? "" })) })) }),
  ),
)

test("a broken plugin or an answer that is not one is no runs", async () => {
  const listOf = (status: OpenCodeRuns.Status) => Effect.runPromise(Runs.use((runs) => runs.list).pipe(Effect.provide(OpenCodeRuns.layer(status))))
  expect(await listOf(() => Effect.die("broken"))).toEqual([])
  expect(await listOf(() => Effect.succeed({ runs: "p1" }))).toEqual([])
  expect(await listOf(() => Effect.succeed(undefined))).toEqual([])
})
