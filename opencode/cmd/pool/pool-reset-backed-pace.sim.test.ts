// Reset-backed pace on the simulated host, each test at 20 seeds: no request
// on the pooled provider goes out over the pool's spend-evenly line unless a
// reset the pool claimed, sent once and observed in a fresh reading, gave the
// room back. The planner's red controls
// (tmp/orchestrate/pool-reset-backed-pace/reset-backed-pace/acceptance.sim.test.ts),
// moved here with package imports, and the owner's incident fixture: shared
// week 100%, Fable 68% of its own week = 34 shared points, observed after the
// claim at 66%, one claim.
import { Pace } from "@dotfiles/opencode-pool/pace"
import { Array as Arr, Effect, Exit, Option, Schema, Scope } from "effect"
import { claimEffect, type FakeClaimResult, type FakeGrant, type FakeQuota } from "../../tests/fake-anthropic.ts"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/pool/pool-reset-backed-pace.sim.test.ts")
const HOUR = 3_600_000
const DAY = 24 * HOUR
const WORK = "/scratch/reset-backed-pace"
const SESSION = "ses_reset_backed"
const POOL = "dotfiles-opencode.pool"

const decodePace = Schema.decodeUnknownSync(Pace)
/** The status RPC's answer, as far as this suite reads it: the anthropic pool's accounts' windows. */
const decodeStatus = Schema.decodeUnknownSync(
  Schema.Struct({
    anthropic: Schema.Struct({
      accounts: Schema.Array(Schema.Struct({ reading: Schema.Struct({ windows: Schema.Array(Schema.Struct({ name: Schema.String, utilization: Schema.Number })) }) })),
    }),
  }),
)

/** Midweek: the shared week resets in 3.5 days, so the even line is 54.5% used (with its 5-point leeway). */
const quota = (week: number, own: number): FakeQuota => ({
  fiveHour: { utilization: 0.2, resetAt: World.START + 3 * HOUR },
  sevenDay: { utilization: week, resetAt: World.START + 3.5 * DAY },
  fable: { utilization: own, resetAt: World.START + 3.5 * DAY, ofWeekly: 0.5 },
})

const fable: FakeGrant = {
  id: "fable-1",
  resetsLeft: 1,
  endsAt: World.START + 60 * DAY,
  clears: ["five_hour", "seven_day_overage_included"],
  type: "full",
  givesBackWeekly: true,
}

const boot = (seed: number, initial: FakeQuota, grants: ReadonlyArray<FakeGrant> = []) =>
  Effect.gen(function* () {
    const accounts = Provider.accounts(seed, ["fixture"])
    let reading = initial
    let used = false
    const world = World.make({
      seed,
      script: () => World.say(""),
      anthropic: {
        accounts,
        quota: () => reading,
        grants: () => grants.filter(() => !used),
        claim: (_account, id) =>
          Option.match(Option.filter(Arr.findFirst(grants, (each) => each.id === id), () => !used), {
            onNone: () => "ineligible",
            onSome: (granted) => {
              used = true
              reading = claimEffect(reading, granted)
              return "reset"
            },
          }),
      },
      integrations: {
        anthropic: [{ id: "fixture", label: "Fixture Claude", ...accounts.fixture!, expires: World.START + 8 * HOUR }],
      },
    })
    yield* world.load(Plugins.anthropicAuth(world.provider()), { directory: WORK })
    yield* world.load(Plugins.pool(new Map(), Plugins.network(world.provider())), {
      directory: WORK,
      options: { sweepMinutes: 0.1, limitsFile: "/nonexistent/loop-probe-x/limits.json" },
    })
    const session = yield* world.session(WORK, { id: SESSION })
    yield* world.advance(7_000)
    const pace = world.rpc(POOL, "pace", { providerID: "anthropic", model: "claude-opus-5-5", sessionID: session })
    return { world, session, pace, setQuota: (next: FakeQuota) => { reading = next } }
  })

