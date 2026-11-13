// Rate-limit resets on the simulated host, each test at 20 seeds:
// tests/pool-resets.test.ts's names and claims that rest on the pool and the
// Anthropic auth plugin alone, moved off real OpenCode. The Claude logins
// OpenCode holds, the auth plugin and the pool sweeping every 6 s, against the
// world's Anthropic (sim/provider.ts: its usage endpoint lists each account's
// grants, its claim endpoint takes them). The pool's RPC is called as the pane
// calls it, on the world's clock.
import { Data, Effect, Option, Schema } from "effect"
import { claimEffect, type FakeGrant, type FakeQuota } from "../../tests/fake-anthropic.ts"
import { spentAccount } from "../../tests/fake-chatgpt.ts"
import * as ChatGPT from "../../sim/chatgpt.ts"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import { line } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/pool/pool-resets.sim.test.ts")

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WORK = "/scratch/work"
const SESSION = "ses_resets_root"
const POOL = "dotfiles-opencode.pool"
/** How long the real run waited for a claim. */
const CLAIM_LIMIT_MS = 60_000

/** The ChatGPT login OpenCode holds, its account `acct-1` on the world's ChatGPT backend. */
const CHATGPT = "chatgpt"

/**
 * The world with the Claude logins `names` OpenCode holds (the first active), the auth plugin and the pool sweeping
 * every 6 s; with a ChatGPT backend, the ChatGPT login too, its pool paced on the backend's usage endpoint.
 */
const serve = (seed: number, names: ReadonlyArray<string>, anthropic: Omit<Provider.Options, "seed" | "accounts">) =>
  Effect.gen(function* () {
    const accounts = Provider.accounts(seed, [...names, CHATGPT])
    const chatgpt = Option.fromNullishOr(anthropic.chatgpt)
    const world = World.make({
      seed,
      script: () => World.say(""),
      anthropic: { accounts, ...anthropic },
      integrations: {
        anthropic: names.map((name) => ({ id: `cred_${name}`, label: `Claude ${name}`, ...accounts[name], expires: World.START + 8 * HOUR })),
        openai: Option.match(chatgpt, {
          onNone: () => [],
          onSome: () => [
            {
              id: "cred_chatgpt",
              label: "ChatGPT",
              ...accounts[CHATGPT],
              expires: World.START + 8 * HOUR,
              methodID: "chatgpt-browser",
              metadata: { accountID: "acct-1" },
            },
          ],
        }),
      },
    })
    const paced = Option.match(chatgpt, {
      onNone: () => ({}),
      onSome: () => ({ paced: { openai: "openai" }, usageURL: ChatGPT.USAGE_URL }),
    })
    yield* world.load(Plugins.anthropicAuth(world.provider()), { directory: WORK })
    yield* world.load(Plugins.pool(new Map(), Plugins.network(world.provider())), {
      directory: WORK,
      options: { sweepMinutes: 0.1, limitsFile: "/nonexistent/sim/limits.json", ...paced },
    })
    yield* world.load(Plugins.questions, { directory: WORK })
    // The session that waits for a start, where the owner is asked.
    yield* world.session(WORK, { id: SESSION })
    const pool = (method: string, input: Schema.Json = {}) => world.rpc(POOL, method, input)
    const questions = (method: string, input: Schema.Json) => world.rpc(QUESTIONS, method, input)
    const open = questions("open", { sessionIDs: [SESSION] }).pipe(
      Effect.map((answer) => Schema.decodeUnknownOption(Open)(answer).pipe(Option.match({ onNone: () => [], onSome: (decoded) => decoded.questions }))),
    )
    const pace = pool("pace", { providerID: "anthropic", sessionID: SESSION })
    /**
     * The pane paces a start each second of the world's clock and reads the tray, until `done` holds of it: the
     * tray then. Fails past `limit` ms, saying what `label` waited for.
     */
    const until = (done: (rows: ReadonlyArray<OpenQuestion>) => boolean, label: string, limit = CLAIM_LIMIT_MS, paced = true) =>
      Effect.gen(function* () {
        const from = world.now()
        for (;;) {
          if (paced) yield* pace
          const rows = yield* open
          if (done(rows)) return rows
          if (world.now() - from >= limit) return yield* Effect.fail(new Waited({ message: `${label}: still ${line(rows)} after ${limit} ms` }))
          yield* world.advance(SECOND)
        }
      })
    return { world, accounts, pool, questions, open, pace, until }
  })

