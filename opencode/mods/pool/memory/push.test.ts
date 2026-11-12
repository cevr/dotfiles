// The push's acceptance: the owner's two flows end to end on the pool model
// over memory layers, a fake provider (its quota and its claims are the
// memory quota's: nothing reaches a provider) and the test clock.
//
// 1. Asked push: the owner's session starts a push with an approved reset;
//    the answer is the plan, measured from the pool, with the host's load
//    against its cores. A start the spend-evenly target held goes on (a
//    planner stays on Opus); a start held for lack of quota has the approved
//    reset claimed through the fleet's lease, and the next ask goes on. With
//    its resets spent the pace holds again, from the claim's line; past its
//    end the push is gone.
// 2. Proactive: a run's queued units need more than the pool can spend
//    before its windows reset by themselves; the pool asks once in the run's
//    session, a yes starts the push, and the run closing ends it. A no holds
//    for the week.
// And the forecast: with low demand, resets in hand that would expire unused
// are named, and the owner is asked even with no queued work; during a push
// of the whole host, an account whose week is spent has its reset claimed at
// once, with no start held.
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, type Schema, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { PoolId } from "../account-pool.ts"
import { CACHE_LIFE_MS } from "../accounts.ts"
import * as Lease from "../lease.ts"
import * as Model from "../model.ts"
import { NOT_NOW, type PushAnswer, type PushRequest, START } from "../push.ts"
import type { ClaimAnswer, QuotaReading, ResetCredit } from "../quota.ts"
import { type RunWork, Workload } from "../service.ts"
import * as FleetTest from "./fleet.ts"
import * as LedgerTest from "./ledger.ts"
import * as LoginsTest from "./logins.ts"
import * as OwnerTest from "./owner.ts"
import * as PeersTest from "./peers.ts"
import * as PushesTest from "./pushes.ts"
import * as QuotaTest from "./quota.ts"
import * as ResetsTest from "./resets.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.parse("2026-11-11T12:00:00Z")
const ANTHROPIC = PoolId.make("anthropic")

const FULL: Partial<ResetCredit> = { clears: ["five_hour", "seven_day"], kind: "full" }
const WEEKLY: Partial<ResetCredit> = { clears: ["seven_day"], kind: "weekly" }
const grant = (id: string, expiresAt: number, fields: Partial<ResetCredit>): ResetCredit => ({ id, count: 1, usable: true, expiresAt, requiresLimit: false, ...fields })

/** A reading at `at`: the 5-hour window at `fiveHour`, the week at `week` resetting at `weekAt`, with `credits`. */
const reading = (at: number, fiveHour: number, week: number, weekAt: number, credits: ReadonlyArray<ResetCredit> = []): QuotaReading => ({
  at,
  windows: [
    { name: "5h", utilization: fiveHour, resetAt: at + 2 * HOUR },
    { name: "7d", utilization: week, resetAt: weekAt },
  ],
  resets: { available: credits.length, credits },
})

interface Sent {
  readonly credentialID: string
  readonly creditID: string
  readonly requestID: string
}

/** The workbox's pool on memory layers: a peer (the Mac) that grants every lease it is asked for, and the runs and load the test sets. */
interface Fleet {
  readonly host: string
  readonly peer: string
  /** What the peer does with a push request, as ssh/push.ts hands it to the peer's `push` RPC; none: it takes no pushes. */
  readonly pushes?: (peer: string, request: PushRequest) => Effect.Effect<PushAnswer>
}

const world = (config: Partial<Model.Config> = {}, fleet: Fleet = { host: "workbox", peer: "mac" }) => {
  const readings = new Map<string, QuotaReading>()
  const claims: Array<Sent> = []
  const leases: Array<string> = []
  const owner = OwnerTest.empty()
  const work: { runs: ReadonlyArray<RunWork> } = { runs: [] }
  const state = { answer: (_claim: Sent): ClaimAnswer => ({ outcome: "reset" }) }
  const externals = Layer.mergeAll(
    LoginsTest.layer({
      connections: new Map([
        [
          ANTHROPIC,
          [
            { type: "credential" as const, method: "oauth" as const, id: "a", label: "Max A" },
            { type: "credential" as const, method: "oauth" as const, id: "b", label: "Max B" },
          ],
        ],
      ]),
      marks: [],
    }),
    QuotaTest.layer(new Map([[ANTHROPIC, readings]]), new Map(), (_pool, input) => {
      claims.push(input)
      return state.answer(input)
    }),
    LedgerTest.layer(),
    PeersTest.layer(
      new Map([[fleet.peer, { down: "not read in this test" }]]),
      (peer, message) =>
        Effect.sync(() => {
          leases.push(`${peer}:${message._tag}`)
          return { granted: true }
        }),
      fleet.pushes,
    ),
    FleetTest.layer(),
    ResetsTest.layer(new Map<string, Schema.Json>()),
    OwnerTest.layer(owner),
    PushesTest.layer(),
    Layer.succeed(Workload, { load: Effect.succeed({ load: 42, cores: 16 }), runs: Effect.sync(() => work.runs) }),
    Layer.succeed(Lease.Leases, Lease.make({ quietMs: 0 })),
  )
  const full: Model.Config = {
    providers: { anthropic: ANTHROPIC },
    cacheLifeMs: CACHE_LIFE_MS,
    resets: { anthropic: "claude" },
    // Each start counts 40% of a week until it settles: three of them put the pool over its spend-evenly line.
    fleet: { ...Model.DEFAULT_FLEET, host: fleet.host, startCost: 0.4 },
    ...config,
  }
  const pool = Effect.gen(function* () {
    const services = yield* Layer.build(Model.layer(full).pipe(Layer.provide(externals)))
    return Context.get(services, Model.Pool)
  })
  return { readings, claims, leases, owner, work, state, pool }
}

