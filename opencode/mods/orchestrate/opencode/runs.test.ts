// The runs over a stand-in for the status plugin's RPC: the laws, and the
// answers that give no runs (no plugin, a failure, an answer that is not one).
import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { runsLaws } from "../laws.ts"
import { Runs } from "../service.ts"
import * as OpenCodeRuns from "./runs.ts"

runsLaws("OpenCode's Runs", (world) =>
  OpenCodeRuns.layer(() =>
    world === "unreadable"
      ? Effect.fail(new Error("no server for dotfiles-opencode.status"))
      : // The status plugin's answer, with the fields this reader does not read (an older table's `cadence` among them).
        Effect.succeed({
          agents: [],
          errors: [],
          runs: world.map((run) => ({ ...run, units: run.units.map((unit) => ({ ...unit, round: unit.round ?? "", verdict: unit.verdict ?? "", since: unit.since ?? "", cadence: "3 ready or 60 min" })) })),
        }),
  ),
)

test("a broken plugin or an answer that is not one is no runs", async () => {
  const listOf = (status: OpenCodeRuns.Status) => Effect.runPromise(Runs.use((runs) => runs.list).pipe(Effect.provide(OpenCodeRuns.layer(status))))
  expect(await listOf(() => Effect.die("broken"))).toEqual([])
  expect(await listOf(() => Effect.succeed({ runs: "p1" }))).toEqual([])
  expect(await listOf(() => Effect.succeed(undefined))).toEqual([])
})

effectTest(
  "a read says why the runs could not be read: the status plugin's runs error, a broken plugin, an answer that is not one",
  Effect.gen(function* () {
    const readOf = (status: OpenCodeRuns.Status) => Runs.use((runs) => runs.read).pipe(Effect.provide(OpenCodeRuns.layer(status)))
    expect(yield* readOf(() => Effect.succeed({ agents: [], runs: [], errors: ["Agents: EISDIR", "Runs: bun failed: no such run"] }))).toEqual({
      runs: [],
      error: Option.some("bun failed: no such run"),
    })
    expect(yield* readOf(() => Effect.succeed({ agents: [], runs: [], errors: ["Runs: p1 failed", "Agents: EISDIR", "Runs: p2 timed out"] }))).toEqual({
      runs: [],
      error: Option.some("p1 failed; p2 timed out"),
    })
    expect(yield* readOf(() => Effect.succeed({ agents: [], runs: [], errors: ["Agents: EISDIR"] }))).toEqual({ runs: [], error: Option.none() })
    expect(Option.isSome((yield* readOf(() => Effect.die("broken"))).error)).toBe(true)
    expect(Option.isSome((yield* readOf(() => Effect.succeed({ runs: "p1" }))).error)).toBe(true)
  }),
  5_000,
)
