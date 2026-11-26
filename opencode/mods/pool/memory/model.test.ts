// The pool model working resets on memory layers: a start held on a pool
// whose every account is spent, with work running, has a reset claimed on its
// own, Codex's or Claude's, once, and the owner is told after in the waiting
// session; the pool asks nothing, and withdraws any older question still
// open. Nothing here reaches a provider: the claim is the memory quota's.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Cause, Clock, Context, Effect, Exit, Fiber, Layer, Option, Order, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { AccountsHeld, PoolId } from "../account-pool.ts"
import { CACHE_LIFE_MS } from "../accounts.ts"
import type { RequestHeld } from "../pace.ts"
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
import { stamp } from "../../../tests/hang-guard.ts"

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
const world = (config: Model.Config, connections: Map<PoolId, ReadonlyArray<{ readonly id: string; readonly label: string }>>, usage?: Parameters<typeof QuotaTest.layer>[3]) => {
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
    }, usage),
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

/** Three sessions busy on the provider, each a step started: work running, which a spent window would hold too. */
const busy = (pool: Model.Pool["Service"], providerID: string) =>
  Effect.forEach([1, 2, 3], (n) => pool.stepStarted(`ses_busy_${n}`, providerID), { discard: true })

/** Let the review a held pace forked run. */
const settle = Effect.yieldNow

test("a cached run on an ahead-of-pace login moves to a fresh week despite the other accounts' spend", () =>
  scoped(Effect.gen(function* () {
    const now = Date.parse("2026-11-25T19:00:00Z")
    yield* TestClock.setTime(now)
    const ids = ["cached", "spent", "fresh"]
    const fixture = world({ providers: { anthropic: ANTHROPIC }, cacheLifeMs: CACHE_LIFE_MS },
      new Map([[ANTHROPIC, ids.map((id) => ({ id, label: id }))]]))
    const samples = fixture.readings.get(ANTHROPIC)!
    samples.set("cached", reading(now, { fiveHour: 0, sevenDay: 0.2 }))
    samples.set("spent", reading(now, { fiveHour: 0, sevenDay: 1 }))
    samples.set("fresh", reading(now, { fiveHour: 0, sevenDay: 0, weekIn: 7 * DAY }))
    const pool = yield* fixture.pool
    const turn = { providerID: "anthropic", model: "claude-haiku-4-5", sessionID: "ses_dynamic", kind: "primary" } as const
    expect((yield* pool.place(turn))?.credentialID).toBe("cached")
    yield* TestClock.adjust(1)
    samples.set("cached", reading(now + 1, { fiveHour: 0, sevenDay: 0.94 }))
    const next = yield* pool.place(turn)
    expect(next?.credentialID).toBe("fresh")
    expect((yield* pool.session({ sessionID: turn.sessionID })).account?.credentialID).toBe("fresh")
    expect(fixture.claims).toEqual([])
  }).pipe(Effect.provide(TestClock.layer()))))

