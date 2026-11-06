// The guard's routing: which agent a subagent call runs as.
import { describe, expect, test } from "bun:test"
import { codexFallback, route, unspecific } from "./role.ts"

describe("the guard's routing", () => {
  test("an untyped or general call runs as the worker; a former role name as the role", () => {
    expect(route(undefined)).toEqual({ agent: "worker", reason: "untyped" })
    expect(route("")).toEqual({ agent: "worker", reason: "untyped" })
    for (const name of ["general", "general-purpose", "claude", "status:general"])
      expect(route(name)).toEqual({ agent: "worker", reason: "general" })
    expect(route("orchestrate-reviewer")).toEqual({ agent: "verifier", reason: "renamed" })
    for (const role of ["planner", "implementor", "verifier", "worker"])
      expect(route(`orchestrate-${role}`)).toEqual({ agent: role, reason: "renamed" })
    expect(route("explore")).toEqual({ agent: "explore", reason: "kept" })
    expect(route("planner")).toEqual({ agent: "planner", reason: "kept" })
  })

  test("with the full-agent escape, a general call runs as asked", () => {
    expect(route(undefined, true)).toEqual({ agent: "general", reason: "kept" })
    expect(route("general", true)).toEqual({ agent: "general", reason: "kept" })
    expect(route("orchestrate-reviewer", true)).toEqual({ agent: "verifier", reason: "renamed" })
  })

  test("a call that would run as the worker runs as the role its description names", () => {
    for (const asked of [undefined, "", "general", "general-purpose", "worker", "orchestrate-worker"]) {
      expect(route(asked, false, "verifier bite-19493 r3")).toEqual({ agent: "verifier", reason: "described" })
      expect(route(asked, false, "pkg-lower implementor")).toEqual({ agent: "implementor", reason: "described" })
      expect(route(asked, false, "closure-flake verifier r1 (Opus)")).toEqual({ agent: "verifier", reason: "described" })
      expect(route(asked, false, "planner hsdaily r1")).toEqual({ agent: "planner", reason: "described" })
    }
  })

  test("a role only mentioned in prose stays with the worker", () => {
    expect(route("general", false, "Fix the verifier's timeout")).toEqual({ agent: "worker", reason: "general" })
    expect(route(undefined, false, "Ask the planner about X")).toEqual({ agent: "worker", reason: "untyped" })
    expect(route("worker", false, "std-1 wave planner (read-only)")).toEqual({ agent: "worker", reason: "kept" })
  })

  test("an agent asked by name stays as asked, whatever the description says; so does the full-agent escape's general", () => {
    expect(route("implementor", false, "verifier pkg-lower r1")).toEqual({ agent: "implementor", reason: "kept" })
    expect(route("explore", false, "planner hsdaily r1")).toEqual({ agent: "explore", reason: "kept" })
    expect(route("orchestrate-reviewer", false, "implementor x r1")).toEqual({ agent: "verifier", reason: "renamed" })
    expect(route("general", true, "verifier pkg-lower r1")).toEqual({ agent: "general", reason: "kept" })
    expect(route(undefined, true, "verifier pkg-lower r1")).toEqual({ agent: "general", reason: "kept" })
  })

  test("a call names no particular agent when untyped, general or the worker", () => {
    for (const asked of [undefined, null, "", "general", "claude", "status:general", "worker"]) expect(unspecific(asked)).toBe(true)
    for (const asked of ["planner", "verifier", "explore", "orchestrate-reviewer"]) expect(unspecific(asked)).toBe(false)
  })
})

describe("the Codex fallback", () => {
  test("light, direct or mechanical work runs on luna at max", () => {
    for (const note of ["(light)", "(direct)", "(mechanical)", "(Mechanical) "])
      expect(codexFallback("implementor", `pkg-lower implementor ${note}`)).toEqual({ family: "gpt-luna", variant: "max" })
  })

  test("the rest run on sol: the verifier at medium, everything else at high", () => {
    expect(codexFallback("verifier", "verifier sso r1")).toEqual({ family: "gpt-sol", variant: "medium" })
    for (const agent of ["planner", "implementor", "worker", "explore"]) expect(codexFallback(agent, undefined)).toEqual({ family: "gpt-sol", variant: "high" })
    expect(codexFallback("implementor", "a light (mechanical) refactor, then more")).toEqual({ family: "gpt-sol", variant: "high" })
  })
})