/** Let the review a held pace forked run: a real moment, on the test clock too. */
const settle = Effect.promise(() => new Promise<void>((done) => setTimeout(done, 20)))
const onTestClock = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* TestClock.setTime(T0)
    return yield* body
  }).pipe(Effect.provide(TestClock.layer()))))

describe("asked push", () => {
  test("the owner starts a push: its plan, no spend-evenly hold, its reset claimed for a start held for lack of quota, then the pace again, and gone at its end", () =>
    onTestClock(
      Effect.gen(function* () {
        const w = world()
        const weekAt = T0 + 3 * DAY
        w.readings.set("a", reading(T0, 0.3, 0.5, weekAt, [grant("g-a", T0 + 30 * DAY, FULL)]))
        w.readings.set("b", reading(T0, 0.3, 0.5, weekAt))
        const pool = yield* w.pool
        for (let start = 0; start < 3; start++) yield* pool.started("anthropic")
        const before = yield* pool.pace("anthropic", "claude-opus-5-5", "ses_planner")
        expect(before).toMatchObject({ ok: false, soft: true })

        // The owner's session: a push on this host until 2 h from now, one reset approved.
        const started = yield* pool.push({ action: "start", goal: "ergo", hours: 2, resets: 1, sessionID: "ses_owner" })
        expect(started.ok).toBe(true)
        expect(started.pushes).toHaveLength(1)
        expect(started.text).toContain('"ergo" (asked): host workbox; until 2026-11-11 14:00Z')
        expect(started.text).toContain("up to 1 reset, 0 spent")
        expect(started.text).toContain("Pool anthropic: 2 accounts can spend 100% of one account's week before their weeks reset by themselves")
        expect(started.text).toContain("1. full reset on Max A (anthropic): +50% of a week")
        expect(started.text).toContain("Host load 42.0 on 16 cores (over its cores): a push raises no CPU gate")

        // A planner the spend-evenly target held starts now: it stays on Opus.
        const lifted = yield* pool.pace("anthropic", "claude-opus-5-5", "ses_planner")
        expect(lifted).toMatchObject({ ok: true, measured: true })
        expect(lifted.reason).toContain('the push "ergo" lifts the spend-evenly hold')

        // Every account spent: held for lack of quota, and the push claims its reset.
        w.readings.set("a", reading(T0 + MINUTE, 1, 1, weekAt, [grant("g-a", T0 + 30 * DAY, FULL)]))
        w.readings.set("b", reading(T0 + MINUTE, 1, 1, weekAt))
        w.state.answer = (claim) => {
          w.readings.set(claim.credentialID, reading(T0 + 2 * MINUTE, 0, 0, weekAt))
          return { outcome: "reset" }
        }
        yield* TestClock.adjust(MINUTE)
        const held = yield* pool.pace("anthropic", "claude-opus-5-5", "ses_planner")
        expect(held.ok).toBe(false)
        expect(held.soft).toBeUndefined()
        expect(held.reason).toContain('the push "ergo" claims one of its 1 approved reset')
        expect(held.retryAt).toBeLessThanOrEqual(T0 + MINUTE + Model.PUSH_RETRY_MS)
        yield* settle
        expect(w.claims.map((claim) => [claim.credentialID, claim.creditID])).toEqual([["a", "g-a"]])
        expect(w.claims[0]!.requestID).toMatch(/^pool-[0-9a-f]{24}$/)
        // An asked claim still goes through the fleet's lease, asked and released.
        expect(w.leases).toEqual(["mac:Ask", "mac:Release"])
        expect(w.owner.asked).toEqual([])
        const status = yield* pool.resets
        expect(status.resets.map((reset) => [reset.why, reset.stage, reset.push])).toEqual([["push", "settled", started.pushes[0]!.id]])
        expect(status.pushes?.[0]).toContain("up to 1 reset, 1 spent")

        // Its one reset spent, the pace holds again from the claim's line: use 100%, reset, then pace.
        yield* TestClock.adjust(MINUTE)
        const paced = yield* pool.pace("anthropic", "claude-opus-5-5", "ses_planner")
        expect(paced).toMatchObject({ ok: false, soft: true })

        // Past its end the push is gone.
        yield* TestClock.adjust(2 * HOUR)
        yield* pool.reviewPushes
        expect((yield* pool.push({ action: "status" })).text).toBe("No push is active on workbox.")
        expect((yield* pool.resets).pushes).toBeUndefined()
      }),
    ))

  test("a push for a peer goes to it; one the owner ends holds as before; a bad request changes nothing", () =>
    onTestClock(
      Effect.gen(function* () {
        const w = world()
        w.readings.set("a", reading(T0, 0.3, 0.5, T0 + 3 * DAY))
        const pool = yield* w.pool
        const peer = yield* pool.push({ action: "start", goal: "mac work", host: "mac", resets: 1 })
        expect(peer).toMatchObject({ ok: false })
        expect(peer.text).toContain("mac cannot be reached: takes no pushes")
        expect((yield* pool.push({ action: "start", goal: "x", host: "nowhere" })).text).toContain("No host nowhere")
        expect((yield* pool.push({ action: "start", goal: " " })).ok).toBe(false)
        expect((yield* pool.push({ action: "start", goal: "x", until: "2026-11-11T11:00:00Z" })).text).toBe("That end time has passed already.")
        yield* pool.push({ action: "start", goal: "ergo", session: true, sessionID: "ses_owner", resets: 2 })
        expect((yield* pool.push({ action: "end" })).text).toContain('Ended "ergo"')
        expect((yield* pool.push({ action: "status" })).pushes).toEqual([])
      }),
    ))
})