const QUESTIONS = "dotfiles-opencode.questions"

const OpenQuestion = Schema.Struct({ id: Schema.String, sessionID: Schema.String, question: Schema.String, header: Schema.optional(Schema.String) })
type OpenQuestion = typeof OpenQuestion.Type
const Open = Schema.Struct({ questions: Schema.Array(OpenQuestion) })

/** The pace method's answer, as far as the pane reads it. */
const Paced = Schema.Struct({ ok: Schema.optional(Schema.Boolean) })

/** What the tray, the provider or the pool did not come to within the wait. */
class Waited extends Data.TaggedError("Waited")<{ readonly message: string }> {}

/** The row with `header` in the tray. */
const row = (rows: ReadonlyArray<OpenQuestion>, header: string) =>
  Effect.fromOption(Option.fromNullishOr(rows.find((each) => each.header === header))).pipe(
    Effect.mapError(() => new Waited({ message: `no row ${header} in ${line(rows)}` })),
  )

const Window = Schema.Struct({ name: Schema.String, utilization: Schema.Number })

/** The pool's `resets` answer, as the pane reads it. */
const Resets = Schema.Struct({
  resets: Schema.Array(
    Schema.Struct({ label: Schema.String, stage: Schema.String, why: Schema.String, kind: Schema.optional(Schema.String), message: Schema.optional(Schema.String) }),
  ),
  claims: Schema.Array(
    Schema.Struct({ provider: Schema.String, label: Schema.String, outcome: Schema.String, weekly: Schema.String, after: Schema.optional(Schema.Array(Window)) }),
  ),
})

/** The pool's resets, read. */
const resetsOf = (answer: Schema.Json) => Schema.decodeUnknownEffect(Resets)(answer)

/** A grant's resets left: one until it is claimed. */
const leftOf = (claimed: ReadonlySet<string>, id: string) => Number(!claimed.has(id))

/** How long account b's first 5-hour hold lasts from the pool's first reading of it: its question is withdrawn once it lifts. */
const SHORT_HOLD_MS = 25 * SECOND

