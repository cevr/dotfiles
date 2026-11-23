// The guard's routing: which agent a subagent call runs as.
import { describe, expect, test } from "bun:test"
import { Exit, Schema } from "effect"
import generated from "./agents.json"
import { codexFallback, definitions, Generated, ORCHESTRATOR, orchestrator, type Role, ROLES, route, unspecific, withSection } from "./role.ts"
import { block } from "./round-policy.ts"

describe("the orchestrator's section", () => {
  const system = [
    { type: "text" as const, text: "build's prompt" },
    { type: "text" as const, text: "instructions" },
  ]
  test("goes after build's prompt, in its first part, for the orchestrator only", () => {
    expect(withSection(ORCHESTRATOR, system)).toEqual([{ type: "text", text: `build's prompt\n\n${orchestrator.section}` }, system[1]!])
    expect(system[0]!.text).toBe("build's prompt")
    for (const agent of ["build", ...ROLES]) expect([agent, withSection(agent, system) === system]).toEqual([agent, true])
  })
  test("stands alone in a request with no system part", () => {
    expect(withSection(ORCHESTRATOR, [])).toEqual([{ type: "text", text: orchestrator.section }])
  })
})

describe("the agents' prompts", () => {
  test("the worker, like each role, goes on after a compaction instead of handing off", () => {
    for (const role of ROLES) {
      expect(definitions[role].system).toContain(role === "worker" ? "A compaction does not end your task" : "A compaction does not end your step")
      expect(definitions[role].system).not.toContain("At your first compaction")
    }
  })
})

describe("the round policy each definition carries, decoded at load", () => {
  const decode = Schema.decodeUnknownExit(Generated)
  const withSystem = (role: Role, system: string) => ({ ...generated, agents: { ...generated.agents, [role]: { ...generated.agents[role], system } } })
  test("the shipped agents.json decodes, each role's system carrying its own policy", () => {
    expect(Exit.isSuccess(decode(generated))).toBe(true)
    for (const role of ROLES) expect([role, definitions[role].system.includes(block(role))]).toEqual([role, true])
  })
  test("a lost, swapped, doubled or edited policy fails the decode, naming the role and the part", () => {
    const text = (role: Role) => generated.agents[role].system
    const cases: ReadonlyArray<readonly [Role, string, string]> = [
      ["planner", text("planner").replace(block("planner"), ""), "planner: 0 policy blocks open"],
      ["implementor", text("implementor").replace(block("implementor"), () => block("planner")), "implementor: role: source implementor, shown planner"],
      ["verifier", `${text("verifier")}\n${block("verifier")}`, "verifier: 2 policy blocks open"],
      ["worker", text("worker").replace("`refused.what`", "`refused.allow`"), "worker: stop refusalForm"],
      ["implementor", text("implementor").replace(" and `<unit dir>/blocked.md`", ""), "implementor: verdict blocked"],
    ]
    for (const [role, system, fault] of cases) {
      expect([role, system !== text(role)]).toEqual([role, true])
      const exit = decode(withSystem(role, system))
      expect([role, Exit.isFailure(exit), String(exit).includes(fault)]).toEqual([role, true, true])
    }
  })
})

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
  test("a planner or verifier runs on sol: the verifier at medium, the planner at high", () => {
    expect(codexFallback("verifier")).toEqual({ family: "gpt-sol", variant: "medium" })
    expect(codexFallback("planner")).toEqual({ family: "gpt-sol", variant: "high" })
  })
})
