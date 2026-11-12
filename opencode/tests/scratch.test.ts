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
  "tests/pool-gent-opencode.test.ts",
  "tests/pool-gent-refresh.test.ts",
  "tests/pool-resets.test.ts",
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