seeded(
  "a Codex credit is claimed by itself once; a Claude grant only on the owner's yes, with a no and a lifted hold claiming nothing",
  ({ seed, expect }) =>
    Effect.gen(function* () {
      const now = World.START
      // ── The world's ChatGPT backend: one account, its 5-hour window spent, one credit ──
      const backend = ChatGPT.make()
      // a: spent for two hours, its week resetting in three days (the most time left, so asked first).
      // b: spent for SHORT_HOLD_MS from the pool's first reading of it, its week resetting in two days.
      const quotas = new Map<string, FakeQuota>([
        ["a", { fiveHour: { utilization: 1, resetAt: now + 2 * HOUR }, sevenDay: { utilization: 0.4, resetAt: now + 3 * DAY } }],
      ])
      // The world's clock, once the world is made: the provider reads quotas at its own time.
      const clock = { now: () => now }
      const quotaOf = (account: string): FakeQuota => {
        if (account === "b" && !quotas.has("b"))
          quotas.set("b", { fiveHour: { utilization: 1, resetAt: clock.now() + SHORT_HOLD_MS }, sevenDay: { utilization: 0.4, resetAt: now + 2 * DAY } })
        const quota = Option.getOrThrow(Option.fromNullishOr(quotas.get(account)))
        // A window past its reset reads empty, as the real one does.
        if (clock.now() < quota.fiveHour.resetAt) return quota
        return { ...quota, fiveHour: { utilization: 0, resetAt: clock.now() + 5 * HOUR } }
      }
      const { world, accounts, pool, questions, open, until } = yield* serve(seed, ["a", "b"], {
        chatgpt: backend,
        quota: quotaOf,
        grants: (account) => [{ id: `grant-${account}`, resetsLeft: 1, endsAt: now + 120 * DAY, clears: ["five_hour", "seven_day_overage_included"] }],
        claim: (account) => {
          const quota = Option.getOrThrow(Option.fromNullishOr(quotas.get(account)))
          quotas.set(account, { ...quota, fiveHour: { utilization: 0, resetAt: clock.now() + 5 * HOUR } })
          return "reset"
        },
      })
      clock.now = world.now
      backend.accounts.set("acct-1", spentAccount(accounts[CHATGPT].access, "credit-1", now))
      const claims = () => world.provider().claims()

      // ── Codex: claimed by itself, once ──
      const codexPace = yield* Schema.decodeUnknownEffect(Paced)(yield* pool("pace", { providerID: "openai", sessionID: SESSION }))
      expect(codexPace.ok).toBe(false)
      yield* world.until(() => backend.consumes().length > 0, CLAIM_LIMIT_MS, 250)
      yield* pool("pace", { providerID: "openai", sessionID: SESSION })
      yield* world.advance(SECOND)
      expect(backend.consumes().map(({ account, creditID, code }) => ({ account, creditID, code }))).toEqual([
        { account: "acct-1", creditID: "credit-1", code: "reset" },
      ])
      expect(yield* open).toEqual([])

      // ── Claude: asked, never claimed unasked ──
      const asked = (label: string) =>
        until((rows) => rows.some((each) => each.header === `Claude reset · ${label}`), `a question about ${label}`).pipe(
          Effect.flatMap((rows) => row(rows, `Claude reset · ${label}`)),
        )
      const first = yield* asked("Claude a")
      expect(first.question).toContain("remain before the weekly reset")
      expect(first.question).toContain("Claim it?")
      expect(claims()).toEqual([])

      // A no: nothing is claimed, and the next account is asked.
      expect(yield* questions("answer", { sessionID: SESSION, answers: [{ id: first.id, answer: "Don't claim" }] })).toMatchObject({ ok: true })
      const second = yield* asked("Claude b")
      expect(claims()).toEqual([])

      // b's hold lifts by itself: the sweep reads it, and its question goes unanswered.
      yield* until((rows) => !rows.some((each) => each.id === second.id), "b's question withdrawn", SHORT_HOLD_MS + 30 * SECOND, false)
      expect(claims()).toEqual([])
      const lifted = yield* resetsOf(yield* pool("resets"))
      expect(lifted.resets.filter((reset) => reset.label === "Claude b").map((reset) => [reset.stage, reset.message])).toEqual([
        ["withdrawn", "the hold lifted"],
      ])

      // b is spent again: a new hold, asked again; on a yes its grant is claimed, once.
      quotas.set("b", { fiveHour: { utilization: 1, resetAt: world.now() + 2 * HOUR }, sevenDay: { utilization: 0.4, resetAt: now + 2 * DAY } })
      const third = yield* asked("Claude b")
      expect(yield* questions("answer", { sessionID: SESSION, answers: [{ id: third.id, answer: "Claim it" }] })).toMatchObject({ ok: true })
      yield* world.until(() => claims().length > 0, CLAIM_LIMIT_MS, 250)
      yield* world.advance(2 * SECOND)
      expect(claims().map(({ account, grant, result }) => ({ account, grant, result }))).toEqual([{ account: "b", grant: "grant-b", result: "reset" }])
      expect(String(claims()[0]?.requestID)).toMatch(/^pool-[0-9a-f]{24}$/)
      const settled = yield* resetsOf(yield* pool("resets"))
      expect(settled.claims.map(({ provider, outcome }) => [provider, outcome])).toEqual([
        ["claude", "reset"],
        ["codex", "reset"],
      ])
      expect(settled.claims[0]?.weekly).toBe("kept")
      expect(settled.claims[1]?.weekly).toBe("moved")
      // No token ever shows in what the pool answers or logs.
      const shown = line(settled) + line(world.logs())
      for (const token of [accounts.a.access, accounts.b.access, accounts.a.refresh, accounts[CHATGPT].access, accounts[CHATGPT].refresh])
        expect(shown).not.toContain(token)
    }),
)