test("dispatch starts every stale read together and ends a hung evidence round with a hold", () =>
  scoped(Effect.gen(function* () {
    const ids = ["a", "b", "c", "d", "e", "f", "g"]
    const tried: Array<string> = []
    const now = 1_800_000_000_000
    yield* TestClock.setTime(now)
    const fixture = world({ providers: { anthropic: ANTHROPIC }, cacheLifeMs: CACHE_LIFE_MS },
      new Map([[ANTHROPIC, ids.map((id) => ({ id, label: id }))]]),
      (_pool, id) => Effect.sync(() => { tried.push(id) }).pipe(Effect.andThen(Effect.never)))
    const pool = yield* fixture.pool
    const request = yield* Effect.forkChild(Effect.result(pool.place({
      providerID: "anthropic", sessionID: "hung", kind: "primary", model: "claude-haiku-4-5",
    })))
    yield* TestClock.adjust(1)
    expect(tried.toSorted()).toEqual(ids)
    yield* TestClock.adjust(19_998)
    expect(request.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust(1)
    const finished = Option.fromUndefinedOr(request.pollUnsafe())
    expect(Option.isSome(finished)).toBe(true)
    if (Option.isSome(finished)) {
      const deny = yield* Fiber.join(request)
      expect(Result.match(deny, {
        onSuccess: (placed) => placed,
        onFailure: (error) => {
          if (error._tag === "RequestHeld") return [error._tag, error.retryAt, error.reasonCode]
          return [error._tag, error.retryAt]
        },
      })).toEqual(["RequestHeld", now + 80_000, "usage-unread"])
    }
  }).pipe(Effect.provide(TestClock.layer()))))

test("an in-flight title's success cannot send a refused primary turn back to the same login", () =>
  scoped(
    Effect.gen(function* () {
      const now = Date.parse("2026-11-23T00:00:00Z")
      yield* TestClock.setTime(now)
      const logins = new Map([[ANTHROPIC, [{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }]]])
      const fixture = world({ providers: { anthropic: ANTHROPIC }, cacheLifeMs: CACHE_LIFE_MS }, logins)
      const samples = fixture.readings.get(ANTHROPIC)!
      const room = reading(now, { fiveHour: 0.1, sevenDay: 0.2 })
      samples.set("alpha", room)
      samples.set("beta", room)
      const pool = yield* fixture.pool
      const turn = { providerID: "anthropic", model: "claude-haiku-4-5", sessionID: "ses_owner", kind: "primary" } as const
      const title = { ...turn, kind: "title" } as const
      const primary = yield* pool.place(turn)
      const auxiliary = yield* pool.place(title)
      expect(auxiliary?.credentialID).toBe("alpha")

      // Both requests have already left. Receive the primary's 429 first, then
      // the title's 200 whose headers still say the account has room.
      samples.set("alpha", {
        ...reading(now, { sevenDay: 0.2 }),
        refusal: { kind: "usage-limit", until: now + 2 * HOUR },
      })
      yield* pool.responded({ ...turn, status: 429 })
      yield* TestClock.adjust(1)
      samples.set("alpha", { ...room, at: now + 1, status: "allowed" })
      yield* pool.responded({ ...title, status: 200 })
      expect(yield* pool.retry({ ...turn, error: "provider.quota" })).toBe(true)
      const retry = yield* pool.place(turn)
      const replies = new Map([["alpha", 429], ["beta", 200]])
      const primarySends = [primary, retry].flatMap((placed) =>
        Option.toArray(Option.map(Option.fromUndefinedOr(placed), ({ credentialID }) => [credentialID, replies.get(credentialID)])),
      )
      expect(primarySends).toEqual([["alpha", 429], ["beta", 200]])
    }).pipe(Effect.provide(TestClock.layer())),
  ),
)

describe("Codex resets", () => {
  const config: Model.Config = { providers: {}, paced: { openai: OPENAI }, cacheLifeMs: CACHE_LIFE_MS, resets: { openai: "codex" } }
  const logins = new Map([[OPENAI, [{ id: "codex-a", label: "Codex A" }, { id: "codex-b", label: "Codex B" }]]])

  test("every account spent, a start held and work running: one credit is claimed on its own, once, the account read again, and the owner told", () =>
    scoped(
      Effect.gen(function* () {
        const now = stamp()
        const codex = world(config, logins)
        codex.readings.get(OPENAI)!.set("codex-a", reading(now, { sevenDay: 1, credits: [credit("credit-late", now, 20 * DAY)] }))
        // It expires before the week resets by itself: not one to keep in hand.
        codex.readings.get(OPENAI)!.set("codex-b", reading(now, { sevenDay: 1, credits: [credit("credit-soon", now, 2 * DAY)] }))
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

  test("a spent Codex short window with weekly room left does not discard the week", () =>
    scoped(
      Effect.gen(function* () {
        const now = stamp()
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

  test("a late title's room and an already-redeemed claim do not reopen a refused login", () =>
    scoped(
      Effect.gen(function* () {
        const now = Date.parse("2026-11-23T00:00:00Z")
        const refusedUntil = now + HOUR
        yield* TestClock.setTime(now)
        const fixture = world(config, logins)
        const samples = Option.getOrThrow(Option.fromNullishOr(fixture.readings.get(ANTHROPIC)))
        const room = reading(now, { fiveHour: 0.2, sevenDay: 0.2 })
        samples.set("claude-a", room)
        const pool = yield* fixture.pool
        const primary = { providerID: "anthropic", model: "claude-haiku-4-5", sessionID: "ses_owner", kind: "primary" } as const
        const title = { ...primary, kind: "title" } as const
        expect((yield* pool.place(primary))?.credentialID).toBe("claude-a")
        expect((yield* pool.place(title))?.credentialID).toBe("claude-a")

        samples.set("claude-a", { ...room, refusal: { kind: "usage-limit", until: refusedUntil } })
        yield* pool.responded({ ...primary, status: 429 })
        yield* TestClock.adjust(1)
        samples.set("claude-a", { ...room, at: now + 1, status: "allowed" })
        yield* pool.responded({ ...title, status: 200 })
        expect(yield* pool.pace(primary.providerID, primary.model)).toMatchObject({
          ok: false, reasonCode: "account-held", retryAt: refusedUntil,
        })

        // An expiring grant does not require a spent window, so the pool
        // actually sends the claim even though the late title showed room.
        const expires = { ...credit("expiring", now, 30 * 60_000), clears: ["five_hour"], requiresLimit: false }
        samples.set("claude-a", reading(now + 1, { fiveHour: 0.2, sevenDay: 0.2, credits: [expires] }))
        fixture.state.answer = () => {
          samples.set("claude-a", reading(now + 1, { fiveHour: 0.2, sevenDay: 0.2 }))
          return { outcome: "already-redeemed" }
        }
        yield* pool.sweep
        expect(fixture.claims.map((claim) => [claim.credentialID, claim.creditID])).toEqual([["claude-a", "expiring"]])
        expect((yield* pool.resets).claims.map((claim) => claim.outcome)).toEqual(["already-redeemed"])
        const retry = yield* Effect.result(pool.place(primary))
        expect(retry).toEqual(Result.fail(new AccountsHeld({
          sessionID: primary.sessionID, kind: primary.kind, retryAt: refusedUntil, signIn: [],
        })))

        yield* TestClock.setTime(refusedUntil)
        samples.set("claude-a", reading(refusedUntil, { fiveHour: 0.2, sevenDay: 0.2 }))
        expect((yield* pool.place(primary))?.credentialID).toBe("claude-a")
      }).pipe(Effect.provide(TestClock.layer())),
    ))

  test("a held start with work running: a grant is claimed on its own, once, recorded with whether the week moved, and the owner told in the waiting session; nothing asked", () =>
    scoped(
      Effect.gen(function* () {
        const now = stamp()
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
        expect(claude.owner.asked[0]!.question).toMatch(/^Claimed the 5h reset on Claude A: 5h 100% used of 100% → 0% used \(the account reached its limit: 5h 100% used, 3 agents running, 1 start held; refill the measured limit\)\. 1 reset left this week; next expires .*\.$/)
        const status = yield* pool.resets
        expect(status.claims.map((claim) => [claim.provider, claim.outcome, claim.weekly])).toEqual([["claude", "reset", "kept"]])
        // Read, the notice leaves the tray.
        yield* OwnerTest.answer(claude.owner, claude.owner.asked[0]!.key, SEEN)
        yield* pool.reviewResets
        expect(claude.owner.questions.size).toBe(0)
      }),
    ))

  test("no agent running and no start held: nothing claimed, nothing asked, however spent the pool; agents running across the fleet with no start held: the forecast runs it out before its reset, and a grant is claimed", () =>
    scoped(
      Effect.gen(function* () {
        const now = stamp()
        const claude = world(config, logins)
        held(claude, now)
        const pool = yield* claude.pool
        yield* pool.sweep
        expect(claude.claims).toEqual([])
        expect(claude.owner.asked).toEqual([])
        yield* busy(pool, "anthropic")
        yield* pool.sweep
        expect(claude.claims.map((claim) => claim.creditID)).toEqual(["grant-1"])
        const status = yield* pool.resets
        expect(status.resets.map((reset) => reset.why)).toEqual(["forecast"])
      }),
    ))

  describe("agents busy for hours, admitted long ago", () => {
    const T0 = 1_800_000_000_000
    const MINUTE = 60_000
    const sessions = ["ses_1", "ses_2", "ses_3", "ses_4"]
    /** The week only, `used` of it, resetting at T0 + 3 days; one full reset in hand. */
    const week = (at: number, used: number): QuotaReading => ({
      at,
      windows: [{ name: "7d", utilization: used, resetAt: T0 + 3 * DAY }],
      resets: { available: 1, credits: [{ ...credit("grant-1", T0, 120 * DAY), clears: ["seven_day"], requiresLimit: false }] },
    })
    /**
     * Four sessions admitted at T0 that step every 10 minutes for 3 hours,
     * no start after, the week climbing 10 points an hour from 55%; the pool
     * is read and reviewed at each step. With `idle`, they all go idle just
     * before the last read.
     */
    const run = (idle: boolean) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0)
        const claude = world(config, logins)
        const pool = yield* claude.pool
        yield* Effect.forEach(sessions, () => pool.started("anthropic"), { discard: true })
        const before: Array<number> = []
        for (let step = 0; step <= 18; step++) {
          const at = T0 + step * 10 * MINUTE
          yield* TestClock.setTime(at)
          if (idle && step === 18) yield* Effect.forEach(sessions, (id) => pool.release(id), { discard: true })
          else yield* Effect.forEach(sessions, (id) => pool.stepStarted(id, "anthropic"), { discard: true })
          if (step === 18) before.push(claude.claims.length)
          claude.readings.get(ANTHROPIC)!.set("claude-a", week(at, 0.55 + (0.1 * step) / 6))
          yield* pool.sweep
        }
        return { claude, before: before[0] ?? 0, resets: (yield* pool.resets).resets }
      }).pipe(Effect.provide(TestClock.layer()))

    test("still busy at 3 hours and 85% used: an ordinary reset waits for measured exhaustion", () =>
      scoped(
        Effect.gen(function* () {
          const { claude, before, resets } = yield* run(false)
          expect(before).toBe(0)
          expect(claude.claims).toEqual([])
          expect(resets).toEqual([])
        }),
      ))

    test("the same world with the four gone idle: nothing runs, nothing is claimed", () =>
      scoped(
        Effect.gen(function* () {
          const { claude, resets } = yield* run(true)
          expect(claude.claims).toEqual([])
          expect(resets).toEqual([])
        }),
      ))
  })

  test("an older pool's question still open, about a reset or a push, is withdrawn", () =>
    scoped(
      Effect.gen(function* () {
        const now = stamp()
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

// `admissionQuote` is the request's own admission, asked and not taken. For generated pool states, two identical
// pools at one instant: the quote of one answers as `place` of the other (admitted, or held with the same tag, code
// and time), and the quote changes nothing in its pool's decision stores (the reset review's waits, claims and
// spends; the fleet), and nothing in the store at all when no evidence was due (no usage read taken).
describe("admissionQuote", () => {
  const config: Model.Config = { providers: { anthropic: ANTHROPIC }, cacheLifeMs: CACHE_LIFE_MS, resets: { anthropic: "claude" } }
  const ids = ["claude-a", "claude-b"]
  /** One store for the ledger, the fleet and the resets, as the plugin's storage keeps them, and a counted usage read. */
  const twin = (accounts: ReadonlyArray<string>, samples: ReadonlyMap<string, QuotaReading>, fresh: (id: string, now: number) => QuotaReading) => {
    const store = new Map<string, Schema.Json>()
    const owner = OwnerTest.empty()
    const usage = { reads: 0 }
    const newest = new Map(samples)
    const integration: LoginsTest.Integration = {
      connections: new Map([[ANTHROPIC, accounts.map((id) => ({ type: "credential" as const, method: "oauth" as const, id, label: id }))]]),
      marks: [],
    }
    const externals = Layer.mergeAll(
      LoginsTest.layer(integration),
      QuotaTest.layer(new Map([[ANTHROPIC, newest]]), new Map(), () => ({ outcome: "reset" }), (_pool, id) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          usage.reads += 1
          // The auth plugin keeps what it read last as its newest reading.
          const taken = fresh(id, now)
          newest.set(id, taken)
          return taken
        })),
      LedgerTest.layer(store),
      PeersTest.layer(new Map()),
      FleetTest.layer(store),
      ResetsTest.layer(store),
      OwnerTest.layer(owner),
    )
    const pool = Effect.gen(function* () {
      const services = yield* Layer.build(Model.layer(config).pipe(Layer.provide(externals)))
      return Context.get(services, Model.Pool)
    })
    return { store, usage, pool }
  }
  const decisions = (key: string) => key.startsWith("resets/") || key.startsWith("fleet/")
  const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
  const snapshot = (store: Map<string, Schema.Json>, keep: (key: string) => boolean) =>
    encode(Arr.sort([...store.entries()].filter(([key]) => keep(key)), Order.mapInput(Order.String, ([key]: readonly [string, Schema.Json]) => key)))
  const reasonOf = Schema.decodeUnknownOption(Schema.Struct({ reasonCode: Schema.String }))
  const outcome = <A>(exit: Exit.Exit<A, AccountsHeld | RequestHeld>) =>
    Exit.match(exit, {
      onSuccess: () => "admitted",
      onFailure: (cause) => {
        const failure = Cause.findErrorOption(cause)
        return Option.match(failure, {
          onNone: () => `defect ${Cause.pretty(cause)}`,
          onSome: (held) => `${held._tag} ${Option.getOrElse(Option.map(reasonOf(held), ({ reasonCode }) => reasonCode), () => "")} until ${held.retryAt}`,
        })
      },
    })

  test("answers as the request's own admission at the same instant, over generated pool states, and records nothing", () =>
    scoped(Effect.gen(function* () {
      let state = 0x2545f491
      const below = (n: number) => {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        return Math.min(n - 1, Math.floor(((state >>> 0) / 4294967296) * n))
      }
      const seen = { admitted: 0, held: 0, evidence: 0, quiet: 0 }
      for (let index = 0; index < 120; index += 1) {
        // 2026-11-25T19:00:00Z, a day apart.
        const now = 1_795_633_200_000 + index * DAY
        yield* TestClock.setTime(now)
        const accounts = ids.slice(0, 1 + below(2))
        // A usage sample as the auth plugin reports it: one read of the login at `at`.
        const sampleOf = (at: number): QuotaReading => ({
          ...reading(at, {
            fiveHour: [0, 0.3, 0.8, 1][below(4)] ?? 0,
            sevenDay: 0.2 + below(81) / 100,
            weekIn: [1, 3, 6][below(3)]! * DAY,
            credits: Option.getOrElse(Arr.get([[], [{ ...credit("grant-1", at, 120 * DAY), count: 2, clears: ["five_hour"] }]], below(2)), () => []),
          }),
          usage: { at, samples: 1 },
        })
        const samples = new Map(accounts.map((id) => [id, sampleOf(Option.getOrElse(Arr.get([now - 3 * HOUR, now, now], below(3)), () => now))] as const))
        const fresh = new Map(accounts.map((id) => [id, sampleOf(now)] as const))
        const read = (id: string, at: number): QuotaReading => ({ ...(fresh.get(id) ?? sampleOf(at)), at, usage: { at, samples: 1 } })
        const input = {
          providerID: "anthropic", sessionID: "ses_child", model: "claude-haiku-4-5",
          kind: Option.getOrElse(Arr.get(["title", "primary", "primary", "primary", "primary"] as const, below(5)), () => "primary" as const), priority: below(4) === 0,
        }
        const busyRun = below(2) === 0
        const label = `case ${index}: ${encode({ accounts, samples: [...samples], input, busyRun })}`
        const asked = twin(accounts, samples, read)
        const taken = twin(accounts, samples, read)
        const quoting = yield* asked.pool
        const placing = yield* taken.pool
        if (busyRun) {
          yield* busy(quoting, "anthropic")
          yield* busy(placing, "anthropic")
        }
        // Half the pools have swept already: they hold fresh readings, and the request has no evidence to take.
        if (below(2) === 0) {
          yield* quoting.sweep
          yield* placing.sweep
        }
        yield* settle
        const everything = snapshot(asked.store, () => true)
        const decided = snapshot(asked.store, decisions)
        const readings = snapshot(asked.store, (key) => key.startsWith("anthropic/reading/"))
        const reads = asked.usage.reads
        const quote = outcome(yield* Effect.exit(quoting.admissionQuote(input)))
        yield* settle
        // Evidence: a usage read, or a reading the pool had not taken yet. Both are what the request itself takes.
        const evidence = asked.usage.reads !== reads || snapshot(asked.store, (key) => key.startsWith("anthropic/reading/")) !== readings
        expect([label, snapshot(asked.store, decisions)]).toEqual([label, decided])
        if (!evidence) expect([label, snapshot(asked.store, () => true)]).toEqual([label, everything])
        const placed = outcome(yield* Effect.exit(placing.place(input)))
        expect([label, quote]).toEqual([label, placed])
        seen.admitted += Number(quote === "admitted")
        seen.held += Number(quote !== "admitted")
        seen.evidence += Number(evidence)
        seen.quiet += Number(!evidence)
      }
      // The generated states reach both answers, with evidence due and without.
      expect([encode(seen), Object.values(seen).every((count) => count > 0)]).toEqual([encode(seen), true])
    }).pipe(Effect.provide(TestClock.layer()))))

  test("asked of an unpooled provider, it admits and reads nothing", () =>
    scoped(Effect.gen(function* () {
      const asked = twin(["claude-a"], new Map(), (_id, at) => reading(at, {}))
      const pool = yield* asked.pool
      const before = snapshot(asked.store, () => true)
      yield* pool.admissionQuote({ providerID: "openai", sessionID: "ses_child", kind: "primary", model: "gpt-5" })
      expect(snapshot(asked.store, () => true)).toBe(before)
      expect(asked.usage.reads).toBe(0)
    }).pipe(Effect.provide(TestClock.layer()))))
})