seeded("a prospective Fable allowance cannot admit a start beyond even pace", ({ seed, expect }) =>
  Effect.gen(function* () {
    // At midweek the ordinary line is 54.5%. A Fable window used 4–8% took at
    // most 2–4 shared points, whatever its 50% maximum share of the week.
    const own = (4 + (seed >>> 0) % 5) / 100
    const { world, pace } = yield* boot(seed, quota(0.7 + own / 2, own), [fable])
    expect(world.provider().claims()).toHaveLength(0)
    expect(yield* pace).toMatchObject({ measured: true, ok: false })
  }),
)

seeded("a Fable grant can free an Opus lane held by the shared week", ({ seed, expect }) =>
  Effect.gen(function* () {
    // The 100% shared week is the blocker. Fable's own week is 60%, and the
    // claim genuinely gives back 30 shared points in this provider fixture.
    const { world, pace } = yield* boot(seed, quota(1, 0.6), [fable])
    expect(yield* pace).toMatchObject({ measured: true, ok: false })
    yield* world.advance(20_000)
    expect(world.provider().claims().map((claim) => [claim.account, claim.grant, claim.result])).toEqual([["fixture", "fable-1", "reset"]])
    expect(yield* pace).toMatchObject({ measured: true, ok: true })
    expect(world.provider().claims()).toHaveLength(1)
  }),
)

seeded("the owner's fixture: Fable 68% of its week gives back 34 shared points, one claim, room at 66%", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, pace } = yield* boot(seed, quota(1, 0.68), [fable])
    const held = yield* pace
    expect(held).toMatchObject({ measured: true, ok: false })
    // A send outside the host's hooks (the cache's keepalive) asks as a dispatch: held, and no login it may go out on.
    const dispatch = { providerID: "anthropic", model: "claude-opus-5-5", dispatch: true }
    expect(yield* world.rpc(POOL, "pace", dispatch)).toMatchObject({ measured: true, ok: false, eligible: [] })
    yield* world.advance(20_000)
    expect(world.provider().claims().map((claim) => [claim.account, claim.grant, claim.result])).toEqual([["fixture", "fable-1", "reset"]])
    // The reading after the claim is the observed room: the shared week at 66% (100% less 0.68 × 50%).
    const status = decodeStatus(yield* world.rpc(POOL, "status", {}))
    const weeks = status.anthropic.accounts.flatMap((account) => account.reading.windows.filter((window) => window.name === "7d"))
    expect(weeks.map((window) => window.utilization)).toEqual([expect.closeTo(0.66, 6)])
    const next = yield* pace
    expect(next).toMatchObject({ measured: true, ok: true, admission: "backed" })
    // The observed room admits the login itself to a dispatch, not only a start.
    const admitted = decodePace(yield* world.rpc(POOL, "pace", dispatch))
    expect(admitted).toMatchObject({ measured: true, ok: true, admission: "backed" })
    expect(admitted.eligible).toHaveLength(1)
    // Asked again, the pool claims nothing more: the grant is spent, and the room is the one observed.
    yield* world.advance(20_000)
    expect(world.provider().claims()).toHaveLength(1)
  }),
)

seeded("a Fable grant whose part is unread or too small to free the week sends no claim", ({ seed, expect }) =>
  Effect.gen(function* () {
    // Fable's own week at 0.4% takes 0.2 of a shared point: no claim frees a 100% week with it.
    const { world, pace } = yield* boot(seed, quota(1, 0.004), [fable])
    expect(yield* pace).toMatchObject({ measured: true, ok: false })
    yield* world.advance(20_000)
    expect(world.provider().claims()).toHaveLength(0)
    expect(yield* pace).toMatchObject({ measured: true, ok: false })
  }),
)

