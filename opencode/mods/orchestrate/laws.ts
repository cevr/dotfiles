// What every implementation of a contract in service.ts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, type Scope } from "effect"
import type { CallLine } from "./call-line.ts"
import { DEFAULTS, type Windows } from "./compaction.ts"
import { type ModelRef, type Pace, paceOfReply } from "./pace.ts"
import { type Holds, NO_HOLDS, type Run } from "./idle.ts"
import {
  CallLog,
  CodexAdmission,
  CompactionWindows,
  type LatchRequest,
  Latches,
  type LatchStart,
  Models,
  type Offered,
  PoolPace,
  RootHolds,
  Runs,
  Sessions,
  Steer,
  StepLog,
} from "./service.ts"

const check = <A, E, R>(layer: Layer.Layer<R>, body: Effect.Effect<A, E, R>) =>
  Effect.runPromise(body.pipe(Effect.provide(layer)))

// ── CallLog ──

/** A call log under test: its Layer, and the lines it holds now, read back. */
export interface CallLogProbe {
  readonly layer: Layer.Layer<CallLog>
  readonly written: Effect.Effect<ReadonlyArray<unknown>>
}

const lines: ReadonlyArray<CallLine> = [
  {
    kind: "call",
    at: "2026-11-04T15:00:00.000Z",
    sessionID: "ses_law",
    callID: "call-1",
    from: "build",
    asked: "general",
    agent: "worker",
    reason: "general",
    model: "anthropic/claude-haiku#high",
    background: true,
    description: "law",
    pace: { ok: true, measured: true, reason: "room" },
    codex: { failOpen: "no admission line (exit 2)" },
  },
  { kind: "done", at: "2026-11-04T15:01:00.000Z", sessionID: "ses_law", callID: "call-1", child: "ses_child", status: "running" },
  { kind: "denied", at: "2026-11-04T15:02:00.000Z", sessionID: "ses_law", callID: "call-2", tool: "subagent", why: "held" },
]

