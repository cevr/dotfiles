// The ToolCall aggregate's stories: a subagent starts as the agent the guard
// routes it to, or the Sabbath or the pace refuses it; another tool call in a
// subagent is refused over the Sabbath; a subagent call finishes.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Story from "@dotfiles/decider/story"
import { PaceHeld } from "./pace.ts"
import { explain, KNOWLTON, resumesAt, SabbathRest } from "./sabbath.ts"
import { FinishSubagent, Finished, StartSubagent, Started, SubagentFinished, SubagentStarted, ToolCall, UseTool } from "./tool-call.ts"

/** Friday 30 October 2026, 19:00 in Knowlton (EDT): after sunset, in the Sabbath. */
const FRIDAY_EVENING = "2026-10-30T23:00:00Z"
/** Wednesday 4 November 2026, 10:00 in Knowlton. */
const WEDNESDAY = "2026-11-04T15:00:00Z"
const SABBATH = /^It is the Sabbath; agent work resumes at Sat 18:\d\d \(30 min after sunset, Knowlton, QC\)\.$/

const story = Story.make(ToolCall)
const run = (...steps: Parameters<typeof story>) => Effect.runPromise(story(...steps))

const call = { sessionID: "root", callID: "call-1" }
/** A new subagent call from the build agent asking for `asked`, on Wednesday's terms. */
const start = (asked: unknown, fields: Partial<StartSubagent> = {}) =>
  StartSubagent.make({ call, from: "build", asked, background: false, fullAgent: false, place: KNOWLTON, ...fields })
const started = (fields: Omit<SubagentStarted, "_tag" | "call" | "from">) => SubagentStarted.make({ call, from: "build", ...fields })

describe("a subagent starts", () => {
  test("as the role it asks for, on its model, and finishes", () =>
    run(
      Story.clock(WEDNESDAY),
      Story.when(start("planner", { model: "anthropic/claude-opus#high", description: "plan the unit", background: true })),
      Story.then(
        started({
          asked: "planner",
          agent: "planner",
          reason: "kept",
          model: "anthropic/claude-opus#high",
          background: true,
          description: "plan the unit",
        }),
      ),
      Story.state(Started.make({ agent: "planner" })),
      Story.when(FinishSubagent.make({ call, child: "child-1", status: "running" })),
      Story.then(SubagentFinished.make({ call, child: "child-1", status: "running" })),
      Story.state(Finished.make({ status: "running" })),
    ))

  test("a finish the log never saw start is recorded all the same", () =>
    run(
      Story.when(FinishSubagent.make({ call, status: "error" })),
      Story.then(SubagentFinished.make({ call, status: "error" })),
      Story.state(Finished.make({ status: "error" })),
    ))

  test("a kernel cell's calls share its id, so a second start on the call is decided on its own", () =>
    run(
      Story.given(started({ asked: "planner", agent: "planner", reason: "kept" })),
      Story.clock(WEDNESDAY),
      Story.when(start("verifier")),
      Story.then(started({ asked: "verifier", agent: "verifier", reason: "kept" })),
      Story.state(Started.make({ agent: "verifier" })),
    ))
})

