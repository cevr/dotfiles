// The IdleRoot aggregate's stories: a root that goes idle with ready units
// and nothing holding it is nudged once, with one line; every hold keeps the
// nudge back and says why; only new input opens a new idle period; a draft
// holds it until it ends or goes stale. Then the ready units a root's runs
// give, the line, and what the TUI reports.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Story from "@dotfiles/decider/story"
import {
  DRAFT_TTL_MS,
  DraftCleared,
  DraftSeen,
  type Event,
  GoIdle,
  HEARTBEAT_MS,
  Hear,
  Heard,
  type Holds,
  IdleRoot,
  lineOf,
  NO_HOLDS,
  NotNudged,
  Nudge,
  Nudged,
  type ReadyUnit,
  readyUnits,
  ReportDraft,
  reportsOf,
  unitOf,
  WentIdle,
} from "./idle.ts"

const story = Story.make(IdleRoot)
const run = (...steps: Parameters<typeof story>) => Effect.runPromise(story(...steps))

const READY: ReadonlyArray<ReadyUnit> = [
  { run: "p5", unit: "closure-flake", state: "implement" },
  { run: "p5", unit: "pkg-lower", state: "plan" },
]
const LINE = "idle with units ready: closure-flake, pkg-lower; start them or name what you wait on."
const nudge = (fields: { readonly ready?: ReadonlyArray<ReadyUnit>; readonly holds?: Partial<Holds>; readonly resting?: boolean } = {}) =>
  Nudge.make({ ready: fields.ready ?? READY, holds: { ...NO_HOLDS, ...fields.holds }, resting: fields.resting ?? false })
const idle: Event = WentIdle.make({ background: 0 })
const T = 1_800_000_000_000

describe("an idle root with ready units", () => {
  test("is nudged once with one line naming them", () =>
    run(
      Story.clock(T),
      Story.when(GoIdle.make({ background: 0 })),
      Story.then(idle),
      Story.when(nudge()),
      Story.then(Nudged.make({ units: READY, line: LINE })),
      Story.state({ phase: "nudged", background: 0, drafts: {} }),
    ))

  test("is not nudged twice: going idle again after the nudge stays nudged", () =>
    run(
      Story.given<Event>(idle, Nudged.make({ units: READY, line: LINE })),
      Story.when(GoIdle.make({ background: 0 })),
      Story.then(idle),
      Story.state({ phase: "nudged", background: 0, drafts: {} }),
      Story.when(nudge()),
      Story.rejected(new NotNudged({ why: "nudged", detail: "nudged once this idle period" })),
    ))

  test("new input opens a new idle period, which may nudge again", () =>
    run(
      Story.given<Event>(idle, Nudged.make({ units: READY, line: LINE })),
      Story.when(Hear.make({})),
      Story.then(Heard.make({})),
      Story.when(GoIdle.make({ background: 0 })),
      Story.then(idle),
      Story.when(nudge()),
      Story.then(Nudged.make({ units: READY, line: LINE })),
    ))

  test("input while it works records nothing; a nudge decided after new input is refused", () =>
    run(
      Story.when(Hear.make({})),
      Story.then(),
      Story.given<Event>(idle, Heard.make({})),
      Story.when(nudge()),
      Story.rejected(new NotNudged({ why: "working", detail: "new input came after it went idle" })),
    ))
})

describe("what holds the nudge back", () => {
  test("a subagent or shell still running under it", () =>
    run(
      Story.when(GoIdle.make({ background: 2 })),
      Story.then(WentIdle.make({ background: 2 })),
      Story.when(nudge()),
      Story.rejected(new NotNudged({ why: "background", detail: "2 subagent or shell still running" })),
    ))

  test("the Sabbath, no ready unit, a wake, a question to the owner, a named wait", async () => {
    const cases: ReadonlyArray<readonly [Nudge, NotNudged]> = [
      [nudge({ resting: true }), new NotNudged({ why: "sabbath", detail: "no agent starts over the Sabbath" })],
      [nudge({ ready: [] }), new NotNudged({ why: "nothing-ready", detail: "no run of its holds a unit in plan, implement or verify" })],
      [nudge({ holds: { wakes: 1 } }), new NotNudged({ why: "wake", detail: "1 wake, monitor or latch set" })],
      [nudge({ holds: { questions: 1 } }), new NotNudged({ why: "question", detail: "1 open question" })],
      [nudge({ holds: { needsYou: ["Pick the export format"] } }), new NotNudged({ why: "question", detail: "Pick the export format" })],
      [nudge({ holds: { waits: ["owner review of p5 (pr 12)"] } }), new NotNudged({ why: "wait-named", detail: "owner review of p5 (pr 12)" })],
    ]
    for (const [command, rejection] of cases) await run(Story.given(idle), Story.when(command), Story.rejected(rejection))
  })

  test("the owner drafting a prompt to it, until the draft ends", () =>
    run(
      Story.clock(T),
      Story.given(idle),
      Story.when(ReportDraft.make({ client: "tui-1", drafting: true })),
      Story.then(DraftSeen.make({ client: "tui-1", at: T })),
      Story.when(nudge()),
      Story.rejected(new NotNudged({ why: "drafting", detail: "the owner is writing to it" })),
      Story.when(ReportDraft.make({ client: "tui-1", drafting: false })),
      Story.then(DraftCleared.make({ client: "tui-1" })),
      Story.when(nudge()),
      Story.then(Nudged.make({ units: READY, line: LINE })),
    ))

  test("a draft no TUI reports again within its lifetime has gone", () =>
    run(
      Story.given<Event>(idle, DraftSeen.make({ client: "tui-1", at: T })),
      Story.clock(T + DRAFT_TTL_MS - 1),
      Story.when(nudge()),
      Story.rejected(new NotNudged({ why: "drafting", detail: "the owner is writing to it" })),
      Story.clock(T + DRAFT_TTL_MS),
      Story.when(nudge()),
      Story.then(Nudged.make({ units: READY, line: LINE })),
    ))

  test("one TUI's draft ending leaves another's; a TUI with no draft out clears nothing", () =>
    run(
      Story.clock(T),
      Story.given<Event>(idle, DraftSeen.make({ client: "tui-1", at: T }), DraftSeen.make({ client: "tui-2", at: T })),
      Story.when(ReportDraft.make({ client: "tui-1", drafting: false })),
      Story.then(DraftCleared.make({ client: "tui-1" })),
      Story.when(ReportDraft.make({ client: "tui-1", drafting: false })),
      Story.then(),
      Story.when(nudge()),
      Story.rejected(new NotNudged({ why: "drafting", detail: "the owner is writing to it" })),
    ))
})

