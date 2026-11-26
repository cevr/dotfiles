// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// Rate-limit resets on the simulated host, each test at 20 seeds:
// tests/pool-resets.test.ts's names and claims that rest on the pool and the
// Anthropic auth plugin alone, moved off real OpenCode. The Claude logins
// OpenCode holds, the auth plugin and the pool sweeping every 6 s, against the
// world's Anthropic (sim/provider.ts: its usage endpoint lists each account's
// grants, its claim endpoint takes them). The pool's RPC is called as the pane
// calls it, on the world's clock.
import { Array as Arr, Data, Effect, Option, Schema } from "effect"
import { claimEffect, type FakeAnswer, type FakeGrant, type FakeQuota } from "../../tests/fake-anthropic.ts"
import { spentAccount } from "../../tests/fake-chatgpt.ts"
import * as ChatGPT from "../../sim/chatgpt.ts"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import { line } from "../../sim/runtime.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = simulationRunner("cmd/pool/pool-resets.sim.test.ts")

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
      anthropic: { accounts, script: working, ...anthropic },
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
    /**
     * `count` agents put to work in sessions of their own: each runs a long command (`working`), busy until it ends,
     * with no start recorded. Fails when one is not busy once prompted.
     */
    const work = (count: number) =>
      Effect.gen(function* () {
        const ids: Array<string> = []
        for (let agent = 0; agent < count; agent++) {
          const id = yield* world.session(WORK, { id: `ses_agent_${agent}` })
          yield* world.prompt(id, "work")
          ids.push(id)
        }
        yield* world.advance(SECOND)
        const idle = ids.filter((id) => world.sessions.get(id)?.running !== true)
        if (idle.length > 0) return yield* Effect.fail(new Waited({ message: `not busy once prompted: ${idle.join(", ")} ${line(idle.map((id) => world.messages(id)))}` }))
        return ids
      })
    return { world, accounts, pool, questions, open, pace, until, work }
  })

/** How long an agent's command runs: the sessions it runs in stay busy for hours. */
const WORK_COMMAND = "sleep 10800"

/** The shell tool's name as a request offers it: as is, or as the auth plugin encodes it (`mcp_T` and its base64). */
const SHELL_NAMES = ["shell", `mcp_T${Buffer.from("shell").toString("base64").replace(/=+$/, "")}`]

const ToolNames = Schema.Array(Schema.Struct({ name: Schema.String }))

/** The model's answers: a request offering the shell, with no tool result yet, runs WORK_COMMAND; any other is answered in text. */
const working = (request: Provider.RequestInfo): FakeAnswer => {
  const answered = line(request.body["messages"] ?? []).includes('"tool_result"')
  const names = Option.getOrElse(Schema.decodeUnknownOption(ToolNames)(request.body["tools"] ?? []), () => [])
  return Option.match(
    Option.filter(Arr.findFirst(names, (tool) => SHELL_NAMES.includes(tool.name)), () => !answered),
    {
      onNone: (): FakeAnswer => ({ kind: "ok" }),
      onSome: (shell): FakeAnswer => ({ kind: "ok", tool: { name: shell.name, input: { command: WORK_COMMAND } } }),
    },
  )
}

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