seeded("an active root's live cache cannot send an over-pace request without a reset", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, session, setQuota } = yield* boot(seed, quota(0.2, 0.08))
    const primary = () => world.provider().received().filter((request) => request.path === "/v1/messages" && request.tools > 0)
    yield* world.prompt(session, "Open a cached turn.")
    yield* world.until(() => world.sessions.get(session)?.running === false, HOUR)
    expect(primary().map((request) => request.account)).toEqual(["fixture"])
    setQuota(quota(0.75, 0.08))
    yield* world.advance(7_000)
    yield* world.prompt(session, "Continue the same cached turn.")
    yield* world.advance(10_000)
    expect(primary().map((request) => request.account)).toEqual(["fixture"])
    expect(world.provider().claims()).toHaveLength(0)
  }),
)

// ── The dispatch authority at the provider's bytes ──
// The round-1 verifier's probes (round-1-receipts/adversarial.test.ts and
// ping.test.ts), kept here: each counts the `/v1/messages` requests with tools
// the fake provider actually received, never a pace answer alone.

/** A world's accounts and what the fake answers of them; the test moves it between steps. */
interface Fixture {
  readonly reading: Record<string, FakeQuota>
  /** The account a grant is listed on, while unused. */
  credit: Option.Option<string>
  used: boolean
  /** The usage endpoint answers 429 (a read that fails). */
  unavailable: boolean
  /** What a claim does to the readings, and the outcome the provider answers. */
  readonly onClaim: (account: string) => FakeClaimResult
}

const fixture = (reading: Record<string, FakeQuota>, onClaim: (fixture: Fixture, account: string) => FakeClaimResult, credit: Option.Option<string> = Option.none()): Fixture => {
  const made: Fixture = { reading, credit, used: false, unavailable: false, onClaim: (account) => onClaim(made, account) }
  return made
}

/** The claim goes through and gives back what the grant does. */
const refunds = (made: Fixture, account: string): FakeClaimResult => {
  Option.map(Option.fromUndefinedOr(made.reading[account]), (before) => {
    made.reading[account] = claimEffect(before, fable)
  })
  return "reset"
}

const readOf = (made: Fixture, account: string): FakeQuota => Option.getOrElse(Option.fromUndefinedOr(made.reading[account]), () => quota(0, 0))

const OTHER = "/scratch/reset-backed-pace-other"

const fleet = (made: Fixture, options: { readonly beside?: World.World; readonly model?: string; readonly anotherDirectory?: boolean; readonly sweepMinutes?: number } = {}) =>
  Effect.gen(function* () {
    const names = Object.keys(made.reading)
    const accounts = Provider.accounts(1, names)
    const world = World.make({
      seed: 1,
      model: { providerID: "anthropic", id: Option.getOrElse(Option.fromUndefinedOr(options.model), () => "claude-opus-5-5") },
      ...Option.match(Option.fromUndefinedOr(options.beside), { onNone: () => ({}), onSome: (beside) => ({ beside }) }),
      script: () => World.say(""),
      anthropic: {
        accounts,
        quota: (account) => readOf(made, account),
        grants: (account) => Option.toArray(Option.filter(made.credit, (holder) => holder === account && !made.used)).map(() => fable),
        claim: (account) => {
          made.used = true
          return made.onClaim(account)
        },
      },
      integrations: {
        anthropic: names.flatMap((id) => Option.toArray(Option.fromUndefinedOr(accounts[id])).map((tokens) => ({ id, label: id, ...tokens, expires: World.START + 8 * HOUR }))),
      },
    })
    const provider = world.provider()
    // The usage endpoint fails while `unavailable`: the read goes to a path the fake answers 404, a read that fails.
    const fetch: typeof provider.fetch = (url, init) => {
      const target = new URL(String(url))
      if (made.unavailable && target.pathname === "/api/oauth/usage") target.pathname = "/nonexistent/loop-probe-x"
      return provider.fetch(target, init)
    }
    const sessionDirectory = Option.getOrElse(Option.filter(Option.some(OTHER), () => options.anotherDirectory === true), () => WORK)
    yield* world.load(Plugins.anthropicAuth({ ...provider, fetch }), { directory: sessionDirectory })
    const pool = Plugins.pool(new Map(), Plugins.network({ ...provider, fetch }))
    const sweepMinutes = Option.getOrElse(Option.fromUndefinedOr(options.sweepMinutes), () => 0.1)
    const config = { sweepMinutes, limitsFile: "/nonexistent/loop-probe-x/limits.json", fleet: { startCost: 0.04 } }
    const claimant = yield* Scope.make()
    if (options.anotherDirectory === true) {
      yield* world.load(pool, { directory: OTHER, options: config })
      yield* world.load({ ...pool, effect: (ctx) => Effect.addFinalizer(() => Scope.close(claimant, Exit.void)).pipe(Effect.andThen(pool.effect(ctx).pipe(Scope.provide(claimant)))) }, { directory: WORK, options: config })
    } else {
      yield* world.load(pool, { directory: WORK, options: config })
    }
    yield* world.advance(7_000)
    return {
      world,
      session: (id: string) => world.session(sessionDirectory, { id: `ses_${id}` }),
      pace: (sessionID: string) => Effect.map(world.rpc(POOL, "pace", { providerID: "anthropic", model: "claude-opus-5-5", sessionID }), decodePace),
      primary: () => world.provider().received().filter((request) => request.path === "/v1/messages" && request.tools > 0),
      claims: () => world.provider().claims().map((claim) => claim.result),
      closeClaimant: world.runtime.run(Scope.close(claimant, Exit.void)),
    }
  })

