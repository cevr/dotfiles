// accept: one at a time (an owned child must run and clean up within twenty seconds).
import { describe, expect, test } from "bun:test"
import { Array as Arr } from "effect"
import { existsSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { owned, released } from "./owned.ts"
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

/**
 * How long each of the suites' tests may take in the child run. Without `--timeout` Bun gives a test
 * 5 seconds, a budget `bun run test` and the gate never hold the suites to (they pass 300 seconds);
 * under a 300 load a test past it failed this check with no folder left (batch av). A minute still
 * lets a hung test end inside SUITES_MS, so the run's report names it.
 */
const SUITE_TEST_MS = 60_000

/**
 * What a child `bun test` run reports: its exit code, its "Ran … tests across … files" line, and
 * each failure as `<file> > <test> | <its error lines>`, so a red check on the run names the inner
 * test that failed and why. Bun prints, under the header of the file it runs:
 * - a failed test's error before its `(fail)` line, from `error:` (or `SomeError:`) to the first stack line;
 * - a timeout after it, as `^ this test timed out after …`;
 * - an error outside any test under `# Unhandled error between tests`, reported as `(between tests)`.
 */
const childReport = (code: number, output: string) => {
  const failed: Array<string> = []
  const context = { file: "", block: new Array<string>(), unhandled: false }
  const errorLine = (line: string) => /^(error:|\w*Error\b|[A-Z]{3,}:)/.test(line.trim())
  const report = (name: string, lines: ReadonlyArray<string>) =>
    failed.push([`${context.file} > ${name}`, ...lines.flatMap((each) => each.trim() || [])].join(" | "))
  for (const line of output.split("\n")) {
    const header = /^\S+\.[jt]sx?:$/.test(line)
    const fail = line.startsWith("(fail) ")
    if (header) context.file = line.slice(0, -1)
    if (fail) {
      const error = Arr.takeWhile(Arr.dropWhile(context.block, (each) => !errorLine(each)), (each) => !/^\s+at /.test(each))
      report(line.slice("(fail) ".length).replace(/ \[[\d.]+m?s\]$/, ""), error)
    }
    if (/^\s*\^ this test timed out/.test(line)) failed[failed.length - 1] += ` | ${line.trim()}`
    if (context.unhandled && errorLine(line)) report("(between tests)", [line])
    if (context.unhandled && errorLine(line)) context.unhandled = false
    if (line.startsWith("# Unhandled error between tests")) context.unhandled = true
    context.block = [...context.block, line]
    if (header || fail || /^\((pass|skip|todo)\) /.test(line)) context.block = []
  }
  return { code, ran: output.split("\n").find((line) => /^Ran \d+ tests? across \d+ files?/.test(line)), failed }
}

/** Checks that a child run over `files` test files passed: a red one names each failure and its error. */
const expectPassed = (code: number, output: string, files: number) =>
  expect(childReport(code, output)).toEqual({ code: 0, ran: expect.stringContaining(`across ${files} file`), failed: [] })

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
      const child = owned([process.execPath, "test", "--timeout", String(SUITE_TEST_MS), ...SUITES.map((suite) => `./${suite}`)], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, OPENCODE_DEV: "", TMPDIR: tmp.path },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      })
      const stderr = await new Response(child.stderr).text()
      const code = await child.exited
      expectPassed(code, stderr, SUITES.length)
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

/** A child that makes the folders opencode-drive and OpenCode leave under TMPDIR, and prints its TMPDIR. */
const MAKES_TEMP = ["/bin/sh", "-c", 'mkdir -p "$TMPDIR/opencode-drive/run-x" "$TMPDIR/opencode" && printf %s "$TMPDIR"']

/** How long an owned child's run and cleanup may take: nothing it started is left to stop. */
const RELEASE_MS = 20_000

describe("an owned child's TMPDIR", () => {
  test(
    "is a folder of its own, removed with what opencode-drive and OpenCode made there once the child has stopped",
    async () => {
      const child = owned(MAKES_TEMP, { stdout: "pipe", stderr: "ignore" })
      const temp = await new Response(child.stdout).text()
      const code = await child.exited
      const made = existsSync(join(temp, "opencode-drive"))
      await released(child.pid)
      expect({ code, own: basename(temp).startsWith("child-"), made, gone: !existsSync(temp) }).toEqual({ code: 0, own: true, made: true, gone: true })
    },
    RELEASE_MS,
  )

  test(
    "is the one the test chose for it, kept as it is",
    async () => {
      using chosen = scratch("scratch-chosen-")
      const child = owned(MAKES_TEMP, { env: { ...process.env, TMPDIR: chosen.path }, stdout: "pipe", stderr: "ignore" })
      const temp = await new Response(child.stdout).text()
      const code = await child.exited
      expect({ code, temp, made: existsSync(join(chosen.path, "opencode")) }).toEqual({ code: 0, temp: chosen.path, made: true })
    },
    RELEASE_MS,
  )
})

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
    "a red child run names each failing test, its error, a timeout and an error between tests",
    async () => {
      using tmp = scratch("scratch-cases-")
      const { code, output } = await runCases(tmp.path)
      const check = () => expectPassed(code, output, 1)
      expect(check).toThrow(/tests\/scratch-cases\.ts > failing > first \| error: expect\(received\)\.toBe\(expected\) \| Expected: \\?"removed\\?" \| Received: \\?"kept\\?"/)
      expect(check).toThrow(/tests\/scratch-cases\.ts > timing-out > hangs \| \^ this test timed out after 50ms/)
      expect(check).toThrow(/tests\/scratch-cases\.ts > \(between tests\) \| ENOENT: no such file or directory/)
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