seeded(
  "with agents running, a Codex credit and a Claude grant are each claimed on their own, once, and the owner told after; with no agent running and no start held, nothing is claimed and nothing asked",
  ({ seed, expect }) =>
    Effect.gen(function* () {
      const now = World.START
      // ── The world's ChatGPT backend: one account, its shared week spent, one credit that ends before its week resets ──
      const backend = ChatGPT.make()
      // a and b: both 5-hour windows spent for two hours, a's week resetting in three days, b's in two.
      const quotas = new Map<string, FakeQuota>([
        ["a", { fiveHour: { utilization: 1, resetAt: now + 2 * HOUR }, sevenDay: { utilization: 0.4, resetAt: now + 3 * DAY } }],
        ["b", { fiveHour: { utilization: 1, resetAt: now + 2 * HOUR }, sevenDay: { utilization: 0.4, resetAt: now + 2 * DAY } }],
      ])
      const quotaOf = (account: string): FakeQuota => Option.getOrThrow(Option.fromNullishOr(quotas.get(account)))
      // The world's clock, once the world is made.
      const clock = { now: () => now }
      const usedGrants = new Set<string>()
      const { world, accounts, pool, open, until, work } = yield* serve(seed, ["a", "b"], {
        chatgpt: backend,
        quota: quotaOf,
        // Two resets in hand on each account: not the last one, kept in reserve.
        grants: (account) => [{ id: `grant-${account}`, resetsLeft: 2 - Number(usedGrants.has(`grant-${account}`)), endsAt: now + 120 * DAY, clears: ["five_hour", "seven_day_overage_included"] }],
        claim: (account, grant) => {
          usedGrants.add(grant)
          quotas.set(account, { ...quotaOf(account), fiveHour: { utilization: 0, resetAt: clock.now() + 5 * HOUR } })
          return "reset"
        },
      })
      clock.now = world.now
      // The 5-hour window spent, the week at 40%: a Codex reset restarts the week, so it waits for the week (README rule 3).
      backend.accounts.set("acct-1", spentAccount(accounts[CHATGPT].access, "credit-1", now, 40, 2 * DAY))
      const claims = () => world.provider().claims()

      // ── No work: nothing running and no start held, the pool sweeping on ──
      yield* until(() => false, "half a minute of sweeps", 30 * SECOND, false).pipe(Effect.ignore)
      expect(claims()).toEqual([])
      expect(backend.consumes()).toEqual([])
      expect(yield* open).toEqual([])

      // ── Codex: three starts running, a start held, only the 5-hour window spent: not claimed over half a minute of sweeps ──
      for (let start = 0; start < 3; start++) yield* pool("started", { providerID: "openai" })
      const codexPace = yield* Schema.decodeUnknownEffect(Paced)(yield* pool("pace", { providerID: "openai", sessionID: SESSION }))
      expect(codexPace.ok).toBe(false)
      yield* world.advance(30 * SECOND)
      expect(backend.consumes()).toEqual([])
      expect(yield* open).toEqual([])
      // ── The week spent under the same work: claimed on its own, once ──
      backend.accounts.set("acct-1", spentAccount(accounts[CHATGPT].access, "credit-1", now, 100, 2 * DAY))
      yield* pool("pace", { providerID: "openai", sessionID: SESSION })
      yield* world.until(() => backend.consumes().length > 0, CLAIM_LIMIT_MS, 250)
      yield* pool("pace", { providerID: "openai", sessionID: SESSION })
      yield* world.advance(SECOND)
      expect(backend.consumes().map(({ account, creditID, code }) => ({ account, creditID, code }))).toEqual([
        { account: "acct-1", creditID: "credit-1", code: "reset" },
      ])

      // ── Claude: three agents put to work while the 5-hour windows had room, then the windows spent under them; busy, with no start recorded:
      // one exhausted account is refilled on its own, nothing asked ──
      const spent = new Map(quotas)
      for (const [account, quota] of spent) quotas.set(account, { ...quota, fiveHour: { ...quota.fiveHour, utilization: 0.5 } })
      yield* world.advance(7 * SECOND)
      yield* work(3)
      for (const [account, quota] of spent) quotas.set(account, quota)
      yield* world.until(() => claims().length > 0, CLAIM_LIMIT_MS, 250)
      // The refilled account takes the running work, and the start held before the claim was the claim's to answer:
      // no work waits for the other, so it is not claimed (README rule 2).
      yield* until(() => false, "the pane pacing on", 20 * SECOND).pipe(Effect.ignore)
      expect(claims().map(({ grant, result }) => ({ grant, result }))).toMatchObject([{ result: "reset" }])
      expect(claims()).toHaveLength(1)
      expect(String(claims()[0]?.requestID)).toMatch(/^pool-[0-9a-f]{24}$/)
      // The work spends the refill to the 5-hour hold line: a start held there, which the refilled account cannot take,
      // refills the other spent account once the first refill is observed (its 5-hour window read back), once.
      const first = String(claims()[0]?.account)
      const other = ["a", "b"].filter((account) => account !== first).join("")
      quotas.set(first, { ...quotaOf(first), fiveHour: { utilization: 0.95, resetAt: clock.now() + 4 * HOUR } })
      yield* until(() => claims().length > 1, "the other spent account's refill", CLAIM_LIMIT_MS)
      yield* until(() => false, "the pane pacing on", 20 * SECOND).pipe(Effect.ignore)
      expect(claims().map(({ account, result }) => ({ account, result }))).toEqual([
        { account: first, result: "reset" },
        { account: other, result: "reset" },
      ])
      // The tray holds one notice per claim and nothing else; each says why.
      const rows = yield* open
      expect(rows.map((each) => each.header)).toEqual(["Pool reset claimed", "Pool reset claimed", "Pool reset claimed"])
      expect(rows.map((each) => each.question).join("\n")).toContain("Claimed the Codex reset on ChatGPT")
      expect(rows.map((each) => each.question).join("\n")).toMatch(/Claimed the full reset on Claude [ab]: 5h 100% used of 100% → 0% used \(the account reached its limit: 5h 100% used, 3 agents running, \d+ starts? held; refill the measured limit\)/)
      const settled = yield* resetsOf(yield* pool("resets"))
      expect(settled.claims.map(({ provider, outcome }) => [provider, outcome]).toSorted()).toEqual([
        ["claude", "reset"],
        ["claude", "reset"],
        ["codex", "reset"],
      ])
      expect(settled.claims.filter((claim) => claim.provider === "claude").map((claim) => claim.weekly)).toEqual(["kept", "kept"])
      expect(settled.claims.find((claim) => claim.provider === "codex")?.weekly).toBe("moved")
      // No token ever shows in what the pool answers or logs.
      const shown = line(settled) + line(world.logs())
      for (const token of [accounts.a.access, accounts.b.access, accounts.a.refresh, accounts[CHATGPT].access, accounts[CHATGPT].refresh])
        expect(shown).not.toContain(token)
    }),
)

