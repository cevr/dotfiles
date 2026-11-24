// accept: deep (100.0 s alone on a quiet host: 1-minute load 5.3–7.7 on 12 cores; it waits out the pool's reset windows in real OpenCode)
// Rate-limit resets end to end: the fork's own `serve --service` with the
// Anthropic auth plugin, the pool and the questions plugin, against the fake
// Anthropic API (Claude logins, each with a reset grant) and the fake
// ChatGPT backend (one ChatGPT login with a reset credit). Nothing reaches a
// real endpoint: the auth plugin sends every request to ANTHROPIC_BASE_URL,
// the pool's ChatGPT source to `usageURL`, and every token is drawn at run time.
//
// The pool asks the owner nothing about resets: it claims them on its own
// and tells the owner after, in the waiting session's tray.
// - Every account spent, no agent running and no start held: no forecast,
//   nothing claimed. With three agents running (Codex: started; Claude: three
//   sessions busy on a long command, no start recorded): one Codex credit
//   and one Claude grant claimed, once each; the claimed Claude account takes
//   the work, so the other is not claimed.
// - A spent week is left while the forecast keeps room on a fresher account
//   to the reset; a Fable reset
//   about to expire unused is claimed on its own, empties Fable's week and
//   gives its part of the weekly use back, and the owner is told.
// - One spent week, two weekly resets about to expire: one is claimed, and
//   the reading after it (the week back to 0%) keeps the second.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { formatNotificationTime } from "../decider/notification-time.ts"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { readScratchFileSync, scratchInput } from "./read-path.ts"
import { anthropicAuthPlugin, poolPlugin } from "../testbeds/anthropic-auth.ts"
import { ROOT } from "../scripts/agents.ts"
import { putToWork, working } from "../testbeds/busy-agents.ts"
import { claimEffect, type FakeAccount, fakeAccount, type FakeGrant, type ReceivedRequest, startFakeAnthropic, type FakeQuota } from "./fake-anthropic.ts"
import { spentAccount, startFakeChatGPT } from "./fake-chatgpt.ts"
import { ownedForkFixture } from "./owned.ts"
import { importForkCredentials } from "./scratch-child.ts"
import { keptScratch } from "./scratch.ts"
import { hangGuard, stamp, watchdog } from "./hang-guard.ts"

