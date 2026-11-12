/**
 * The host's work as the pool reads it from the status plugin's answer: each
 * run's units and the session that owns it; an answer that is not one is no
 * runs.
 */
import { describe, expect, test } from "bun:test"
import { decode, runsOf } from "./workload.ts"

describe("the status plugin's runs", () => {
  test("each run keeps its units' states and the session that owns it, when the answer names one", () => {
    const runs = runsOf(
      decode({
        agents: [],
        runs: [
          { name: "ergo", dir: "/x", session: "ses_orch", units: [{ unit: "push", state: "implement", round: "2", since: "t" }] },
          { name: "idle", units: [{ unit: "a", state: "plan", round: "1", since: "t" }] },
        ],
        errors: [],
      }),
    )
    expect(runs).toEqual([
      { name: "ergo", session: "ses_orch", units: [{ unit: "push", state: "implement" }] },
      { name: "idle", units: [{ unit: "a", state: "plan" }] },
    ])
  })

  test("an answer that is not one is no runs", () => {
    expect(runsOf(decode({ runs: [{ name: 3 }] }))).toEqual([])
  })
})
