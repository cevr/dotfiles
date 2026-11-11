// Rate-limit resets end to end: the fork's own `serve --service` with the
// Anthropic auth plugin, the pool and the questions plugin, against the fake
// Anthropic API (Claude logins, each with a reset grant) and the fake
// ChatGPT backend (one ChatGPT login with a reset credit). Nothing reaches a
// real endpoint: the auth plugin sends every request to ANTHROPIC_BASE_URL,
// the pool's ChatGPT source to `usageURL`, and every token is drawn at run time.
//
// - Every Codex account spent and a start held: the pool consumes one credit,
//   once, and asks no one.
// - Every Claude account spent and a start held: the owner is asked in the
//   waiting session (the questions plugin's tray); a no claims nothing, the
//   next account is asked, that question is withdrawn once its hold lifts by
//   itself, and on a yes the grant is claimed, once.
// - The two Claude kinds: a weekly reset is offered on the fleet's demand
//   early in the week and claimed on a yes; a Fable reset about to expire
//   unused is claimed on its own, empties Fable's week and gives its part of
//   the weekly use back, and the owner is told in the tray after.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { anthropicAuthPlugin, poolPlugin } from "../testbeds/anthropic-auth.ts"
import { ROOT } from "../scripts/agents.ts"
import { claimEffect, type FakeAccount, fakeAccount, type FakeGrant, startFakeAnthropic, type FakeQuota } from "./fake-anthropic.ts"
import { spentAccount, startFakeChatGPT } from "./fake-chatgpt.ts"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
const ready = Boolean(fork)
if (!ready) console.warn("tests/pool-resets.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TIMEOUT_MS = 180_000
/** How long account b's first 5-hour hold lasts from the pool's first reading of it: its question is withdrawn once it lifts. */
const SHORT_HOLD_MS = 25 * SECOND
const SESSION = "ses_resets_root"

interface Service {
  readonly url: string
  readonly password: string
}

const authorization = (service: Service) => `Basic ${btoa(`opencode:${service.password}`)}`

/** One method of a plugin's RPC on the server, as the pane and report.ts ask it. */
const rpc = async (service: Service, plugin: string, method: string, input: unknown = {}): Promise<unknown> => {
  const response = await fetch(new URL(`/api/rpc/${plugin}/${method}`, service.url), {
    method: "POST",
    headers: { authorization: authorization(service), "content-type": "application/json" },
    body: JSON.stringify({ input }),
  })
  const body = (await response.json()) as { output?: unknown }
  return body.output
}

const until = async <A>(read: () => Promise<A>, done: (value: A) => boolean, label: () => string, ms = 60_000): Promise<A> => {
  const deadline = Date.now() + ms
  let last = await read()
  while (!done(last)) {
    if (Date.now() > deadline) return expect.unreachable(`${label()}: still ${JSON.stringify(last)}`)
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
  const root = mkdtempSync(join(tmpdir(), "pool-resets-"))
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const stop of stops.reverse()) await stop()
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * The service in a scratch home `name`, with the Claude logins `accounts`
   * (the first active) and a ChatGPT login on `chatgptURL` when given, the pool
   * sweeping every 6 s. Its pool and questions RPCs, once the pool answers.
   */
  const serve = async (name: string, accounts: Readonly<Record<string, FakeAccount>>, anthropicURL: string, now: number, chatgptURL?: string) => {
    const base = join(root, name)
    const home = join(base, "home")
    for (const dir of [join(base, "work"), join(home, ".config/opencode"), join(home, ".local/state")]) mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify({
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
      PATH: process.env.PATH ?? "",
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
    const imported = Bun.spawnSync([...launch.base, "auth", "import", "--standalone"], {
      cwd: join(base, "work"),
      env,
      stdin: new TextEncoder().encode(JSON.stringify(logins)),
    })
    expect(imported.exitCode).toBe(0)
    const child = owned([...launch.base, "serve", "--service", "--port", "0"], { cwd: join(base, "work"), env, stdout: "ignore", stderr: "pipe" })
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
          return JSON.parse(readFileSync(serviceFile, "utf8")) as Service
        } catch {
          return undefined
        }
      },
      (value) => value !== undefined && typeof value.url === "string",
      () => `the service file (${log()})`,
    ))!
    const pool = (method: string, input: unknown = {}) => rpc(service, "dotfiles-opencode.pool", method, input)
    const questions = (method: string, input: unknown) => rpc(service, "dotfiles-opencode.questions", method, input)
    const open = async () => ((await questions("open", { sessionIDs: [SESSION] })) as { questions?: ReadonlyArray<OpenQuestion> } | undefined)?.questions ?? []
    await until(
      () => pool("resets").catch(() => undefined),
      (value) => typeof value === "object" && value !== null && "claims" in value,
      () => `the pool (${log()})`,
    )
    return { pool, questions, open, log, stderr: () => stderr }
  }

  test(
    "a Codex credit is claimed by itself once; a Claude grant only on the owner's yes, with a no and a lifted hold claiming nothing",
    async () => {
      const now = Date.now()
      // ── The fakes ──
      const chatgpt = startFakeChatGPT()
      stops.push(chatgpt.stop)
      chatgpt.accounts.set("acct-1", spentAccount("chatgpt-access-1", "credit-1", now))

      const accounts = { a: fakeAccount(), b: fakeAccount() }
      // a: spent for two hours, its week resetting in three days (the most time left, so asked first).
      // b: spent for SHORT_HOLD_MS from the pool's first reading of it, its week resetting in two days. Not from
      // the test's start: on a loaded host the service took longer than that to boot, b's hold lifted before
      // the pool got to it, and nothing was asked.
      const quotas = new Map<string, FakeQuota>([
        ["a", { fiveHour: { utilization: 1, resetAt: now + 2 * HOUR }, sevenDay: { utilization: 0.4, resetAt: now + 3 * DAY } }],
      ])
      const quotaOf = (account: string): FakeQuota => {
        if (account === "b" && !quotas.has("b"))
          quotas.set("b", { fiveHour: { utilization: 1, resetAt: Date.now() + SHORT_HOLD_MS }, sevenDay: { utilization: 0.4, resetAt: now + 2 * DAY } })
        const quota = quotas.get(account)!
        // A window past its reset reads empty, as the real one does.
        return Date.now() < quota.fiveHour.resetAt ? quota : { ...quota, fiveHour: { utilization: 0, resetAt: Date.now() + 5 * HOUR } }
      }
      const anthropic = startFakeAnthropic({
        accounts,
        quota: quotaOf,
        grants: (account) => [{ id: `grant-${account}`, resetsLeft: 1, endsAt: now + 120 * DAY, clears: ["five_hour", "seven_day_overage_included"] }],
        claim: (account) => {
          const quota = quotas.get(account)!
          quotas.set(account, { ...quota, fiveHour: { utilization: 0, resetAt: Date.now() + 5 * HOUR } })
          return "reset"
        },
      })
      stops.push(anthropic.stop)

      // ── The server ──
      const { pool, questions, open, log, stderr } = await serve("host", accounts, anthropic.url, now, chatgpt.usageURL)

      // ── Codex: claimed by itself, once ──
      const codexPace = (await pool("pace", { providerID: "openai", sessionID: SESSION })) as { ok?: boolean }
      expect(codexPace.ok).toBe(false)
      await until(async () => chatgpt.consumes.length, (count) => count > 0, () => `a consume (${log()})`)
      await pool("pace", { providerID: "openai", sessionID: SESSION })
      await Bun.sleep(1000)
      expect(chatgpt.consumes.map(({ account, creditID, code }) => ({ account, creditID, code }))).toEqual([
        { account: "acct-1", creditID: "credit-1", code: "reset" },
      ])
      expect(await open()).toEqual([])

      // ── Claude: asked, never claimed unasked ──
      const asked = async (label: string) =>
        (await until(
          async () => {
            await pool("pace", { providerID: "anthropic", sessionID: SESSION })
            return open()
          },
          (rows) => rows.some((row) => row.header === `Claude reset · ${label}`),
          () => `a question about ${label} (${log()})`,
        )).find((row) => row.header === `Claude reset · ${label}`)!
      const first = await asked("Claude a")
      expect(first.question).toContain("remain before the weekly reset")
      expect(first.question).toContain("Claim it?")
      expect(anthropic.claims).toEqual([])

      // A no: nothing is claimed, and the next account is asked.
      expect(await questions("answer", { sessionID: SESSION, answers: [{ id: first.id, answer: "Don't claim" }] })).toMatchObject({ ok: true })
      const second = await asked("Claude b")
      expect(anthropic.claims).toEqual([])

      // b's hold lifts by itself: the sweep reads it, and its question goes unanswered.
      await until(open, (rows) => !rows.some((row) => row.id === second.id), () => `b's question withdrawn (${log()})`, SHORT_HOLD_MS + 30 * SECOND)
      expect(anthropic.claims).toEqual([])
      const lifted = (await pool("resets")) as Resets
      expect(lifted.resets.filter((reset) => reset.label === "Claude b").map((reset) => [reset.stage, reset.message])).toEqual([
        ["withdrawn", "the hold lifted"],
      ])

      // b is spent again: a new hold, asked again; on a yes its grant is claimed, once.
      quotas.set("b", { fiveHour: { utilization: 1, resetAt: Date.now() + 2 * HOUR }, sevenDay: { utilization: 0.4, resetAt: now + 2 * DAY } })
      const third = await asked("Claude b")
      expect(await questions("answer", { sessionID: SESSION, answers: [{ id: third.id, answer: "Claim it" }] })).toMatchObject({ ok: true })
      await until(async () => anthropic.claims.length, (count) => count > 0, () => `a Claude claim (${log()})`)
      await Bun.sleep(2000)
      expect(anthropic.claims.map(({ account, grant, result }) => ({ account, grant, result }))).toEqual([
        { account: "b", grant: "grant-b", result: "reset" },
      ])
      expect(String(anthropic.claims[0]?.requestID)).toMatch(/^pool-[0-9a-f]{24}$/)
      const settled = (await pool("resets")) as Resets
      expect(settled.claims.map(({ provider, outcome }) => [provider, outcome])).toEqual([
        ["claude", "reset"],
        ["codex", "reset"],
      ])
      expect(settled.claims[0]?.weekly).toBe("kept")
      expect(settled.claims[1]?.weekly).toBe("moved")
      // No token ever shows in what the pool answers or logs.
      const shown = JSON.stringify(settled) + stderr()
      for (const token of [accounts.a.access, accounts.b.access, accounts.a.refresh, "chatgpt-access-1", "chatgpt-refresh-1"]) expect(shown).not.toContain(token)
    },
    TIMEOUT_MS,
  )

  test(
    "a weekly reset is offered on the fleet's demand early in the week and claimed on a yes; a Fable reset about to expire unused is claimed on its own, gives Fable's part of the week back, and the owner is told",
    async () => {
      const now = Date.now()
      const accounts = { c: fakeAccount(), d: fakeAccount() }
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
          : [{ id: "weekly-d", resetsLeft: claimed.has("weekly-d") ? 0 : 1, endsAt: now + 60 * DAY, clears: ["seven_day"], type: "weekly" }]
      const anthropic = startFakeAnthropic({
        accounts,
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
      const { pool, questions, open, log } = await serve("kinds", accounts, anthropic.url, now)

      // ── Demand: three starts in flight across the fleet, from this session ──
      for (let start = 0; start < 3; start++) await pool("started", { providerID: "anthropic" })
      const offered = (await until(
        async () => {
          await pool("pace", { providerID: "anthropic", sessionID: SESSION })
          return open()
        },
        (rows) => rows.some((row) => row.header === "Reset now · Claude d"),
        () => `an offer for d (${log()})`,
      )).find((row) => row.header === "Reset now · Claude d")!
      expect(offered.question).toContain("weekly reset on account Claude d now? Demand: 3 starts are in flight across the fleet.")
      expect(offered.question).toContain("It gives back weekly 100% → 0%.")
      expect(offered.question).toMatch(/6\.0 days remain before the weekly window resets by itself/)
      expect(anthropic.claims).toEqual([])
      expect(await questions("answer", { sessionID: SESSION, answers: [{ id: offered.id, answer: "Claim it" }] })).toMatchObject({ ok: true })
      await until(async () => anthropic.claims.length, (count) => count > 0, () => `d's claim (${log()})`)
      expect(anthropic.claims.map(({ account, grant, result }) => ({ account, grant, result }))).toEqual([{ account: "d", grant: "weekly-d", result: "reset" }])

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
      expect(notice.question).toContain("The pool claimed the Fable reset on account Claude c before it expired unused")
      // Fable's part of the week, as the fake's usage endpoint reports it (`used_percent_of_weekly`: its use times its allowance share).
      expect(notice.question).toContain("weekly 60% → ~10% (Fable's part 50% as the usage endpoint reports it)")
      expect(anthropic.claims.map(({ account, grant }) => [account, grant])).toEqual([
        ["d", "weekly-d"],
        ["c", "fable-c"],
      ])
      const settled = (await pool("resets")) as Resets
      const fable = settled.claims.find((claim) => claim.label === "Claude c")
      expect(fable).toMatchObject({ outcome: "reset", weekly: "kept" })
      // The reading after the claim: Fable's week empty, the weekly window with Fable's part given back.
      expect(fable?.after?.find((window) => window.name === "7d:Fable")?.utilization).toBe(0)
      expect(fable?.after?.find((window) => window.name === "7d")?.utilization).toBeCloseTo(0.1)
      expect(settled.resets.find((reset) => reset.label === "Claude c")).toMatchObject({ why: "expiring", kind: "fable", stage: "settled" })
      expect(settled.resets.find((reset) => reset.label === "Claude d")).toMatchObject({ why: "offer", kind: "weekly" })

      // The owner reads the notice: it leaves the tray.
      expect(await questions("answer", { sessionID: SESSION, answers: [{ id: notice.id, answer: "OK" }] })).toMatchObject({ ok: true })
      await until(open, (rows) => !rows.some((row) => row.id === notice.id), () => `the notice withdrawn (${log()})`)
      // Each claim once.
      await Bun.sleep(7000)
      expect(anthropic.claims).toHaveLength(2)
    },
    TIMEOUT_MS,
  )
})
