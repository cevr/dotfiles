// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// A login the pool has already measured is never held merely because its usage
// reads keep failing (endpoint unavailable, or a 200 whose tracked fields do
// not read): after one bounded failed read it sends as unmeasured, its last
// REPORTED windows still bind until their own reset, a 429 still holds with a
// finite retry, and the next successful read restores measured state.
import { Effect, Match, Option } from "effect"
import * as ChatGPT from "../../sim/chatgpt.ts"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import { spentAccount } from "../../tests/fake-chatgpt.ts"
import { DAY, decodePace, fixture, fleet, HOUR, POOL, quota, refunds, type UsageLayout } from "./pool-reset-backed-pace.fixture.ts"

const { seeded } = simulationRunner("cmd/pool/pool-usage-read-failure.sim.test.ts")

const MINUTE = 60_000
const FULL: UsageLayout = { five_hour: "window", seven_day: "window", extra: false }
const BOTH_UNRECOGNISED: UsageLayout = { five_hour: "unrecognised", seven_day: "unrecognised", extra: false }
const BOTH_MISSING: UsageLayout = { five_hour: "missing", seven_day: "missing", extra: false }

const E1_ROWS: ReadonlyArray<{ readonly label: string; readonly layout: UsageLayout; readonly unavailable: boolean }> = [
  { label: "control (unchanged)", layout: FULL, unavailable: false },
  { label: "endpoint unavailable", layout: FULL, unavailable: true },
  { label: "both tracked fields unrecognised", layout: BOTH_UNRECOGNISED, unavailable: false },
  { label: "both tracked fields missing", layout: BOTH_MISSING, unavailable: false },
]

for (const row of E1_ROWS) {
  seeded(`E1 (${row.label}): an idle measured Anthropic login sends within one bounded read and recovers measured state`, ({ expect }) =>
    Effect.gen(function* () {
      const made = fixture({ a: quota(0.2, 0.1) }, refunds)
      made.layouts.a = FULL
      const { world, session, pace, primary } = yield* fleet(made, { sweepMinutes: 10 })
      const id = yield* session("e1_idle")
      expect(yield* pace(id)).toMatchObject({ ok: true, measured: true, eligible: ["a"] })
      yield* world.prompt(id, "first prompt on measured windows")
      yield* world.until(() => primary().length === 1, HOUR)
      made.layouts.a = row.layout
      made.unavailable = row.unavailable
      yield* world.advance(40 * MINUTE)
      const afterIdle = yield* pace(id)
      const failing = row.unavailable || row.layout !== FULL
      expect(afterIdle).toMatchObject({ ok: true, measured: !failing, eligible: ["a"] })
      if (failing) expect(afterIdle.admission).toBeUndefined()
      yield* world.prompt(id, "second prompt after 40 min idle under failing reads")
      // Sends within one bounded read (never held for 2 h on usage-unread).
      const sent = yield* world.until(() => primary().length === 2, 25_000).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      expect(sent).toBe(true)
      // Once the endpoint answers again, the next successful read restores measured state.
      made.layouts.a = FULL
      made.unavailable = false
      yield* world.advance(11 * MINUTE)
      expect(yield* pace(id)).toMatchObject({ ok: true, measured: true, admission: "ordinary", eligible: ["a"] })
    }),
  )
}

