// The pool model working resets on memory layers: a start held on a pool
// whose every account is spent claims a Codex credit by itself, once; on a
// Claude pool it asks the owner in the waiting session, claims on a yes, not
// on a no, and withdraws the question once the hold lifts by itself. Nothing
// here reaches a provider: the claim is the memory quota's.
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { PoolId } from "../account-pool.ts"
import { CACHE_LIFE_MS } from "../accounts.ts"
import * as FleetTest from "./fleet.ts"
import * as LedgerTest from "./ledger.ts"
import * as LoginsTest from "./logins.ts"
import * as OwnerTest from "./owner.ts"
import * as PeersTest from "./peers.ts"
import * as QuotaTest from "./quota.ts"
import * as ResetsTest from "./resets.ts"
import * as Model from "../model.ts"
import type { ClaimAnswer, QuotaReading, ResetCredit } from "../quota.ts"
import { CLAIM, KEEP } from "../resets.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const OPENAI = PoolId.make("openai")
const ANTHROPIC = PoolId.make("anthropic")

/** A reading whose 5-hour window is spent (`fiveHour` used), its week `sevenDay` used and resetting in `weekIn`, with `credits`. */
const reading = (
  now: number,
  options: { readonly fiveHour?: number; readonly sevenDay?: number; readonly weekIn?: number; readonly credits?: ReadonlyArray<ResetCredit> },
): QuotaReading => {
  const credits = options.credits ?? []
  return {
    at: now,
    windows: [
      { name: "5h", utilization: options.fiveHour ?? 1, resetAt: now + 2 * HOUR },
      { name: "7d", utilization: options.sevenDay ?? 0.4, resetAt: now + (options.weekIn ?? 3 * DAY) },
    ],
    resets: { available: credits.filter((credit) => credit.usable).length, credits },
  }
}

const credit = (id: string, now: number, expiresIn = 20 * DAY): ResetCredit => ({ id, count: 1, usable: true, expiresAt: now + expiresIn })

interface Claimed {
  readonly pool: PoolId
  readonly credentialID: string
  readonly creditID: string
  readonly requestID: string
}

/** The pool on memory layers: `readings` by pool and login, the claims sent recorded, each answered by `answer`. */
const world = (config: Model.Config, connections: Map<PoolId, ReadonlyArray<{ readonly id: string; readonly label: string }>>) => {
  const readings = new Map<PoolId, Map<string, QuotaReading>>([...connections.keys()].map((pool) => [pool, new Map()]))
  const claims: Array<Claimed> = []
  const owner = OwnerTest.empty()
  const resets = new Map<string, Schema.Json>()
  const state = { answer: (_claim: Claimed): ClaimAnswer => ({ outcome: "reset" }) }
  const integration: LoginsTest.Integration = {
    connections: new Map(
      [...connections].map(([pool, logins]) => [pool, logins.map((login) => ({ type: "credential" as const, method: "oauth" as const, ...login }))]),
    ),
    marks: [],
  }
  const externals = Layer.mergeAll(
    LoginsTest.layer(integration),
    QuotaTest.layer(readings, new Map(), (pool, input) => {
      const claim = { pool, ...input }
      claims.push(claim)
      return state.answer(claim)
    }),
    LedgerTest.layer(),
    PeersTest.layer(new Map()),
    FleetTest.layer(),
    ResetsTest.layer(resets),
    OwnerTest.layer(owner),
  )
  const pool = Effect.gen(function* () {
    const services = yield* Layer.build(Model.layer(config).pipe(Layer.provide(externals)))
    return Context.get(services, Model.Pool)
  })
  return { readings, claims, owner, state, pool }
}

