// The pool model working resets on memory layers: a start held on a pool
// whose every account is spent, with work running, has a reset claimed on its
// own, Codex's or Claude's, once, and the owner is told after in the waiting
// session; the pool asks nothing, and withdraws any older question still
// open. Nothing here reaches a provider: the claim is the memory quota's.
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
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
import { SEEN } from "../resets.ts"

const HOUR = 60 * 60_000
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

/** Three agents started on the provider: work running, which a spent window would hold too. */
const busy = (pool: Model.Pool["Service"], providerID: string) => Effect.forEach([1, 2, 3], () => pool.started(providerID), { discard: true })

/** Let the review a held pace forked run. */
const settle = Effect.promise(() => new Promise<void>((done) => setTimeout(done, 20)))

describe("Codex resets", () => {
  const config: Model.Config = { providers: {}, paced: { openai: OPENAI }, cacheLifeMs: CACHE_LIFE_MS, resets: { openai: "codex" } }
  const logins = new Map([[OPENAI, [{ id: "codex-a", label: "Codex A" }, { id: "codex-b", label: "Codex B" }]]])

  test("every account spent, a start held and work running: one credit is claimed on its own, once, the account read again, and the owner told", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const codex = world(config, logins)
        codex.readings.get(OPENAI)!.set("codex-a", reading(now, { credits: [credit("credit-late", now, 20 * DAY)] }))
        // It expires before the week resets by itself: not one to keep in hand.
        codex.readings.get(OPENAI)!.set("codex-b", reading(now, { credits: [credit("credit-soon", now, 2 * DAY)] }))
        // The reset empties the windows and restarts the week, as Codex's does.
        codex.state.answer = (claim) => {
          codex.readings.get(OPENAI)!.set(claim.credentialID, reading(now, { fiveHour: 0, sevenDay: 0, weekIn: 7 * DAY }))
          return { outcome: "reset" }
        }
        const pool = yield* codex.pool
        yield* busy(pool, "openai")
        const pace = yield* pool.pace("openai", undefined, "ses_root")
        expect(pace.ok).toBe(false)
        yield* settle
        yield* pool.reviewResets
        yield* pool.sweep
        expect(codex.claims.map((claim) => [claim.credentialID, claim.creditID])).toEqual([["codex-b", "credit-soon"]])
        expect(codex.claims[0]!.requestID).toMatch(/^pool-[0-9a-f]{24}$/)
        // Nothing asked: the one item in the tray is the notice after the claim.
        expect(codex.owner.asked.map((question) => [question.sessionID, question.header, question.options.map((option) => option.label)])).toEqual([
          ["ses_root", "Pool reset claimed", [SEEN]],
        ])
        expect(codex.owner.asked[0]!.question).toStartWith("Claimed the Codex reset on Codex B: 5h 100% used of 100% → 0% used")
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
        codex.readings.get(OPENAI)!.set("codex-a", reading(now, { credits: [credit("credit-a", now, 2 * DAY)] }))
        codex.readings.get(OPENAI)!.set("codex-b", reading(now, { fiveHour: 0.1, credits: [credit("credit-b", now, 2 * DAY)] }))
        const pool = yield* codex.pool
        yield* busy(pool, "openai")
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

  /** The account's 5-hour window spent, two 5-hour grants in hand. */
  const held = (claude: ReturnType<typeof world>, now: number, weekIn = 3 * DAY) =>
    claude.readings.get(ANTHROPIC)!.set("claude-a", reading(now, { weekIn, credits: [{ ...credit("grant-1", now, 120 * DAY), count: 2, clears: ["five_hour"] }] }))

  test("a held start with work running: a grant is claimed on its own, once, recorded with whether the week moved, and the owner told in the waiting session; nothing asked", () =>
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
        yield* busy(pool, "anthropic")
        yield* pool.pace("anthropic", undefined, "ses_root")
        yield* settle
        yield* pool.reviewResets
        expect(claude.claims.map((claim) => [claim.credentialID, claim.creditID])).toEqual([["claude-a", "grant-1"]])
        expect(claude.owner.asked.map((question) => [question.sessionID, question.options.map((option) => option.label)])).toEqual([["ses_root", [SEEN]]])
        expect(claude.owner.asked[0]!.question).toMatch(/^Claimed the 5h reset on Claude A: 5h 100% used of 100% → 0% used \(held work no fresh account can take: .*\)\. 1 reset left this week; next expires .*\.$/)
        const status = yield* pool.resets
        expect(status.claims.map((claim) => [claim.provider, claim.outcome, claim.weekly])).toEqual([["claude", "reset", "kept"]])
        // Read, the notice leaves the tray.
        yield* OwnerTest.answer(claude.owner, claude.owner.asked[0]!.key, SEEN)
        yield* pool.reviewResets
        expect(claude.owner.questions.size).toBe(0)
      }),
    ))

  test("a held start with nothing else running is too little work: nothing claimed, nothing asked", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const claude = world(config, logins)
        held(claude, now)
        const pool = yield* claude.pool
        yield* pool.pace("anthropic", undefined, "ses_root")
        yield* settle
        yield* pool.reviewResets
        expect(claude.claims).toEqual([])
        expect(claude.owner.asked).toEqual([])
      }),
    ))

  test("an older pool's question still open, about a reset or a push, is withdrawn", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.now()
        const claude = world(config, logins)
        held(claude, now)
        const old = { sessionID: "ses_root", question: "Claim it?", header: "Claude reset · Claude A", options: [{ label: "Claim it" }], assume: "Don't claim" }
        for (const key of ["claude:anthropic:claude-a:1", "push:workbox:*:ergo"]) claude.owner.questions.set(key, { question: { ...old, key } })
        const pool = yield* claude.pool
        yield* pool.reviewResets
        expect(claude.owner.withdrawn.toSorted()).toEqual(["claude:anthropic:claude-a:1", "push:workbox:*:ergo"])
      }),
    ))
})
