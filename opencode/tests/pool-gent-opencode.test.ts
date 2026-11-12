// Real OpenCode (the fork, from source) with the Anthropic auth plugin and
// the pool reading gent's store, against the fake Anthropic API. OpenCode
// holds no Anthropic login of its own: both accounts are gent's, signed in
// by gent's own `Auth` in a temporary directory. The first one's turn meets
// a plan limit; the run must finish on the second, each request carrying the
// token of the gent slot the pool picked, and the stale second slot must be
// refreshed once under gent's lock and written back for gent.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { anthropicAuthPlugin, poolPlugin } from "../testbeds/anthropic-auth.ts"
import { fakeAccount, startFakeAnthropic, type FakeAnswer, type FakeRequestInfo } from "./fake-anthropic.ts"
import { gentAvailable, gentSource, openGentStore } from "./gent/store.ts"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
const ready = Boolean(fork) && gentAvailable()
if (!ready) {
  console.warn(
    `tests/pool-gent-opencode.test.ts: skipped. Set OPENCODE_DEV to the fork, and gent to ${gentSource()} (or set GENT_SOURCE).`,
  )
}

const HOUR = 3_600_000
const RUN_TIMEOUT_MS = 120_000

describe.skipIf(!ready)("OpenCode runs on gent's Claude accounts through the pool (real OpenCode, fake Anthropic)", () => {
  const kept = keptScratch(ready, "pool-gent-opencode-", true)
  const root = kept.path
  afterAll(() => kept.done())

  test(
    "the turn goes out on the gent slot the pool picked, and fails over to the next gent slot",
    kept.test(async () => {
      const accounts = { alpha: fakeAccount(), beta: fakeAccount() }
      const store = join(root, "gent-auth")
      const gent = await openGentStore(store)
      await gent.signIn("alpha", { ...accounts.alpha, expires: Date.now() + 8 * HOUR })
      // beta's token is stale: the pool refreshes it under gent's lock before it sends.
      await gent.signIn("beta", { ...accounts.beta, expires: Date.now() - 1000 })

      const resetAt = Date.now() + 3 * HOUR
      const fake = startFakeAnthropic({
        accounts,
        script: ({ account, body }: FakeRequestInfo): FakeAnswer => {
          const turn = Array.isArray(body.tools) && body.tools.length > 0
          if (turn && account === "alpha") return { kind: "usage-429", claim: "five_hour", resetAt }
          return { kind: "ok", text: turn ? "Hello from gent's second account." : "Greeting" }
        },
      })
      try {
        const base = join(root, "run")
        for (const dir of ["work", "home", "config", "plugins"]) mkdirSync(join(base, dir), { recursive: true })
        const launch = forkLaunch(fork!, process.execPath)
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
        // No `auth import`: OpenCode's own store holds no Anthropic login.
        const run = owned(
          [...launch.base, "run", "--standalone", "--dangerously-skip-permissions", "--format", "json", "say hello"],
          { cwd: join(base, "work"), env, stdout: "pipe", stderr: "pipe" },
        )
        const timer = setTimeout(() => run.kill(), RUN_TIMEOUT_MS)
        const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])
        await run.exited
        clearTimeout(timer)

        const messages = fake.received.filter((request) => request.path === "/v1/messages")
        const turns = messages.filter((request) => request.tools > 0)
        expect(run.exitCode, stderr.slice(-2000)).toBe(0)
        expect(stdout).toContain("Hello from gent's second account.")
        expect(turns.map((request) => [request.account, request.status])).toEqual([
          ["alpha", 429],
          ["beta", 200],
        ])
        // Every request carried a gent slot's current token; none went out unsigned.
        expect(messages.every((request) => request.account !== undefined)).toBe(true)
        expect(messages.flatMap((request) => request.opencodeHeaders)).not.toContain("x-opencode-credential-id")

        // beta was refreshed once, by the pool, and gent reads the result.
        const trades = fake.received.filter((request) => request.path === "/v1/oauth/token")
        expect(trades.map((request) => [request.account, request.status])).toEqual([["beta", 200]])
        const beta = await gent.get("beta")
        expect(beta?.access).toBe(fake.tokens("beta").access)
        expect(beta?.refresh).toBe(fake.tokens("beta").refresh)
        expect(beta?.metadata).toEqual({ owner: "gent" })
        expect(statSync(join(store, ".slots/anthropic/beta")).mode & 0o777).toBe(0o600)
        // alpha is as gent left it.
        expect((await gent.get("alpha"))?.access).toBe(accounts.alpha.access)

        // No token in what OpenCode printed.
        for (const name of ["alpha", "beta"] as const) {
          for (const token of [accounts[name].access, accounts[name].refresh, fake.tokens(name).access, fake.tokens(name).refresh]) {
            expect(stdout + stderr).not.toContain(token)
          }
        }
      } finally {
        await fake.stop()
      }
    }),
    RUN_TIMEOUT_MS + 30_000,
  )
})