/** `make` gives a fresh, empty call log within the test's scope. */
export const callLogLaws = (name: string, make: Effect.Effect<CallLogProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the CallLog laws`, () => {
    test("holds every appended line, in order", () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const probe = yield* make
            yield* Effect.gen(function* () {
              const log = yield* CallLog
              for (const line of lines) yield* log.append(line)
            }).pipe(Effect.provide(probe.layer))
            expect(yield* probe.written).toEqual([...lines])
          }),
        ),
      ))

    test("a fresh log holds nothing", () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            expect(yield* (yield* make).written).toEqual([])
          }),
        ),
      ))
  })

// ── Sessions ──

/** The sessions a host knows, by id; any other cannot be read. */
export type SessionsWorld = Readonly<
  Record<string, { readonly parentID?: string; readonly agent?: string; readonly started?: boolean; readonly latch?: unknown }>
>

export const sessionsLaws = (name: string, layer: (world: SessionsWorld) => Layer.Layer<Sessions>) =>
  describe(`${name} keeps the Sessions laws`, () => {
    const world: SessionsWorld = {
      root: { agent: "build" },
      child: { parentID: "root", agent: "verifier" },
      blank: { parentID: "", agent: "" },
      ran: { parentID: "root", agent: "worker", started: true },
      latched: { parentID: "root", agent: "worker", latch: { hold: "pace", reason: "held", opensAt: 9_000, at: 1_000 } },
      cancelled: { parentID: "root", agent: "worker", latch: { hold: "pace", reason: "held", opensAt: 9_000, at: 1_000, cancelledAt: 2_000 } },
      failed: { parentID: "root", agent: "worker", latch: { hold: "sabbath", reason: "rest", opensAt: 9_000, at: 1_000, failed: "gone" } },
      marred: { parentID: "root", agent: "worker", latch: { opensAt: "soon" } },
    }

    test("a session's parent and agent are what the host knows", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const sessions = yield* Sessions
          expect(yield* sessions.parentOf("child")).toBe("root")
          expect(yield* sessions.agentOf("child")).toBe("verifier")
          expect(yield* sessions.parentOf("root")).toBeUndefined()
          expect(yield* sessions.agentOf("root")).toBe("build")
        }),
      ))

    test("an empty parent or agent is none", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const sessions = yield* Sessions
          expect(yield* sessions.parentOf("blank")).toBeUndefined()
          expect(yield* sessions.agentOf("blank")).toBeUndefined()
        }),
      ))

    test("a session that ran a turn has started; one made and never prompted has not", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const sessions = yield* Sessions
          expect(yield* sessions.startedOf("ran")).toBe(true)
          expect(yield* sessions.startedOf("latched")).toBe(false)
        }),
      ))

    test("a latched child opens when its mark says; cancelled, failed, unmarked or a mark that does not read is none", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const sessions = yield* Sessions
          expect(yield* sessions.latchOf("latched")).toBe(9_000)
          for (const id of ["cancelled", "failed", "ran", "marred"]) expect(yield* sessions.latchOf(id)).toBeUndefined()
        }),
      ))

    test("a session the host cannot read answers none, without failing", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const sessions = yield* Sessions
          expect(yield* sessions.parentOf("missing")).toBeUndefined()
          expect(yield* sessions.agentOf("missing")).toBeUndefined()
          expect(yield* sessions.startedOf("missing")).toBe(false)
          expect(yield* sessions.latchOf("missing")).toBeUndefined()
        }),
      ))
  })

// ── Models ──

/** A host whose sessions run on `model`, offered at `variants`, no model at all when absent; `others` it offers too. */
export interface ModelsWorld {
  readonly model?: ModelRef
  readonly variants: ReadonlyArray<string>
  readonly others?: ReadonlyArray<Offered>
}

export const modelsLaws = (name: string, layer: (world: ModelsWorld) => Layer.Layer<Models>) =>
  describe(`${name} keeps the Models laws`, () => {
    const model = { providerID: "anthropic", id: "claude-haiku" }

    test("a new subagent runs on the session's model, at a variant the model offers", () =>
      check(
        layer({ model, variants: ["high", "low"] }),
        Effect.gen(function* () {
          const models = yield* Models
          expect(yield* models.base("ses_law", "planner")).toEqual(model)
          expect(yield* models.variant("ses_law", "planner", "high")).toBe("anthropic/claude-haiku#high")
        }),
      ))

    test("a variant the model does not offer is none", () =>
      check(
        layer({ model, variants: ["low"] }),
        Effect.gen(function* () {
          expect(yield* (yield* Models).variant("ses_law", "planner", "high")).toBeUndefined()
        }),
      ))

    test("no model is none, for the base and every variant", () =>
      check(
        layer({ variants: ["high"] }),
        Effect.gen(function* () {
          const models = yield* Models
          expect(yield* models.base("ses_law", "planner")).toBeUndefined()
          expect(yield* models.variant("ses_law", "planner", "high")).toBeUndefined()
        }),
      ))

    const sol = (id: string, released: number, fields: Partial<Offered> = {}): Offered => ({
      providerID: "openai",
      id,
      family: "gpt-sol",
      time: { released },
      variants: [{ id: "high" }, { id: "medium" }],
      ...fields,
    })

    test("the newest of a family is the latest release on the providers asked, never a deprecated one", () =>
      check(
        layer({
          model,
          variants: [],
          others: [
            sol("gpt-6-sol", 1),
            sol("gpt-6.1-sol", 2),
            sol("gpt-7-sol", 3, { status: "deprecated" }),
            sol("gpt-8-sol", 4, { providerID: "other" }),
            sol("gpt-6-luna", 5, { family: "gpt-luna" }),
          ],
        }),
        Effect.gen(function* () {
          const models = yield* Models
          expect(yield* models.newest("ses_law", ["openai"], "gpt-sol", "high")).toBe("openai/gpt-6.1-sol#high")
          expect(yield* models.newest("ses_law", ["openai", "other"], "gpt-sol", "high")).toBe("other/gpt-8-sol#high")
        }),
      ))

    test("the newest at a variant it does not offer is the bare model; a family not offered is none", () =>
      check(
        layer({ model, variants: [], others: [sol("gpt-6-sol", 1)] }),
        Effect.gen(function* () {
          const models = yield* Models
          expect(yield* models.newest("ses_law", ["openai"], "gpt-sol", "max")).toBe("openai/gpt-6-sol")
          expect(yield* models.newest("ses_law", ["openai"], "gpt-luna", "max")).toBeUndefined()
        }),
      ))
  })

// ── PoolPace ──

/** The pool's answer by provider; a provider it has none for is unpaced. */
export type PoolPaceWorld = Readonly<Record<string, Pace>>

export const poolPaceLaws = (name: string, layer: (world: PoolPaceWorld) => Layer.Layer<PoolPace>) =>
  describe(`${name} keeps the PoolPace laws`, () => {
    const held: Pace = { ok: false, measured: true, reason: "all pool accounts are held", retryAt: 9_000 }
    const open: Pace = { ok: true, measured: false, reason: "room" }

    test("answers the pool's pace for each provider", () =>
      check(
        layer({ anthropic: held, openai: open }),
        Effect.gen(function* () {
          const pool = yield* PoolPace
          expect(yield* pool.pace("anthropic")).toEqual({ _tag: "Answered", pace: held })
          expect(yield* pool.pace("openai")).toEqual({ _tag: "Answered", pace: open })
        }),
      ))

    test("a provider the pool has no answer for is not held, without failing", () =>
      check(
        layer({ anthropic: held }),
        Effect.gen(function* () {
          expect(paceOfReply(yield* (yield* PoolPace).pace("google"))?.ok).not.toBe(false)
        }),
      ))

    test("telling it of a new agent never fails, for a provider it has no answer for too", () =>
      check(
        layer({ anthropic: held }),
        Effect.gen(function* () {
          const pool = yield* PoolPace
          yield* pool.started("anthropic")
          yield* pool.started("google")
        }),
      ))
  })

// ── CodexAdmission ──

/**
 * The admission script's answers by model and role, as the script can say
 * them: measured, and a hold's time to the minute. A model and role not
 * listed has no answer.
 */
export type CodexWorld = ReadonlyArray<{ readonly model: string; readonly role: string; readonly answer: Pace | undefined }>

export const codexAdmissionLaws = (name: string, layer: (world: CodexWorld) => Layer.Layer<CodexAdmission>) =>
  describe(`${name} keeps the CodexAdmission laws`, () => {
    const world: CodexWorld = [
      { model: "gpt-5", role: "planner", answer: { ok: true, measured: true, reason: "room for 3" } },
      {
        model: "gpt-5",
        role: "none",
        answer: { ok: false, measured: true, reason: "weekly pace", retryAt: Date.parse("2026-11-04T18:30:00Z") },
      },
      { model: "gpt-5-mini", role: "worker", answer: { ok: false, measured: true, reason: "no room" } },
      { model: "gpt-5-nano", role: "worker", answer: undefined },
    ]

    test("answers the script's admission for each model and role", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const codex = yield* CodexAdmission
          for (const { model, role, answer } of world) {
            const reply = yield* codex.admit(model, role)
            if (answer === undefined) expect(reply._tag).toBe("FailedOpen")
            else expect(reply).toEqual({ _tag: "Answered", pace: answer })
          }
        }),
      ))

    test("a model and role the script has no answer for fails open, saying why", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const reply = yield* (yield* CodexAdmission).admit("gpt-5", "verifier")
          expect(reply._tag).toBe("FailedOpen")
          expect(reply._tag === "FailedOpen" ? reply.why : "").not.toBe("")
        }),
      ))
  })

// ── Latches ──

/** Latches under test: wakes that keep each latch, or refuse with `refuse`; a start that runs, or fails with `fail`. */
export interface LatchesWorld {
  readonly refuse?: string
  readonly fail?: string
}

const request: LatchRequest = {
  parent: "ses_parent",
  from: "build",
  messageID: "msg_1",
  callID: "call-1",
  agent: "implementor",
  description: "Add the export",
  prompt: "Add the CSV export.",
  model: "anthropic/claude-opus#high",
  hold: "pace",
  why: "anthropic is at 92% of its 5h window",
  opensAt: 9_000,
  recheckAt: 5_000,
  context: { reason: "kept" },
}

const opening = (child: string): LatchStart => ({
  parent: "ses_parent",
  from: "build",
  messageID: "msg_1",
  callID: "call-1",
  child,
  agent: "implementor",
  description: "Add the export",
  prompt: "Add the CSV export.",
  model: "anthropic/claude-opus#high",
})

export const latchesLaws = (name: string, layer: (world: LatchesWorld) => Layer.Layer<Latches>) =>
  describe(`${name} keeps the Latches laws`, () => {
    test("each latch kept has its own id and child", () =>
      check(
        layer({}),
        Effect.gen(function* () {
          const latches = yield* Latches
          const first = yield* latches.latch(request)
          const second = yield* latches.latch({ ...request, callID: "call-2" })
          expect(first.id).not.toBe(second.id)
          expect(first.child).not.toBe(second.child)
        }),
      ))

    test("a latch the wakes will not keep is refused, with their reason", () =>
      check(
        layer({ refuse: "this session has no room" }),
        Effect.gen(function* () {
          const refused = yield* Effect.flip((yield* Latches).latch(request))
          expect(refused._tag).toBe("LatchRefused")
          expect(refused.reason).toBe("this session has no room")
        }),
      ))

    test("a latched child starts; a start that fails says why", async () => {
      await check(
        layer({}),
        Effect.gen(function* () {
          yield* (yield* Latches).start(opening("ses_child"))
        }),
      )
      await check(
        layer({ fail: "Unknown agent: implementor" }),
        Effect.gen(function* () {
          const failed = yield* Effect.flip((yield* Latches).start(opening("ses_child")))
          expect(failed._tag).toBe("StartFailed")
          expect(failed.message).toContain("Unknown agent: implementor")
        }),
      )
    })
  })

// ── CompactionWindows ──

/** compact.json's text, or no file. */
export type WindowsWorld = string | undefined

export const compactionWindowsLaws = (name: string, layer: (world: WindowsWorld) => Layer.Layer<CompactionWindows>) =>
  describe(`${name} keeps the CompactionWindows laws`, () => {
    const read = (world: WindowsWorld) =>
      check(
        layer(world),
        Effect.gen(function* () {
          return yield* (yield* CompactionWindows).read
        }),
      )

    test("compact.json's windows, capped, and the defaults for the kinds it leaves out", async () => {
      const tuned: Windows = { ...DEFAULTS, planner: 50_000, worker: 150_000, root: 600_000 }
      expect(await read(JSON.stringify({ windows: { planner: 50_000, worker: 150_000, root: 600_000, verifier: 900_000 } }))).toEqual(tuned)
    })

    test("no file, or a broken one, gives the defaults", async () => {
      expect(await read(undefined)).toEqual(DEFAULTS)
      expect(await read("{")).toEqual(DEFAULTS)
    })
  })

// ── StepLog ──

/** The units each session started a step of, in order, repeats included. */
export type StepWorld = Readonly<Record<string, ReadonlyArray<string>>>

export const stepLogLaws = (name: string, layer: (world: StepWorld) => Layer.Layer<StepLog>) =>
  describe(`${name} keeps the StepLog laws`, () => {
    test("a session's units are the ones it started steps of, once each, in the order first started", () =>
      check(
        layer({ root: ["alpha", "beta", "alpha", "gamma"], other: ["delta"] }),
        Effect.gen(function* () {
          const log = yield* StepLog
          expect(yield* log.units("root")).toEqual(["alpha", "beta", "gamma"])
          expect(yield* log.units("other")).toEqual(["delta"])
        }),
      ))

    test("a session that started no step has none", () =>
      check(
        layer({}),
        Effect.gen(function* () {
          expect(yield* (yield* StepLog).units("root")).toEqual([])
        }),
      ))
  })

// ── Runs ──

/** What the runs' source answers: runs of units with their states, or nothing it can give. */
export type RunsWorld = ReadonlyArray<Run> | "unreadable"

export const runsLaws = (name: string, layer: (world: RunsWorld) => Layer.Layer<Runs>) =>
  describe(`${name} keeps the Runs laws`, () => {
    const runs: ReadonlyArray<Run> = [
      { name: "p1", units: [{ unit: "alpha", state: "implement" }, { unit: "beta", state: "merged 1234567" }] },
      { name: "p2", units: [] },
    ]
    test("the runs, each with its units' states, in order", () =>
      check(
        layer(runs),
        Effect.gen(function* () {
          expect(yield* (yield* Runs).list).toEqual(runs)
        }),
      ))

    test("runs that cannot be read are none, without failing", () =>
      check(
        layer("unreadable"),
        Effect.gen(function* () {
          expect(yield* (yield* Runs).list).toEqual([])
        }),
      ))
  })

// ── RootHolds ──

/** What the other plugins hold, by session; `unreadable` when none of them can be asked. */
export type HoldsWorld = Readonly<Record<string, Holds>> | "unreadable"

export const rootHoldsLaws = (name: string, layer: (world: HoldsWorld) => Layer.Layer<RootHolds>) =>
  describe(`${name} keeps the RootHolds laws`, () => {
    const held: Holds = { wakes: 2, questions: 1, needsYou: ["Pick the export format"], waits: ["CI on the PR (pr 12)"] }
    test("a session's wakes, questions, needs and waits; another session's are not its", () =>
      check(
        layer({ root: held, other: { ...NO_HOLDS, wakes: 5 } }),
        Effect.gen(function* () {
          const holds = yield* RootHolds
          expect(yield* holds.of("root")).toEqual(held)
          expect(yield* holds.of("quiet")).toEqual(NO_HOLDS)
        }),
      ))

    test("plugins that cannot be asked hold nothing", () =>
      check(
        layer("unreadable"),
        Effect.gen(function* () {
          expect(yield* (yield* RootHolds).of("root")).toEqual(NO_HOLDS)
        }),
      ))
  })

// ── Steer ──

/** A host whose sessions take messages, recording each in `sent`, or refuse with `refuse`. */
export interface SteerWorld {
  readonly refuse?: string
}

/** `make` gives the Steer on `world` and the lines it delivered, by session. */
export const steerLaws = (
  name: string,
  make: (world: SteerWorld) => { readonly layer: Layer.Layer<Steer>; readonly sent: () => ReadonlyArray<{ readonly sessionID: string; readonly line: string }> },
) =>
  describe(`${name} keeps the Steer laws`, () => {
    test("a nudge reaches its session with its line", async () => {
      const probe = make({})
      await check(
        probe.layer,
        Effect.gen(function* () {
          yield* (yield* Steer).nudge("root", "idle with units ready: alpha; start them or name what you wait on.")
        }),
      )
      expect(probe.sent()).toEqual([{ sessionID: "root", line: "idle with units ready: alpha; start them or name what you wait on." }])
    })

    test("a nudge the host refuses fails, saying why", () =>
      check(
        make({ refuse: "session not found" }).layer,
        Effect.gen(function* () {
          const refused = yield* Effect.flip((yield* Steer).nudge("root", "line"))
          expect(refused._tag).toBe("NudgeRefused")
          expect(refused.message).toContain("session not found")
        }),
      ))
  })