seeded(
  "a weekly reset is offered on the fleet's demand early in the week and claimed on a yes; a Fable reset about to expire unused is claimed on its own, gives Fable's part of the week back, and the owner is told",
  ({ seed, expect }) =>
    Effect.gen(function* () {
      const now = World.START
      // Day one of both weeks. c: Fable's own week spent, its allowance half the weekly window; 60% of the week used.
      // d: its whole week spent on day one.
      const quotas = new Map<string, FakeQuota>([
        [
          "c",
          {
            fiveHour: { utilization: 0.2, resetAt: now + 3 * HOUR },
            sevenDay: { utilization: 0.6, resetAt: now + 6 * DAY },
            fable: { utilization: 1, resetAt: now + 6 * DAY, ofWeekly: 0.5 },
          },
        ],
        ["d", { fiveHour: { utilization: 0.2, resetAt: now + 3 * HOUR }, sevenDay: { utilization: 1, resetAt: now + 6 * DAY } }],
      ])
      const quotaOf = (account: string) => Option.getOrThrow(Option.fromNullishOr(quotas.get(account)))
      // c's Fable reset ends in two hours, long before Fable's week resets: it is listed once the test says so.
      let fableListed = false
      const claimed = new Set<string>()
      const grantsOf = (account: string): ReadonlyArray<FakeGrant> => {
        if (account !== "c") return [{ id: "weekly-d", resetsLeft: leftOf(claimed, "weekly-d"), endsAt: now + 60 * DAY, clears: ["seven_day"], type: "weekly" }]
        if (!fableListed) return []
        return [
          {
            id: "fable-c",
            resetsLeft: leftOf(claimed, "fable-c"),
            endsAt: now + 2 * HOUR,
            clears: ["five_hour", "seven_day_overage_included"],
            type: "full",
            givesBackWeekly: true,
          },
        ]
      }
      const { world, pool, questions, open, until } = yield* serve(seed, ["c", "d"], {
        quota: quotaOf,
        grants: grantsOf,
        claim: (account, grant) => {
          for (const found of grantsOf(account).filter((item) => item.id === grant)) quotas.set(account, claimEffect(quotaOf(account), found))
          claimed.add(grant)
          return "reset"
        },
      })
      const claims = () => world.provider().claims()

      // ── Demand: three starts in flight across the fleet, from this session ──
      for (let start = 0; start < 3; start++) yield* pool("started", { providerID: "anthropic" })
      const offered = yield* row(yield* until((rows) => rows.some((each) => each.header === "Reset now · Claude d"), "an offer for d"), "Reset now · Claude d")
      expect(offered.question).toContain("weekly reset on account Claude d now? Demand: 3 starts are in flight across the fleet.")
      expect(offered.question).toContain("It gives back weekly 100% → 0%.")
      expect(offered.question).toMatch(/6\.0 days remain before the weekly window resets by itself/)
      expect(claims()).toEqual([])
      expect(yield* questions("answer", { sessionID: SESSION, answers: [{ id: offered.id, answer: "Claim it" }] })).toMatchObject({ ok: true })
      yield* world.until(() => claims().length > 0, CLAIM_LIMIT_MS, SECOND)
      expect(claims().map(({ account, grant, result }) => ({ account, grant, result }))).toEqual([{ account: "d", grant: "weekly-d", result: "reset" }])

      // ── Use it or lose it: c's Fable reset, listed now, is claimed by itself and the owner told ──
      fableListed = true
      const notice = yield* row(yield* until((rows) => rows.some((each) => each.header === "Pool reset claimed"), "the notice of c's claim"), "Pool reset claimed")
      expect(notice.question).toContain("The pool claimed the Fable reset on account Claude c before it expired unused")
      // Fable's part of the week, as the usage endpoint reports it (`used_percent_of_weekly`: its use times its allowance share).
      expect(notice.question).toContain("weekly 60% → ~10% (Fable's part 50% as the usage endpoint reports it)")
      expect(claims().map(({ account, grant }) => [account, grant])).toEqual([
        ["d", "weekly-d"],
        ["c", "fable-c"],
      ])
      const settled = yield* resetsOf(yield* pool("resets"))
      const fable = settled.claims.find((claim) => claim.label === "Claude c")
      expect(fable).toMatchObject({ outcome: "reset", weekly: "kept" })
      // The reading after the claim: Fable's week empty, the weekly window with Fable's part given back.
      expect(fable?.after?.find((window) => window.name === "7d:Fable")?.utilization).toBe(0)
      expect(fable?.after?.find((window) => window.name === "7d")?.utilization).toBeCloseTo(0.1)
      expect(settled.resets.find((reset) => reset.label === "Claude c")).toMatchObject({ why: "expiring", kind: "fable", stage: "settled" })
      expect(settled.resets.find((reset) => reset.label === "Claude d")).toMatchObject({ why: "offer", kind: "weekly" })

      // The owner reads the notice: it leaves the tray.
      expect(yield* questions("answer", { sessionID: SESSION, answers: [{ id: notice.id, answer: "OK" }] })).toMatchObject({ ok: true })
      yield* until((rows) => !rows.some((each) => each.id === notice.id), "the notice withdrawn", CLAIM_LIMIT_MS, false)
      // Each claim once.
      yield* world.advance(7 * SECOND)
      expect(claims()).toHaveLength(2)
      expect(yield* open).toEqual([])
    }),
)