seeded(
  "an exhausted week refills despite a fresher account; a later Fable expiry gives its part of the week back, with one notice per claim",
  ({ seed, expect }) =>
    Effect.gen(function* () {
      const now = World.START
      // A day and a half left of both weeks. c: Fable's own week spent, its allowance half the weekly window; 60% of the week used,
      // while d's whole week is spent. Fresh c does not veto d's refill.
      const quotas = new Map<string, FakeQuota>([
        [
          "c",
          {
            fiveHour: { utilization: 0.2, resetAt: now + 3 * HOUR },
            sevenDay: { utilization: 0.6, resetAt: now + 1.5 * DAY },
            fable: { utilization: 1, resetAt: now + 1.5 * DAY, ofWeekly: 0.5 },
          },
        ],
        ["d", { fiveHour: { utilization: 0.2, resetAt: now + 3 * HOUR }, sevenDay: { utilization: 1, resetAt: now + 1.5 * DAY } }],
      ])
      const quotaOf = (account: string) => Option.getOrThrow(Option.fromNullishOr(quotas.get(account)))
      // c's Fable reset ends in two hours, long before Fable's week resets: it is listed once the test says so.
      let fableListed = false
      let weeklyListed = false
      const claimed = new Set<string>()
      const grantsOf = (account: string): ReadonlyArray<FakeGrant> => {
        if (account !== "c" && !weeklyListed) return []
        if (account !== "c") return [{ id: "weekly-d", resetsLeft: 2 - Number(claimed.has("weekly-d")), endsAt: now + 60 * DAY, clears: ["seven_day"], type: "weekly" }]
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
      const { world, pool, questions, open, until, work } = yield* serve(seed, ["c", "d"], {
        quota: quotaOf,
        grants: grantsOf,
        claim: (account, grant) => {
          for (const found of grantsOf(account).filter((item) => item.id === grant)) quotas.set(account, claimEffect(quotaOf(account), found))
          claimed.add(grant)
          return "reset"
        },
      })
      const claims = () => world.provider().claims()

      // ── Demand: a Fable start waits on c's own exhausted week and d's shared week.
      // Record its session before listing d's grant, then let running work trigger the refill. ──
      yield* world.advance(7 * SECOND)
      expect(Schema.decodeUnknownSync(Paced)(yield* pool("pace", { providerID: "anthropic", model: "claude-fable-5-2", sessionID: SESSION })).ok).toBe(false)
      weeklyListed = true
      yield* work(3)
      const weeklyNotice = yield* row(yield* until((rows) => rows.some((each) => each.header === "Pool reset claimed"), "the notice of d's claim"), "Pool reset claimed")
      expect(claims().map(({ account, grant }) => [account, grant])).toEqual([["d", "weekly-d"]])
      expect(weeklyNotice.question).toContain("the account reached its limit")
      expect(yield* questions("answer", { sessionID: SESSION, answers: [{ id: weeklyNotice.id, answer: "OK" }] })).toMatchObject({ ok: true })
      yield* until((rows) => !rows.some((each) => each.id === weeklyNotice.id), "d's notice withdrawn", CLAIM_LIMIT_MS, false)
      expect(yield* open).toEqual([])

      // ── Use it or lose it: c's Fable reset, listed now, is claimed by itself and the owner told ──
      fableListed = true
      const notice = yield* row(yield* until((rows) => rows.some((each) => each.header === "Pool reset claimed"), "the notice of c's claim"), "Pool reset claimed")
      expect(notice.question).toStartWith("Claimed the Fable reset on Claude c: ")
      expect(notice.question).toContain("(about to expire unused: ")
      // Fable's part of the week, as the usage endpoint reports it (`used_percent_of_weekly`: its use times its allowance share).
      expect(notice.question).toMatch(/weekly 60% used of 100% → ~10% used, next reset [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2} [AP]M (?:EST|EDT) \(Fable's part 50% of the week as the usage endpoint reports it\)/)
      expect(claims().map(({ account, grant }) => [account, grant])).toEqual([["d", "weekly-d"], ["c", "fable-c"]])
      const settled = yield* resetsOf(yield* pool("resets"))
      const fable = settled.claims.find((claim) => claim.label === "Claude c")
      expect(fable).toMatchObject({ outcome: "reset", weekly: "kept" })
      // The reading after the claim: Fable's week empty, the weekly window with Fable's part given back.
      expect(fable?.after?.find((window) => window.name === "7d:Fable")?.utilization).toBe(0)
      expect(fable?.after?.find((window) => window.name === "7d")?.utilization).toBeCloseTo(0.1)
      expect(settled.resets.find((reset) => reset.label === "Claude c")).toMatchObject({ why: "expiring", kind: "fable", stage: "settled" })

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