describe("the ready units and the line", () => {
  const runs = [
    {
      name: "p5",
      units: [
        { unit: "closure-flake", state: "implement" },
        { unit: "pkg-lower", state: "plan" },
        { unit: "lexer", state: "verify" },
        { unit: "parser", state: "merged abc1234" },
        { unit: "docs", state: "waiting(pr)" },
        { unit: "cli", state: "stuck(quota)" },
      ],
    },
    { name: "hymnapp", units: [{ unit: "audio", state: "implement" }] },
  ]

  test("a run is the root's once it started a step of any of its units; only plan, implement and verify are ready", () => {
    expect(readyUnits(runs, ["parser"])).toEqual([
      { run: "p5", unit: "closure-flake", state: "implement" },
      { run: "p5", unit: "pkg-lower", state: "plan" },
      { run: "p5", unit: "lexer", state: "verify" },
    ])
    expect(readyUnits(runs, ["someone-elses"])).toEqual([])
    expect(readyUnits(runs, [])).toEqual([])
  })

  test("names the units, by run when they come from more than one, and counts past eight", () => {
    expect(lineOf(readyUnits(runs, ["parser"]))).toBe("idle with units ready: closure-flake, pkg-lower, lexer; start them or name what you wait on.")
    expect(lineOf(readyUnits(runs, ["parser", "audio"]))).toBe(
      "idle with units ready: p5/closure-flake, p5/pkg-lower, p5/lexer, hymnapp/audio; start them or name what you wait on.",
    )
    const many = Array.from({ length: 10 }, (_, n) => ({ run: "r", unit: `u${n}`, state: "plan" }))
    expect(lineOf(many)).toBe("idle with units ready: u0, u1, u2, u3, u4, u5, u6, u7 and 2 more; start them or name what you wait on.")
  })

  test("a step's unit is the first word after its role", () => {
    expect(unitOf("closure-flake r1 (Opus)")).toBe("closure-flake")
    expect(unitOf("  pkg-lower r2")).toBe("pkg-lower")
    expect(unitOf("")).toBeUndefined()
  })
})

describe("what the TUI reports", () => {
  test("a new draft, again each heartbeat while it stays, and its end", () => {
    expect(reportsOf(undefined, { sessionID: "root", drafting: false }, T)).toEqual([])
    expect(reportsOf(undefined, { sessionID: undefined, drafting: true }, T)).toEqual([])
    expect(reportsOf(undefined, { sessionID: "root", drafting: true }, T)).toEqual([{ sessionID: "root", drafting: true }])
    expect(reportsOf({ sessionID: "root", at: T }, { sessionID: "root", drafting: true }, T + HEARTBEAT_MS - 1)).toEqual([])
    expect(reportsOf({ sessionID: "root", at: T }, { sessionID: "root", drafting: true }, T + HEARTBEAT_MS)).toEqual([{ sessionID: "root", drafting: true }])
    expect(reportsOf({ sessionID: "root", at: T }, { sessionID: "root", drafting: false }, T + 1)).toEqual([{ sessionID: "root", drafting: false }])
  })

  test("moving to another root clears the draft to the first; leaving every session clears it", () => {
    expect(reportsOf({ sessionID: "root", at: T }, { sessionID: "other", drafting: true }, T + 1)).toEqual([
      { sessionID: "root", drafting: false },
      { sessionID: "other", drafting: true },
    ])
    expect(reportsOf({ sessionID: "root", at: T }, { sessionID: undefined, drafting: true }, T + 1)).toEqual([{ sessionID: "root", drafting: false }])
  })
})