seeded("a still-running directory observes the refund after the claiming directory closes, without a restart", ({ expect }) =>
  Effect.gen(function* () {
    const made = fixture({ a: quota(1, 0.68) }, () => "reset", Option.some("a"))
    const { world, session, pace, primary, claims, closeClaimant } = yield* fleet(made, { anotherDirectory: true })
    const id = yield* session("surviving_directory")
    expect(yield* pace(id)).toMatchObject({ ok: false })
    yield* world.advance(20_000)
    expect(claims()).toEqual(["reset"])
    yield* closeClaimant
    made.reading["a"] = claimEffect(readOf(made, "a"), fable)
    yield* world.advance(60_000)
    yield* world.prompt(id, "use the claim the other directory left pending")
    yield* world.advance(1_000)
    const errors = world.messages(id).filter((message) => message.type === "error").map((message) => message.message)
    expect({ claims: claims(), sent: primary().map((request) => request.account) }, errors.join("; ")).toEqual({ claims: ["reset"], sent: ["a"] })
  }),
)

seeded("B1: two requests on one reading after a claim share one 4-point slot: one goes out, the other is held, a restart too", ({ expect }) =>
  Effect.gen(function* () {
    const made = fixture({ a: quota(1, 0.68) }, refunds, Option.some("a"))
    const { world, session, pace, primary, claims } = yield* fleet(made)
    const one = yield* session("one")
    const two = yield* session("two")
    expect(yield* pace(one)).toMatchObject({ ok: false })
    yield* world.advance(20_000)
    expect(yield* pace(one)).toMatchObject({ ok: true, admission: "backed" })
    // Both on one virtual instant: the fake does not yet show either one's spend.
    yield* Effect.all([world.prompt(one, "one"), world.prompt(two, "two")], { concurrency: "unbounded" })
    yield* world.advance(200)
    expect({ claims: claims(), sent: primary().length }).toEqual({ claims: ["reset"], sent: 1 })
    // The reservation is kept with the claim: a new process reads it, and the slot stays spent.
    yield* world.restart
    yield* world.prompt(two, "after the restart")
    yield* world.advance(200)
    expect(primary()).toHaveLength(1)
  }),
)

