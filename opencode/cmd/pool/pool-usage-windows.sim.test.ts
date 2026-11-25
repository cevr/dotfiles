// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// A usage reading is a set of windows, each REPORTED, ABSENT or UNKNOWN
// (mods/pool/quota.ts `WindowReading`), through the whole plugin stack: the
// usage endpoint's answer in each layout, the pace, the request it admits or
// holds, and the status a person reads.
import { Effect, Option, Schema } from "effect"
import * as ChatGPT from "../../sim/chatgpt.ts"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import { spentAccount } from "../../tests/fake-chatgpt.ts"
import { decodePace, fixture, fleet, HOUR, POOL, quota, refunds, ULTRA, type UsageLayout } from "./pool-reset-backed-pace.fixture.ts"

const { seeded } = simulationRunner("cmd/pool/pool-usage-windows.sim.test.ts")

const WEEK_ONLY = ULTRA
const NO_WEEK: UsageLayout = { five_hour: "window", seven_day: "absent", extra: false }
const NONE: UsageLayout = { five_hour: "absent", seven_day: "absent", extra: false }
const CHANGED: UsageLayout = { five_hour: "unrecognised", seven_day: "window", extra: true }
const FULL: UsageLayout = { five_hour: "window", seven_day: "window", extra: false }
const MINUTE = 60_000

/** The anthropic pool's accounts as the status method answers, as far as these checks read them. */
const statusOf = Schema.decodeUnknownSync(Schema.Struct({
  anthropic: Schema.Struct({
    accounts: Schema.Array(Schema.Struct({
      credentialID: Schema.String,
      noRoom: Schema.Boolean,
      hold: Schema.optionalKey(Schema.Struct({ kind: Schema.String, until: Schema.Number })),
      reading: Schema.optionalKey(Schema.Struct({
        windows: Schema.Array(Schema.Struct({ name: Schema.String, utilization: Schema.Number })),
        absent: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
        unrecognised: Schema.optionalKey(Schema.Array(Schema.String)),
      })),
    })),
  }),
}))

const NULL = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Null))("null")
/** The ChatGPT usage answer, as far as a weekly-only plan rewrites it. */
const decodeUsage = Schema.decodeUnknownSync(Schema.StructWithRest(
  Schema.Struct({ rate_limit: Schema.StructWithRest(Schema.Struct({ secondary_window: Schema.Json }), [Schema.Record(Schema.String, Schema.Json)]) }),
  [Schema.Record(Schema.String, Schema.Json)],
))

const sends = (layout: UsageLayout, week = 0.2) =>
  Effect.gen(function* () {
    const made = fixture({ a: quota(week, 0.1) }, refunds)
    made.layouts.a = layout
    const { world, session, pace, primary } = yield* fleet(made)
    const id = yield* session("windows")
    const answer = yield* pace(id)
    yield* world.prompt(id, "go out on the account's reported windows")
    yield* world.until(() => primary().length > 0, HOUR)
    const status = statusOf(yield* world.rpc(POOL, "status", {}))
    return { answer, sent: primary().map((request) => request.account), status }
  })

seeded("an account whose five-hour limit is removed (Ultra) is admitted on its week, and its status says the window is absent", ({ expect }) =>
  Effect.gen(function* () {
    const { answer, sent, status } = yield* sends(WEEK_ONLY)
    expect(answer).toMatchObject({ ok: true, admission: "ordinary", eligible: ["a"] })
    expect(sent).toEqual(["a"])
    expect(status.anthropic.accounts[0]?.reading).toMatchObject({ absent: [{ name: "5h" }] })
  }),
)

seeded("an account with no weekly window is admitted with nothing to pace, its 5-hour window still read", ({ expect }) =>
  Effect.gen(function* () {
    const { answer, sent, status } = yield* sends(NO_WEEK, 0.9)
    expect(answer).toMatchObject({ ok: true, measured: true, eligible: ["a"] })
    expect(answer.reason).toContain("no weekly window to pace")
    expect(sent).toEqual(["a"])
    expect(status.anthropic.accounts[0]?.reading).toMatchObject({ absent: [{ name: "7d" }], windows: expect.arrayContaining([expect.objectContaining({ name: "5h" })]) })
  }),
)

