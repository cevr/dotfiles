// The AgentCalls view over orchestrate's call log: calls folded by caller and
// call id, a return adding the child and how it ended, and the live calls in
// the order they first appeared. The view has no aggregate (its events are
// another program's log lines), so its cases fold events directly.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { AgentCalled, AgentCalls, AgentReturned, live, runSession, stepUnit } from "./agent-calls.ts"

const called = (sessionID: string, callID: string, agent = "worker", fields: { description?: string; child?: string } = {}) =>
  AgentCalled.make({ sessionID, callID, agent, ...fields })
const returned = (sessionID: string, callID: string, fields: { child?: string; status?: string } = {}) =>
  AgentReturned.make({ sessionID, callID, ...fields })

const liveOf = (...events: ReadonlyArray<AgentCalled | AgentReturned>) => live(fold(AgentCalls, events))

describe("AgentCalls", () => {
  test("a call is live until it returns completed or error", () => {
    expect(
      liveOf(
        called("ses_1", "a", "worker", { description: "port" }),
        called("ses_1", "b"),
        called("ses_1", "c"),
        returned("ses_1", "a", { child: "ses_a", status: "completed" }),
        returned("ses_1", "b", { child: "ses_b", status: "error" }),
      ),
    ).toEqual([{ sessionID: "ses_1", callID: "c", agent: "worker" }])
  })

  test("a background call returning `running` stays live, with its child", () => {
    expect(liveOf(called("ses_1", "a", "worker", { description: "port" }), returned("ses_1", "a", { child: "ses_a", status: "running" }))).toEqual([
      { sessionID: "ses_1", callID: "a", agent: "worker", description: "port", child: "ses_a", status: "running" },
    ])
  })

  test("the same call id under two callers is two calls", () => {
    expect(
      liveOf(called("ses_1", "call_1", "worker"), called("ses_2", "call_1", "planner"), returned("ses_1", "call_1", { status: "completed" })),
    ).toEqual([{ sessionID: "ses_2", callID: "call_1", agent: "planner" }])
  })

  test("a call seen again starts over in its first place", () => {
    expect(
      liveOf(
        called("ses_1", "a", "worker", { child: "ses_old" }),
        called("ses_1", "b"),
        returned("ses_1", "a", { status: "running" }),
        called("ses_1", "a", "planner"),
      ),
    ).toEqual([
      { sessionID: "ses_1", callID: "a", agent: "planner" },
      { sessionID: "ses_1", callID: "b", agent: "worker" },
    ])
  })

  test("a return keeps what it does not name, and a return with no call is ignored", () => {
    expect(
      liveOf(
        returned("ses_1", "ghost", { status: "running" }),
        called("ses_1", "a", "worker", { child: "ses_a" }),
        returned("ses_1", "a"),
      ),
    ).toEqual([{ sessionID: "ses_1", callID: "a", agent: "worker", child: "ses_a" }])
  })

  test("no events, no calls", () => {
    expect(liveOf()).toEqual([])
  })
})

describe("a run's session", () => {
  test("a step's unit, in both of the skill's forms; prose names none", () => {
    expect(stepUnit("implementor push r2")).toEqual(Option.some("push"))
    expect(stepUnit("verifier batch-3 r1")).toEqual(Option.some("batch-3"))
    expect(stepUnit("push r2 implementor")).toEqual(Option.some("push"))
    expect(stepUnit("closure-flake verifier r1 (Opus)")).toEqual(Option.some("closure-flake"))
    for (const prose of ["Fix the verifier's timeout", "Ask the planner about X", "Fix verifier", "r2 verifier", ""]) expect(stepUnit(prose)).toEqual(Option.none())
  })

  test("the session that started the latest step of one of the run's units owns it, returned or not; a run with no step has none", () => {
    const state = fold(AgentCalls, [
      called("ses_old", "a", "planner", { description: "planner wake r1" }),
      called("ses_new", "b", "implementor", { description: "implementor sleep r1" }),
      returned("ses_new", "b", { status: "completed" }),
      called("ses_other", "c", "implementor", { description: "implementor elsewhere r1" }),
      called("ses_new", "d", "worker", { description: "Ask the planner about wake" }),
    ])
    expect(runSession(state, ["wake", "sleep"])).toEqual(Option.some("ses_new"))
    expect(runSession(state, ["wake"])).toEqual(Option.some("ses_old"))
    expect(runSession(state, ["nothing"])).toEqual(Option.none())
  })
})