seeded(
  "one spent week with two weekly resets about to expire spends one: the reading after it shows the week back, so the second is kept",
  ({ seed, expect }) =>
    Effect.gen(function* () {
      const now = World.START
      // The round-1 verifier's case: the week spent, resetting in three days; two weekly grants ending in two hours.
      let quota: FakeQuota = { fiveHour: { utilization: 0.2, resetAt: now + HOUR }, sevenDay: { utilization: 1, resetAt: now + 3 * DAY } }
      const claimed = new Set<string>()
      const grantsOf = (): ReadonlyArray<FakeGrant> =>
        ["g1", "g2"].map((id) => ({ id, resetsLeft: leftOf(claimed, id), endsAt: now + 2 * HOUR, clears: ["seven_day"], type: "weekly" as const }))
      const { world, pool } = yield* serve(seed, ["e"], {
        quota: () => quota,
        grants: grantsOf,
        claim: (_account, grant) => {
          for (const found of grantsOf().filter((item) => item.id === grant)) quota = claimEffect(quota, found)
          claimed.add(grant)
          return "reset"
        },
      })
      const claims = () => world.provider().claims()
      // The pane paces a start each second until the pool claims.
      for (let waited = 0; claims().length === 0 && waited < CLAIM_LIMIT_MS; waited += SECOND) {
        yield* pool("pace", { providerID: "anthropic", sessionID: SESSION })
        yield* world.advance(SECOND)
      }
      // Three sweeps (6 s each) after it, each reading the week back to 0%: no second grant goes.
      for (let second = 0; second < 20; second++) {
        yield* world.advance(SECOND)
        yield* pool("pace", { providerID: "anthropic", sessionID: SESSION })
      }
      expect(claims().map(({ account, grant, result }) => ({ account, grant, result }))).toEqual([{ account: "e", grant: "g1", result: "reset" }])
      const settled = yield* resetsOf(yield* pool("resets"))
      expect(settled.claims).toHaveLength(1)
      expect(settled.claims[0]?.after?.find((window) => window.name === "7d")?.utilization, line(settled)).toBe(0)
    }),
)