describe("proactive push", () => {
  const queued = (state: string, count: number): RunWork => ({ name: "ergo", units: Array.from({ length: count }, (_, at) => ({ unit: `u${at}`, state })) })
  const setUp = Effect.fn(function* () {
    const w = world()
    w.owner.parents.set("ses_orchestrator", "ses_owner")
    // Weeks nearly spent with days to go, a weekly reset each: 10% of room against six units (60% of a week).
    w.readings.set("a", reading(T0, 0.2, 0.95, T0 + 5 * DAY, [grant("g-a", T0 + 30 * DAY, WEEKLY)]))
    w.readings.set("b", reading(T0, 0.2, 0.95, T0 + 5 * DAY, [grant("g-b", T0 + 30 * DAY, WEEKLY)]))
    // Four units being implemented, two planned, one landed: six queued.
    w.work.runs = [{ name: "ergo", session: "ses_orchestrator", units: [...queued("implement", 4).units, ...queued("plan", 2).units, { unit: "done", state: "merged 0f0f0f0" }] }]
    const pool = yield* w.pool
    // The run's orchestrator asks the pace: the pool knows where to ask.
    yield* pool.pace("anthropic", "claude-opus-5-5", "ses_orchestrator")
    yield* pool.reviewPushes
    return { w, pool }
  })

  test("queued work past what the pool can spend: asked once in the run's session, a yes starts the push, the run closing ends it", () =>
    onTestClock(
      Effect.gen(function* () {
        const { w, pool } = yield* setUp()
        const asked = w.owner.asked.filter((question) => question.key.startsWith("push:"))
        expect(asked).toHaveLength(1)
        expect(asked[0]).toMatchObject({ sessionID: "ses_owner", key: "push:workbox:*:ergo", options: [{ label: START }, { label: NOT_NOW }] })
        expect(asked[0]!.question).toContain("Start a push for run ergo using the weekly reset on Max A?")
        expect(asked[0]!.question).toContain("Queued work: 6 units ≈ 60% of one account's week; room 10%")
        expect(asked[0]!.question).toContain("Host load 42.0 on 16 cores")
        // Asked once: the next sweep asks nothing more.
        yield* pool.reviewPushes
        expect(w.owner.asked.filter((question) => question.key.startsWith("push:"))).toHaveLength(1)

        // The owner says yes: the push starts, scoped to the run's session and the run.
        yield* OwnerTest.answer(w.owner, asked[0]!.key, START)
        yield* pool.reviewResets
        const status = yield* pool.push({ action: "status" })
        expect(status.pushes).toMatchObject([{ goal: "run ergo", by: "proactive", scope: { host: "workbox", sessionID: "ses_owner", run: "ergo" }, allowance: { max: 1, kinds: ["weekly"] } }])
        expect(w.owner.withdrawn).toContain(asked[0]!.key)

        // The run closes: every unit merged or dropped. The push ends.
        w.work.runs = [{ name: "ergo", units: [{ unit: "u0", state: "merged 1a2b3c4" }, { unit: "u1", state: "dropped" }] }]
        yield* pool.reviewPushes
        expect((yield* pool.push({ action: "status" })).pushes).toEqual([])
      }),
    ))

  test("a no holds for the week, then the pool asks again", () =>
    onTestClock(
      Effect.gen(function* () {
        const { w, pool } = yield* setUp()
        const key = w.owner.asked.find((question) => question.key.startsWith("push:"))!.key
        yield* OwnerTest.answer(w.owner, key, NOT_NOW)
        yield* pool.reviewResets
        expect((yield* pool.push({ action: "status" })).pushes).toEqual([])
        yield* TestClock.adjust(6 * DAY)
        yield* pool.pace("anthropic", "claude-opus-5-5", "ses_orchestrator")
        yield* pool.reviewPushes
        expect(w.owner.asked.filter((question) => question.key === key)).toHaveLength(1)
        yield* TestClock.adjust(DAY)
        yield* pool.pace("anthropic", "claude-opus-5-5", "ses_orchestrator")
        yield* pool.reviewPushes
        expect(w.owner.asked.filter((question) => question.key === key)).toHaveLength(2)
        // The readings are a week old: no forecast is made on them, so no other push question.
        expect(w.owner.asked.filter((question) => question.key.startsWith("push:"))).toHaveLength(2)
      }),
    ))

  /** Round 2's Q1: the run names the session that started its steps (the status RPC, from orchestrate's call log), and its push is that session's tree's. */
  test("Q1 after an unrelated session asks the pace, the run's question is still asked in the run's orchestrator tree, and a yes covers that tree, not the stranger's", () =>
    onTestClock(
      Effect.gen(function* () {
        const w = world()
        w.owner.parents.set("ses_orch", "ses_owner")
        const weekAt = T0 + 5 * DAY
        w.readings.set("a", reading(T0, 0.2, 0.95, weekAt, [grant("g-a", T0 + 30 * DAY, WEEKLY)]))
        w.readings.set("b", reading(T0, 0.2, 0.95, weekAt, [grant("g-b", T0 + 30 * DAY, WEEKLY)]))
        w.work.runs = [{ name: "ergo", session: "ses_orch", units: queued("implement", 6).units }]
        const pool = yield* w.pool
        yield* pool.pace("anthropic", "claude-opus-5-5", "ses_orch")
        yield* TestClock.adjust(MINUTE)
        yield* pool.pace("anthropic", "claude-opus-5-5", "ses_stranger")
        yield* pool.reviewPushes
        const asked = w.owner.asked.filter((question) => question.key.startsWith("push:") && !question.key.includes("#"))
        expect(asked.map((question) => question.sessionID)).toEqual(["ses_owner"])
        yield* OwnerTest.answer(w.owner, asked[0]!.key, START)
        yield* pool.reviewResets
        expect((yield* pool.push({ action: "status" })).pushes.map((push) => push.scope)).toEqual([{ host: "workbox", sessionID: "ses_owner", run: "ergo" }])
        for (let start = 0; start < 3; start++) yield* pool.started("anthropic")
        expect(yield* pool.pace("anthropic", "claude-opus-5-5", "ses_orch")).toMatchObject({ ok: true })
        expect(yield* pool.pace("anthropic", "claude-opus-5-5", "ses_stranger")).toMatchObject({ ok: false, soft: true })
        /** Weeks spent: the stranger's held start claims nothing. */
        w.readings.set("a", reading(T0 + 2 * MINUTE, 1, 1, weekAt, [grant("g-a", T0 + 30 * DAY, WEEKLY)]))
        w.readings.set("b", reading(T0 + 2 * MINUTE, 1, 1, weekAt, [grant("g-b", T0 + 30 * DAY, WEEKLY)]))
        yield* TestClock.adjust(MINUTE)
        yield* pool.pace("anthropic", "claude-opus-5-5", "ses_stranger")
        yield* settle
        expect(w.claims).toEqual([])
      }),
    ))

  test("a run whose session is not known, or whose tree has not asked the pace lately, is asked about nowhere", () =>
    onTestClock(
      Effect.gen(function* () {
        const w = world()
        w.readings.set("a", reading(T0, 0.2, 0.95, T0 + 5 * DAY, [grant("g-a", T0 + 30 * DAY, WEEKLY)]))
        w.readings.set("b", reading(T0, 0.2, 0.95, T0 + 5 * DAY, [grant("g-b", T0 + 30 * DAY, WEEKLY)]))
        w.work.runs = [{ name: "ergo", units: queued("implement", 6).units }, { name: "idle", session: "ses_gone", units: queued("plan", 6).units }]
        const pool = yield* w.pool
        yield* pool.pace("anthropic", "claude-opus-5-5", "ses_stranger")
        yield* pool.reviewPushes
        expect(w.owner.asked.filter((question) => question.key.startsWith("push:") && !question.key.includes("#"))).toEqual([])
      }),
    ))

  /** The verifier's VP1 (round 3): the run's tree asked the pace `gap` ago, and another tree paces now; the run's questions asked after the review. */
  const askedAfter = Effect.fn("test.askedAfter")(function* (gap: number) {
    const w = world()
    w.owner.parents.set("ses_orch", "ses_owner")
    const weekAt = T0 + 5 * DAY
    w.work.runs = [{ name: "ergo", session: "ses_orch", units: queued("implement", 6).units }]
    const read = (at: number) => {
      w.readings.set("a", reading(at, 0.2, 0.95, weekAt, [grant("g-a", T0 + 30 * DAY, WEEKLY)]))
      w.readings.set("b", reading(at, 0.2, 0.95, weekAt, [grant("g-b", T0 + 30 * DAY, WEEKLY)]))
    }
    read(T0)
    const pool = yield* w.pool
    yield* pool.pace("anthropic", "claude-opus-5-5", "ses_orch")
    yield* TestClock.adjust(gap)
    read(T0 + gap)
    yield* pool.pace("anthropic", "claude-opus-5-5", "ses_stranger")
    yield* pool.reviewPushes
    return w.owner.asked.filter((question) => question.key.startsWith("push:") && !question.key.includes("#")).map((question) => question.sessionID)
  })

  test("VP1 a run whose tree asked the pace over an hour ago is asked about nowhere, though another tree paces now", () =>
    onTestClock(
      Effect.gen(function* () {
        expect(yield* askedAfter(Model.PUSH_ASKER_MS + MINUTE)).toEqual([])
      }),
    ))

  test("VP1, the other side of the hour: a run whose tree asked the pace within it is asked about in its tree", () =>
    onTestClock(
      Effect.gen(function* () {
        expect(yield* askedAfter(Model.PUSH_ASKER_MS - MINUTE)).toEqual(["ses_owner"])
      }),
    ))

  /** A property over askers from several trees: whatever asks the pace, and in what order, a yes to the run's question lifts no hold outside the run's tree. */
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    test(`property, seed ${seed}: a yes to a run's question lifts no hold outside the run's tree`, () =>
      onTestClock(
        Effect.gen(function* () {
          let s = seed
          const next = () => {
            s = (s * 1103515245 + 12345) % 2147483648
            return s / 2147483648
          }
          const w = world()
          const trees = ["ses_owner", "ses_a", "ses_b"]
          w.owner.parents.set("ses_orch", "ses_owner")
          for (const tree of trees.slice(1)) w.owner.parents.set(`${tree}_child`, tree)
          w.readings.set("a", reading(T0, 0.2, 0.95, T0 + 5 * DAY, [grant("g-a", T0 + 30 * DAY, WEEKLY)]))
          w.readings.set("b", reading(T0, 0.2, 0.95, T0 + 5 * DAY, [grant("g-b", T0 + 30 * DAY, WEEKLY)]))
          w.work.runs = [{ name: "ergo", session: "ses_orch", units: queued("implement", 6).units }]
          const pool = yield* w.pool
          const sessions = ["ses_orch", "ses_a_child", "ses_b_child", "ses_a", "ses_b"]
          for (let step = 0; step < 6; step++) {
            yield* pool.pace("anthropic", "claude-opus-5-5", sessions[Math.floor(next() * sessions.length)]!)
            yield* TestClock.adjust(Math.floor(next() * 10) * MINUTE)
            yield* pool.reviewPushes
          }
          for (const question of w.owner.asked.filter((item) => item.key.startsWith("push:") && !item.key.includes("#"))) {
            expect(question.sessionID).toBe("ses_owner")
            yield* OwnerTest.answer(w.owner, question.key, START)
          }
          yield* pool.reviewResets
          for (let start = 0; start < 3; start++) yield* pool.started("anthropic")
          for (const outside of ["ses_a_child", "ses_b_child", "ses_a", "ses_b"]) expect((yield* pool.pace("anthropic", "claude-opus-5-5", outside)).ok).toBe(false)
          for (const push of (yield* pool.push({ action: "status" })).pushes) expect(push.scope.sessionID).toBe("ses_owner")
        }),
      ))
  }
})