seeded("B2: a cached login never spends another login's refund; the request goes out on the login whose claim gave room", ({ expect }) =>
  Effect.gen(function* () {
    const made = fixture({ a: { ...quota(0.75, 0.68), fiveHour: { utilization: 1, resetAt: World.START + 3 * HOUR } }, b: quota(0.2, 0) }, refunds)
    const { world, session, pace, primary, claims } = yield* fleet(made)
    const id = yield* session("cache_account")
    yield* world.prompt(id, "warm b only")
    yield* world.advance(7_000)
    expect(primary().map((request) => request.account)).toEqual(["b"])
    made.reading["a"] = quota(1, 0.68)
    made.reading["b"] = { ...quota(0.58, 0), fiveHour: { utilization: 1, resetAt: World.START + 3 * HOUR } }
    made.credit = Option.some("a")
    yield* world.advance(7_000)
    yield* pace(id)
    yield* world.advance(20_000)
    made.reading["b"] = quota(0.58, 0)
    yield* world.advance(7_000)
    yield* world.prompt(id, "resume on the login that has room")
    yield* world.advance(7_000)
    expect({ claims: claims(), primary: primary().map((request) => request.account) }).toEqual({ claims: ["reset"], primary: ["b", "a"] })
  }),
)

seeded("B3: a managed login with no usage read, or one read 31 minutes ago, sends nothing", ({ expect }) =>
  Effect.gen(function* () {
    const missing = fixture({ a: quota(0.2, 0) }, refunds)
    missing.unavailable = true
    const cold = yield* fleet(missing)
    const first = yield* cold.session("missing")
    expect(yield* cold.pace(first)).toMatchObject({ ok: false, measured: false, reasonCode: "usage-unread" })
    yield* cold.world.prompt(first, "unmeasured")
    yield* cold.world.advance(10_000)
    expect(cold.primary()).toHaveLength(0)

    const stale = fixture({ a: quota(0.2, 0) }, refunds)
    const warm = yield* fleet(stale, { sweepMinutes: 1 })
    const second = yield* warm.session("stale")
    yield* warm.world.prompt(second, "fresh positive control")
    yield* warm.world.advance(8_000)
    expect(warm.primary()).toHaveLength(1)
    stale.reading["a"] = quota(0.85, 0)
    stale.unavailable = true
    yield* warm.world.advance(31 * 60_000)
    yield* warm.world.prompt(second, "stale cached continuation")
    yield* warm.world.advance(10_000)
    expect(warm.primary()).toHaveLength(1)
  }),
)

seeded("B4: an already-redeemed answer while another actor's refund shows sends nothing", ({ expect }) =>
  Effect.gen(function* () {
    const made = fixture({ a: quota(1, 0.68) }, (self, account) => (refunds(self, account), "already_used"), Option.some("a"))
    const { world, session, pace, primary, claims } = yield* fleet(made)
    const id = yield* session("redeemed")
    yield* pace(id)
    yield* world.advance(20_000)
    expect(yield* pace(id)).toMatchObject({ ok: false })
    yield* world.prompt(id, "must not spend somebody else's refund")
    yield* world.advance(200)
    expect({ claims: claims(), sent: primary().length }).toEqual({ claims: ["already_used"], sent: 0 })
  }),
)

seeded("M1: a claim that went through with its reading after it unread reopens on the first fresh reading, never sending the claim again", ({ expect }) =>
  Effect.gen(function* () {
    const made = fixture(
      { a: quota(1, 0.68) },
      (self) => {
        self.unavailable = true
        return "reset"
      },
      Option.some("a"),
    )
    const { world, session, pace, primary, claims } = yield* fleet(made)
    const id = yield* session("delayed")
    yield* pace(id)
    yield* world.advance(20_000)
    expect(claims()).toEqual(["reset"])
    yield* world.prompt(id, "claim effect not yet observed")
    yield* world.advance(200)
    expect(primary()).toHaveLength(0)
    made.reading["a"] = claimEffect(readOf(made, "a"), fable)
    made.unavailable = false
    yield* world.advance(20_000)
    expect(yield* pace(id)).toMatchObject({ ok: true, admission: "backed" })
    yield* world.prompt(id, "verified delayed refund")
    yield* world.advance(200)
    expect({ claims: claims(), sent: primary().length }).toEqual({ claims: ["reset"], sent: 1 })
  }),
)