seeded("an account that reports no usage window at all is admitted, and says so", ({ expect }) =>
  Effect.gen(function* () {
    const { answer, sent } = yield* sends(NONE)
    expect(answer).toMatchObject({ ok: true, measured: true })
    expect(answer.reason).toContain("no usage windows at all")
    expect(sent).toEqual(["a"])
  }),
)

seeded("an unrecognised five-hour shape and a spent window the pool does not know: the week binds, the shape change is named, nothing holds forever", ({ expect }) =>
  Effect.gen(function* () {
    const { answer, sent, status } = yield* sends(CHANGED)
    expect(answer).toMatchObject({ ok: true, eligible: ["a"] })
    expect(sent).toEqual(["a"])
    const account = status.anthropic.accounts[0]
    expect(account?.hold).toBeUndefined()
    expect(account?.noRoom).toBe(false)
    expect(account?.reading).toMatchObject({ unrecognised: ["five_hour"], windows: expect.arrayContaining([{ name: "seven_day_newcomer", utilization: 1 }]) })
    expect(account?.reading?.absent).toBeUndefined()
  }),
)

seeded("the shape changes mid-run with a stored hold: a removed limit ends the hold at that read; a limit that returns spent holds at that read", ({ expect }) =>
  Effect.gen(function* () {
    const spent = { ...quota(0.2, 0.1), fiveHour: { utilization: 1, resetAt: World.START + 3 * HOUR } }
    const made = fixture({ a: spent }, refunds)
    made.layouts.a = FULL
    const { world, session, pace, primary } = yield* fleet(made)
    const id = yield* session("shape_change")
    const held = yield* pace(id)
    expect(held).toMatchObject({ ok: false })
    expect(statusOf(yield* world.rpc(POOL, "status", {})).anthropic.accounts[0]?.hold).toMatchObject({ kind: "usage-limit", until: World.START + 3 * HOUR })
    // The provider removes the account's five-hour limit: the next read ends the stored hold.
    made.layouts.a = WEEK_ONLY
    yield* world.advance(20_000)
    expect(statusOf(yield* world.rpc(POOL, "status", {})).anthropic.accounts[0]?.hold).toBeUndefined()
    expect(yield* pace(id)).toMatchObject({ ok: true, eligible: ["a"] })
    yield* world.prompt(id, "the removed limit holds nothing")
    yield* world.until(() => primary().length > 0, HOUR)
    // The limit comes back spent: it binds at the read that reports it, until its own reset.
    made.layouts.a = FULL
    yield* world.advance(20_000)
    expect(yield* pace(id)).toMatchObject({ ok: false, retryAt: World.START + 3 * HOUR })
    expect(statusOf(yield* world.rpc(POOL, "status", {})).anthropic.accounts[0]?.hold).toMatchObject({ kind: "usage-limit", until: World.START + 3 * HOUR })
  }),
)

seeded("a mixed pool: the weekly-only account takes the work while the other's five-hour window is spent", ({ expect }) =>
  Effect.gen(function* () {
    const made = fixture({ a: quota(0.2, 0.1), b: { ...quota(0.2, 0.1), fiveHour: { utilization: 1, resetAt: World.START + 3 * HOUR } } }, refunds)
    made.layouts.a = WEEK_ONLY
    const { world, session, pace, primary } = yield* fleet(made)
    const id = yield* session("mixed")
    expect(yield* pace(id)).toMatchObject({ ok: true, eligible: ["a"] })
    yield* world.prompt(id, "go where there is room")
    yield* world.until(() => primary().length > 0, HOUR)
    expect(primary().map((request) => request.account)).toEqual(["a"])
  }),
)

