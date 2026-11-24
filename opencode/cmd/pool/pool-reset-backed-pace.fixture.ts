import { Pace } from "@dotfiles/opencode-pool/pace"
import { Array as Arr, Effect, Exit, Option, Schema, Scope } from "effect"
import { claimEffect, type FakeClaimResult, type FakeGrant, type FakeQuota } from "../../tests/fake-anthropic.ts"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import * as World from "../../sim/world.ts"

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const WORK = "/scratch/reset-backed-pace"
const SESSION = "ses_reset_backed"
export const POOL = "dotfiles-opencode.pool"

export const decodePace = Schema.decodeUnknownSync(Pace)
/** The status RPC's answer, as far as this suite reads it: the anthropic pool's accounts' windows. */
export const decodeStatus = Schema.decodeUnknownSync(
  Schema.Struct({
    anthropic: Schema.Struct({
      accounts: Schema.Array(Schema.Struct({ reading: Schema.Struct({ windows: Schema.Array(Schema.Struct({ name: Schema.String, utilization: Schema.Number })) }) })),
    }),
  }),
)

/** Midweek: the shared week resets in 3.5 days, so the even line is 54.5% used (with its 5-point leeway). */
export const quota = (week: number, own: number): FakeQuota => ({
  fiveHour: { utilization: 0.2, resetAt: World.START + 3 * HOUR },
  sevenDay: { utilization: week, resetAt: World.START + 3.5 * DAY },
  fable: { utilization: own, resetAt: World.START + 3.5 * DAY, ofWeekly: 0.5 },
})

export const fable: FakeGrant = {
  id: "fable-1",
  resetsLeft: 1,
  endsAt: World.START + 60 * DAY,
  clears: ["five_hour", "seven_day_overage_included"],
  type: "full",
  givesBackWeekly: true,
}

export const boot = (seed: number, initial: FakeQuota, grants: ReadonlyArray<FakeGrant> = []) =>
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

/** A world's accounts and what the fake answers of them; the test moves it between steps. */
export interface Fixture {
  readonly reading: Record<string, FakeQuota>
  /** The account a grant is listed on, while unused. */
  credit: Option.Option<string>
  used: boolean
  /** The usage endpoint answers 429 (a read that fails). */
  unavailable: boolean
  /** The usage endpoint explicitly reports removal of the account's five-hour limit. */
  fiveHourRemoved: boolean
  /** What a claim does to the readings, and the outcome the provider answers. */
  readonly onClaim: (account: string) => FakeClaimResult
}

export const fixture = (reading: Record<string, FakeQuota>, onClaim: (fixture: Fixture, account: string) => FakeClaimResult, credit: Option.Option<string> = Option.none()): Fixture => {
  const made: Fixture = { reading, credit, used: false, unavailable: false, fiveHourRemoved: false, onClaim: (account) => onClaim(made, account) }
  return made
}

/** The claim goes through and gives back what the grant does. */
export const refunds = (made: Fixture, account: string): FakeClaimResult => {
  Option.map(Option.fromUndefinedOr(made.reading[account]), (before) => {
    made.reading[account] = claimEffect(before, fable)
  })
  return "reset"
}

export const readOf = (made: Fixture, account: string): FakeQuota => Option.getOrElse(Option.fromUndefinedOr(made.reading[account]), () => quota(0, 0))

const OTHER = "/scratch/reset-backed-pace-other"

export const fleet = (made: Fixture, options: { readonly beside?: World.World; readonly model?: string; readonly anotherDirectory?: boolean; readonly sweepMinutes?: number } = {}) =>
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
      return provider.fetch(target, init).then((response) => {
        if (!made.fiveHourRemoved || !response.ok) return response
        if (target.pathname === "/api/oauth/usage") return response.json().then((body) => Response.json({
          ...body,
          five_hour: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Null))("null"),
          limits: body.limits?.filter((limit: { group: string }) => limit.group !== "session"),
          weekly_scoped_shares: body.weekly_scoped_shares?.map((share: { limit_index: number }) => ({ ...share, limit_index: share.limit_index - 1 })),
        }))
        const headers = new Headers(response.headers)
        headers.delete("anthropic-ratelimit-unified-5h-utilization")
        headers.delete("anthropic-ratelimit-unified-5h-reset")
        return new Response(response.body, { status: response.status, headers })
      })
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
