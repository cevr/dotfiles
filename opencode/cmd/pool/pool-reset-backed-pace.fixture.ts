import { Pace } from "@dotfiles/opencode-pool/pace"
import { Array as Arr, Effect, Exit, Match, Option, Schema, Scope } from "effect"
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
    const parent = yield* world.session(WORK, { id: "ses_reset_parent", model: { providerID: "fixture-parent", id: "parent" } })
    const session = yield* world.session(WORK, { id: SESSION, parentID: parent })
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
  /** How the usage endpoint answers each account's tracked fields; an account not named answers both as windows. */
  readonly layouts: Record<string, UsageLayout>
  /** What a claim does to the readings, and the outcome the provider answers. */
  readonly onClaim: (account: string) => FakeClaimResult
}

/**
 * A tracked usage field as the endpoint answers it: a `window`, `absent` (an
 * explicit `null`: the account has no such limit), `missing` (no key), or
 * `unrecognised` (a shape the reader does not know).
 */
export type Field = "window" | "absent" | "missing" | "unrecognised"
export interface UsageLayout {
  readonly five_hour: Field
  readonly seven_day: Field
  /** A window field the pool does not know, spent: shown, never binding. */
  readonly extra: boolean
}
/** An account whose five-hour limit Anthropic removed (Ultra, 2026-11-24): `five_hour: null`. */
export const ULTRA: UsageLayout = { five_hour: "absent", seven_day: "window", extra: false }

export const fixture = (reading: Record<string, FakeQuota>, onClaim: (fixture: Fixture, account: string) => FakeClaimResult, credit: Option.Option<string> = Option.none()): Fixture => {
  const made: Fixture = { reading, credit, used: false, unavailable: false, layouts: {}, onClaim: (account) => onClaim(made, account) }
  return made
}

const NULL = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Null))("null")
const JsonEntry = Schema.Record(Schema.String, Schema.Json)
const decodeBody = Schema.decodeUnknownSync(JsonEntry)
const decodeEntries = Schema.decodeUnknownOption(Schema.Array(JsonEntry))
/** A field's value in that layout, or none for a missing key. */
const fieldOf = (field: Field, window: Option.Option<Schema.Json>): Option.Option<Schema.Json> =>
  Match.value(field).pipe(
    Match.when("window", () => window),
    Match.when("absent", () => Option.some<Schema.Json>(NULL)),
    Match.when("missing", () => Option.none()),
    Match.orElse(() => Option.some<Schema.Json>({ used: "40%" })),
  )

/** A usage body as `layout` answers it: each tracked field in its state, a removed five-hour limit gone from `limits` too. */
const laidOut = (body: typeof JsonEntry.Type, layout: UsageLayout) => {
  const { five_hour, seven_day, ...rest } = body
  const limits = Option.filter(decodeEntries(body.limits), () => layout.five_hour !== "window")
  return {
    ...rest,
    ...Option.match(fieldOf(layout.five_hour, Option.fromUndefinedOr(five_hour)), { onNone: () => ({}), onSome: (value) => ({ five_hour: value }) }),
    ...Option.match(fieldOf(layout.seven_day, Option.fromUndefinedOr(seven_day)), { onNone: () => ({}), onSome: (value) => ({ seven_day: value }) }),
    ...Option.match(limits, {
      onNone: () => ({}),
      onSome: (limits) => ({
        limits: limits.filter((limit) => limit.group !== "session"),
        weekly_scoped_shares: Option.getOrElse(decodeEntries(body.weekly_scoped_shares), () => []).map((share) => ({ ...share, limit_index: Number(share.limit_index) - 1 })),
      }),
    }),
    ...Arr.match(Arr.filter([{ seven_day_newcomer: { utilization: 100, resets_at: "2099-01-01T00:00:00Z" } }], () => layout.extra), {
      onEmpty: () => ({}), onNonEmpty: ([extra]) => extra,
    }),
  }
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

/** The unified windows `account`'s shape says it has none of, read at each answer (a test may change the shape meanwhile). */
const withoutOf = (made: Fixture, account: string): ReadonlyArray<"5h" | "7d"> =>
  Option.match(Option.fromUndefinedOr(made.layouts[account]), {
    onNone: () => [],
    onSome: (layout) => Arr.filter(["5h", "7d"] as const, (name) => Match.value(name).pipe(Match.when("5h", () => layout.five_hour), Match.orElse(() => layout.seven_day)) === "absent"),
  })

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
        quota: (account) => ({ ...readOf(made, account), without: withoutOf(made, account) }),
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
      // The account a request is for, by its bearer token; its layout, read when the answer comes (a test may change it meanwhile).
      // A model response's headers leave out the windows the account has none of (`quota` below).
      const bearer = new Headers(init?.headers).get("authorization")
      const account = Arr.findFirst(names, (name) => Option.exists(Option.fromUndefinedOr(accounts[name]), (tokens) => bearer === `Bearer ${tokens.access}`))
      return provider.fetch(target, init).then((response) => {
        const layout = Option.flatMap(account, (name) => Option.fromUndefinedOr(made.layouts[name]))
        if (Option.isNone(layout) || !response.ok || target.pathname !== "/api/oauth/usage") return response
        return response.json().then((body) => Response.json(laidOut(decodeBody(body), layout.value)))
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
    const parent = yield* world.session(sessionDirectory, { id: "ses_dispatch_parent", model: { providerID: "fixture-parent", id: "parent" } })
    return {
      world,
      session: (id: string) => world.session(sessionDirectory, { id: `ses_${id}`, parentID: parent }),
      pace: (sessionID: string) => Effect.map(world.rpc(POOL, "pace", { providerID: "anthropic", model: "claude-opus-5-5", sessionID }), decodePace),
      primary: () => world.provider().received().filter((request) => request.path === "/v1/messages" && request.tools > 0),
      claims: () => world.provider().claims().map((claim) => claim.result),
      closeClaimant: world.runtime.run(Scope.close(claimant, Exit.void)),
    }
  })
