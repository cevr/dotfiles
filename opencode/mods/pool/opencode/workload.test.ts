// The host's work as the pool reads it from the status plugin's answer: each
// run's units and the session that owns it; an answer that is not one is no
// runs.
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Workload } from "../service.ts"
import * as WorkloadLive from "./workload.ts"

const runsOf = (answer: unknown) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* Layer.build(WorkloadLive.layer(() => Effect.succeed(answer), () => ({ load: 1, cores: 4 })))
      return yield* Context.get(services, Workload).runs
    }).pipe(Effect.scoped),
  )

describe("the status plugin's runs", () => {
  test("each run keeps its units' states and the session that owns it, when the answer names one", async () => {
    const runs = await runsOf({
      agents: [],
      runs: [
        { name: "ergo", dir: "/x", session: "ses_orch", units: [{ unit: "push", state: "implement", round: "2", since: "t" }] },
        { name: "idle", units: [{ unit: "a", state: "plan", round: "1", since: "t" }] },
      ],
      errors: [],
    })
    expect(runs).toEqual([
      { name: "ergo", session: "ses_orch", units: [{ unit: "push", state: "implement" }] },
      { name: "idle", units: [{ unit: "a", state: "plan" }] },
    ])
  })

  test("an answer that is not one is no runs", async () => {
    expect(await runsOf({ runs: [{ name: 3 }] })).toEqual([])
  })
})