describe("use it or lose it", () => {
  test("with low demand the resets in hand would expire unused: the forecast names them, and the owner is asked with no queued work", () =>
    onTestClock(
      Effect.gen(function* () {
        const w = world()
        // 10% of the week used two days in, two weekly resets each expiring in ten days.
        const credits = (id: string) => [grant(`${id}-1`, T0 + 10 * DAY, WEEKLY), grant(`${id}-2`, T0 + 10 * DAY, WEEKLY)]
        w.readings.set("a", reading(T0, 0.1, 0.1, T0 + 5 * DAY, credits("a")))
        w.readings.set("b", reading(T0, 0.1, 0.1, T0 + 5 * DAY, credits("b")))
        const pool = yield* w.pool
        yield* pool.pace("anthropic", "claude-opus-5-5", "ses_owner")
        yield* pool.reviewPushes
        const status = yield* pool.resets
        expect(status.forecast).toEqual([expect.stringContaining("4 of its 4 resets (weekly reset; ≈99% of a week each) expire unused by 2026-11-21 12:00Z")])
        const asked = w.owner.asked.filter((question) => question.key === "push:workbox:*:*#anthropic")
        expect(asked).toHaveLength(1)
        expect(asked[0]!.question).toContain("Start a push to spend the anthropic resets that would go unused?")
        expect(asked[0]!.question).toContain("No queued work was found")
        // A yes starts a push of the whole host with those resets.
        yield* OwnerTest.answer(w.owner, asked[0]!.key, START)
        yield* pool.reviewResets
        expect((yield* pool.push({ action: "status" })).pushes).toMatchObject([{ scope: { host: "workbox" }, allowance: { max: 4, kinds: ["weekly"] } }])
      }),
    ))

  test("during a push of the host, an account whose week is spent has its reset claimed at once, and its line starts again from the claim", () =>
    onTestClock(
      Effect.gen(function* () {
        const w = world()
        const weekAt = T0 + 4 * DAY
        w.readings.set("a", reading(T0, 0.3, 1, weekAt, [grant("g-a", T0 + 30 * DAY, WEEKLY)]))
        w.readings.set("b", reading(T0, 0.3, 0.2, weekAt))
        w.state.answer = (claim) => {
          w.readings.set(claim.credentialID, reading(T0 + MINUTE, 0.3, 0, weekAt))
          return { outcome: "reset" }
        }
        const pool = yield* w.pool
        yield* pool.push({ action: "start", goal: "spend it", resets: 1 })
        // No start is held: b has room. The sweep reviews.
        expect((yield* pool.pace("anthropic", "claude-opus-5-5", "ses_x")).ok).toBe(true)
        yield* pool.sweep
        expect(w.claims.map((claim) => claim.creditID)).toEqual(["g-a"])
        const claim = (yield* pool.resets).claims[0]!
        expect(claim.after?.find((window) => window.name === "7d")?.utilization).toBe(0)
      }),
    ))
})

