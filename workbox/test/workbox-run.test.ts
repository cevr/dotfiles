import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readInputText } from "../../opencode/tests/read-path.ts"
import { spawnScratchShellFileSync, writeScratchScript } from "../../opencode/tests/scratch-child.ts"

const run = (args: string[], cwd: string) => {
  const helper = writeScratchScript(join(cwd, "workbox-run"), readInputText("../workbox/bin/workbox-run"))
  const tools = join(cwd, "bin")
  mkdirSync(tools, { recursive: true })
  const result = spawnScratchShellFileSync(helper, args, { cwd, tools, paths: {}, values: { HB_EXPECT: "value with spaces" } })
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe("workbox-run", () => {
  test("rejects missing delimiters, unknown families, and unbounded memory requests", () => {
    const prefix = join(realpathSync(tmpdir()), "workbox-run-")
    const cwd = mkdtempSync(prefix)
    try {
      for (const args of [[], ["project", "--", "true"], ["ergo", "echo"], ["ergo", "--memory-max", "0", "--", "true"], ["default", "--memory-max", "infinity", "--", "true"]]) {
        expect(run(args, cwd)).toMatchObject({ code: 2, out: "", err: expect.stringContaining("usage: workbox-run") })
      }
    } finally {
      if (cwd.startsWith(prefix)) rmSync(cwd, { recursive: true })
    }
  })

  test("without systemd, says it skipped limits and preserves cwd, argv, environment, and status", () => {
    const prefix = join(realpathSync(tmpdir()), "workbox-run-")
    const cwd = mkdtempSync(prefix)
    try {
      const tools = join(cwd, "bin")
      mkdirSync(tools)
      const uname = join(tools, "uname")
      writeFileSync(uname, "#!/bin/sh\nprintf 'Darwin\\n'\n")
      chmodSync(uname, 0o755)
      const fixture = writeScratchScript(join(cwd, "fixture"), `#!/bin/sh\nprintf '%s\\n' "$PWD" "$HB_EXPECT" "$1"; exit 27\n`)
      chmodSync(fixture, 0o755)
      const result = run(["default", "--memory-max", "8M", "--", fixture, "arg with spaces"], cwd)
      expect(result).toEqual({ code: 27, out: `${cwd}\nvalue with spaces\narg with spaces\n`, err: "workbox-run: systemd is absent; running without cgroup limits\n" })
    } finally {
      if (cwd.startsWith(prefix)) rmSync(cwd, { recursive: true })
    }
  })
})