describe("the guard's routing", () => {
  test("an untyped call runs as the worker", () =>
    run(Story.clock(WEDNESDAY), Story.when(start(undefined)), Story.then(started({ agent: "worker", reason: "untyped" }))))

  test("an empty agent is untyped too, and is still what was asked", () =>
    run(Story.clock(WEDNESDAY), Story.when(start("")), Story.then(started({ asked: "", agent: "worker", reason: "untyped" }))))

  test("a general call runs as the worker", () =>
    run(
      Story.clock(WEDNESDAY),
      Story.when(start("general-purpose")),
      Story.then(started({ asked: "general-purpose", agent: "worker", reason: "general" })),
    ))

  test("a former role name runs as the role", () =>
    run(
      Story.clock(WEDNESDAY),
      Story.when(start("orchestrate-reviewer")),
      Story.then(started({ asked: "orchestrate-reviewer", agent: "verifier", reason: "renamed" })),
    ))

  test("any other agent runs as asked", () =>
    run(Story.clock(WEDNESDAY), Story.when(start("explore")), Story.then(started({ asked: "explore", agent: "explore", reason: "kept" }))))

  test("with the full-agent escape, an untyped call runs as the general agent", () =>
    run(
      Story.clock(WEDNESDAY),
      Story.when(start(undefined, { fullAgent: true })),
      Story.then(started({ agent: "general", reason: "kept" })),
    ))

  test("a follow-up naming no agent keeps its child's", () =>
    run(
      Story.clock(WEDNESDAY),
      Story.when(start(undefined, { child: "child-1", childAgent: "verifier" })),
      Story.then(started({ agent: "verifier", reason: "continued", child: "child-1" })),
    ))

  test("a follow-up asking for a general agent or the worker keeps its child's too", () =>
    run(
      Story.clock(WEDNESDAY),
      Story.when(start("general", { child: "child-1", childAgent: "verifier", description: "gate-test-disk implementor (resume)" })),
      Story.then(
        started({ asked: "general", agent: "verifier", reason: "continued", child: "child-1", description: "gate-test-disk implementor (resume)" }),
      ),
    ))

  test("a follow-up naming an agent is routed as any call", () =>
    run(
      Story.clock(WEDNESDAY),
      Story.when(start("planner", { child: "child-1", childAgent: "worker" })),
      Story.then(started({ asked: "planner", agent: "planner", reason: "kept", child: "child-1" })),
    ))

  test("a follow-up whose child's agent is unknown never changes agent by its description", () =>
    run(
      Story.clock(WEDNESDAY),
      Story.when(start("general", { child: "child-1", description: "verifier sso r3 (resume)" })),
      Story.then(started({ asked: "general", agent: "worker", reason: "general", child: "child-1", description: "verifier sso r3 (resume)" })),
    ))

  test("role work asked of a general agent runs as the role its description names", () =>
    run(
      Story.clock(WEDNESDAY),
      Story.when(start("general", { description: "closure-flake verifier r1 (Opus)", background: true })),
      Story.then(
        started({ asked: "general", agent: "verifier", reason: "described", background: true, description: "closure-flake verifier r1 (Opus)" }),
      ),
      Story.state(Started.make({ agent: "verifier" })),
    ))
})

describe("the Sabbath", () => {
  const friday = Date.parse(FRIDAY_EVENING)
  const rest = new SabbathRest({ resumesAt: resumesAt(friday, KNOWLTON)!, place: KNOWLTON })

  test("its rejection says when work resumes, in the Claude Code mod's words", () => {
    expect(rest.why).toMatch(SABBATH)
    expect(rest.why).toBe(explain(rest.resumesAt, KNOWLTON))
  })

  test("no subagent starts, whatever it asks or its pace says", () =>
    run(
      Story.clock(FRIDAY_EVENING),
      Story.when(start("planner", { hold: { whose: "pool", reason: "held" } })),
      Story.rejected(rest),
    ))

  test("a running subagent's next tool call is refused", () =>
    run(
      Story.clock(FRIDAY_EVENING),
      Story.when(UseTool.make({ call, tool: "shell", inSubagent: true, place: KNOWLTON })),
      Story.rejected(rest),
    ))

  test("the main session's own tools run", () =>
    run(Story.clock(FRIDAY_EVENING), Story.when(UseTool.make({ call, tool: "shell", inSubagent: false, place: KNOWLTON })), Story.then()))

  test("on a weekday a subagent's tools run", () =>
    run(Story.clock(WEDNESDAY), Story.when(UseTool.make({ call, tool: "shell", inSubagent: true, place: KNOWLTON })), Story.then()))
})

describe("the pace", () => {
  const now = Date.parse(WEDNESDAY)

  test("the pool's hold refuses a new agent until the time it names", () =>
    run(
      Story.clock(now),
      Story.when(start("planner", { hold: { whose: "pool", reason: "all pool accounts are held", retryAt: now + 300_000 } })),
      Story.rejected(new PaceHeld({ whose: "pool", reason: "all pool accounts are held", retryAt: now + 300_000 })),
    ))

  test("the Codex account's hold, past its time, waits a second", () =>
    run(
      Story.clock(now),
      Story.when(start("verifier", { hold: { whose: "codex", reason: "weekly pace", retryAt: now - 5_000 } })),
      Story.rejected(new PaceHeld({ whose: "codex", reason: "weekly pace", retryAt: now + 1_000 })),
    ))

  test("a hold that names no time waits a minute", () =>
    run(
      Story.clock(now),
      Story.when(start(undefined, { hold: { whose: "pool", reason: "no room" } })),
      Story.rejected(new PaceHeld({ whose: "pool", reason: "no room", retryAt: now + 60_000 })),
    ))
})