const scoped = <A, E>(body: Effect.Effect<A, E, import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

/** Let the review a held pace forked run. */
const settle = Effect.promise(() => new Promise<void>((done) => setTimeout(done, 20)))

describe("Codex resets", () => {
  const config: Model.Config = { providers: {}, paced: { openai: OPENAI }, cacheLifeMs: CACHE_LIFE_MS, resets: { openai: "codex" } }
  const logins = new Map([[OPENAI, [{ id: "codex-a", label: "Codex A" }, { id: "codex-b", label: "Codex B" }]]])

  test("every account spent and a start held: one credit is claimed, once, and the account read again", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const codex = world(config, logins)
        codex.readings.get(OPENAI)!.set("codex-a", reading(now, { credits: [credit("credit-late", now, 20 * DAY)] }))
        codex.readings.get(OPENAI)!.set("codex-b", reading(now, { credits: [credit("credit-soon", now, 3 * DAY)] }))
        // The reset empties the windows and restarts the week, as Codex's does.
        codex.state.answer = (claim) => {
          codex.readings.get(OPENAI)!.set(claim.credentialID, reading(now, { fiveHour: 0, sevenDay: 0, weekIn: 7 * DAY }))
          return { outcome: "reset" }
        }
        const pool = yield* codex.pool
        const pace = yield* pool.pace("openai", undefined, "ses_root")
        expect(pace.ok).toBe(false)
        yield* settle
        yield* pool.reviewResets
        yield* pool.sweep
        // The credit that expires soonest goes first; the hold is worked once.
        expect(codex.claims.map((claim) => [claim.credentialID, claim.creditID])).toEqual([["codex-b", "credit-soon"]])
        expect(codex.claims[0]!.requestID).toMatch(/^pool-[0-9a-f]{24}$/)
        // No question about the claim; the push question about resets left unused (push.ts) is another matter.
        expect(codex.owner.asked.filter((question) => !question.key.startsWith("push:"))).toEqual([])
        const status = yield* pool.resets
        expect(status.claims.map((claim) => [claim.outcome, claim.weekly])).toEqual([["reset", "moved"]])
        expect(status.resets.map((reset) => [reset.credentialID, reset.stage])).toEqual([["codex-b", "settled"]])
        // The claimed account takes starts again.
        expect((yield* pool.pace("openai", undefined, "ses_root")).ok).toBe(true)
      }),
    ))

  test("one account with room: nothing is claimed", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const codex = world(config, logins)
        codex.readings.get(OPENAI)!.set("codex-a", reading(now, { credits: [credit("credit-a", now)] }))
        codex.readings.get(OPENAI)!.set("codex-b", reading(now, { fiveHour: 0.1, credits: [credit("credit-b", now)] }))
        const pool = yield* codex.pool
        yield* pool.pace("openai", undefined, "ses_root")
        yield* settle
        yield* pool.reviewResets
        expect(codex.claims).toEqual([])
      }),
    ))
})

