// The IdleRoot aggregate's stories: a root that goes idle with units to move
// or a due batch, and nothing holding it, is nudged once, with one line;
// every hold keeps the nudge back and says why; only new input opens a new
// idle period; a draft holds it until it ends or goes stale; a batch is due at
// three ready units or the oldest ready for thirty minutes. Then the units a
// root's runs give, the line, and what the TUI reports.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Story from "@dotfiles/decider/story"
import {
  BATCH_WAIT_MS,
  cadenceOf,
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
  type MovingUnit,
  NO_HOLDS,
  NotNudged,
  Nudge,
  Nudged,
  type ReadyUnit,
  ReportDraft,
  reportsOf,
  riftOf,
  sinceOf,
  unitOf,
  unitsOf,
  WentIdle,
} from "./idle.ts"

const story = Story.make(IdleRoot)
const run = (...steps: Parameters<typeof story>) => Effect.runPromise(story(...steps))

const MOVING: ReadonlyArray<MovingUnit> = [
  { run: "p5", unit: "closure-flake", state: "implement" },
  { run: "p5", unit: "pkg-lower", state: "plan" },
]
const LINE = "idle with units in plan, implement or verify: closure-flake, pkg-lower; start them or name what you wait on."
const nudge = (
  fields: { readonly moving?: ReadonlyArray<MovingUnit>; readonly ready?: ReadonlyArray<ReadyUnit>; readonly holds?: Partial<Holds>; readonly resting?: boolean } = {},
) =>
  Nudge.make({ moving: fields.moving ?? MOVING, ready: fields.ready ?? [], holds: { ...NO_HOLDS, ...fields.holds }, resting: fields.resting ?? false })
const nudged = Nudged.make({ moving: MOVING, landing: [], line: LINE })
const idle: Event = WentIdle.make({ background: 0 })
const T = 1_800_000_000_000
const MINUTE = 60_000

