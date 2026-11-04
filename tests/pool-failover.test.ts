// Real OpenCode (the fork, from source) with two Anthropic logins, the
// Anthropic auth plugin and the pool, against the fake Anthropic API. The
// first login answers with a plan-limit 429; the run must finish on the
// second, and the fake must have seen exactly that. No real Anthropic call:
// the auth plugin sends every request to ANTHROPIC_BASE_URL, the fake.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { anthropicAuthPlugin, anthropicAuthSource, poolPlugin } from "../testbeds/anthropic-auth.ts"
import {
  fakeAccount,
  startFakeAnthropic,
  type FakeAnswer,
  type FakeAnthropic,
  type FakeRequestInfo,
} from "./fake-anthropic.ts"

const fork = process.env.OPENCODE_DEV
const auth = anthropicAuthSource()
const ready = Boolean(fork) && existsSync(join(auth, "src/index.ts"))
if (!ready) {
  console.warn(
    "tests/pool-failover.test.ts: skipped. Set OPENCODE_DEV to the fork, and clone the auth plugin fork " +
      `to ${auth} (or set OPENCODE_ANTHROPIC_AUTH).`,
  )
}

const HOUR = 3_600_000
const RUN_TIMEOUT_MS = 120_000

/** Agent turns on the first login meet a plan limit; titles, and everything on the second login, go through. */
const firstRefused =
  (resetAt: number) =>
  ({ account, body }: FakeRequestInfo): FakeAnswer => {
    const turn = Array.isArray(body.tools) && body.tools.length > 0
    if (turn && account === "first") return { kind: "usage-429", claim: "five_hour", resetAt }
    return { kind: "ok", text: turn ? "Hello from the second login." : "Greeting" }
  }

interface Run {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

describe.skipIf(!ready)("the pool fails a refused run over to the next login (real OpenCode, fake Anthropic)", () => {
  const root = mkdtempSync(join(tmpdir(), "pool-failover-"))
  let fake: FakeAnthropic | undefined
  afterAll(async () => {
    await fake?.stop()
    rmSync(root, { recursive: true, force: true })
  })

  const runOpenCode = async (
    name: string,
    accounts: Record<string, ReturnType<typeof fakeAccount>>,
    url: string,
    pooled: boolean,
  ): Promise<Run> => {
    const base = join(root, name)
    for (const dir of ["work", "home", "config", "plugins"]) mkdirSync(join(base, dir), { recursive: true })
    const launch = forkLaunch(fork!, process.execPath)
    writeFileSync(
      join(base, "work/opencode.json"),
      JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        plugins: [
          anthropicAuthPlugin(join(base, "plugins")),
          ...(pooled ? [{ package: poolPlugin, options: { sweepMinutes: 0 } }] : []),
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
      ANTHROPIC_BASE_URL: url,
      ...launch.env,
    }
    // The logins go in on stdin, never in argv or a file.
    const logins = Object.entries(accounts).map(([name, account], index) => ({
      id: `cred_${name}`,
      integrationID: "anthropic",
      label: `Anthropic ${index + 1}`,
      active: index === 0,
      value: {
        type: "oauth",
        methodID: "claude-max",
        refresh: account.refresh,
        access: account.access,
        expires: Date.now() + 8 * HOUR,
      },
    }))
    const imported = Bun.spawnSync([...launch.base, "auth", "import", "--standalone"], {
      cwd: join(base, "work"),
      env,
      stdin: new TextEncoder().encode(JSON.stringify(logins)),
    })
    expect(imported.exitCode).toBe(0)
    const run = Bun.spawn(
      [...launch.base, "run", "--standalone", "--dangerously-skip-permissions", "--format", "json", "say hello"],
      { cwd: join(base, "work"), env, stdout: "pipe", stderr: "pipe" },
    )
    const timer = setTimeout(() => run.kill(), RUN_TIMEOUT_MS)
    const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])
    await run.exited
    clearTimeout(timer)
    return { exitCode: run.exitCode, stdout, stderr }
  }

  test(
    "without the pool, the same refusal ends the run: the host does not retry a plan limit",
    async () => {
      const accounts = { first: fakeAccount(), second: fakeAccount() }
      const control = startFakeAnthropic({ accounts, script: firstRefused(Date.now() + 3 * HOUR) })
      try {
        const run = await runOpenCode("control", accounts, control.url, false)
        const turns = control.received.filter((request) => request.path === "/v1/messages" && request.tools > 0)
        expect(run.stdout).not.toContain("Hello from the second login.")
        expect(turns.map((request) => [request.account, request.status])).toEqual([["first", 429]])
      } finally {
        await control.stop()
      }
    },
    RUN_TIMEOUT_MS + 30_000,
  )

  test(
    "the first login's plan-limit 429 holds it, and the run goes out on the second",
    async () => {
      const accounts = { first: fakeAccount(), second: fakeAccount() }
      const resetAt = Date.now() + 3 * HOUR
      fake = startFakeAnthropic({ accounts, script: firstRefused(resetAt) })
      const run = await runOpenCode("pooled", accounts, fake.url, true)
      const messages = fake.received.filter((request) => request.path === "/v1/messages")
      const turns = messages.filter((request) => request.tools > 0)

      expect(run.exitCode).toBe(0)
      expect(run.stdout).toContain("Hello from the second login.")
      // The agent turn went out on the first login, was refused, and went again at once on the second.
      expect(turns.map((request) => [request.account, request.status])).toEqual([
        ["first", 429],
        ["second", 200],
      ])
      expect(turns[1]!.at - turns[0]!.at).toBeLessThan(2_000)
      // Nothing went out unsigned, nothing on a stranger's token.
      expect(messages.every((request) => request.account !== undefined)).toBe(true)
      // The credential choice never reached Anthropic.
      expect(messages.flatMap((request) => request.opencodeHeaders)).not.toContain("x-opencode-credential-id")
      // The wire extras: Haiku's beta set and the session header.
      for (const request of messages) {
        expect(request.betas).toContain("oauth-2025-04-20")
        expect(request.betas).not.toContain("interleaved-thinking-2025-05-14")
        expect(request.sessionHeader).toMatch(/^[0-9a-f-]{36}$/)
      }
      // No token in what OpenCode printed.
      for (const account of Object.values(accounts)) {
        expect(run.stdout + run.stderr).not.toContain(account.access)
        expect(run.stdout + run.stderr).not.toContain(account.refresh)
      }
    },
    RUN_TIMEOUT_MS + 30_000,
  )
})