describe("Claude resets", () => {
  const config: Model.Config = { providers: { anthropic: ANTHROPIC }, cacheLifeMs: CACHE_LIFE_MS, resets: { anthropic: "claude" } }
  const logins = new Map([[ANTHROPIC, [{ id: "claude-a", label: "Claude A" }]]])

  const held = (claude: ReturnType<typeof world>, now: number) =>
    claude.readings.get(ANTHROPIC)!.set("claude-a", reading(now, { weekIn: 3 * DAY, credits: [credit("grant-1", now, 120 * DAY)] }))

  test("a held start asks the owner once, in the waiting session, with the days left; nothing is claimed unasked", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const claude = world(config, logins)
        held(claude, now)
        const pool = yield* claude.pool
        yield* pool.pace("anthropic", undefined, "ses_root")
        yield* settle
        yield* pool.pace("anthropic", undefined, "ses_root")
        yield* settle
        yield* pool.reviewResets
        expect(claude.claims).toEqual([])
        expect(claude.owner.asked).toHaveLength(1)
        const asked = claude.owner.asked[0]!
        expect(asked.sessionID).toBe("ses_root")
        expect(asked.header).toBe("Claude reset · Claude A")
        expect(asked.question).toContain("3.0 days remain before the weekly reset")
        expect(asked.question).toContain("The grant ends")
        expect(asked.question).not.toContain("probably not worth it")
        expect(asked.options.map((option) => option.label)).toEqual([CLAIM, KEEP])
      }),
    ))

  test("a yes claims the grant, once, records the outcome and whether the week moved, and takes the question down", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const claude = world(config, logins)
        held(claude, now)
        // A Claude grant clears the 5-hour window and keeps the weekly reset.
        claude.state.answer = (claim) => {
          claude.readings.get(ANTHROPIC)!.set(claim.credentialID, reading(now, { fiveHour: 0, weekIn: 3 * DAY }))
          return { outcome: "reset" }
        }
        const pool = yield* claude.pool
        yield* Effect.forkScoped(pool.followAnswers)
        yield* pool.pace("anthropic", undefined, "ses_root")
        yield* settle
        const key = claude.owner.asked[0]!.key
        yield* OwnerTest.answer(claude.owner, key, CLAIM)
        yield* settle
        yield* pool.reviewResets
        expect(claude.claims.map((claim) => [claim.credentialID, claim.creditID])).toEqual([["claude-a", "grant-1"]])
        expect(claude.owner.withdrawn).toContain(key)
        expect(claude.owner.questions.size).toBe(0)
        const status = yield* pool.resets
        expect(status.claims.map((claim) => [claim.provider, claim.outcome, claim.weekly])).toEqual([["claude", "reset", "kept"]])
      }),
    ))

  test("a no claims nothing and is not asked again for the same hold", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const claude = world(config, logins)
        held(claude, now)
        const pool = yield* claude.pool
        yield* pool.pace("anthropic", undefined, "ses_root")
        yield* settle
        const key = claude.owner.asked[0]!.key
        yield* OwnerTest.answer(claude.owner, key, KEEP)
        yield* pool.reviewResets
        yield* pool.pace("anthropic", undefined, "ses_root")
        yield* settle
        yield* pool.reviewResets
        expect(claude.claims).toEqual([])
        expect(claude.owner.asked).toHaveLength(1)
        expect(claude.owner.withdrawn).toContain(key)
        expect((yield* pool.resets).resets.map((reset) => reset.stage)).toEqual(["declined"])
      }),
    ))

  test("the hold lifting by itself withdraws the question unanswered", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        yield* TestClock.setTime(now)
        const claude = world(config, logins)
        held(claude, now)
        const pool = yield* claude.pool
        yield* pool.pace("anthropic", undefined, "ses_root")
        yield* settle
        const key = claude.owner.asked[0]!.key
        // The 5-hour window resets; the sweep reads it and reviews.
        yield* TestClock.adjust(2 * HOUR + MINUTE)
        claude.readings
          .get(ANTHROPIC)!
          .set("claude-a", reading(now + 2 * HOUR + MINUTE, { fiveHour: 0, weekIn: 3 * DAY - 2 * HOUR, credits: [credit("grant-1", now, 120 * DAY)] }))
        yield* pool.sweep
        expect(claude.owner.withdrawn).toEqual([key])
        expect(claude.claims).toEqual([])
        expect((yield* pool.resets).resets.map((reset) => [reset.stage, reset.message])).toEqual([["withdrawn", "the hold lifted"]])
      }).pipe(Effect.provide(TestClock.layer())),
    ))

  test("under a day to the weekly reset, the question says it is probably not worth it", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const claude = world(config, logins)
        claude.readings.get(ANTHROPIC)!.set("claude-a", reading(now, { weekIn: 10 * HOUR, credits: [credit("grant-1", now, 120 * DAY)] }))
        const pool = yield* claude.pool
        yield* pool.pace("anthropic", undefined, "ses_root")
        yield* settle
        expect(claude.owner.asked[0]?.question).toContain("probably not worth it")
      }),
    ))
})