describe("an idle root with units to move", () => {
  test("is nudged once with one line naming them", () =>
    run(
      Story.clock(T),
      Story.when(GoIdle.make({ background: 0 })),
      Story.then(idle),
      Story.when(nudge()),
      Story.then(nudged),
      Story.state({ phase: "nudged", background: 0, drafts: {} }),
    ))

  test("ready units short of the cadence add nothing to the line", () =>
    run(Story.clock(T), Story.given(idle), Story.when(nudge({ ready: [{ run: "p5", unit: "lexer", since: T - MINUTE }] })), Story.then(nudged)))

  test("is not nudged twice: going idle again after the nudge stays nudged", () =>
    run(
      Story.given<Event>(idle, nudged),
      Story.when(GoIdle.make({ background: 0 })),
      Story.then(idle),
      Story.state({ phase: "nudged", background: 0, drafts: {} }),
      Story.when(nudge()),
      Story.rejected(new NotNudged({ why: "nudged", detail: "nudged once this idle period" })),
    ))

  test("new input opens a new idle period, which may nudge again", () =>
    run(
      Story.given<Event>(idle, nudged),
      Story.when(Hear.make({})),
      Story.then(Heard.make({})),
      Story.when(GoIdle.make({ background: 0 })),
      Story.then(idle),
      Story.when(nudge()),
      Story.then(nudged),
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

  test("the Sabbath, nothing to move and no batch due, a wake, a question to the owner, a named wait", async () => {
    const cases: ReadonlyArray<readonly [Nudge, NotNudged]> = [
      [nudge({ resting: true }), new NotNudged({ why: "sabbath", detail: "no agent starts over the Sabbath" })],
      [nudge({ moving: [] }), new NotNudged({ why: "nothing-due", detail: "no run of its holds a unit in plan, implement or verify" })],
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
      Story.then(nudged),
    ))

  test("a draft no TUI reports again within its lifetime has gone", () =>
    run(
      Story.given<Event>(idle, DraftSeen.make({ client: "tui-1", at: T })),
      Story.clock(T + DRAFT_TTL_MS - 1),
      Story.when(nudge()),
      Story.rejected(new NotNudged({ why: "drafting", detail: "the owner is writing to it" })),
      Story.clock(T + DRAFT_TTL_MS),
      Story.when(nudge()),
      Story.then(nudged),
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

describe("a due batch", () => {
  const ready = (count: number, since?: number): ReadonlyArray<ReadyUnit> =>
    ["lexer", "parser", "docs"].slice(0, count).map((unit) => (since === undefined ? { run: "p5", unit } : { run: "p5", unit, since }))
  const LAND = 'land it with rift({ action: "land", rifts: ["lexer", "parser", "docs"] }).'

  test("three ready units are due at once, two are not", () =>
    run(
      Story.clock(T),
      Story.given(idle),
      Story.when(nudge({ moving: [], ready: ready(2, T) })),
      Story.rejected(
        new NotNudged({
          why: "nothing-due",
          detail: "no run of its holds a unit in plan, implement or verify, and its batch is not due: 2 ready, the oldest for 0 min (due at 3 or 30 min)",
        }),
      ),
      Story.when(nudge({ moving: [], ready: ready(3, T) })),
      Story.then(Nudged.make({ moving: [], landing: ready(3, T), line: `idle with a batch due (3 ready): lexer, parser, docs; ${LAND}` })),
    ))

  test("one ready unit is due once it has been ready thirty minutes, not a millisecond before", () =>
    run(
      Story.given(idle),
      Story.clock(T + BATCH_WAIT_MS - 1),
      Story.when(nudge({ moving: [], ready: ready(1, T) })),
      Story.rejected(
        new NotNudged({
          why: "nothing-due",
          detail: "no run of its holds a unit in plan, implement or verify, and its batch is not due: 1 ready, the oldest for 29 min (due at 3 or 30 min)",
        }),
      ),
      Story.clock(T + BATCH_WAIT_MS),
      Story.when(nudge({ moving: [], ready: ready(1, T) })),
      Story.then(
        Nudged.make({
          moving: [],
          landing: ready(1, T),
          line: 'idle with a batch due (lexer ready 30 min): lexer; land it with rift({ action: "land", rifts: ["lexer"] }).',
        }),
      ),
    ))

  test("the oldest of several decides, and a unit whose log has no time never ages", () =>
    run(
      Story.given(idle),
      Story.clock(T + BATCH_WAIT_MS + 5 * MINUTE),
      Story.when(nudge({ moving: [], ready: [{ run: "p5", unit: "lexer" }, { run: "p5", unit: "parser" }] })),
      Story.rejected(
        new NotNudged({ why: "nothing-due", detail: "no run of its holds a unit in plan, implement or verify, and its batch is not due: 2 ready (due at 3 or 30 min)" }),
      ),
      Story.when(nudge({ moving: [], ready: [{ run: "p5", unit: "lexer", since: T + 10 * MINUTE }, { run: "p5", unit: "parser", since: T }] })),
      Story.then(
        Nudged.make({
          moving: [],
          landing: [{ run: "p5", unit: "lexer", since: T + 10 * MINUTE }, { run: "p5", unit: "parser", since: T }],
          line: 'idle with a batch due (parser ready 35 min): lexer, parser; land it with rift({ action: "land", rifts: ["lexer", "parser"] }).',
        }),
      ),
    ))

  test("a due batch with units to move names both", () =>
    run(
      Story.clock(T),
      Story.given(idle),
      Story.when(nudge({ ready: ready(3) })),
      Story.then(Nudged.make({ moving: MOVING, landing: ready(3), line: `${LINE} A batch due (3 ready): lexer, parser, docs; ${LAND}` })),
    ))

  test("a unit's own cadence decides for it: one ready is due at once at `1 ready`, a longer wait holds past thirty minutes", () => {
    const hot: ReadyUnit = { run: "p5", unit: "hotfix", since: T, cadence: { ready: 1, waitMs: 30 * MINUTE } }
    const slow: ReadyUnit = { run: "p5", unit: "lexer", since: T, cadence: { ready: 4, waitMs: 60 * MINUTE } }
    return run(
      Story.given(idle),
      Story.clock(T + 45 * MINUTE),
      Story.when(nudge({ moving: [], ready: [slow] })),
      Story.rejected(
        new NotNudged({
          why: "nothing-due",
          detail: "no run of its holds a unit in plan, implement or verify, and its batch is not due: 1 ready, the oldest for 45 min (due at 4 or 60 min)",
        }),
      ),
      Story.when(nudge({ moving: [], ready: [slow, { ...slow, unit: "parser" }, { ...slow, unit: "docs" }] })),
      Story.rejected(
        new NotNudged({
          why: "nothing-due",
          detail: "no run of its holds a unit in plan, implement or verify, and its batch is not due: 3 ready, the oldest for 45 min (due at 4 or 60 min)",
        }),
      ),
      Story.when(nudge({ moving: [], ready: [slow, hot] })),
      Story.then(
        Nudged.make({ moving: [], landing: [slow, hot], line: 'idle with a batch due (2 ready): lexer, hotfix; land it with rift({ action: "land", rifts: ["lexer", "hotfix"] }).' }),
      ),
    )
  })

  test("a shorter wait of its own is due before thirty minutes", () => {
    const quick: ReadyUnit = { run: "p5", unit: "lexer", since: T, cadence: { ready: 3, waitMs: 10 * MINUTE } }
    return run(
      Story.given(idle),
      Story.clock(T + 10 * MINUTE),
      Story.when(nudge({ moving: [], ready: [quick] })),
      Story.then(Nudged.make({ moving: [], landing: [quick], line: 'idle with a batch due (lexer ready 10 min): lexer; land it with rift({ action: "land", rifts: ["lexer"] }).' })),
    )
  })

  test("a due batch is held like any nudge: by a wake, a question or a named wait", () =>
    run(
      Story.given(idle),
      Story.when(nudge({ moving: [], ready: ready(3), holds: { wakes: 1 } })),
      Story.rejected(new NotNudged({ why: "wake", detail: "1 wake, monitor or latch set" })),
    ))
})

describe("the units and the line", () => {
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
        { unit: "fmt", state: "ready", since: "2026-11-06T10:00Z", cadence: "1 ready or 15 min" },
        { unit: "lint", state: "ready", since: "garbled" },
      ],
    },
    { name: "hymnapp", units: [{ unit: "audio", state: "implement" }] },
  ]

  test("a run is the root's once it started a step of any of its units; plan, implement and verify move, ready waits for its batch", () => {
    expect(unitsOf(runs, ["parser"])).toEqual({
      moving: [
        { run: "p5", unit: "closure-flake", state: "implement" },
        { run: "p5", unit: "pkg-lower", state: "plan" },
        { run: "p5", unit: "lexer", state: "verify" },
      ],
      ready: [
        { run: "p5", unit: "fmt", since: Date.parse("2026-11-06T10:00:00Z"), cadence: { ready: 1, waitMs: 15 * MINUTE } },
        { run: "p5", unit: "lint" },
      ],
    })
    expect(unitsOf(runs, ["someone-elses"])).toEqual({ moving: [], ready: [] })
    expect(unitsOf(runs, [])).toEqual({ moving: [], ready: [] })
  })

  test("a log.md time reads as UTC, with or without its Z; anything else is no time", () => {
    expect(sinceOf("2026-11-06T10:00Z")).toBe(Date.parse("2026-11-06T10:00:00Z"))
    expect(sinceOf("2026-11-06T10:00")).toBe(Date.parse("2026-11-06T10:00:00Z"))
    expect(sinceOf("")).toBeUndefined()
    expect(sinceOf(undefined)).toBeUndefined()
    expect(sinceOf("garbled")).toBeUndefined()
  })

  test("the status script's cadence reads as counts and a wait; anything else is the default", () => {
    expect(cadenceOf("2 ready or 45 min")).toEqual({ ready: 2, waitMs: 45 * MINUTE })
    expect(cadenceOf("0 ready or 0 min")).toEqual({ ready: 1, waitMs: 0 })
    expect(cadenceOf(undefined)).toBeUndefined()
    expect(cadenceOf("override: lands with hskokoro")).toBeUndefined()
  })

  test("a unit's Rift is the one the orchestrator made for it, named after the unit, as the rift tool finds it by name", () => {
    // SKILL.md, plan: `.rifts/<repo>/<unit>` on branch `<run>/<unit>`; the tool matches a name to a Rift's directory.
    expect(riftOf({ run: "hymnapp", unit: "hskokoro" })).toBe("hskokoro")
  })

  test("names the units, by run when they come from more than one, and counts past eight", () => {
    expect(lineOf({ moving: unitsOf(runs, ["parser"]).moving })).toBe(
      "idle with units in plan, implement or verify: closure-flake, pkg-lower, lexer; start them or name what you wait on.",
    )
    expect(lineOf({ moving: unitsOf(runs, ["parser", "audio"]).moving })).toBe(
      "idle with units in plan, implement or verify: p5/closure-flake, p5/pkg-lower, p5/lexer, hymnapp/audio; start them or name what you wait on.",
    )
    const many = Array.from({ length: 10 }, (_, n) => ({ run: "r", unit: `u${n}`, state: "plan" }))
    expect(lineOf({ moving: many })).toBe(
      "idle with units in plan, implement or verify: u0, u1, u2, u3, u4, u5, u6, u7 and 2 more; start them or name what you wait on.",
    )
  })

  test("the land call names every ready unit's Rift, past the eight the line lists", () => {
    const many = Array.from({ length: 9 }, (_, n) => ({ run: "r", unit: `u${n}` }))
    expect(lineOf({ moving: [], landing: { units: many, why: "9 ready" } })).toBe(
      `idle with a batch due (9 ready): u0, u1, u2, u3, u4, u5, u6, u7 and 1 more; land it with rift({ action: "land", rifts: [${many.map((unit) => `"${unit.unit}"`).join(", ")}] }).`,
    )
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