seeded("two hosts, one refund: only the claim's host spends its room, at the same instant as the other host's dispatch", ({ expect }) =>
  Effect.gen(function* () {
    const made = fixture({ a: quota(1, 0.68) }, refunds, Option.some("a"))
    const owner = yield* fleet(made)
    const ownerID = yield* owner.session("owner")
    yield* owner.pace(ownerID)
    yield* owner.world.advance(20_000)
    const peer = yield* fleet(made, { beside: owner.world })
    const peerID = yield* peer.session("peer")
    const views = [(yield* owner.pace(ownerID)).ok, (yield* peer.pace(peerID)).ok]
    yield* Effect.all([owner.world.prompt(ownerID, "owner dispatch"), peer.world.prompt(peerID, "peer dispatch")], { concurrency: "unbounded" })
    yield* owner.world.advance(200)
    expect({ views, counts: [owner.primary().length, peer.primary().length], outcomes: [owner.claims(), peer.claims()] }).toEqual({
      views: [true, false],
      counts: [1, 0],
      outcomes: [["reset"], []],
    })
  }),
)

seeded("a 100%-spent Fable cache rotates to a fresh Fable login (good placement kept)", ({ expect }) =>
  Effect.gen(function* () {
    const made = fixture({ a: quota(0.2, 0.2), b: quota(0.2, 1) }, refunds)
    const { world, session, primary } = yield* fleet(made, { model: "claude-fable-5-2" })
    const id = yield* session("fable_model")
    yield* world.prompt(id, "warm a")
    yield* world.advance(7_000)
    made.reading["a"] = quota(0.2, 1)
    made.reading["b"] = quota(0.2, 0.2)
    yield* world.advance(7_000)
    yield* world.prompt(id, "rotate this Fable")
    yield* world.advance(200)
    expect(primary().map((request) => [request.account, request.model])).toEqual([
      ["a", "claude-fable-5-2"],
      ["b", "claude-fable-5-2"],
    ])
  }),
)

// ── A claim the provider's reporting has not caught up with ──
// The claim went through (`reset`) and the reading right after it is fresh but
// unchanged. The claim stays pending, within its bounded observation interval,
// and a quiet reading neither ends it nor sends a second claim of a grant the
// provider still lists.

/** The claim goes through, and the provider's readings do not show it yet; the grant stays listed, as if it held more resets. */
const lags = (made: Fixture): FakeClaimResult => {
  made.used = false
  return "reset"
}

seeded("R3: a claim read unchanged right after it stays pending, sends no request and no second claim, and a timely recovery admits", ({ expect }) =>
  Effect.gen(function* () {
    const made = fixture({ a: quota(1, 0.68) }, lags, Option.some("a"))
    const { world, session, pace, primary, claims } = yield* fleet(made)
    const id = yield* session("lagging")
    expect(yield* pace(id)).toMatchObject({ ok: false })
    yield* world.advance(20_000)
    expect(claims()).toEqual(["reset"])
    // The readings after it (the settle's own and the sweeps') show the week unchanged: no room, nothing goes out.
    yield* world.advance(60_000)
    expect(yield* pace(id)).toMatchObject({ ok: false, measured: true })
    yield* world.prompt(id, "the claim's effect is not reported yet")
    yield* world.advance(200)
    expect(primary()).toHaveLength(0)
    // Still within its observation interval, more readings and asks claim nothing more.
    yield* world.advance(3 * 60_000)
    expect(yield* pace(id)).toMatchObject({ ok: false })
    yield* world.advance(60_000)
    expect(claims()).toEqual(["reset"])
    // The provider catches up: a same-period reading shows the week given back, the claim's own recovery.
    made.reading["a"] = claimEffect(readOf(made, "a"), fable)
    made.used = true
    yield* world.advance(20_000)
    expect(yield* pace(id)).toMatchObject({ ok: true, measured: true, admission: "backed" })
    yield* world.prompt(id, "the recovery is observed")
    yield* world.advance(200)
    expect({ claims: claims(), sent: primary().length }).toEqual({ claims: ["reset"], sent: 1 })
  }),
)