seeded("E1 (ChatGPT): an idle measured OpenAI login sends as unmeasured when usage reads fail and restores measured state on recovery", ({ seed, expect }) =>
  Effect.gen(function* () {
    const account = Provider.accounts(seed, ["sol"]).sol
    const quotaOf = ChatGPT.make()
    const fixtureAccount = { ...spentAccount(account.access, "never-claim", World.START, 20), fiveHour: 0, credits: [] }
    quotaOf.accounts.set("fixture", fixtureAccount)
    let mode: "ok" | "unavailable" | "unrecognised" | "missing" = "ok"
    const sent: Array<number> = []
    const world = World.make({
      seed,
      model: { providerID: "openai", id: "gpt-6.2-fixture" },
      script: () => World.say("unused"),
      provider: {
        id: "openai",
        baseURL: "http://127.0.0.1:11",
        handle: () =>
          Effect.sync(() => {
            sent.push(world.now())
            return new Response("data: {\"type\":\"message_stop\"}\n\n")
          }),
      },
      integrations: {
        openai: [{ id: "cred_sol", label: "Sol", ...account, expires: World.START + 86_400_000, methodID: "chatgpt-browser", metadata: { accountID: "fixture" } }],
      },
    })
    const chatgpt = {
      ...quotaOf,
      handle: (request: Request) =>
        Effect.suspend(() => {
          if (request.url !== ChatGPT.USAGE_URL) return quotaOf.handle(request)
          return Match.value(mode).pipe(
            Match.when("ok", () => quotaOf.handle(request)),
            Match.when("unavailable", () => Effect.succeed(new Response("outage", { status: 503 }))),
            Match.when("unrecognised", () => Effect.succeed(Response.json({ rate_limit: { primary_window: { used: "bad" }, secondary_window: { used: "bad" } } }))),
            Match.when("missing", () => Effect.succeed(Response.json({ rate_limit: {} }))),
            Match.exhaustive,
          )
        }),
    }
    const network = Provider.make({ seed, accounts: {}, chatgpt }, world.runtime)
    yield* world.load(Plugins.pool(new Map(), Plugins.network(network)), {
      directory: "/scratch/openai-read-failure",
      options: { providers: {}, paced: { openai: "openai" }, sweepMinutes: 10, resets: false, usageURL: ChatGPT.USAGE_URL, limitsFile: "/nonexistent/sim/limits.json" },
    })
    const session = yield* world.session("/scratch/openai-read-failure", { title: "No auxiliary title request" })
    yield* world.advance(2_000)
    const askPace = () => Effect.map(world.rpc(POOL, "pace", { providerID: "openai", model: "gpt-6.2-fixture", dispatch: true }), decodePace)
    expect(yield* askPace()).toMatchObject({ ok: true, measured: true, eligible: ["cred_sol"] })
    for (const next of ["unavailable", "unrecognised", "missing"] as const) {
      mode = next
      yield* world.advance(40 * MINUTE)
      const answer = yield* askPace()
      expect(answer).toMatchObject({ ok: true, measured: false, eligible: ["cred_sol"] })
      expect(answer.admission).toBeUndefined()
      const before = sent.length
      yield* world.prompt(session, `prompt during ${next}`)
      yield* world.until(() => sent.length === before + 1, 25_000)
      mode = "ok"
      fixtureAccount.fiveHourResetAt = world.now() + 3 * HOUR
      yield* world.advance(11 * MINUTE)
      expect(yield* askPace()).toMatchObject({ ok: true, measured: true, admission: "ordinary", eligible: ["cred_sol"] })
    }
  }),
)

seeded("a measured login at a REPORTED limit before its reset is still held during failed usage reads, and sends once the reset passes", ({ expect }) =>
  Effect.gen(function* () {
    const shortReset = World.START + 3 * HOUR
    const limited = { ...quota(0.2, 0.1), fiveHour: { utilization: 0.95, resetAt: shortReset } }
    const made = fixture({ a: limited }, refunds)
    made.layouts.a = FULL
    const { world, session, pace, primary } = yield* fleet(made, { sweepMinutes: 10 })
    const id = yield* session("reported_limit")
    expect(yield* pace(id)).toMatchObject({ ok: false, reasonCode: "quota-limit", retryAt: shortReset })
    // Usage reads now fail completely; the last REPORTED 5h limit still binds until its own reset.
    made.unavailable = true
    yield* world.advance(40 * MINUTE)
    const held = yield* pace(id)
    expect(held).toMatchObject({ ok: false, reasonCode: "quota-limit", retryAt: shortReset })
    yield* world.prompt(id, "still before 5h reset")
    yield* world.advance(25_000)
    expect(primary()).toHaveLength(0)
    // Until the 5h window's own reset nothing goes out.
    yield* world.advance(shortReset - 1 - world.now())
    expect(primary()).toHaveLength(0)
    // Past the 5h window's own reset, the expired limit stops binding and the login sends as unmeasured.
    yield* world.advance(MINUTE + 1)
    const afterReset = yield* pace(id)
    expect(afterReset).toMatchObject({ ok: true, measured: false, eligible: ["a"] })
    // The session is a subagent: on a host with no Step its held turn ended, and the pool woke it once the reset
    // passed (cmd/pool/pool-hold-wake.sim.test.ts), so the held work went out exactly once, after the reset.
    expect(primary()).toHaveLength(1)
    yield* world.prompt(id, "after 5h reset while usage endpoint is still down")
    const sent = yield* world.until(() => primary().length === 2, 25_000).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    expect(sent).toBe(true)
    // The next prompt sent exactly one more.
    yield* world.advance(MINUTE)
    expect(primary()).toHaveLength(2)

    // Reported weekly over-the-even-line limit also still binds during failed usage reads.
    const overLine = fixture({ a: quota(0.75, 0.1) }, refunds)
    overLine.layouts.a = FULL
    const paced = yield* fleet(overLine, { sweepMinutes: 10 })
    const overId = yield* paced.session("reported_even_line")
    expect(yield* paced.pace(overId)).toMatchObject({ ok: false, reasonCode: "even-line" })
    overLine.layouts.a = BOTH_UNRECOGNISED
    yield* paced.world.advance(40 * MINUTE)
    const stillOver = yield* paced.pace(overId)
    expect(stillOver).toMatchObject({ ok: false, reasonCode: "even-line" })
    if (!stillOver.ok) expect(stillOver.retryAt).toBeGreaterThan(paced.world.now())
    yield* paced.world.prompt(overId, "over even line still holds")
    yield* paced.world.advance(25_000)
    expect(paced.primary()).toHaveLength(0)
  }),
)

