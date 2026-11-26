// What every implementation of a contract in service.ts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Layer, Option, type Scope } from "effect"
import type { CallLine } from "./call-line.ts"
import { type ModelRef, type Pace, paceOfReply } from "./pace.ts"
import { type Holds, NO_HOLDS, type Run } from "./idle.ts"
import { type Actor, type Command, Command as Commands, EMPTY, fold, type RecordEvent } from "./record.ts"
import {
  CallLog,
  CodexAdmission,
  CommitmentRecord,
  type LatchRequest,
  Latches,
  type LatchStart,
  MainLine,
  Models,
  type Offered,
  PoolPace,
  RootHolds,
  RunFiles,
  Runs,
  Sessions,
  Steer,
  StepLog,
  UnitLogs,
} from "./service.ts"

const check = <A, E, R>(layer: Layer.Layer<R>, body: Effect.Effect<A, E, R>) =>
  Effect.runPromise(body.pipe(Effect.provide(layer)))

/** A law over a probe `make` gives within the test's scope, its body on the probe's layer. */
const scenario = <P, S, E>(make: Effect.Effect<P, never, Scope.Scope>, layerOf: (probe: P) => Layer.Layer<S>, body: (probe: P) => Effect.Effect<void, E, S>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(make, (probe) => body(probe).pipe(Effect.provide(layerOf(probe))))))

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
  Record<
    string,
    {
      readonly parentID?: string
      readonly agent?: string
      readonly started?: boolean
      readonly stopped?: boolean
      readonly latch?: unknown
      readonly directory?: string
      /** The text its last answer wrote. */
      readonly lastWords?: string
      /** When its last turn ended, while no turn runs. */
      readonly idleSince?: number
    }
  >
>