seeded("R3: a claim whose recovery shows only past its observation interval gives no room; a natural rollover still does", ({ expect }) =>
  Effect.gen(function* () {
    const made = fixture(
      { a: quota(1, 0.68) },
      () => "reset",
      Option.some("a"),
    )
    // Exercise repeated reads across 45 minutes without polling every six seconds.
    const { world, session, pace, primary, claims } = yield* fleet(made, { sweepMinutes: 1 })
    const id = yield* session("late")
    yield* pace(id)
    yield* world.advance(20_000)
    expect(claims()).toEqual(["reset"])
    // Unchanged past the interval, then lower: no longer attributable to the claim.
    yield* world.advance(45 * 60_000)
    made.reading["a"] = claimEffect(readOf(made, "a"), fable)
    yield* world.advance(65_000)
    expect(yield* pace(id)).toMatchObject({ ok: false, measured: true })
    yield* world.prompt(id, "a late reduction is not the claim's room")
    yield* world.advance(200)
    expect(primary()).toHaveLength(0)
    // The week rolls over: ordinary room, with no claim.
    made.reading["a"] = { ...quota(0.02, 0), sevenDay: { utilization: 0.02, resetAt: World.START + 6 * DAY } }
    yield* world.advance(65_000)
    expect(yield* pace(id)).toMatchObject({ ok: true, admission: "ordinary" })
    yield* world.prompt(id, "the week reset")
    yield* world.advance(200)
    expect({ claims: claims(), sent: primary().length }).toEqual({ claims: ["reset"], sent: 1 })
  }),
)

// ── Readings that are no evidence of room ──
// A week whose reset time no week can have, or a model's own window that is
// absent or stale, holds the request with a reason and a time to ask again;
// a fresh, valid reading lets it go.

seeded("R3: a fresh week whose reset is more than a week away holds the request, and a valid reading admits it", ({ expect }) =>
  Effect.gen(function* () {
    const invalid = { ...quota(0.2, 0), sevenDay: { utilization: 0.2, resetAt: World.START + 9 * DAY } }
    const made = fixture({ a: invalid }, refunds)
    const { world, session, primary } = yield* fleet(made)
    const id = yield* session("invalid_week")
    const dispatch = decodePace(yield* world.rpc(POOL, "pace", { providerID: "anthropic", model: "claude-opus-5-5", dispatch: true }))
    expect(dispatch).toMatchObject({ ok: false, eligible: [] })
    expect(dispatch.reason).toContain("reset")
    expect(dispatch.retryAt).toBeGreaterThan(World.START)
    yield* world.prompt(id, "an invalid week is no room")
    yield* world.advance(10_000)
    expect(primary()).toHaveLength(0)
    made.reading["a"] = quota(0.2, 0)
    yield* world.advance(20_000)
    yield* world.prompt(id, "a valid week")
    yield* world.until(() => primary().length > 0, HOUR)
    expect(primary().map((request) => request.account)).toEqual(["a"])
  }),
)

