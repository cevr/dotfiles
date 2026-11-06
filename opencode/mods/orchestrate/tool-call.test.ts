// The ToolCall aggregate's stories: a subagent starts as the agent the guard
// routes it to, or latches while the Sabbath or the pace holds it; a latch is
// decided again when it opens; a follow-up is refused over the Sabbath or
// while its child is latched; another tool call in a subagent is refused over
// the Sabbath; a subagent call finishes.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Story from "@dotfiles/decider/story"
import { explain, KNOWLTON, resumesAt, SabbathRest } from "./sabbath.ts"
import {
  FinishSubagent,
  Finished,
  Latched,
  OpenLatch,
  PACE_POLL_MS,
  StartSubagent,
  Started,
  StillLatched,
  SubagentFinished,
  SubagentLatched,
  SubagentStarted,
  ToolCall,
  UseTool,
} from "./tool-call.ts"

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
const latched = (fields: Omit<SubagentLatched, "_tag" | "call" | "from">) => SubagentLatched.make({ call, from: "build", ...fields })
/** The latch for a planner's start, at its time, with what the guard gathered then. */
const open = (fields: Partial<OpenLatch> = {}) =>
  OpenLatch.make({ call, from: "build", agent: "planner", reason: "kept", child: "child-1", place: KNOWLTON, started: false, ...fields })

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

  test("a new subagent latches until work resumes, whatever its pace says", () =>
    run(
      Story.clock(FRIDAY_EVENING),
      Story.when(start("planner", { hold: { whose: "pool", reason: "held" }, description: "plan" })),
      Story.then(
        latched({ asked: "planner", agent: "planner", reason: "kept", description: "plan", hold: "sabbath", why: rest.why, opensAt: rest.resumesAt, recheckAt: rest.resumesAt }),
      ),
      Story.state(Latched.make({ agent: "planner", opensAt: rest.resumesAt })),
    ))

  test("a follow-up is refused, not latched", () =>
    run(Story.clock(FRIDAY_EVENING), Story.when(start(undefined, { child: "child-1", childAgent: "verifier" })), Story.rejected(rest)))

  test("a latch that opens over the Sabbath latches again until work resumes", () =>
    run(
      Story.clock(FRIDAY_EVENING),
      Story.when(open()),
      Story.then(
        latched({ agent: "planner", reason: "kept", child: "child-1", background: true, hold: "sabbath", why: rest.why, opensAt: rest.resumesAt, recheckAt: rest.resumesAt }),
      ),
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

  test("the pool's hold latches a new agent until the time it names, asked again every two minutes", () =>
    run(
      Story.clock(now),
      Story.when(start("planner", { hold: { whose: "pool", reason: "all pool accounts are held", retryAt: now + 300_000 } })),
      Story.then(
        latched({
          asked: "planner",
          agent: "planner",
          reason: "kept",
          hold: "pace",
          whose: "pool",
          why: "all pool accounts are held",
          opensAt: now + 300_000,
          recheckAt: now + PACE_POLL_MS,
        }),
      ),
    ))

  test("the Codex account's hold, past its time, opens in a second", () =>
    run(
      Story.clock(now),
      Story.when(start("verifier", { hold: { whose: "codex", reason: "weekly pace", retryAt: now - 5_000 } })),
      Story.then(
        latched({ asked: "verifier", agent: "verifier", reason: "kept", hold: "pace", whose: "codex", why: "weekly pace", opensAt: now + 1_000, recheckAt: now + 1_000 }),
      ),
    ))

  test("a hold that names no time opens in a minute", () =>
    run(
      Story.clock(now),
      Story.when(start(undefined, { hold: { whose: "pool", reason: "no room" } })),
      Story.then(latched({ agent: "worker", reason: "untyped", hold: "pace", whose: "pool", why: "no room", opensAt: now + 60_000, recheckAt: now + 60_000 })),
    ))
})

describe("a latch", () => {
  const now = Date.parse(WEDNESDAY)

  test("still held when it opens, it latches again with the new reason and time", () =>
    run(
      Story.clock(now),
      Story.when(open({ model: "anthropic/claude-opus#high", hold: { whose: "pool", reason: "anthropic is at 95%", retryAt: now + 900_000 } })),
      Story.then(
        latched({
          agent: "planner",
          reason: "kept",
          model: "anthropic/claude-opus#high",
          child: "child-1",
          background: true,
          hold: "pace",
          whose: "pool",
          why: "anthropic is at 95%",
          opensAt: now + 900_000,
          recheckAt: now + PACE_POLL_MS,
        }),
      ),
    ))

  test("admitted when it opens, it starts on its child in the background", () =>
    run(
      Story.clock(now),
      Story.when(open({ model: "anthropic/claude-opus#high", description: "plan the unit" })),
      Story.then(started({ agent: "planner", reason: "kept", model: "anthropic/claude-opus#high", child: "child-1", background: true, description: "plan the unit" })),
      Story.state(Started.make({ agent: "planner" })),
    ))

  test("a child that already ran starts nothing again", () => run(Story.clock(now), Story.when(open({ started: true })), Story.then()))

  test("a follow-up to a child still latched is refused, with when it opens", () =>
    run(
      Story.clock(now),
      Story.when(start("planner", { child: "child-1", childLatched: now + 300_000 })),
      Story.rejected(new StillLatched({ child: "child-1", opensAt: now + 300_000 })),
    ))
})

