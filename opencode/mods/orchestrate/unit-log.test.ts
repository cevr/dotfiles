// A unit's moves as the plugin reads them: a role's start from its call's
// description, its hand-back from its last answer, and the unit dir from the
// paths either names.
import { describe, expect, test } from "bun:test"
import { handBackOf, startOf, unitDirsIn } from "./unit-log.ts"

describe("a role's start", () => {
  test("moves its unit to the role's state in the round its description names, citing the file it starts from", () => {
    expect(startOf("planner", "planner auth r1")).toEqual({ unit: "auth", to: "plan", round: 1, note: "" })
    expect(startOf("implementor", "implementor auth r1")).toEqual({ unit: "auth", to: "implement", round: 1, note: "spec.md" })
    expect(startOf("implementor", "implementor auth r3 (fresh)")).toEqual({ unit: "auth", to: "implement", round: 3, note: "round-2-findings.md" })
    expect(startOf("verifier", "verifier auth r2")).toEqual({ unit: "auth", to: "verify", round: 2, note: "round-2-request.md" })
    // The suffix form the guard routes too.
    expect(startOf("verifier", "closure-flake verifier r1 (Opus)")).toEqual({ unit: "closure-flake", to: "verify", round: 1, note: "round-1-request.md" })
    expect(startOf("implementor", "pkg-lower r2 implementor")).toEqual({ unit: "pkg-lower", to: "implement", round: 2, note: "round-1-findings.md" })
  })

  test("moves nothing for the worker, another agent, another role, no round, or prose", () => {
    expect(startOf("worker", "implementor auth r1")).toBeUndefined()
    expect(startOf("explore", "verifier auth r1")).toBeUndefined()
    expect(startOf("implementor", "verifier auth r1")).toBeUndefined()
    expect(startOf("implementor", "pkg-lower implementor")).toBeUndefined()
    expect(startOf("verifier", "Fix the verifier's timeout")).toBeUndefined()
    expect(startOf("verifier", "verifier Auth r1")).toBeUndefined()
    expect(startOf("verifier", undefined)).toBeUndefined()
  })
})

describe("a role's hand-back", () => {
  const dir = "/work/tmp/orchestrate/web/auth"

  test("moves its unit as the machine says, citing its file and verdict", () => {
    expect(handBackOf("implementor", `implementor auth r1: ready ${dir}/round-1-request.md\nGate green.`)).toEqual({
      transition: { unit: "auth", to: "verify", round: 1, note: "round-1-request.md ready" },
      file: `${dir}/round-1-request.md`,
    })
    expect(handBackOf("verifier", `verifier auth r2: accepted ${dir}/round-2-findings.md`)?.transition).toEqual({ unit: "auth", to: "decide", round: 2, note: "round-2-findings.md accepted" })
    expect(handBackOf("verifier", `verifier auth r2: changes ${dir}/round-2-findings.md`)?.transition).toEqual({ unit: "auth", to: "implement", round: 3, note: "round-2-findings.md changes" })
    expect(handBackOf("verifier", `verifier auth r2: stuck ${dir}/round-2-findings.md`)?.transition).toEqual({ unit: "auth", to: "decide", round: 2, note: "round-2-findings.md stuck" })
    for (const role of ["planner", "implementor", "verifier"])
      expect(handBackOf(role, `${role} auth r1: blocked ${dir}/blocked.md`)?.transition).toEqual({ unit: "auth", to: "blocked", round: 1, note: "blocked.md blocked" })
  })

  test("a planner's ready moves nothing; the line may sit after blank lines, in backticks or bold", () => {
    expect(handBackOf("planner", `planner auth r1: ready ${dir}/spec.md`)).toEqual({ transition: undefined, file: `${dir}/spec.md` })
    expect(handBackOf("implementor", `\n\n\`implementor auth r1: ready ${dir}/round-1-request.md\``)?.file).toBe(`${dir}/round-1-request.md`)
    expect(handBackOf("verifier", `**verifier auth r1: accepted** ${dir}/round-1-findings.md`)?.transition?.to).toBe("decide")
    expect(handBackOf("implementor", "implementor auth r1: ready")).toEqual({ transition: { unit: "auth", to: "verify", round: 1, note: "ready" }, file: undefined })
  })

  test("is none for another role's line, a line that is not first, or an answer that is not a hand-back", () => {
    expect(handBackOf("implementor", `verifier auth r1: accepted ${dir}/round-1-findings.md`)).toBeUndefined()
    expect(handBackOf("worker", `implementor auth r1: ready ${dir}/round-1-request.md`)).toBeUndefined()
    expect(handBackOf("implementor", `Done.\nimplementor auth r1: ready ${dir}/round-1-request.md`)).toBeUndefined()
    expect(handBackOf("implementor", "implementor auth r1: still working")).toBeUndefined()
    expect(handBackOf("verifier", "verifier auth r1: approved")).toBeUndefined()
    expect(handBackOf("verifier", undefined)).toBeUndefined()
  })
})

describe("the unit dirs a text names", () => {
  test("are the paths up to the unit's segment, in order, each once", () => {
    const prompt = [
      "Spec: /work/tmp/orchestrate/web/auth/spec.md (round 1).",
      "Findings: `~/work/tmp/orchestrate/web/auth/round-1-findings.md`, and /work/tmp/orchestrate/web/auth/state.md.",
      "Relative: tmp/orchestrate/web/auth/round-2-request.md; unrelated /work/tmp/orchestrate/web/tabs/spec.md",
    ].join("\n")
    expect(unitDirsIn(prompt, "auth")).toEqual(["/work/tmp/orchestrate/web/auth", "~/work/tmp/orchestrate/web/auth", "tmp/orchestrate/web/auth"])
  })

  test("take the last segment when the run shares the unit's name; none when no path names it", () => {
    expect(unitDirsIn("/r/tmp/orchestrate/auth/auth/spec.md", "auth")).toEqual(["/r/tmp/orchestrate/auth/auth"])
    expect(unitDirsIn("Fix auth in /r/src/login.ts", "auth")).toEqual([])
    expect(unitDirsIn(undefined, "auth")).toEqual([])
  })
})