seeded("R3: a Fable request is held on a login whose reading has no Fable window, then goes out once one is read", ({ expect }) =>
  Effect.gen(function* () {
    const { fable: _absent, ...noFable } = quota(0.2, 0)
    const made = fixture({ a: { ...quota(0.2, 0.5), fiveHour: { utilization: 1, resetAt: World.START + 3 * HOUR } }, b: noFable }, refunds)
    const { world, session, primary } = yield* fleet(made, { model: "claude-fable-5-2" })
    const id = yield* session("absent_fable")
    const dispatch = decodePace(yield* world.rpc(POOL, "pace", { providerID: "anthropic", model: "claude-fable-5-2", dispatch: true }))
    expect(dispatch).toMatchObject({ ok: false, eligible: [] })
    expect(dispatch.reason).toContain("Fable")
    expect(dispatch.retryAt).toBeGreaterThan(World.START)
    yield* world.prompt(id, "no Fable reading is no Fable room")
    yield* world.advance(10_000)
    expect(primary()).toHaveLength(0)
    made.reading["b"] = quota(0.2, 0.2)
    yield* world.advance(20_000)
    yield* world.prompt(id, "Fable read")
    yield* world.until(() => primary().length > 0, HOUR)
    expect(primary().map((request) => [request.account, request.model])).toEqual([["b", "claude-fable-5-2"]])
  }),
)

seeded("R3: a Fable request is held while its Fable window is a stale carried-over reading, though the week is fresh", ({ expect }) =>
  Effect.gen(function* () {
    const made = fixture({ a: quota(0.2, 0.5) }, refunds)
    const { world, primary } = yield* fleet(made, { sweepMinutes: 1 })
    const opus = yield* world.session(WORK, { id: "ses_stale_opus" })
    const fableSession = yield* world.session(WORK, { id: "ses_stale_fable", model: { providerID: "anthropic", id: "claude-fable-5-2" } })
    yield* world.prompt(opus, "read once")
    yield* world.advance(8_000)
    expect(primary()).toHaveLength(1)
    // The usage endpoint fails from here; Opus answers keep the week fresh through their headers, which carry no Fable window.
    made.unavailable = true
    for (const step of [1, 2, 3, 4]) {
      yield* world.advance(10 * 60_000)
      yield* world.prompt(opus, `keep the week fresh ${step}`)
      yield* world.advance(8_000)
    }
    expect(primary()).toHaveLength(5)
    const dispatch = decodePace(yield* world.rpc(POOL, "pace", { providerID: "anthropic", model: "claude-fable-5-2", dispatch: true }))
    expect(dispatch).toMatchObject({ ok: false, eligible: [] })
    expect(dispatch.reason).toContain("Fable")
    yield* world.prompt(fableSession, "a 40-minute-old Fable window is no Fable room")
    yield* world.advance(10_000)
    expect(primary().filter((request) => request.model === "claude-fable-5-2")).toHaveLength(0)
    made.unavailable = false
    yield* world.advance(65_000)
    yield* world.prompt(fableSession, "Fable read again")
    yield* world.until(() => primary().some((request) => request.model === "claude-fable-5-2"), HOUR)
    expect(primary().filter((request) => request.model === "claude-fable-5-2").map((request) => request.account)).toEqual(["a"])
  }),
)

seeded("a natural weekly reset reopens a held request with no claim", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, session, setQuota } = yield* boot(seed, quota(0.75, 0.08))
    const primary = () => world.provider().received().filter((request) => request.path === "/v1/messages" && request.tools > 0)
    yield* world.prompt(session, "Held at the line.")
    yield* world.advance(10_000)
    expect(primary()).toHaveLength(0)
    // The week rolls over: a fresh period, 2% used, its reset within the week ahead (a reset further off is no valid week).
    setQuota({ ...quota(0.02, 0), sevenDay: { utilization: 0.02, resetAt: World.START + 6 * DAY } })
    yield* world.advance(7_000)
    yield* world.prompt(session, "The week reset.")
    yield* world.until(() => primary().length > 0, HOUR)
    expect(primary().map((request) => request.account)).toEqual(["fixture"])
    expect(world.provider().claims()).toHaveLength(0)
  }),
)
