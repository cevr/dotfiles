// Reset-backed pace on the simulated host, each test at 20 seeds: no request
// on the pooled provider goes out over the pool's spend-evenly line unless a
// reset the pool claimed, sent once and observed in a fresh reading, gave the
// room back. The planner's red controls
// (tmp/orchestrate/pool-reset-backed-pace/reset-backed-pace/acceptance.sim.test.ts),
// moved here with package imports, and the owner's incident fixture: shared
// week 100%, Fable 68% of its own week = 34 shared points, observed after the
// claim at 66%, one claim.
import { Pace } from "@dotfiles/opencode-pool/pace"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { claimEffect, type FakeGrant, type FakeQuota } from "../../tests/fake-anthropic.ts"
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

seeded("a natural weekly reset reopens a held request with no claim", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, session, setQuota } = yield* boot(seed, quota(0.75, 0.08))
    const primary = () => world.provider().received().filter((request) => request.path === "/v1/messages" && request.tools > 0)
    yield* world.prompt(session, "Held at the line.")
    yield* world.advance(10_000)
    expect(primary()).toHaveLength(0)
    // The week rolls over: a fresh period, 2% used.
    setQuota({ ...quota(0.02, 0), sevenDay: { utilization: 0.02, resetAt: World.START + 10.5 * DAY } })
    yield* world.advance(7_000)
    yield* world.prompt(session, "The week reset.")
    yield* world.until(() => primary().length > 0, HOUR)
    expect(primary().map((request) => request.account)).toEqual(["fixture"])
    expect(world.provider().claims()).toHaveLength(0)
  }),
)