describe("Opus first, Codex second", () => {
  const now = Date.parse(WEDNESDAY)
  const OPUS = "anthropic/claude-opus#medium"
  const SOL = "openai/gpt-sol#medium"
  const poolHold = { whose: "pool" as const, reason: "anthropic is at 95%", retryAt: now + 900_000 }

  test("the pool admits it: it starts on Opus, and the fallback is never used", () =>
    run(
      Story.clock(now),
      Story.when(start("verifier", { model: OPUS, fallback: { model: SOL } })),
      Story.then(started({ asked: "verifier", agent: "verifier", reason: "kept", model: OPUS })),
    ))

  test("the pool holds Opus and Codex has room: it starts on Codex at once, saying why", () =>
    run(
      Story.clock(now),
      Story.when(start("verifier", { model: OPUS, hold: poolHold, fallback: { model: SOL }, description: "verifier sso r1" })),
      Story.then(
        started({
          asked: "verifier",
          agent: "verifier",
          reason: "kept",
          model: SOL,
          description: "verifier sso r1",
          fallback: `${OPUS} held: anthropic is at 95%`,
        }),
      ),
      Story.state(Started.make({ agent: "verifier" })),
    ))

  test("held on both, it latches on Opus when Opus opens first", () =>
    run(
      Story.clock(now),
      Story.when(start("planner", { model: OPUS, hold: poolHold, fallback: { model: SOL, hold: { whose: "codex", reason: "weekly pace", retryAt: now + 3_600_000 } } })),
      Story.then(
        latched({
          asked: "planner",
          agent: "planner",
          reason: "kept",
          model: OPUS,
          hold: "pace",
          whose: "pool",
          why: "anthropic is at 95%",
          opensAt: now + 900_000,
          recheckAt: now + PACE_POLL_MS,
        }),
      ),
    ))

  test("held on both, it latches on Codex when Codex opens first, saying why", () =>
    run(
      Story.clock(now),
      Story.when(start("planner", { model: OPUS, hold: poolHold, fallback: { model: SOL, hold: { whose: "codex", reason: "5h pace", retryAt: now + 300_000 } } })),
      Story.then(
        latched({
          asked: "planner",
          agent: "planner",
          reason: "kept",
          model: SOL,
          fallback: `${OPUS} held: anthropic is at 95%`,
          hold: "pace",
          whose: "codex",
          why: "5h pace",
          opensAt: now + 300_000,
          recheckAt: now + PACE_POLL_MS,
        }),
      ),
    ))

  test("over the Sabbath it latches on Opus until work resumes, whatever Codex says", () => {
    const friday = Date.parse(FRIDAY_EVENING)
    const rest = new SabbathRest({ resumesAt: resumesAt(friday, KNOWLTON)!, place: KNOWLTON })
    return run(
      Story.clock(friday),
      Story.when(start("planner", { model: OPUS, hold: poolHold, fallback: { model: SOL } })),
      Story.then(latched({ asked: "planner", agent: "planner", reason: "kept", model: OPUS, hold: "sabbath", why: rest.why, opensAt: rest.resumesAt, recheckAt: rest.resumesAt })),
    )
  })

  test("a follow-up never falls back: it continues its child where it runs", () =>
    run(
      Story.clock(now),
      Story.when(start("planner", { child: "child-1", hold: poolHold, fallback: { model: SOL } })),
      Story.then(latched({ asked: "planner", agent: "planner", reason: "kept", child: "child-1", hold: "pace", whose: "pool", why: "anthropic is at 95%", opensAt: now + 900_000, recheckAt: now + PACE_POLL_MS })),
    ))

  test("a latch tries Opus first when it opens", () =>
    run(
      Story.clock(now),
      Story.when(open({ model: OPUS, fallback: { model: SOL } })),
      Story.then(started({ agent: "planner", reason: "kept", model: OPUS, child: "child-1", background: true })),
    ))

  test("a latch still held on Opus opens on Codex when Codex has room", () =>
    run(
      Story.clock(now),
      Story.when(open({ model: OPUS, hold: poolHold, fallback: { model: SOL } })),
      Story.then(started({ agent: "planner", reason: "kept", model: SOL, child: "child-1", background: true, fallback: `${OPUS} held: anthropic is at 95%` })),
    ))
})