seeded("a 429 refusal still holds with a finite retry even when usage reads fail", ({ seed, expect }) =>
  Effect.gen(function* () {
    const accounts = Provider.accounts(seed, ["a"])
    const now = World.START
    let refuse = false
    let unavailable = false
    const world = World.make({
      seed,
      model: { providerID: "anthropic", id: "claude-opus-5-5" },
      script: () => World.say(""),
      anthropic: {
        accounts,
        script: () =>
          Match.value(refuse).pipe(
            Match.when(true, () => ({ kind: "transient-429" as const, retryAfterSeconds: 120 })),
            Match.orElse(() => ({ kind: "ok" as const, text: "ok" })),
          ),
        quota: () => ({
          fiveHour: { utilization: 0.2, resetAt: now + 3 * HOUR },
          sevenDay: { utilization: 0.1, resetAt: now + 3.5 * DAY },
          fable: { utilization: 0.1, resetAt: now + 3.5 * DAY, ofWeekly: 0.5 },
        }),
      },
      integrations: {
        anthropic: [{ id: "a", label: "a", ...accounts.a!, expires: now + 8 * HOUR }],
      },
    })
    const provider = world.provider()
    const primary = () => provider.received().filter((request) => request.path === "/v1/messages" && request.tools > 0)
    const fetch: typeof provider.fetch = (url, init) => {
      const target = new URL(String(url))
      if (unavailable && target.pathname === "/api/oauth/usage") target.pathname = "/nonexistent/e1-429"
      return provider.fetch(target, init)
    }
    yield* world.load(Plugins.anthropicAuth({ ...provider, fetch }), { directory: "/scratch/e1-429" })
    yield* world.load(Plugins.pool(new Map(), Plugins.network({ ...provider, fetch })), {
      directory: "/scratch/e1-429",
      options: { sweepMinutes: 10, limitsFile: "/nonexistent/e1-429/limits.json" },
    })
    const id = yield* world.session("/scratch/e1-429", { id: "ses_e1_429", title: "No auxiliary title request" })
    yield* world.advance(7_000)
    const askPace = () => Effect.map(world.rpc(POOL, "pace", { providerID: "anthropic", model: "claude-opus-5-5", sessionID: id }), decodePace)
    expect(yield* askPace()).toMatchObject({ ok: true, measured: true, eligible: ["a"] })
    // Usage endpoint fails and account sits idle 40 min, then the unmeasured send hits a 429.
    unavailable = true
    refuse = true
    yield* world.advance(40 * MINUTE)
    expect(yield* askPace()).toMatchObject({ ok: true, measured: false, eligible: ["a"] })
    yield* world.prompt(id, "hits 429 while usage reads fail")
    yield* world.until(() => primary().length === 1, 25_000)
    yield* world.advance(1_000)
    const held = yield* askPace()
    expect(held).toMatchObject({ ok: false, reasonCode: "account-held" })
    const retryAt = Option.getOrThrow(
      Match.value(held).pipe(
        Match.when({ ok: false }, (entry) => Option.some(entry.retryAt)),
        Match.orElse(() => Option.none<number>()),
      ),
    )
    expect(Number.isFinite(retryAt) && retryAt > world.now()).toBe(true)
    // While held, another prompt does not go out.
    yield* world.prompt(id, "held by 429")
    yield* world.advance(30_000)
    expect(primary()).toHaveLength(1)
    // After retryAt passes, the account opens and sends again.
    refuse = false
    yield* world.advance(retryAt - world.now() + 1_000)
    expect(yield* askPace()).toMatchObject({ ok: true, eligible: ["a"] })
    yield* world.prompt(id, "sent after 429 expiry")
    yield* world.until(() => primary().length === 2, 25_000)
    expect(primary()).toHaveLength(2)
  }),
)