export const sessionsLaws = (name: string, layer: (world: SessionsWorld) => Layer.Layer<Sessions>) =>
  describe(`${name} keeps the Sessions laws`, () => {
    const world: SessionsWorld = {
      root: { agent: "build", directory: "/work" },
      child: { parentID: "root", agent: "verifier", lastWords: "verifier auth r1: accepted /work/tmp/orchestrate/web/auth/round-1-findings.md" },
      blank: { parentID: "", agent: "" },
      ran: { parentID: "root", agent: "worker", started: true, idleSince: 5_000 },
      stopped: { parentID: "root", agent: "implementor", started: true, stopped: true },
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

    test("a session whose last turn was stopped is stopped; one that ran to its end, never ran or cannot be read is not", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const sessions = yield* Sessions
          expect(yield* sessions.stoppedOf("stopped")).toBe(true)
          for (const id of ["ran", "latched", "missing"]) expect(yield* sessions.stoppedOf(id)).toBe(false)
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
          expect(yield* sessions.directoryOf("missing")).toBeUndefined()
          expect(yield* sessions.lastWordsOf("missing")).toBeUndefined()
          expect(yield* sessions.idleSinceOf("missing")).toEqual(Option.none())
        }),
      ))

    test("a session idle since its last turn ended says when; one never run says none", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const sessions = yield* Sessions
          expect(yield* sessions.idleSinceOf("ran")).toEqual(Option.some(5_000))
          expect(yield* sessions.idleSinceOf("latched")).toEqual(Option.none())
        }),
      ))

    test("a session's directory and last words are what the host knows; none when it has none", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const sessions = yield* Sessions
          expect(yield* sessions.directoryOf("root")).toBe("/work")
          expect(yield* sessions.lastWordsOf("child")).toBe("verifier auth r1: accepted /work/tmp/orchestrate/web/auth/round-1-findings.md")
          expect(yield* sessions.directoryOf("child")).toBeUndefined()
          expect(yield* sessions.lastWordsOf("root")).toBeUndefined()
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

    test("a session's model at a variant keeps it: a new worker would run at that variant", () =>
      check(
        layer({ model: { ...model, variant: "max" }, variants: ["high", "max"] }),
        Effect.gen(function* () {
          expect(yield* (yield* Models).base("ses_law", "worker")).toEqual({ ...model, variant: "max" })
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

    // The catalog makes `<id>-fast` a model of its own that asks `<id>`, of the same family and release.
    const fast = (base: string, released: number) => sol(`${base}-fast`, released, { modelID: base })

    const newestSol = Effect.gen(function* () {
      return yield* (yield* Models).newest("ses_law", ["openai"], "gpt-sol", "high")
    })

    test("the newest of a family is never a fast mode of the same release", () =>
      check(
        layer({ model, variants: [], others: [sol("gpt-6.2-sol", 5), fast("gpt-6.2-sol", 5)] }),
        Effect.map(newestSol, (newest) => expect(newest).toBe("openai/gpt-6.2-sol#high")),
      ))

    test("the newest of a family is never a fast mode newer than its newest standard model", () =>
      check(
        layer({ model, variants: [], others: [sol("gpt-6.2-sol", 5), fast("gpt-6.2-sol", 5), fast("gpt-6.3-sol", 9)] }),
        Effect.map(newestSol, (newest) => expect(newest).toBe("openai/gpt-6.2-sol#high")),
      ))

    test("a family offered only in fast modes has no newest", () =>
      check(
        layer({ model, variants: [], others: [fast("gpt-6.2-sol", 5)] }),
        Effect.map(newestSol, (newest) => expect(newest).toBeUndefined()),
      ))

    // Fast is asked per start (owner, 2026-11-24: "they can spawn a worker that's fast or not"): `fast` finds the mode.
    const fastOf = (model: string) => Models.use((models) => models.fast("ses_law", model))
    const standardOf = (model: string) => Models.use((models) => models.standardOf("ses_law", model))

    test("a model's fast mode is its `-fast` mode at the same variant, and a fast mode is its own", () =>
      check(
        layer({ model, variants: [], others: [sol("gpt-6.2-sol", 5), fast("gpt-6.2-sol", 5)] }),
        Effect.gen(function* () {
          expect(yield* fastOf("openai/gpt-6.2-sol#high")).toEqual(Option.some("openai/gpt-6.2-sol-fast#high"))
          expect(yield* fastOf("openai/gpt-6.2-sol")).toEqual(Option.some("openai/gpt-6.2-sol-fast"))
          expect(yield* fastOf("openai/gpt-6.2-sol-fast#high")).toEqual(Option.some("openai/gpt-6.2-sol-fast#high"))
          // Off a variant the mode does not offer, the mode runs bare.
          expect(yield* fastOf("openai/gpt-6.2-sol#max")).toEqual(Option.some("openai/gpt-6.2-sol-fast"))
        }),
      ))

    test("a model with no fast mode has none, nor has a model not offered; another mode is no fast one", () =>
      check(
        layer({ model, variants: [], others: [sol("gpt-6.2-sol", 5), sol("gpt-6.2-sol-ultrafast", 5, { modelID: "gpt-6.2-sol" }), fast("gpt-6.3-sol", 9)] }),
        Effect.gen(function* () {
          expect(yield* fastOf("openai/gpt-6.2-sol#high")).toEqual(Option.none())
          expect(yield* fastOf("openai/gpt-6.2-sol-ultrafast#high")).toEqual(Option.none())
          expect(yield* fastOf("openai/gpt-9-sol#high")).toEqual(Option.none())
          expect(yield* fastOf("no-provider")).toEqual(Option.none())
        }),
      ))

    test("a fast mode's standard model is the model it asks, at the same variant; any other model has none", () =>
      check(
        layer({ model, variants: [], others: [sol("gpt-6.2-sol", 5), fast("gpt-6.2-sol", 5), sol("gpt-6.2-sol-ultrafast", 5, { modelID: "gpt-6.2-sol" })] }),
        Effect.gen(function* () {
          expect(yield* standardOf("openai/gpt-6.2-sol-fast#high")).toEqual(Option.some("openai/gpt-6.2-sol#high"))
          expect(yield* standardOf("openai/gpt-6.2-sol-fast")).toEqual(Option.some("openai/gpt-6.2-sol"))
          expect(yield* standardOf("openai/gpt-6.2-sol#high")).toEqual(Option.none())
          expect(yield* standardOf("openai/gpt-6.2-sol-ultrafast#high")).toEqual(Option.none())
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

    test("a model by name is at the variant it offers, bare at one it does not, and none when not offered", () =>
      check(
        layer({ model, variants: [], others: [{ providerID: "anthropic", id: "claude-fable", variants: [{ id: "high" }] }] }),
        Effect.gen(function* () {
          const models = yield* Models
          expect(yield* models.at("ses_law", "anthropic/claude-fable", "high")).toBe("anthropic/claude-fable#high")
          expect(yield* models.at("ses_law", "anthropic/claude-fable", "max")).toBe("anthropic/claude-fable")
          expect(yield* models.at("ses_law", "anthropic/claude-fable", undefined)).toBe("anthropic/claude-fable")
          expect(yield* models.at("ses_law", "anthropic/claude-sage", "high")).toBeUndefined()
          expect(yield* models.at("ses_law", "no-provider", "high")).toBeUndefined()
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
          const reply = yield* (yield* CodexAdmission).admit("gpt-5-unlisted", "planner")
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
  why: "anthropic's 5h window is at 92% used of 100%",
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

// ── UnitLogs ──

/** Units' logs under test: a scratch checkout, a way to make a dir in it, and each unit's moves read back. */
export interface UnitLogsProbe {
  readonly layer: Layer.Layer<UnitLogs>
  /** The checkout's absolute path. */
  readonly checkout: string
  /** Make `<checkout>/<path>` a directory; its absolute path. */
  readonly make: (path: string) => Effect.Effect<string>
  /** Write an empty file at `<checkout>/<path>`, its directories made. */
  readonly touch: (path: string) => Effect.Effect<void>
  /** The moves in a unit's log, `<from> → <to> r<N>[ note]`, oldest first. */
  readonly moves: (unitDir: string) => Effect.Effect<ReadonlyArray<string>>
}

/** `make` gives a fresh, empty checkout within the test's scope. */
export const unitLogsLaws = (name: string, make: Effect.Effect<UnitLogsProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the UnitLogs laws`, () => {
    const scoped = (body: (probe: UnitLogsProbe) => Effect.Effect<void, never, UnitLogs>) => scenario(make, (probe) => probe.layer, body)

    test("a unit is found at a path named for it, absolute or relative to the directory, else under the checkout's runs", () =>
      scoped((probe) =>
        Effect.gen(function* () {
          const logs = yield* UnitLogs
          const auth = yield* probe.make("tmp/orchestrate/web/auth")
          yield* probe.touch("tmp/orchestrate/web/plan.md")
          const elsewhere = yield* probe.make("notes/auth")
          yield* probe.touch("notes/auth/spec.md")
          expect(yield* logs.find({ unit: "auth", named: ["/nonexistent/loop-probe-x/auth", elsewhere], directory: probe.checkout })).toBe(elsewhere)
          expect(yield* logs.find({ unit: "auth", named: ["notes/auth"], directory: probe.checkout })).toBe(elsewhere)
          expect(yield* logs.find({ unit: "auth", named: [], directory: probe.checkout })).toBe(auth)
          expect(yield* logs.find({ unit: "auth", named: ["notes/auth"] })).toBeUndefined()
        }),
      ))

    test("no unit is found when nothing names it and the checkout has none, or two runs have one", () =>
      scoped((probe) =>
        Effect.gen(function* () {
          const logs = yield* UnitLogs
          expect(yield* logs.find({ unit: "auth", named: [], directory: probe.checkout })).toBeUndefined()
          expect(yield* logs.find({ unit: "auth", named: [], directory: "/nonexistent/loop-probe-x" })).toBeUndefined()
          yield* probe.make("tmp/orchestrate/web/auth")
          yield* probe.touch("tmp/orchestrate/web/plan.md")
          yield* probe.make("tmp/orchestrate/api/auth")
          yield* probe.touch("tmp/orchestrate/api/auth/log.md")
          expect(yield* logs.find({ unit: "auth", named: [], directory: probe.checkout })).toBeUndefined()
        }),
      ))

    test("a directory that only shares the unit's name (a Rift called like it) is no unit dir, so a start in it writes nothing", () =>
      scoped((probe) =>
        Effect.gen(function* () {
          const logs = yield* UnitLogs
          const rift = yield* probe.make(".work/app/auth")
          yield* probe.touch(".work/app/auth/README.md")
          yield* probe.make("tmp/orchestrate/web/auth")
          expect(yield* logs.find({ unit: "auth", named: [rift], directory: rift })).toBeUndefined()
          expect(yield* logs.find({ unit: "auth", named: [".work/app/auth"], directory: probe.checkout })).toBeUndefined()
          expect(yield* logs.find({ unit: "auth", named: [], directory: probe.checkout })).toBeUndefined()
          // The run's own unit dir, named next to the Rift, is still found.
          yield* probe.touch("tmp/orchestrate/web/auth/spec.md")
          expect(yield* logs.find({ unit: "auth", named: [rift, "tmp/orchestrate/web/auth"], directory: probe.checkout })).toBe(
            yield* probe.make("tmp/orchestrate/web/auth"),
          )
        }),
      ))

    test("a move goes from the unit's current state; one already logged, or one the machine refuses, writes nothing", () =>
      scoped((probe) =>
        Effect.gen(function* () {
          const logs = yield* UnitLogs
          const dir = yield* probe.make("tmp/orchestrate/web/auth")
          yield* logs.append(dir, { unit: "auth", to: "plan", round: 1, note: "" })
          yield* logs.append(dir, { unit: "auth", to: "implement", round: 1, note: "spec.md" })
          yield* logs.append(dir, { unit: "auth", to: "implement", round: 1, note: "spec.md" })
          yield* logs.append(dir, { unit: "auth", to: "ready", round: 1, note: "round-1-request.md ready" })
          yield* logs.append(dir, { unit: "auth", to: "implement", round: 2, note: "round-1-findings.md" })
          yield* logs.append(dir, { unit: "auth", to: "ready", round: 1, note: "late" })
          expect(yield* probe.moves(dir)).toEqual([
            "new → plan r1",
            "plan → implement r1 spec.md",
            "implement → ready r1 round-1-request.md ready",
            "ready → implement r2 round-1-findings.md",
          ])
        }),
      ))

    test("a move for a dir that is gone fails nothing", () =>
      scoped(() =>
        Effect.gen(function* () {
          yield* (yield* UnitLogs).append("/nonexistent/loop-probe-x/auth", { unit: "auth", to: "plan", round: 1, note: "" })
        }),
      ))
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
      {
        name: "p1",
        dir: "/repo/tmp/orchestrate/p1",
        units: [
          { unit: "alpha", state: "implement" },
          { unit: "beta", state: "merged 1234567" },
          { unit: "gamma", state: "ready", since: "2026-11-06T10:00Z", round: "2", verdict: "changes r1" },
        ],
      },
      { name: "p2", units: [] },
    ]
    test("the runs, each with its dir when given, its units' states, the time each entered it, its round and verdict, in order", () =>
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
          yield* (yield* Steer).nudge("root", "idle with units in plan, implement or verify: alpha; start them or name what you wait on.")
        }),
      )
      expect(probe.sent()).toEqual([{ sessionID: "root", line: "idle with units in plan, implement or verify: alpha; start them or name what you wait on." }])
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

// ── MainLine ──

/** A history a MainLine probe made: its checkout, its first-parent line (oldest first) and the tips its merges took in. */
export interface MainLineHistory {
  readonly checkout: string
  readonly line: ReadonlyArray<string>
  readonly tips: ReadonlyArray<string>
}

/** A default branch under test: repositories made as git would hold them, origin's default branch moved, and a path that is no repository. */
export interface MainLineProbe {
  readonly layer: Layer.Layer<MainLine>
  /** A checkout named `name` on `branch`: a root commit, then `merges` merges of one branch commit each. */
  readonly repository: (name: string, branch: string, merges: number) => Effect.Effect<MainLineHistory>
  /** Point the checkout's `origin/HEAD` at `sha`, a commit of its line. */
  readonly origin: (checkout: string, sha: string) => Effect.Effect<void>
  /** A directory that is no repository. */
  readonly plain: Effect.Effect<string>
}

const at = (list: ReadonlyArray<string>, index: number) => Option.getOrElse(Arr.get(list, index), () => "")

/** `make` gives a fresh probe within the test's scope. */
export const mainLineLaws = (name: string, make: Effect.Effect<MainLineProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the MainLine laws`, () => {
    test("one history answers its tip, first-parent merges, a range's commits and commits", () =>
      scenario(make, (probe) => probe.layer, (probe) =>
        Effect.gen(function* () {
          const main = yield* MainLine
          const { checkout, line, tips } = yield* probe.repository("same", "main", 7)
          const head = at(line, line.length - 1)
          expect(yield* main.tip(checkout, Option.none())).toEqual(Option.some({ branch: "main", head }))
          expect(yield* main.tip(checkout, Option.some(at(line, 3)))).toEqual(Option.some({ branch: "main", head: at(line, 3) }))
          const all = yield* main.merges(checkout, head, Option.none(), 100)
          expect(all.map((merge) => merge.sha)).toEqual(line.slice(1).toReversed())
          expect(all.map((merge) => merge.parent)).toEqual(line.slice(0, -1).toReversed())
          expect(Option.map(Arr.head(all), (merge) => merge.subject)).toEqual(Option.some("Merge branch 'feat/u6'"))
          expect(yield* main.merges(checkout, head, Option.none(), 6)).toHaveLength(6)
          expect((yield* main.merges(checkout, head, Option.some(at(line, 4)), 100)).map((merge) => merge.sha)).toEqual(line.slice(5).toReversed())
          // A range's commits: the first-parent ones (a fast-forward land's own) and each merge's side tip, none of the base's.
          const sorted = (shas: ReadonlyArray<string>) => shas.toSorted()
          expect(sorted(yield* main.between(checkout, at(line, 3), head))).toEqual(sorted([...line.slice(4), ...tips.slice(3)]))
          expect([yield* main.between(checkout, head, head), yield* main.between(checkout, "f".repeat(40), head)]).toEqual([[], []])
          expect(yield* main.commitOf(checkout, head)).toEqual(Option.some(head))
        }),
      ))

    test("the default branch is origin's, else main, else master; none with neither, at a commit it lacks, or outside a repository", () =>
      scenario(make, (probe) => probe.layer, (probe) =>
        Effect.gen(function* () {
          const main = yield* MainLine
          const master = yield* probe.repository("master", "master", 1)
          expect(yield* main.tip(master.checkout, Option.none())).toEqual(Option.some({ branch: "master", head: at(master.line, 1) }))
          const trunk = yield* probe.repository("trunk", "trunk", 1)
          expect(yield* main.tip(trunk.checkout, Option.none())).toEqual(Option.none())
          // origin's default branch, as the checkout last fetched it, wins over a local main that moved on.
          const both = yield* probe.repository("origin", "main", 3)
          yield* probe.origin(both.checkout, at(both.line, 1))
          expect(yield* main.tip(both.checkout, Option.none())).toEqual(Option.some({ branch: "main", head: at(both.line, 1) }))
          expect(yield* main.tip(both.checkout, Option.some("f".repeat(40)))).toEqual(Option.none())
          const plain = yield* probe.plain
          expect([yield* main.tip(plain, Option.none()), yield* main.merges(plain, "HEAD", Option.none(), 5), yield* main.between(plain, "a", "b")]).toEqual([Option.none(), [], []])
        }),
      ))

    test("a commit is on the default branch as git's ancestry says: a merged tip and a first-parent commit are; one past origin's head is not", () =>
      scenario(make, (probe) => probe.layer, (probe) =>
        Effect.gen(function* () {
          const main = yield* MainLine
          const { checkout, line, tips } = yield* probe.repository("ancestry", "main", 6)
          // What the commitment record asks (commitments-tool.ts `factsOf`): the commit resolves and nothing of it is outside the tip.
          const onMain = (commit: string) =>
            Effect.gen(function* () {
              const tip = Option.map(yield* main.tip(checkout, Option.none()), (each) => each.head)
              const known = yield* main.commitOf(checkout, commit)
              if (Option.isNone(tip) || Option.isNone(known)) return false
              return (yield* main.between(checkout, tip.value, known.value)).length === 0
            })
          expect(yield* Effect.forEach([at(tips, 2), at(line, 4), at(tips, 5), at(line, 6)], onMain)).toEqual([true, true, true, true])
          yield* probe.origin(checkout, at(line, 3))
          expect(yield* Effect.forEach([at(tips, 1), at(line, 3), at(tips, 4), at(line, 6)], onMain)).toEqual([true, true, false, false])
        }),
      ))
  })

// ── RunFiles ──

/** The runs' files under test: a root for run dirs, a way to write a file as of a time, to read one back, and a path no write can take. */
export interface RunFilesProbe {
  readonly layer: Layer.Layer<RunFiles>
  /** An empty directory, absolute, with no trailing slash. */
  readonly root: string
  /** Write `text` at `path`, its directories made, last written at `when` (epoch ms, whole seconds). */
  readonly put: (path: string, text: string, when: number) => Effect.Effect<void>
  /** A file's text; none when there is none. */
  readonly read: (path: string) => Effect.Effect<Option.Option<string>>
  /** A path under which nothing can be written, when the store has one. */
  readonly unwritable: Effect.Effect<Option.Option<string>>
}

const lawSha = (n: number) => n.toString(16).padStart(40, "0")
const LAW_T0 = Date.parse("2026-11-14T10:00:00Z")

/** A run dir's files, by path under it, and when each was written (minutes after LAW_T0). */
const RUN_FILES: ReadonlyArray<readonly [string, string, number]> = [
  ["a/log.md", "2026-11-14T10:00Z implement → ready r2\n", 0],
  ["a/round-1-request.md", `Head: ${lawSha(1)}\n`, 1],
  ["a/round-2-request.md", `Range 1234567..${lawSha(2).slice(0, 9)}\n`, 2],
  ["a/round-1-findings.md", "verifier batch-1 r1: changes /x\n", 3],
  ["b/log.md", "2026-11-14T10:00Z plan → implement r1\n", 0],
  ["c/spec.md", "a spec, no log: no unit dir\n", 0],
  ["verify-old/batch-old.md", `# batch-old\nBase: ${lawSha(5)}\nHead: ${lawSha(6)}\n`, 4],
  ["verify-old/batch-old-findings.md", "Verdict: ACCEPTED\n", 5],
  ["verify-new/batch-new.md", `# batch-new\nHead: ${lawSha(7)}\n`, 6],
  ["verify-new/batch-new-findings.md", "verifier batch-new r1: changes /x\n", 9],
  ["verify-open/batch-open.md", `Head: ${lawSha(8)}\n`, 10],
  ["verify-open/batch-open-findings.md", "still verifying\n", 11],
  // As this run's own verify dirs hold them: the head only on the heads line, the findings opening with the verdict.
  [
    "verify-1115cc/batch-2026-11-15cc.md",
    `# batch-2026-11-15cc\nBase: ${lawSha(6)} (batch cb's head).\nHeads: dotfiles=${lawSha(10)} fork=${lawSha(11)}\nLand: on receipts.\n- machine-cut r1 (${lawSha(10).slice(0, 8)}: …).\n`,
    7,
  ],
  ["verify-1115cc/batch-2026-11-15cc-findings.md", `Verdict: accepted\n\n# batch-2026-11-15cc: findings (base ${lawSha(6).slice(0, 8)}, head ${lawSha(10).slice(0, 8)})\n`, 10],
]

/** The skill's batch mode: `<run dir>/batch-<k>.md` with the heads line, its findings beside it; and two that are no verify. */
const ROOT_BATCHES: ReadonlyArray<readonly [string, string, number]> = [
  ["batch-3.md", `# batch-3\nBase: ${lawSha(10)}\nHeads: dotfiles=${lawSha(12)} fork=${lawSha(13)}\n`, 11],
  ["batch-3-findings.md", "verifier batch-3 r1: accepted /run/batch-3-findings.md\n", 12],
  // A malformed heads line (short commits) names no head.
  ["batch-4.md", `# batch-4\nHeads: dotfiles=${lawSha(14).slice(0, 12)} fork=${lawSha(15).slice(0, 12)}\n`, 12],
  ["batch-4-findings.md", "Verdict: accepted\n", 14],
  // No findings yet.
  ["batch-5.md", `Head: ${lawSha(16)}\n`, 15],
]

/** `make` gives a fresh probe within the test's scope. */
export const runFilesLaws = (name: string, make: Effect.Effect<RunFilesProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the RunFiles laws`, () => {
    test("a run dir answers its units, a unit's newest request and findings, and the newest verify with a verdict", () =>
      scenario(make, (probe) => probe.layer, (probe) =>
        Effect.gen(function* () {
          const files = yield* RunFiles
          const dir = `${probe.root}/run`
          yield* Effect.forEach(RUN_FILES, ([path, text, minutes]) => probe.put(`${dir}/${path}`, text, LAW_T0 + minutes * 60_000), { discard: true })
          expect((yield* files.units(dir)).map((unit) => unit.unit).toSorted()).toEqual(["a", "b"])
          expect(yield* files.unit(`${dir}/a`)).toEqual({
            unit: "a",
            dir: `${dir}/a`,
            request: Option.some({ round: 2, path: `${dir}/a/round-2-request.md`, head: Option.some(lawSha(2).slice(0, 9)) }),
            findings: Option.some({ round: 1, path: `${dir}/a/round-1-findings.md`, verdict: Option.some("changes") }),
          })
          // The newest verify by its verdict's time; one whose findings hold no verdict line is none. A batch file naming its
          // head only on the heads line is a verify of that line's dotfiles commit.
          expect(yield* files.verified([dir, `${probe.root}/none`])).toEqual(
            Option.some({ file: `${dir}/verify-1115cc/batch-2026-11-15cc.md`, head: lawSha(10), at: LAW_T0 + 10 * 60_000 }),
          )
          expect(yield* files.verified([`${probe.root}/none`])).toEqual(Option.none())
          // A batch file in the run dir itself, as batch mode writes it, is a verify too; one with no head or no verdict is not.
          yield* Effect.forEach(ROOT_BATCHES, ([path, text, minutes]) => probe.put(`${dir}/${path}`, text, LAW_T0 + minutes * 60_000), { discard: true })
          expect(yield* files.verified([dir])).toEqual(Option.some({ file: `${dir}/batch-3.md`, head: lawSha(12), at: LAW_T0 + 12 * 60_000 }))
          expect((yield* files.units(dir)).map((unit) => unit.unit).toSorted()).toEqual(["a", "b"])
        }),
      ))

    test("a write makes its directory and reads back; a path the store cannot take fails as unwritten", () =>
      scenario(make, (probe) => probe.layer, (probe) =>
        Effect.gen(function* () {
          const files = yield* RunFiles
          const path = `${probe.root}/written/verify-main-abc1234/batch-main-abc1234.md`
          yield* files.write(path, "# batch\n")
          expect(yield* probe.read(path)).toEqual(Option.some("# batch\n"))
          const unwritable = yield* probe.unwritable
          const failed = yield* Effect.forEach(Option.toArray(unwritable), (blocked) => Effect.flip(files.write(blocked, "x")))
          expect(failed.map((each) => each._tag)).toEqual(Option.toArray(Option.as(unwritable, "RunFileUnwritten")))
        }),
      ))
  })

// ── CommitmentRecord ──

const T0 = 1_800_000_000_000
const HOUR = 3_600_000
const ROOT_ACTOR: Actor = { id: "ses_root", role: "root" }
const WORKER_ACTOR: Actor = { id: "ses_worker", role: "worker" }
/** The guarantee the script's decisions rest on: an invariant the root declares first, its document as git held it. */
export const GUARANTEE = { reasonClass: "guarantee" as const, referent: "invariant/one-writer" }
const DOCUMENT = { path: "docs/record.md", blob: "b".repeat(40), commit: "c".repeat(40) }

/** Every kind of command once, in an order that moves each kind of row: what the replay law replays. */
export const RECORD_SCRIPT: ReadonlyArray<readonly [Command, Actor, number]> = [
  [
    Commands.cases.add.make({
      run: "r1",
      sourceKind: "owner-answer",
      sourceRef: "ses_root:q1",
      quote: Option.some("yes, all three parts"),
      plan: Option.some("plan-x"),
      parts: [
        { id: "part-a", title: "Part A", ownerLane: Option.some("lane-a"), after: Option.some([{ kind: "manual", ref: "go" }]) },
        { id: "part-b", title: "Part B", part: Option.some("2"), rank: Option.some("B") },
        { id: "part-c", title: "Part C" },
      ],
    }),
    ROOT_ACTOR,
    T0,
  ],
  [Commands.cases.word.make({ run: "r1", word: "go" }), ROOT_ACTOR, T0 + HOUR],
  [Commands.cases.invariant.make({ id: "one-writer", anchor: "one-writer", observed: DOCUMENT }), ROOT_ACTOR, T0 + HOUR],
  [Commands.cases.assign.make({ id: "part-b", ownerLane: "lane-b", ownerSession: Option.some("ses_b"), after: [{ kind: "commit-on-main", ref: "c1c1c1c" }], reviewBy: Option.some(T0 + 48 * HOUR ) }), ROOT_ACTOR, T0 + 2 * HOUR],
  [Commands.cases.order.make({ ownerLane: "lane-b", ids: ["part-b"] }), ROOT_ACTOR, T0 + 3 * HOUR],
  [Commands.cases.hand_back.make({ run: "r1", ownerLane: "lane-b", role: "implementor", round: Option.some(1), session: "ses_b", verdict: "ready", head: Option.some("c1c1c1c"), claims: ["part-b"] }), WORKER_ACTOR, T0 + 4 * HOUR],
  [Commands.cases.route.make({ handBack: 1, as: "routed" }), ROOT_ACTOR, T0 + 5 * HOUR],
  [Commands.cases.pass.make({ onMain: ["c1c1c1c"], gone: [], root: Option.some("ses_root") }), { id: "plugin", role: "plugin" }, T0 + 6 * HOUR],
  [Commands.cases.decide.make({ id: "part-c", why: "folded into part B", reason: GUARANTEE }), ROOT_ACTOR, T0 + 7 * HOUR],
  [Commands.cases.seen.make({ id: "part-c" }), { id: "owner", role: "owner" }, T0 + 8 * HOUR],
  [Commands.cases.reopen.make({ id: "part-c" }), ROOT_ACTOR, T0 + 9 * HOUR],
  [
    Commands.cases.add.make({ run: "r1", sourceKind: "follow-up", sourceRef: "ses_worker:call-1", suggestOwner: Option.some("lane-a"), parts: [{ id: "follow-d", title: "A test for D" }], reason: Option.some({ reasonClass: "dependency", referent: "commitment/part-a" }) }),
    WORKER_ACTOR,
    T0 + 10 * HOUR,
  ],
  [Commands.cases.defer.make({ id: "part-c", reason: { reasonClass: "dependency", referent: "commitment/part-a" } }), ROOT_ACTOR, T0 + 10 * HOUR],
  [Commands.cases.decide.make({ id: "follow-d", why: "covered by part A", reason: GUARANTEE }), ROOT_ACTOR, T0 + 11 * HOUR],
  [Commands.cases.add.make({ run: "r1", sourceKind: "owner-answer", sourceRef: "ses_root:q3", parts: [{ id: "answer-q3", title: "Their answer to q3" }] }), ROOT_ACTOR, T0 + 11 * HOUR],
  [Commands.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "plan.md:3", plan: Option.some("answer-q3"), parts: [{ id: "q3-a", title: "Its part A" }] }), ROOT_ACTOR, T0 + 11 * HOUR],
  [Commands.cases.release.make({ id: "part-a" }), ROOT_ACTOR, T0 + 12 * HOUR],
  [Commands.cases.lane.make({ run: "r1", unit: "unit-e" }), ROOT_ACTOR, T0 + 13 * HOUR],
  [
    Commands.cases.import.make({
      run: "wf9",
      rows: [
        {
          id: "IMP-1",
          row: {
            title: "An imported part",
            sourceKind: "plan-part",
            sourceRef: "plan.md:12",
            ownerLane: Option.some("lane-z"),
            state: "open",
            reviewBy: Option.some("2027-01-01T00:00:00.000Z"),
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-02T00:00:00.000Z",
            after: [{ kind: "date", ref: "2026-12-01T00:00:00.000Z" }],
          },
          history: [{ at: "2026-11-01T00:00:00.000Z", actor: "ORCH", toState: Option.some("open"), note: "filed" }],
        },
      ],
    }),
    { id: "ergo-register", role: "import" },
    T0 + 14 * HOUR,
  ],
]

/** Runs `script` in order: each command's outcome, refused or done. */
const play = (script: ReadonlyArray<readonly [Command, Actor, number]>) =>
  Effect.gen(function* () {
    const record = yield* CommitmentRecord
    return yield* Effect.forEach(script, ([command, actor, now]) => Effect.result(record.run(command, { actor, now })))
  })

const tagsOf = (events: ReadonlyArray<RecordEvent>) => events.map((event) => event.happening._tag)

/** `make` gives a fresh store, empty, within the test's scope. */
export const commitmentRecordLaws = (name: string, make: Effect.Effect<Layer.Layer<CommitmentRecord>, never, Scope.Scope>) =>
  describe(`${name} keeps the CommitmentRecord laws`, () => {
    test("the replay law: the events folded into an empty record give the rows, for every kind of command", () =>
      scenario(make, (layer) => layer, () =>
        Effect.gen(function* () {
          const outcomes = yield* play(RECORD_SCRIPT)
          expect(outcomes.map((each) => each._tag)).toEqual(RECORD_SCRIPT.map(() => "Success"))
          const record = yield* CommitmentRecord
          const events = yield* record.events
          expect(fold(EMPTY, events)).toEqual(yield* record.read)
          expect(events.map((event) => event.seq)).toEqual(events.map((_, at) => at + 1))
        }),
      ))

    test("a command's events and rows move together: the pass lands only a claimed commit on main and wakes the root once", () =>
      scenario(make, (layer) => layer, () =>
        Effect.gen(function* () {
          yield* play(RECORD_SCRIPT.slice(0, 6))
          const record = yield* CommitmentRecord
          const passed = yield* record.run(Commands.cases.pass.make({ onMain: ["c1c1c1c"], gone: [], root: Option.some("ses_root") }), { actor: { id: "plugin", role: "plugin" }, now: T0 + 6 * HOUR })
          expect(tagsOf(passed.events)).toEqual(["landed", "woke"])
          expect(Option.map(Option.fromUndefinedOr(passed.snapshot.commitments.get("part-b")), (row) => [row.state, row.landedCommit])).toEqual(Option.some(["landed", Option.some("c1c1c1c")]))
          const again = yield* record.run(Commands.cases.pass.make({ onMain: ["c1c1c1c"], gone: [], root: Option.some("ses_root") }), { actor: { id: "plugin", role: "plugin" }, now: T0 + 7 * HOUR })
          expect(again.events).toEqual([])
          expect((yield* record.history("commitment", "part-a")).map((event) => event.happening._tag)).toEqual(["promised", "assigned", "woke"])
        }),
      ))

    test("a refusal writes nothing, and the record says why", () =>
      scenario(make, (layer) => layer, () =>
        Effect.gen(function* () {
          yield* play(RECORD_SCRIPT.slice(0, 1))
          const record = yield* CommitmentRecord
          const before = (yield* record.events).length
          const refused = yield* play([
            [Commands.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "plan.md", parts: [{ id: "part-a", title: "again" }] }), ROOT_ACTOR, T0],
            [Commands.cases.decide.make({ id: "part-a", why: "not mine", reason: GUARANTEE }), WORKER_ACTOR, T0],
            [Commands.cases.decide.make({ id: "part-b", why: " ", reason: GUARANTEE }), ROOT_ACTOR, T0],
            [Commands.cases.decide.make({ id: "part-b", why: "no invariant", reason: { reasonClass: "guarantee", referent: "invariant/never-declared" } }), ROOT_ACTOR, T0],
            [Commands.cases.decide.make({ id: "part-b", why: "measured", reason: { reasonClass: "measured", referent: "receipt/tmp/orchestrate/r/x.json" } }), ROOT_ACTOR, T0],
            [Commands.cases.add.make({ run: "r1", sourceKind: "follow-up", sourceRef: "x", parts: [{ id: "f-1", title: "t" }] }), WORKER_ACTOR, T0],
            [Commands.cases.assign.make({ id: "part-c", ownerLane: "lane-c", after: [], reviewBy: Option.some(T0 - 1) }), ROOT_ACTOR, T0],
            [Commands.cases.assign.make({ id: "part-c", ownerLane: "lane-c", after: [] }), WORKER_ACTOR, T0],
            [Commands.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "x", parts: [{ id: "has space", title: "t" }] }), ROOT_ACTOR, T0],
            [Commands.cases.add.make({ run: "r1", sourceKind: "follow-up", sourceRef: "x", quote: Option.some("owner words"), parts: [{ id: "q-1", title: "t" }] }), ROOT_ACTOR, T0],
            [Commands.cases.add.make({ run: "r1", sourceKind: "owner-ask", sourceRef: "x", parts: [{ id: "w-1", title: "t" }] }), WORKER_ACTOR, T0],
            [Commands.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "x", parts: [{ id: "long-1", title: "t".repeat(201) }] }), ROOT_ACTOR, T0],
          ])
          expect(refused.map((each) => each._tag)).toEqual(refused.map(() => "Failure"))
          expect((yield* record.events).length).toBe(before)
        }),
      ))

    test("a root's decision on an owner-sourced commitment leaves a notice until it is seen or reopened; a root's on a follow-up leaves none", () =>
      scenario(make, (layer) => layer, () =>
        Effect.gen(function* () {
          yield* play(RECORD_SCRIPT.slice(0, 3))
          const record = yield* CommitmentRecord
          const decided = yield* record.run(Commands.cases.decide.make({ id: "part-c", why: "folded into part B", reason: GUARANTEE }), { actor: ROOT_ACTOR, now: T0 })
          expect(Option.flatMap(Option.fromUndefinedOr(decided.snapshot.commitments.get("part-c")), (row) => row.noticeUntil)).toEqual(Option.some("2027-01-22T08:00:00.000Z"))
          const seen = yield* record.run(Commands.cases.seen.make({ id: "part-c" }), { actor: { id: "owner", role: "owner" }, now: T0 + HOUR })
          expect(Option.flatMap(Option.fromUndefinedOr(seen.snapshot.commitments.get("part-c")), (row) => row.noticeUntil)).toEqual(Option.none())
          yield* record.run(Commands.cases.add.make({ run: "r1", sourceKind: "follow-up", sourceRef: "ses_worker:call-2", parts: [{ id: "follow-e", title: "E" }], reason: Option.some({ reasonClass: "dependency", referent: "commitment/part-a" }) }), { actor: WORKER_ACTOR, now: T0 })
          const closed = yield* record.run(Commands.cases.decide.make({ id: "follow-e", why: "done by C", reason: GUARANTEE }), { actor: ROOT_ACTOR, now: T0 })
          expect(Option.flatMap(Option.fromUndefinedOr(closed.snapshot.commitments.get("follow-e")), (row) => row.noticeUntil)).toEqual(Option.none())
        }),
      ))

    test("a secret-shaped text is kept redacted", () =>
      scenario(make, (layer) => layer, () =>
        Effect.gen(function* () {
          const record = yield* CommitmentRecord
          const token = `ghp_${"a1B2c3D4e5".repeat(3)}`
          const added = yield* record.run(
            Commands.cases.add.make({ run: "r1", sourceKind: "owner-answer", sourceRef: "ses_root:q2", quote: Option.some(`use ${token}`), parts: [{ id: "sec-1", title: `rotate ${token}` }] }),
            { actor: ROOT_ACTOR, now: T0 },
          )
          const row = Option.fromUndefinedOr(added.snapshot.commitments.get("sec-1"))
          expect(Option.map(row, (each) => [each.title, each.quote])).toEqual(Option.some(["rotate [redacted]", Option.some("use [redacted]")]))
        }),
      ))
  })
