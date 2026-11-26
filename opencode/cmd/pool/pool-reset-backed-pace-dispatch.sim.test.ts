// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// ── The dispatch authority at the provider's bytes ──
// The round-1 verifier's probes (round-1-receipts/adversarial.test.ts and
// ping.test.ts), kept here: each counts the `/v1/messages` requests with tools
// the fake provider actually received, never a pace answer alone.

import { Effect, Option } from "effect"
import { claimEffect } from "../../tests/fake-anthropic.ts"
import { DAY, fable, fleet, fixture, HOUR, quota, readOf, refunds } from "./pool-reset-backed-pace.fixture.ts"
import * as World from "../../sim/world.ts"
import { simulationRunner } from "../../sim/seed.ts"

const { seeded } = simulationRunner("cmd/pool/pool-reset-backed-pace-dispatch.sim.test.ts")

seeded("a fresh week sends beside spent and ahead-of-pace accounts, then holds at its own pace", ({ expect }) =>
  Effect.gen(function* () {
    const fresh = { ...quota(0, 0), sevenDay: { utilization: 0, resetAt: World.START + 7 * DAY } }
    const made = fixture({ spent: quota(1, 0), ahead: quota(0.94, 0), fresh }, refunds)
    const { world, session, pace, primary, claims } = yield* fleet(made)
    const id = yield* session("dynamic_week")
    expect(yield* pace(id)).toMatchObject({ ok: true, admission: "ordinary", eligible: ["fresh"] })
    yield* world.prompt(id, "start on the fresh weekly allowance")
    yield* world.advance(7_000)
    expect(primary().map((request) => request.account)).toEqual(["fresh"])
    made.reading.fresh = { ...fresh, sevenDay: { ...fresh.sevenDay, utilization: 0.06 } }
    yield* world.advance(7_000)
    expect(yield* pace(id)).toMatchObject({ ok: false, reasonCode: "even-line", eligible: [] })
    yield* world.prompt(id, "wait now that this week is ahead of its own pace")
    yield* world.advance(7_000)
    expect(primary().map((request) => request.account)).toEqual(["fresh"])
    expect(claims()).toEqual([])
  }),
)

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

seeded("B3: a managed login never measured sends nothing; an idle measured login whose usage endpoint fails sends once as unmeasured, then obeys its response headers", ({ expect }) =>
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
    // E1 (option a): after one bounded failed read, the already-measured login sends as unmeasured;
    // its response headers report the 85% week and hold the next prompt at the even line.
    expect(yield* warm.pace(second)).toMatchObject({ ok: true, measured: false, eligible: ["a"] })
    yield* warm.world.prompt(second, "stale cached continuation")
    yield* warm.world.advance(10_000)
    expect(warm.primary()).toHaveLength(2)
    expect(yield* warm.pace(second)).toMatchObject({ ok: false, measured: true, reasonCode: "even-line" })
    yield* warm.world.prompt(second, "held once response headers restore the over-line week")
    yield* warm.world.advance(10_000)
    expect(warm.primary()).toHaveLength(2)
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