seeded("an OpenAI account whose usage answer has no five-hour window reads it ABSENT, not unread, and is paced on its week", ({ seed, expect }) =>
  Effect.gen(function* () {
    const account = Provider.accounts(seed, ["sol"]).sol
    const quotaOf = ChatGPT.make()
    quotaOf.accounts.set("fixture", { ...spentAccount(account.access, "never-claim", World.START, 20), fiveHour: 0, credits: [] })
    const world = World.make({
      seed, model: { providerID: "openai", id: "gpt-6.2-fixture" }, script: () => World.say("unused"),
      provider: { id: "openai", baseURL: "http://127.0.0.1:11", handle: () => Effect.succeed(new Response("data: {\"type\":\"message_stop\"}\n\n")) },
      integrations: { openai: [{ id: "cred_sol", label: "Sol", ...account, expires: World.START + 86_400_000, methodID: "chatgpt-browser", metadata: { accountID: "fixture" } }] },
    })
    // A weekly-only plan, as measured on 2026-11-05: the week in the first slot, the second `null`.
    const weekOnly = (request: Request) =>
      Effect.gen(function* () {
        const response = yield* quotaOf.handle(request)
        const body = decodeUsage(yield* Effect.promise(() => response.json()))
        return Response.json({ ...body, rate_limit: { ...body.rate_limit, primary_window: body.rate_limit.secondary_window, secondary_window: NULL } })
      })
    const chatgpt = { ...quotaOf, handle: (request: Request) => Option.match(Option.liftPredicate(request, (each) => each.url === ChatGPT.USAGE_URL), { onNone: () => quotaOf.handle(request), onSome: weekOnly }) }
    const network = Provider.make({ seed, accounts: {}, chatgpt }, world.runtime)
    yield* world.load(Plugins.pool(new Map(), Plugins.network(network)), {
      directory: "/scratch/openai-windows",
      options: { providers: {}, paced: { openai: "openai" }, sweepMinutes: 0.1, resets: false, usageURL: ChatGPT.USAGE_URL, limitsFile: "/nonexistent/sim/limits.json" },
    })
    yield* world.advance(20_000)
    const status = Schema.decodeUnknownSync(Schema.Struct({ openai: Schema.Struct({ accounts: Schema.Array(Schema.Struct({ reading: Schema.optionalKey(Schema.Unknown) })) }) }))(yield* world.rpc(POOL, "status", {}))
    expect(status.openai.accounts[0]?.reading).toMatchObject({ windows: [{ name: "7d", utilization: 0.2 }], absent: [{ name: "5h" }], unrecognised: [] })
    const answer = decodePace(yield* world.rpc(POOL, "pace", { providerID: "openai", model: "gpt-6.2-fixture" }))
    expect(answer).toMatchObject({ ok: true, measured: true })
  }),
)

const STALE_AFTER_CHANGE: ReadonlyArray<readonly [string, UsageLayout]> = [
  ["unchanged control", FULL],
  ["seven_day unrecognised", { five_hour: "window", seven_day: "unrecognised", extra: false }],
  ["seven_day missing", { five_hour: "window", seven_day: "missing", extra: false }],
  ["five_hour missing", { five_hour: "missing", seven_day: "window", extra: false }],
  ["five_hour unrecognised", { five_hour: "unrecognised", seven_day: "window", extra: false }],
]

for (const [label, changed] of STALE_AFTER_CHANGE) {
  seeded(`a previously reported window turning UNKNOWN (${label}) does not hold after 40 min idle`, ({ expect }) =>
    Effect.gen(function* () {
      const made = fixture({ a: quota(0.2, 0.1) }, refunds)
      made.layouts.a = FULL
      const { world, session, pace, primary } = yield* fleet(made, { sweepMinutes: 10 })
      const id = yield* session("stale_unknown")
      expect(yield* pace(id)).toMatchObject({ ok: true })
      yield* world.prompt(id, "first request on reported windows")
      yield* world.until(() => primary().length > 0, HOUR)
      const first = primary().length
      made.layouts.a = changed
      yield* world.advance(40 * MINUTE)
      expect(yield* pace(id)).toMatchObject({ ok: true })
      yield* world.prompt(id, "second request after 40 min idle under changed layout")
      const sent = yield* world.until(() => primary().length > first, 2 * HOUR).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
      expect(sent).toBe(true)
    }),
  )
}
