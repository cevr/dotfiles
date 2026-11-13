// accept: one at a time (it bounds the gap between the failed turn and its retry).
// Real OpenCode (the fork, from source) with two Anthropic logins, the
// Anthropic auth plugin and the pool, against the fake Anthropic API. The
// first login answers with a plan-limit 429; the run must finish on the
// second, and the fake must have seen exactly that. No real Anthropic call:
// the auth plugin sends every request to ANTHROPIC_BASE_URL, the fake.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DateTime, Option, Schema } from "effect"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { anthropicAuthPlugin, poolPlugin } from "../testbeds/anthropic-auth.ts"
import {
  fakeAccount,
  startFakeAnthropic,
  type FakeAnswer,
  type FakeAnthropic,
  type FakeRequestInfo,
} from "./fake-anthropic.ts"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
const ready = Boolean(fork)
if (!ready) {
  console.warn(
    "tests/pool-failover.test.ts: skipped. Set OPENCODE_DEV to the fork.",
  )
}

const HOUR = 3_600_000

/** A line of `opencode run --format json` that ends the run on an error, with its message. */
const decodeEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String, error: Schema.Struct({ message: Schema.String }) })),
)
/** The pool's own refusal: every account held, and when the first opens. */
const POOL_REFUSAL = /^dotfiles-opencode\.pool: all pool accounts are held; the first opens at (\S+Z)$/
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
  const kept = keptScratch(ready, "pool-failover-", true)
  // Every fake a test starts, stopped once the file is done.
  const fakes: Array<FakeAnthropic> = []
  const started = (options: Parameters<typeof startFakeAnthropic>[0]) => {
    const fake = startFakeAnthropic(options)
    fakes.push(fake)
    return fake
  }
  afterAll(async () => {
    for (const fake of fakes) await fake.stop()
    kept.done()
  })

  const runOpenCode = async (
    name: string,
    accounts: Record<string, ReturnType<typeof fakeAccount>>,
    url: string,
    pooled: boolean,
  ): Promise<Run> => {
    const base = kept.dir(`${name}-`)
    for (const dir of ["work", "home", "config", "plugins"]) mkdirSync(join(base, dir))
    const launch = forkLaunch(fork!, process.execPath)
    writeFileSync(
      join(base, "work/opencode.json"),
      JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        plugins: [
          anthropicAuthPlugin,
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
    const run = owned(
      [...launch.base, "run", "--standalone", "--dangerously-skip-permissions", "--format", "json", "say hello"],
      { cwd: join(base, "work"), env, stdout: "pipe", stderr: "pipe" },
    )
    const timer = setTimeout(() => run.kill(), RUN_TIMEOUT_MS)
    const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    clearTimeout(timer)
    return { exitCode: run.exitCode, stdout, stderr }
  }

  test(
    "without the pool, the same refusal ends the run: the host does not retry a plan limit",
    kept.test(async () => {
      const accounts = { first: fakeAccount(), second: fakeAccount() }
      const control = started({ accounts, script: firstRefused(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3 * HOUR) })
      const run = await runOpenCode("control", accounts, control.url, false)
      const turns = control.received.filter((request) => request.path === "/v1/messages" && request.tools > 0)
      expect(run.stdout).not.toContain("Hello from the second login.")
      expect(turns.map((request) => [request.account, request.status])).toEqual([["first", 429]])
    }),
    RUN_TIMEOUT_MS + 30_000,
  )

  test(
    "the first login's plan-limit 429 holds it, and the run goes out on the second",
    kept.test(async () => {
      const accounts = { first: fakeAccount(), second: fakeAccount() }
      const resetAt = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3 * HOUR
      const fake = started({ accounts, script: firstRefused(resetAt) })
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
    }),
    RUN_TIMEOUT_MS + 30_000,
  )

  test(
    "with both logins spent, the run ends on the pool's own refusal and when the first opens, never sent on a spent login again",
    kept.test(async () => {
      const accounts = { first: fakeAccount(), second: fakeAccount() }
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe())
      // The second login resets first.
      const spent = started({
        accounts,
        script: ({ account, body }) => {
          if (!Array.isArray(body.tools) || body.tools.length === 0) return { kind: "ok", text: "Greeting" }
          if (account === "second") return { kind: "usage-429", claim: "five_hour", resetAt: now + HOUR }
          return { kind: "usage-429", claim: "five_hour", resetAt: now + 3 * HOUR }
        },
      })
      const run = await runOpenCode("spent", accounts, spent.url, true)
      const turns = spent.received.filter((request) => request.path === "/v1/messages" && request.tools > 0)
      // Each login was refused once, and nothing went out on it again before its reset.
      expect(turns.map((request) => [request.account, request.status])).toEqual([
        ["first", 429],
        ["second", 429],
      ])
      // The turn ends on the pool's words and a time to try again: the second login's reset, the soonest. Never on
      // the provider's refusal (the retries between carry it; the turn's end does not).
      const ends = run.stdout
        .split("\n")
        .flatMap((line) => Option.toArray(decodeEvent(line)))
        .filter((event) => event.type === "error")
        .map((event) => event.error.message)
      expect(ends, run.stdout.slice(-2_000)).toHaveLength(1)
      const opens = Option.flatMap(Option.fromNullishOr(POOL_REFUSAL.exec(ends.join(""))?.[1]), DateTime.make)
      expect(Option.isSome(opens), ends.join("")).toBe(true)
      expect(Math.abs(Option.getOrElse(Option.map(opens, DateTime.toEpochMillis), () => 0) - (now + HOUR))).toBeLessThan(5_000)
    }),
    RUN_TIMEOUT_MS + 30_000,
  )
})
