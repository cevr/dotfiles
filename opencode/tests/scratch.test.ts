import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { owned } from "./owned.ts"
import { scratch } from "./scratch.ts"

/**
 * The suites that made a temp directory and left it behind, run without OPENCODE_DEV (so the
 * OpenCode e2e suites skip, as in the gate), each from the opencode directory.
 */
const SUITES = [
  "cmd/kernel/server.test.ts",
  "cmd/pool/server.test.ts",
  "mods/kernel/filestore/files.test.ts",
  "mods/kernel/worker/workers.test.ts",
  "mods/pool/opencode/limits.test.ts",
  "mods/pool/ssh/peers.test.ts",
  "mods/wake/cron/backstop.test.ts",
  "scripts/cache-audit.test.ts",
  "scripts/daily.test.ts",
  "scripts/migrate-schedules.test.ts",
  "tests/dock-reconnect.test.ts",
  "tests/mail-peer.test.ts",
  "tests/mail-start.test.ts",
  "tests/pool-failover.test.ts",
  "tests/pool-fleet.test.ts",
  "tests/pool-resets.test.ts",
  "tests/pool-store-opencode.test.ts",
  "tests/pool-store-refresh.test.ts",
  "tests/pool-store.test.ts",
  "tests/reconnect-session.test.ts",
  "tests/update-badge.test.ts",
]

/** How long the suites get together, well past their usual 20 seconds. */
const SUITES_MS = 240_000

describe("a scratch directory", () => {
  test("is there while its block runs and gone once it ends", () => {
    const made: Array<string> = []
    {
      using dir = scratch("scratch-block-")
      made.push(dir.path)
      expect(existsSync(dir.path)).toBe(true)
    }
    expect(made.map(existsSync)).toEqual([false])
  })

  test(
    "the suites that make one leave none behind in the temp directory",
    async () => {
      using tmp = scratch("scratch-guard-")
      const before = readdirSync(tmp.path)
      const child = owned([process.execPath, "test", ...SUITES.map((suite) => `./${suite}`)], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, OPENCODE_DEV: "", TMPDIR: tmp.path },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      })
      const stderr = await new Response(child.stderr).text()
      const code = await child.exited
      expect({ code, ran: stderr.match(/Ran \d+ tests across \d+ files/)?.[0] }).toEqual({ code: 0, ran: expect.stringContaining(`across ${SUITES.length} files`) })
      expect(readdirSync(tmp.path)).toEqual(before)
    },
    SUITES_MS,
  )
})

/**
 * Runs the kept-directory cases in a child `bun test` with `tmp` as its TMPDIR, then reads what it
 * left there and its report. tests/scratch-cases.ts has no `.test.` in its name, so only this run
 * picks it up.
 */
const runCases = async (tmp: string, ...args: ReadonlyArray<string>) => {
  const child = owned([process.execPath, "test", "./tests/scratch-cases.ts", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, TMPDIR: tmp },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  const output = await new Response(child.stderr).text()
  return { code: await child.exited, output, left: readdirSync(tmp) }
}

/** How long a child run of the cases gets: they hang for 50 ms at most. */
const CASES_MS = 60_000

/** The cases that fail, by the full names Bun reports: a test, a setup, a timeout or a late setup each. */
const FAILING_CASES = [
  "failing > first",
  "setup-failing > setup",
  "timing-out > hangs",
  "setup-timing-out > setup",
  "closing-after-timeout > hangs",
  "late-writer > hangs then writes",
  "closing-after-late-setup > setup",
]

describe("an e2e suite's directory", () => {
  test(
    "goes at the suite's end whether the suite passed, failed, or ran out of time, and no output names it as kept",
    async () => {
      using tmp = scratch("scratch-cases-")
      const { code, output, left } = await runCases(tmp.path)
      const failed = FAILING_CASES.filter((name) => output.includes(`(fail) ${name}`))
      expect({ code, failed, left, namedKept: /kept: |kept the failed/.test(output) }).toEqual({ code: 1, failed: FAILING_CASES, left: [], namedKept: false })
    },
    CASES_MS,
  )

  test(
    "goes when a -t filter runs only some of a passing suite's tests",
    async () => {
      using tmp = scratch("scratch-cases-")
      const { code, output, left } = await runCases(tmp.path, "-t", "^passing first$")
      expect({ code, passed: output.match(/(\d+) pass/)?.[1], left }).toEqual({ code: 0, passed: "1", left: [] })
    },
    CASES_MS,
  )

  test.skipIf(!process.env.OPENCODE_DEV)(
    "reconnect-session makes none when a -t filter runs none of its tests, with an old TUI binary to copy",
    async () => {
      using tmp = scratch("scratch-reconnect-")
      const child = owned([process.execPath, "test", "./tests/reconnect-session.test.ts", "-t", "^no test is named this$"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, TMPDIR: tmp.path, OPENCODE_RECONNECT_TUI_BINARY: fileURLToPath(import.meta.url) },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      })
      const output = await new Response(child.stderr).text()
      await child.exited
      expect({ collected: /skipping [1-9]\d* tests/.test(output), left: readdirSync(tmp.path) }).toEqual({ collected: true, left: [] })
    },
    CASES_MS,
  )
})
