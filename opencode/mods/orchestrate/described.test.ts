// The step a subagent call's description names, in the skill's form or the role-after-unit form roots write.
import { describe, expect, test } from "bun:test"
import { described } from "./described.ts"

describe("the step a description names", () => {
  test("the hand-back form: the role first, then the unit", () => {
    expect(described("verifier bite-19493 r3")).toEqual({ role: "verifier", rest: "bite-19493 r3" })
    expect(described("implementor sso-layer3-v3 rewrite r3")).toEqual({ role: "implementor", rest: "sso-layer3-v3 rewrite r3" })
    expect(described("planner hsdaily r1")).toEqual({ role: "planner", rest: "hsdaily r1" })
    expect(described("verifier PR #21380 round 2")).toEqual({ role: "verifier", rest: "PR #21380 round 2" })
    expect(described("  verifier   sso r3 (resume) ")).toEqual({ role: "verifier", rest: "sso r3 (resume)" })
  })

  test("the role after a one-word unit, with an optional round and note (the descriptions ergo wrote)", () => {
    expect(described("pkg-lower implementor")).toEqual({ role: "implementor", rest: "pkg-lower" })
    expect(described("pkg-lower r2 implementor")).toEqual({ role: "implementor", rest: "pkg-lower r2" })
    expect(described("closure-flake verifier r1 (Opus)")).toEqual({ role: "verifier", rest: "closure-flake r1 (Opus)" })
    expect(described("gate-test-disk implementor (resume 2)")).toEqual({ role: "implementor", rest: "gate-test-disk (resume 2)" })
    expect(described("gate-test-disk r3 implementor (re-plan)")).toEqual({ role: "implementor", rest: "gate-test-disk r3 (re-plan)" })
  })

  test("a role mentioned in prose, a capitalised one, or one with no unit names no step", () => {
    for (const prose of [
      "Fix the verifier's timeout",
      "Ask the planner about X",
      "Fix verifier",
      "Planner prompt rewrite",
      "Implementor pkg-lower r1",
      "std-1 wave planner (read-only)",
      "r2 verifier",
      "pkg-lower verifier r1 then merge",
      "verifier",
      "verifier's prompt",
      "worker pkg-lower r1",
      "Rows name the orchestrate role; untyped role work routes to its role agent",
      "",
      undefined,
    ])
      expect(described(prose)).toBeUndefined()
  })
})
