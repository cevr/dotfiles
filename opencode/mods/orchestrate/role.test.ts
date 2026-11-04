// The guard's routing: which agent a subagent call runs as.
import { describe, expect, test } from "bun:test"
import { route } from "./role.ts"

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
})