// The owner's limits, each as the verifier of round 1 probed it (P1-P3,
// P5-P8): a push reaches no further than its scope and its end, spends no
// more than the resets approved, and a no to its question holds for the run.
describe("the owner's limits", () => {
  const weekAt = T0 + 3 * DAY
  const spentBoth = (w: ReturnType<typeof world>, at: number) => {
    w.readings.set("a", reading(at, 1, 1, weekAt, [grant("g-a", T0 + 30 * DAY, FULL)]))
    w.readings.set("b", reading(at, 1, 1, weekAt, [grant("g-b", T0 + 30 * DAY, FULL)]))
  }
  const roomy = (w: ReturnType<typeof world>) => {
    w.readings.set("a", reading(T0, 0.3, 0.5, weekAt, [grant("g-a", T0 + 30 * DAY, FULL)]))
    w.readings.set("b", reading(T0, 0.3, 0.5, weekAt))
  }

  test("P1 a push for the peer starts there, by the names each host knows (daily.ts FLEET: the Mac's workbox is bite-cristian); session and run stay on the asking host", () =>
    onTestClock(
      Effect.gen(function* () {
        const wb = world({}, { host: "bite-cristian", peer: "macbook" })
        roomy(wb)
        const workbox = yield* wb.pool
        const mac = world({}, { host: "cristians-macbook-pro", peer: "workbox", pushes: (_peer, request) => workbox.push(request) })
        roomy(mac)
        const pool = yield* mac.pool
        const answer = yield* pool.push({ action: "start", goal: "ergo", host: "workbox", resets: 1, sessionID: "ses_mac" })
        expect(answer.ok).toBe(true)
        expect(answer.pushes).toMatchObject([{ goal: "ergo", scope: { host: "bite-cristian" } }])
        expect(answer.pushes[0]!.scope.sessionID).toBeUndefined()
        expect((yield* pool.push({ action: "status" })).pushes).toEqual([])
        expect((yield* pool.push({ action: "status", host: "workbox" })).pushes).toHaveLength(1)
        // A session's tree or a run is the Mac's: refused for the workbox, and nothing starts.
        for (const scoped of [{ session: true }, { run: "ergo" }]) {
          const refused = yield* pool.push({ action: "start", goal: "x", host: "workbox", sessionID: "ses_mac", ...scoped })
          expect(refused.ok).toBe(false)
          expect(refused.text).toContain("covers that whole host")
        }
        expect((yield* workbox.push({ action: "status" })).pushes.map((push) => push.goal)).toEqual(["ergo"])
      }),
    ))

  test("P2 a run's push covers the tree it was started from: an unrelated session keeps its spend-evenly hold and gets no claim; a run with no calling session is refused", () =>
    onTestClock(
      Effect.gen(function* () {
        const w = world()
        roomy(w)
        w.owner.parents.set("ses_child", "ses_owner")
        const pool = yield* w.pool
        for (let start = 0; start < 3; start++) yield* pool.started("anthropic")
        const started = yield* pool.push({ action: "start", goal: "run ergo only", run: "ergo", resets: 1, sessionID: "ses_owner" })
        expect(started.pushes).toMatchObject([{ scope: { host: "workbox", sessionID: "ses_owner", run: "ergo" } }])
        expect(yield* pool.pace("anthropic", "claude-opus-5-5", "ses_other")).toMatchObject({ ok: false, soft: true })
        expect(yield* pool.pace("anthropic", "claude-opus-5-5", "ses_child")).toMatchObject({ ok: true })
        // Every account spent: a start from outside the tree is held, and the push claims nothing for it, at once or on the sweep.
        spentBoth(w, T0 + MINUTE)
        yield* TestClock.adjust(MINUTE)
        const held = yield* pool.pace("anthropic", "claude-opus-5-5", "ses_other")
        expect(held.reason ?? "").not.toContain("the push")
        yield* settle
        yield* pool.sweep
        yield* settle
        expect(w.claims).toEqual([])
        // From inside the tree, the claim.
        yield* pool.pace("anthropic", "claude-opus-5-5", "ses_child")
        yield* settle
        expect(w.claims.map((claim) => claim.creditID)).toHaveLength(1)
        // The push RPC with a run and no calling session: no tree to cover, so no push.
        const refused = yield* pool.push({ action: "start", goal: "y", run: "other" })
        expect(refused).toMatchObject({ ok: false })
        expect(refused.text).toContain("needs the calling session")
      }),
    ))

  test("M6 a session's push lifts the spend-evenly hold in its tree only", () =>
    onTestClock(
      Effect.gen(function* () {
        const w = world()
        roomy(w)
        w.owner.parents.set("ses_child", "ses_owner")
        const pool = yield* w.pool
        for (let start = 0; start < 3; start++) yield* pool.started("anthropic")
        yield* pool.push({ action: "start", goal: "ergo", session: true, resets: 1, sessionID: "ses_owner" })
        expect(yield* pool.pace("anthropic", "claude-opus-5-5", "ses_other")).toMatchObject({ ok: false, soft: true })
        expect(yield* pool.pace("anthropic", "claude-opus-5-5", "ses_child")).toMatchObject({ ok: true })
      }),
    ))

  test("P3 a no to a run's question holds for the week, whichever session asks the pace next", () =>
    onTestClock(
      Effect.gen(function* () {
        const w = world()
        w.readings.set("a", reading(T0, 0.2, 0.95, T0 + 5 * DAY, [grant("g-a", T0 + 30 * DAY, WEEKLY)]))
        w.readings.set("b", reading(T0, 0.2, 0.95, T0 + 5 * DAY, [grant("g-b", T0 + 30 * DAY, WEEKLY)]))
        w.work.runs = [{ name: "ergo", session: "ses_orch_1", units: Array.from({ length: 6 }, (_, at) => ({ unit: `u${at}`, state: "implement" })) }]
        const pool = yield* w.pool
        const runQuestions = () => w.owner.asked.filter((question) => question.key.startsWith("push:") && !question.key.includes("#"))
        yield* pool.pace("anthropic", "claude-opus-5-5", "ses_orch_1")
        yield* pool.reviewPushes
        expect(runQuestions().map((question) => question.key)).toEqual(["push:workbox:*:ergo"])
        yield* OwnerTest.answer(w.owner, runQuestions()[0]!.key, NOT_NOW)
        yield* pool.reviewResets
        // Handed off: other orchestrator sessions own the run (they start its steps) and ask the pace through the week; the run is not asked about again.
        for (const [hours, session] of [[1, "ses_orch_2"], [30, "ses_orch_3"], [100, "ses_orch_2"]] as const) {
          yield* TestClock.adjust(hours * HOUR)
          w.work.runs = w.work.runs.map((run) => ({ ...run, session }))
          yield* pool.pace("anthropic", "claude-opus-5-5", session)
          yield* pool.reviewPushes
        }
        expect(runQuestions()).toHaveLength(1)
      }),
    ))

  test("P5 one approved reset: never a second claim, however long the starts are held", () =>
    onTestClock(
      Effect.gen(function* () {
        const w = world()
        spentBoth(w, T0)
        const pool = yield* w.pool
        yield* pool.push({ action: "start", goal: "ergo", resets: 1, sessionID: "ses_owner" })
        for (let round = 0; round < 8; round++) {
          // The claim does not show in the readings: the accounts stay spent.
          spentBoth(w, T0 + round * 40 * MINUTE)
          yield* pool.pace("anthropic", "claude-opus-5-5", "ses_x")
          yield* settle
          yield* pool.sweep
          yield* settle
          yield* TestClock.adjust(40 * MINUTE)
        }
        expect(new Set(w.claims.map((claim) => claim.requestID)).size).toBe(1)
      }),
    ))

  test("P6 past its end and before the sweep ends it: the spend-evenly hold holds and nothing is claimed", () =>
    onTestClock(
      Effect.gen(function* () {
        const w = world()
        roomy(w)
        const pool = yield* w.pool
        for (let start = 0; start < 3; start++) yield* pool.started("anthropic")
        yield* pool.push({ action: "start", goal: "ergo", hours: 1, resets: 3, sessionID: "ses_owner" })
        expect((yield* pool.pace("anthropic", "claude-opus-5-5", "ses_x")).ok).toBe(true)
        yield* TestClock.adjust(61 * MINUTE)
        for (let start = 0; start < 3; start++) yield* pool.started("anthropic")
        // No sweep has run: the push is still recorded, and past its end it does nothing.
        expect(yield* pool.pace("anthropic", "claude-opus-5-5", "ses_x")).toMatchObject({ ok: false, soft: true })
        spentBoth(w, T0 + 61 * MINUTE)
        yield* pool.pace("anthropic", "claude-opus-5-5", "ses_x")
        yield* settle
        expect(w.claims).toEqual([])
      }),
    ))

  test("P7 a session's push: a start held in another tree, or a week spent with none held, claims nothing; held in the tree, one claim", () =>
    onTestClock(
      Effect.gen(function* () {
        const w = world()
        spentBoth(w, T0)
        const pool = yield* w.pool
        yield* pool.push({ action: "start", goal: "ergo", session: true, resets: 2, sessionID: "ses_owner" })
        yield* pool.pace("anthropic", "claude-opus-5-5", "ses_other")
        yield* settle
        yield* pool.sweep
        yield* settle
        expect(w.claims).toEqual([])
        w.owner.parents.set("ses_child", "ses_owner")
        yield* pool.pace("anthropic", "claude-opus-5-5", "ses_child")
        yield* settle
        expect(w.claims).toHaveLength(1)
      }),
    ))

  test("P8 a push on the Mac: the workbox's review of the same accounts claims nothing", () =>
    onTestClock(
      Effect.gen(function* () {
        const mac = world({}, { host: "cristians-macbook-pro", peer: "workbox" })
        const wb = world({}, { host: "bite-cristian", peer: "macbook" })
        spentBoth(mac, T0)
        spentBoth(wb, T0)
        const macPool = yield* mac.pool
        const wbPool = yield* wb.pool
        yield* macPool.push({ action: "start", goal: "mac only", resets: 2, sessionID: "ses_owner" })
        yield* wbPool.pace("anthropic", "claude-opus-5-5", "ses_wb")
        yield* settle
        yield* wbPool.sweep
        yield* settle
        expect(wb.claims).toEqual([])
      }),
    ))

  // A property over push and pace sequences (seeded, so a failure replays):
  // the claims never pass the approved count, none is made past the push's
  // end, and a push of one tree claims nothing and lifts no hold for starts
  // from outside it.
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
    test(`property, seed ${seed}: claims ≤ approved, none past the end, none and no lifted hold outside the tree`, () =>
      onTestClock(
        Effect.gen(function* () {
          const next = random(seed)
          const w = world()
          w.owner.parents.set("ses_child", "ses_owner")
          let now = T0
          const claimedAt: Array<number> = []
          w.state.answer = (claim) => {
            claimedAt.push(now)
            w.readings.set(claim.credentialID, reading(now, 0, 0, weekAt))
            return { outcome: "reset" }
          }
          roomy(w)
          const pool = yield* w.pool
          const max = 1 + Math.floor(next() * 2)
          const hours = 1 + Math.floor(next() * 3)
          const endsAt = T0 + hours * HOUR
          yield* pool.push({ action: "start", goal: "ergo", session: true, hours, resets: max, sessionID: "ses_owner" })
          for (let step = 0; step < 14; step++) {
            const roll = next()
            if (roll < 0.3) spentBoth(w, now)
            else if (roll < 0.4) yield* pool.started("anthropic")
            const outside = next() < 0.5
            const answer = yield* pool.pace("anthropic", "claude-opus-5-5", outside ? "ses_other" : "ses_child")
            yield* settle
            if (next() < 0.3) yield* pool.sweep
            yield* settle
            if (outside) expect(answer.reason ?? "").not.toContain("the push")
            const elapsed = Math.floor(next() * 50) * MINUTE
            yield* TestClock.adjust(elapsed)
            now += elapsed
          }
          expect(claimedAt.length).toBeLessThanOrEqual(max)
          expect(claimedAt.every((at) => at < endsAt)).toBe(true)
        }),
      ))
  }

  test("property: only starts from outside a session's push, any sequence: no claim at all", () =>
    onTestClock(
      Effect.gen(function* () {
        for (const seed of [4, 6, 9]) {
          const next = random(seed)
          const w = world()
          spentBoth(w, T0)
          const pool = yield* w.pool
          yield* pool.push({ action: "start", goal: "ergo", session: true, resets: 3, sessionID: "ses_owner" })
          for (let step = 0; step < 8; step++) {
            yield* pool.pace("anthropic", "claude-opus-5-5", `ses_other_${Math.floor(next() * 3)}`)
            yield* settle
            if (next() < 0.5) yield* pool.sweep
            yield* settle
            yield* TestClock.adjust(Math.floor(next() * 50) * MINUTE)
          }
          expect(w.claims).toEqual([])
        }
      }),
    ))
})
