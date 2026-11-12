// Real OpenCode (the fork, from source) with the Anthropic auth plugin and
// the pool reading gent's store, against the fake Anthropic API. Two gent
// accounts: the first one's token has expired, and the token endpoint answers
// its refresh with a 429. That refresh failing must not end the turn: the
// request is refused as a retryable rate limit, the session retries, and the
// pool places the retry on the second account, where the turn completes with
// no error in the transcript.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { anthropicAuthPlugin, poolPlugin } from "../testbeds/anthropic-auth.ts"
import { fakeAccount, startFakeAnthropic, type FakeAnswer, type FakeRequestInfo, type FakeTokenAnswer } from "./fake-anthropic.ts"
import { gentAvailable, gentSource, openGentStore } from "./gent/store.ts"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
const ready = Boolean(fork) && gentAvailable()
if (!ready) {
  console.warn(
    `tests/pool-gent-refresh.test.ts: skipped. Set OPENCODE_DEV to the fork, and gent to ${gentSource()} (or set GENT_SOURCE).`,
  )
}

const HOUR = 3_600_000
const RUN_TIMEOUT_MS = 120_000

/** The JSON events `opencode run --format json` printed, one per line. */
const eventsOf = (stdout: string): Array<{ readonly type?: unknown }> =>
  stdout.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line)
      return typeof value === "object" && value !== null ? [value] : []
    } catch {
      return []
    }
  })

/** Every `.log` file under `dir`, joined. */
const logsUnder = (dir: string): string =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".log"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n")

describe.skipIf(!ready)("a gent account whose refresh is rate-limited does not end the turn (real OpenCode, fake Anthropic)", () => {
  const kept = keptScratch(ready, "pool-gent-refresh-", true)
  afterAll(() => kept.done())

  test(
    "the turn completes on the second account, with no error row",
    kept.test(async () => {
      const accounts = { alpha: fakeAccount(), beta: fakeAccount() }
      const store = kept.dir("gent-auth-")
      const gent = await openGentStore(store)
      // alpha's token has expired: it must be refreshed before it is sent, and its refresh is rate-limited.
      await gent.signIn("alpha", { ...accounts.alpha, expires: Date.now() - 1000 })
      await gent.signIn("beta", { ...accounts.beta, expires: Date.now() + 8 * HOUR })

      const fake = startFakeAnthropic({
        accounts,
        token: (account): FakeTokenAnswer =>
          account === "alpha" ? { kind: "rate-limited", retryAfterSeconds: 60 } : { kind: "rotate" },
        script: ({ body }: FakeRequestInfo): FakeAnswer => {
          const turn = Array.isArray(body.tools) && body.tools.length > 0
          return { kind: "ok", text: turn ? "Hello from the second gent account." : "Greeting" }
        },
      })
      try {
        const base = kept.dir("run-")
        for (const dir of ["work", "home", "config", "plugins"]) mkdirSync(join(base, dir))
        const launch = forkLaunch(fork ?? "", process.execPath)
        writeFileSync(
          join(base, "work/opencode.json"),
          JSON.stringify({
            model: "anthropic/claude-haiku-4-5",
            plugins: [
              anthropicAuthPlugin,
              {
                package: poolPlugin,
                options: { sweepMinutes: 0, sources: [{ kind: "gent", dir: store, tokenURL: `${fake.url}/v1/oauth/token` }] },
              },
            ],
          }),
        )
        const env: Record<string, string> = {
          PATH: process.env.PATH ?? "",
          HOME: join(base, "home"),
          XDG_CONFIG_HOME: join(base, "home/.config"),
          XDG_DATA_HOME: join(base, "home/.local/share"),
          XDG_STATE_HOME: join(base, "home/.local/state"),
          XDG_CACHE_HOME: join(base, "home/.cache"),
          OPENCODE_DB: join(base, "opencode.db"),
          OPENCODE_CONFIG_DIR: join(base, "config"),
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          ANTHROPIC_BASE_URL: fake.url,
          ...launch.env,
        }
        const started = Date.now()
        const run = owned(
          [...launch.base, "run", "--standalone", "--dangerously-skip-permissions", "--format", "json", "say hello"],
          { cwd: join(base, "work"), env, stdout: "pipe", stderr: "pipe" },
        )
        const timer = setTimeout(() => run.kill(), RUN_TIMEOUT_MS)
        const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])
        await run.exited
        clearTimeout(timer)

        expect(run.exitCode, stderr.slice(-2000)).toBe(0)
        expect(stdout).toContain("Hello from the second gent account.")
        // No error row: the refused attempt was retried, not reported.
        expect(eventsOf(stdout).filter((event) => event.type === "error"), stdout.slice(-2000)).toEqual([])

        // alpha's refresh was tried once and rate-limited; the pause held every later try.
        const trades = fake.received.filter((request) => request.path === "/v1/oauth/token")
        expect(trades.map((request) => [request.account, request.status])).toEqual([["alpha", 429]])
        // Nothing reached Anthropic on alpha's expired token; every turn went out on beta.
        const messages = fake.received.filter((request) => request.path === "/v1/messages")
        expect(messages.length).toBeGreaterThan(0)
        expect(messages.every((request) => request.account === "beta")).toBe(true)
        expect(messages.filter((request) => request.tools > 0).map((request) => request.status)).toEqual([200])
        // The pool failed over at once rather than waiting out alpha's pause.
        expect(Date.now() - started).toBeLessThan(60_000)
        // alpha is as gent left it.
        expect((await gent.get("alpha"))?.access).toBe(accounts.alpha.access)

        // OpenCode's log has the trade at info and the pause once at warning, through the plugin's loggers.
        const logs = logsUnder(join(base, "home"))
        expect(logs.match(/level=INFO [^\n]*gent refresh \\?"alpha\\?": unavailable/g) ?? [], logs.slice(-2000)).toHaveLength(1)
        expect(logs.match(/level=WARN [^\n]*gent refresh: the token endpoint answered 429/g) ?? []).toHaveLength(1)

        for (const name of ["alpha", "beta"] as const)
          for (const token of [accounts[name].access, accounts[name].refresh])
            expect(stdout + stderr + logs).not.toContain(token)
      } finally {
        await fake.stop()
      }
    }),
    RUN_TIMEOUT_MS + 30_000,
  )
})
