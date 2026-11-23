// claude/bin/claude-daily-install, run each day by workbox/systemd/user/claude-daily.timer and on the Mac by
// mac/launchd/com.cvr.claude-daily.plist. It runs here against a stand-in `claude` in a scratch HOME; nothing
// touches the real host's Claude Code.
// @reads ../claude/bin/claude-daily-install
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { matchingInput } from "../../opencode/tests/read-path.ts"

const script = matchingInput("../claude/bin/claude-daily-install")
const root = mkdtempSync(join(tmpdir(), "claude-daily-test-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let count = 0
/**
 * Runs the job in a fresh HOME whose `claude` exits `installExit` for `install` and prints `version` for
 * `--version`, after a release `recorded` was written by an earlier run. Answers the exit code, the recorded
 * release and the log.
 */
const run = (version: string, installExit: number, recorded?: string) => {
  const home = join(root, `home-${++count}`)
  const bin = join(home, ".local", "bin")
  mkdirSync(bin, { recursive: true })
  const claude = join(bin, "claude")
  writeFileSync(
    claude,
    `#!/bin/sh\ncase "$1" in\ninstall) echo "installing $2"; exit ${installExit} ;;\n--version) printf '%s\\n' '${version}' ;;\nesac\n`,
  )
  chmodSync(claude, 0o755)
  const state = join(home, ".local", "state", "claude-daily")
  if (recorded !== undefined) {
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, "version"), recorded)
  }
  const done = Bun.spawnSync(["/bin/sh", script], { env: { HOME: home, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" })
  const versionFile = join(state, "version")
  return {
    exit: done.exitCode,
    output: done.stdout.toString() + done.stderr.toString(),
    recorded: existsSync(versionFile) ? readFileSync(versionFile, "utf8") : undefined,
    log: readFileSync(join(state, "install.log"), "utf8"),
  }
}

describe("the daily Claude Code install", () => {
  test("installs the latest release, records it and logs to ~/.local/state, printing nothing", () => {
    const done = run("2.1.400 (Claude Code)", 0)
    expect([done.exit, done.output, done.recorded]).toEqual([0, "", "2.1.400\n"])
    expect(done.log).toContain("installing latest\ninstall exit 0\ninstalled release 2.1.400\n")
  })

  test("a failed install exits with its status and still records the release in place", () => {
    const done = run("2.1.318 (Claude Code)", 3, "2.1.300\n")
    expect([done.exit, done.recorded]).toEqual([3, "2.1.318\n"])
    expect(done.log).toContain("install exit 3\n")
  })

  test("a version that is not major.minor.patch leaves the recorded release as it was", () => {
    for (const version of ["", "2.1 (Claude Code)", "02.1.400", "2.1.400.1", "v2.1.400", "2.1.400-beta (Claude Code)"]) {
      const done = run(version, 0, "2.1.318\n")
      expect([version, done.recorded]).toEqual([version, "2.1.318\n"])
      expect(done.log).toContain("the recorded one stays\n")
    }
  })
})
