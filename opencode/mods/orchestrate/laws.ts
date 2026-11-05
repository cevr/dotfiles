// What every implementation of a contract in service.ts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, type Scope } from "effect"
import type { CallLine } from "./call-line.ts"
import { DEFAULTS, type Windows } from "./compaction.ts"
import type { ModelRef, Pace } from "./pace.ts"
import { CallLog, CodexAdmission, CompactionWindows, Models, PoolPace, Sessions } from "./service.ts"

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
export type SessionsWorld = Readonly<Record<string, { readonly parentID?: string; readonly agent?: string }>>

export const sessionsLaws = (name: string, layer: (world: SessionsWorld) => Layer.Layer<Sessions>) =>
  describe(`${name} keeps the Sessions laws`, () => {
    const world: SessionsWorld = {
      root: { agent: "build" },
      child: { parentID: "root", agent: "verifier" },
      blank: { parentID: "", agent: "" },
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

    test("a session the host cannot read answers none, without failing", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const sessions = yield* Sessions
          expect(yield* sessions.parentOf("missing")).toBeUndefined()
          expect(yield* sessions.agentOf("missing")).toBeUndefined()
        }),
      ))
  })

// ── Models ──

/** A host whose sessions run on `model`, offered at `variants`; no model at all when absent. */
export interface ModelsWorld {
  readonly model?: ModelRef
  readonly variants: ReadonlyArray<string>
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
          expect(yield* pool.pace("anthropic")).toEqual(held)
          expect(yield* pool.pace("openai")).toEqual(open)
        }),
      ))

    test("a provider the pool has no answer for is unpaced, without failing", () =>
      check(
        layer({ anthropic: held }),
        Effect.gen(function* () {
          expect(yield* (yield* PoolPace).pace("google")).toBeUndefined()
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
          for (const { model, role, answer } of world) expect(yield* codex.admit(model, role)).toEqual(answer)
        }),
      ))

    test("a model and role the script has no answer for is none, and fails open", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          expect(yield* (yield* CodexAdmission).admit("gpt-5", "verifier")).toBeUndefined()
        }),
      ))
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