const fork = process.env.OPENCODE_DEV
const ready = Boolean(fork)
if (!ready) console.warn("tests/pool-resets.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const SESSION = "ses_resets_root"
const readBusy = Schema.decodeUnknownSync(Schema.Struct({ busy: Schema.Array(Schema.String) }))

interface Service {
  readonly url: string
  readonly password: string
}

const authorization = (service: Service) => `Basic ${btoa(`opencode:${service.password}`)}`


/** One method of a plugin's RPC on the server, as the pane and report.ts ask it. */
const rpc = async (service: Service, directory: string, plugin: string, method: string, input: unknown = {}): Promise<unknown> => {
  const target = new URL(`/api/rpc/${plugin}/${method}`, service.url)
  target.searchParams.set("location[directory]", directory)
  const response = await fetch(target, {
    method: "POST",
    headers: { authorization: authorization(service), "content-type": "application/json" },
    body: JSON.stringify({ input }),
  })
  const body = (await response.json()) as { output?: unknown }
  return body.output
}

const until = async <A>(read: () => A | Promise<A>, done: (value: A) => boolean, label: () => string, ms = hangGuard("process-fixture")): Promise<A> => {
  const deadline = watchdog(ms)
  let last = await read()
  while (!done(last)) {
    if (deadline.expired()) return expect.unreachable(`${label()}: still ${JSON.stringify(last)}`)
    await Bun.sleep(250)
    last = await read()
  }
  return last
}

interface OpenQuestion {
  readonly id: string
  readonly sessionID: string
  readonly question: string
  readonly header?: string
}

interface Window {
  readonly name: string
  readonly utilization: number
}

interface Resets {
  readonly resets: ReadonlyArray<{ readonly label: string; readonly stage: string; readonly why: string; readonly kind?: string; readonly message?: string; readonly told?: string }>
  readonly claims: ReadonlyArray<{
    readonly provider: string
    readonly label: string
    readonly outcome: string
    readonly weekly: string
    readonly after?: ReadonlyArray<Window>
  }>
}

describe.skipIf(!ready)("rate-limit resets (real OpenCode, fake Anthropic, fake ChatGPT)", () => {
  const kept = keptScratch(ready, "pool-resets-", true)
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const stop of stops.reverse()) await stop()
    kept.done()
  })

  /**
   * The service in a scratch home `name`, with the Claude logins `accounts`
   * (the first active) and a ChatGPT login on `chatgptURL` when given, the pool
   * sweeping every 6 s. Its pool and questions RPCs, once the pool answers.
   */
  const serve = async (name: string, accounts: Readonly<Record<string, FakeAccount>>, anthropicURL: string, now: number, chatgptURL?: string) => {
    const base = kept.dir(`${name}-`)
    const home = join(base, "home")
    for (const dir of ["work", "home", "home/.config", "home/.config/opencode", "home/.local", "home/.local/state"]) mkdirSync(join(base, dir))
    writeFileSync(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        plugins: [
          anthropicAuthPlugin,
          {
            package: poolPlugin,
            options: { sweepMinutes: 0.1, ...(chatgptURL === undefined ? {} : { paced: { openai: "openai" }, usageURL: chatgptURL }) },
          },
          join(ROOT, "cmd/questions"),
        ],
      }),
    )
    const launch = forkLaunch(fork ?? "", process.execPath)
    const env: Record<string, string> = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_DB: join(base, "opencode.db"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      ANTHROPIC_BASE_URL: anthropicURL,
      ...launch.env,
    }
    // The logins go in on stdin, never in argv or a file.
    const logins = [
      ...Object.entries(accounts).map(([label, account], index) => ({
        id: `cred_${label}`,
        integrationID: "anthropic",
        label: `Claude ${label}`,
        active: index === 0,
        value: { type: "oauth", methodID: "claude-max", refresh: account.refresh, access: account.access, expires: now + 8 * HOUR },
      })),
      ...(chatgptURL === undefined
        ? []
        : [
            {
              id: "cred_chatgpt",
              integrationID: "openai",
              label: "ChatGPT",
              active: true,
              value: {
                type: "oauth",
                methodID: "chatgpt-browser",
                refresh: "chatgpt-refresh-1",
                access: "chatgpt-access-1",
                expires: now + 8 * HOUR,
                metadata: { accountID: "acct-1" },
              },
            },
          ]),
    ]
    const imported = importForkCredentials(fork ?? "", join(base, "work"), env, new TextEncoder().encode(JSON.stringify(logins)))
    expect(imported.exitCode).toBe(0)
    const child = ownedForkFixture([fork ?? "", join(base, "work"), ["serve", "--service", "--port", "0"], env], { stdout: "ignore", stderr: "pipe" })
    let stderr = ""
    void (async () => {
      for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk)
    })()
    stops.push(async () => {
      child.kill()
      await child.exited
    })
    const log = () => stderr.slice(-500)
    const serviceFile = join(home, ".local/state/opencode/service-local.json")
    const service = (await until(
      async () => {
        try {
          return JSON.parse(readScratchFileSync(serviceFile, "utf8")) as Service
        } catch {
          return undefined
        }
      },
      (value) => value !== undefined && typeof value.url === "string",
      () => `the service file (${log()})`,
    ))!
    const directory = realpathSync(scratchInput(join(base, "work")))
    const pool = (method: string, input: unknown = {}) => rpc(service, directory, "dotfiles-opencode.pool", method, input)
    /** Do not spend the quota until the pool itself sees every Claude session running. */
    const running = Effect.promise(() => pool("report")).pipe(Effect.map((report) => readBusy(report).busy.filter((provider) => provider === "anthropic").length))
    const work = (count: number, fake: { readonly received: ReadonlyArray<ReceivedRequest> }, reads = 0) =>
      putToWork({ fork: String(fork), url: service.url, authorization: authorization(service), directory, owner: SESSION, received: fake.received, running, count, reads, log })
    const questions = (method: string, input: unknown) => rpc(service, directory, "dotfiles-opencode.questions", method, input)
    const open = async () => ((await questions("open", { sessionIDs: [SESSION] })) as { questions?: ReadonlyArray<OpenQuestion> } | undefined)?.questions ?? []
    await until(
      () => pool("resets").catch(() => undefined),
      (value) => typeof value === "object" && value !== null && "claims" in value,
      () => `the pool (${log()})`,
    )
    // A new read of the same login is an opportunity for the prior sweep to finish.
    // Keep asking to pace (as the pane does) until the fake sees those opportunities.
    const swept = (fake: { readonly received: ReadonlyArray<ReceivedRequest> }, count: number, providers: ReadonlyArray<string> = []) => {
      const login = Object.keys(accounts).at(0)
      const reads = () => fake.received.filter((request) => request.account === login && request.path === "/api/oauth/usage").length
      const target = reads() + count + 2 // Skip a sweep already in progress, and read again after the last one.
      return until(async () => {
        for (const providerID of providers) await pool("pace", { providerID, sessionID: SESSION })
        return reads()
      }, (seen) => seen >= target, () => `the pool's ${count} completed sweeps (${log()})`)
    }
    return { pool, questions, open, log, swept, work, stderr: () => stderr }
  }

  test(
    "with agents running, a Codex credit and a Claude grant are each claimed on their own, once, and the owner told after; with no agent running and no start held, nothing is claimed and nothing asked",
    kept.test(async () => {
      const now = stamp()
      // ── The fakes ──
      const chatgpt = startFakeChatGPT()
      stops.push(chatgpt.stop)
      // The credit ends before the week resets: not one to keep in hand.
      chatgpt.accounts.set("acct-1", spentAccount("chatgpt-access-1", "credit-1", now, 40, 2 * DAY))

      const accounts = { a: fakeAccount(), b: fakeAccount() }
      // a and b: both 5-hour windows spent for two hours, a's week resetting in three days, b's in two.
      const quotas = new Map<string, FakeQuota>([
        ["a", { fiveHour: { utilization: 1, resetAt: now + 2 * HOUR }, sevenDay: { utilization: 0.4, resetAt: now + 3 * DAY } }],
        ["b", { fiveHour: { utilization: 1, resetAt: now + 2 * HOUR }, sevenDay: { utilization: 0.4, resetAt: now + 2 * DAY } }],
      ])
      const anthropic = startFakeAnthropic({
        accounts,
        script: working,
        quota: (account) => quotas.get(account)!,
        // Two resets in hand on each account: not the last one, kept in reserve.
        grants: (account) => [{ id: `grant-${account}`, resetsLeft: 2, endsAt: now + 120 * DAY, clears: ["five_hour", "seven_day_overage_included"] }],
        claim: (account) => {
          const quota = quotas.get(account)!
          quotas.set(account, { ...quota, fiveHour: { utilization: 0, resetAt: stamp() + 5 * HOUR } })
          return "reset"
        },
      })
      stops.push(anthropic.stop)

      // ── The server ──
      const { pool, open, log, swept, work, stderr } = await serve("host", accounts, anthropic.url, now, chatgpt.usageURL)

      // ── No work: nothing running and no start held, over two sweeps ──
      await swept(anthropic, 2)
      expect(anthropic.claims).toEqual([])
      expect(chatgpt.consumes).toEqual([])
      expect(await open()).toEqual([])

      // ── Codex: three starts running, a start held: claimed on its own, once ──
      for (let start = 0; start < 3; start++) await pool("started", { providerID: "openai" })
      const codexPace = (await pool("pace", { providerID: "openai", sessionID: SESSION })) as { ok?: boolean }
      expect(codexPace.ok).toBe(false)
      await until(() => chatgpt.consumes.length, (count) => count > 0, () => `a consume (${log()})`)
      await until(open, (rows) => rows.some((row) => row.header === "Pool reset claimed"), () => `the recorded Codex claim (${log()})`)
      expect(chatgpt.consumes.map(({ account, creditID, code }) => ({ account, creditID, code }))).toEqual([
        { account: "acct-1", creditID: "credit-1", code: "reset" },
      ])

      // ── Claude: three agents put to work while the 5-hour windows had room, then the windows spent under them; busy, with no
      // start recorded: the forecast runs the pool out before its reset, one grant claimed on its own, nothing asked ──
      const spent = new Map(quotas)
      for (const [account, quota] of spent) quotas.set(account, { ...quota, fiveHour: { ...quota.fiveHour, utilization: 0.5 } })
      // A sweep reads the room on both logins before the agents start.
      await work(3, anthropic, 2)
      for (const [account, quota] of spent) quotas.set(account, quota)
      await until(
        async () => {
          await pool("pace", { providerID: "anthropic", sessionID: SESSION })
          return anthropic.claims.length
        },
        (count) => count > 0,
        () => `a Claude claim (${log()})`,
      )
      // The claimed account takes the work: the other is not claimed, over two more sweeps.
      await swept(anthropic, 2, ["anthropic"])
      expect(anthropic.claims.map(({ result }) => result)).toEqual(["reset"])
      expect(String(anthropic.claims[0]?.requestID)).toMatch(/^pool-[0-9a-f]{24}$/)
      // The tray holds the two notices and nothing else; each says why, in one clause.
      const rows = await open()
      expect(rows.map((row) => row.header)).toEqual(["Pool reset claimed", "Pool reset claimed"])
      const told = rows.map((row) => row.question).join("\n")
      expect(told).toContain("Claimed the Codex reset on ChatGPT")
      expect(told).toMatch(/Claimed the full reset on Claude [ab]: 5h 100% used of 100% → 0% used \(the pool runs out before its reset: (\d+ starts? held, )?3 agents running on 1 host, /)
      const settled = (await pool("resets")) as Resets
      expect(settled.claims.map(({ provider, outcome }) => [provider, outcome]).toSorted()).toEqual([
        ["claude", "reset"],
        ["codex", "reset"],
      ])
      expect(settled.claims.find((claim) => claim.provider === "claude")?.weekly).toBe("kept")
      expect(settled.claims.find((claim) => claim.provider === "codex")?.weekly).toBe("moved")
      // No token ever shows in what the pool answers or logs.
      const shown = JSON.stringify(settled) + stderr()
      for (const token of [accounts.a.access, accounts.b.access, accounts.a.refresh, "chatgpt-access-1", "chatgpt-refresh-1"]) expect(shown).not.toContain(token)
    }),
    hangGuard("fork-session"),
  )

  test(
    "a spent week is not claimed while the forecast keeps room on a fresher account to the reset; a Fable reset about to expire unused is claimed on its own, gives Fable's part of the week back, and the owner is told",
    kept.test(async () => {
      const now = stamp()
      const accounts = { c: fakeAccount(), d: fakeAccount() }
      // A day and a half left of both weeks. c: Fable's own week spent, its allowance half the weekly window; 60% of the week used,
      // so at the pool's burn its room outlasts the reset. d: its whole week spent.
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
      // c's Fable reset ends in two hours, long before Fable's week resets: it is listed once the test says so.
      let fableListed = false
      const claimed = new Set<string>()
      const grantsOf = (account: string): ReadonlyArray<FakeGrant> =>
        account === "c"
          ? fableListed
            ? [
                {
                  id: "fable-c",
                  resetsLeft: claimed.has("fable-c") ? 0 : 1,
                  endsAt: now + 2 * HOUR,
                  clears: ["five_hour", "seven_day_overage_included"],
                  type: "full",
                  givesBackWeekly: true,
                },
              ]
            : []
          : [{ id: "weekly-d", resetsLeft: claimed.has("weekly-d") ? 1 : 2, endsAt: now + 60 * DAY, clears: ["seven_day"], type: "weekly" }]
      const anthropic = startFakeAnthropic({
        accounts,
        script: working,
        quota: (account) => quotas.get(account)!,
        grants: grantsOf,
        claim: (account, grant) => {
          const found = grantsOf(account).find((item) => item.id === grant)
          if (found !== undefined) quotas.set(account, claimEffect(quotas.get(account)!, found))
          claimed.add(grant)
          return "reset"
        },
      })
      stops.push(anthropic.stop)
      const { pool, questions, open, log, swept, work } = await serve("kinds", accounts, anthropic.url, now)

      // ── Demand: three agents busy, a start paced each second: c's room outlasts the reset, so d's week is left ──
      await work(3, anthropic)
      await swept(anthropic, 2, ["anthropic"])
      expect(anthropic.claims).toEqual([])
      expect(await open()).toEqual([])

      // ── Use it or lose it: c's Fable reset, listed now, is claimed by itself and the owner told ──
      fableListed = true
      let seen = ""
      const notice = (await until(
        async () => {
          await pool("pace", { providerID: "anthropic", sessionID: SESSION })
          seen = JSON.stringify({ claims: anthropic.claims.map(({ account, grant }) => [account, grant]), resets: await pool("resets"), status: await pool("status") })
          return open()
        },
        (rows) => rows.some((row) => row.header === "Pool reset claimed"),
        () => `the notice of c's claim (${seen.slice(0, 3000)})`,
      )).find((row) => row.header === "Pool reset claimed")!
      expect(notice.question).toStartWith("Claimed the Fable reset on Claude c: ")
      // Times as the owner reads them (decider/notification-time.ts), from the instants the fake reports.
      expect(notice.question).toContain(`(about to expire unused: it expires ${formatNotificationTime(now + 2 * HOUR)}, lost unused otherwise)`)
      // Fable's part of the week, as the fake's usage endpoint reports it (`used_percent_of_weekly`: its use times its allowance share).
      expect(notice.question).toContain(
        `weekly 60% used of 100% → ~10% used, next reset ${formatNotificationTime(now + 1.5 * DAY)} (Fable's part 50% of the week as the usage endpoint reports it)`,
      )
      expect(anthropic.claims.map(({ account, grant }) => [account, grant])).toEqual([["c", "fable-c"]])
      const settled = (await pool("resets")) as Resets
      const fable = settled.claims.find((claim) => claim.label === "Claude c")
      expect(fable).toMatchObject({ outcome: "reset", weekly: "kept" })
      // The reading after the claim: Fable's week empty, the weekly window with Fable's part given back.
      expect(fable?.after?.find((window) => window.name === "7d:Fable")?.utilization).toBe(0)
      expect(fable?.after?.find((window) => window.name === "7d")?.utilization).toBeCloseTo(0.1)
      expect(settled.resets.find((reset) => reset.label === "Claude c")).toMatchObject({ why: "expiring", kind: "fable", stage: "settled" })

      // The owner reads the notice: it leaves the tray.
      expect(await questions("answer", { sessionID: SESSION, answers: [{ id: notice.id, answer: "OK" }] })).toMatchObject({ ok: true })
      await until(open, (rows) => !rows.some((row) => row.id === notice.id), () => `the notice withdrawn (${log()})`)
      // Each claim once.
      await swept(anthropic, 1)
      expect(anthropic.claims).toHaveLength(1)
    }),
    hangGuard("fork-session"),
  )

  test(
    "one spent week with two weekly resets about to expire spends one: the reading after it shows the week back, so the second is kept",
    kept.test(async () => {
      const now = stamp()
      const accounts = { e: fakeAccount() }
      // The round-1 verifier's case: the week spent, resetting in three days; two weekly grants ending in two hours.
      let quota: FakeQuota = { fiveHour: { utilization: 0.2, resetAt: now + HOUR }, sevenDay: { utilization: 1, resetAt: now + 3 * DAY } }
      const claimed = new Set<string>()
      const grantsOf = (): ReadonlyArray<FakeGrant> =>
        ["g1", "g2"].map((id) => ({ id, resetsLeft: claimed.has(id) ? 0 : 1, endsAt: now + 2 * HOUR, clears: ["seven_day"], type: "weekly" as const }))
      const anthropic = startFakeAnthropic({
        accounts,
        quota: () => quota,
        grants: grantsOf,
        claim: (_account, grant) => {
          const found = grantsOf().find((item) => item.id === grant)
          if (found !== undefined) quota = claimEffect(quota, found)
          claimed.add(grant)
          return "reset"
        },
      })
      stops.push(anthropic.stop)
      const { pool, log, swept } = await serve("two-grants", accounts, anthropic.url, now)
      await until(
        async () => {
          await pool("pace", { providerID: "anthropic", sessionID: SESSION })
          return anthropic.claims.length
        },
        (count) => count > 0,
        () => `a claim (${log()})`,
      )
      // Three sweeps after it, each reading the week back to 0%: no second grant goes.
      await swept(anthropic, 3, ["anthropic"])
      expect(anthropic.claims.map(({ account, grant, result }) => ({ account, grant, result }))).toEqual([{ account: "e", grant: "g1", result: "reset" }])
      const settled = (await pool("resets")) as Resets
      expect(settled.claims).toHaveLength(1)
      expect(settled.claims[0]?.after?.find((window) => window.name === "7d")?.utilization).toBe(0)
    }),
    hangGuard("fork-session"),
  )
})
