// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
import { Effect, Option } from "effect"
import { claimEffect, type FakeClaimResult } from "../../tests/fake-anthropic.ts"
import { boot, DAY, decodePace, fable, fleet, fixture, HOUR, POOL, quota, readOf, refunds, WORK, type Fixture } from "./pool-reset-backed-pace.fixture.ts"
import * as World from "../../sim/world.ts"
import { simulationRunner } from "../../sim/seed.ts"

const { seeded } = simulationRunner("cmd/pool/pool-reset-backed-pace-readings.sim.test.ts")

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
