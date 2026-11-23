import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const helper = join(import.meta.dir, "../bin/workbox-run")
const run = (args: string[], cwd?: string) => {
  const result = Bun.spawnSync(["/bin/sh", helper, ...args], {
    cwd,
    env: { PATH: cwd ? `${cwd}:/usr/bin:/bin` : "/usr/bin:/bin", HB_EXPECT: "value with spaces" },
  })
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe("workbox-run", () => {
  test("rejects missing delimiters, unknown families, and unbounded memory requests", () => {
    for (const args of [[], ["project", "--", "true"], ["ergo", "echo"], ["ergo", "--memory-max", "0", "--", "true"], ["default", "--memory-max", "infinity", "--", "true"]]) {
      expect(run(args)).toMatchObject({ code: 2, out: "", err: expect.stringContaining("usage: workbox-run") })
    }
  })

  test("without systemd, says it skipped limits and preserves cwd, argv, environment, and status", () => {
    const prefix = join(realpathSync(tmpdir()), "workbox-run-")
    const cwd = mkdtempSync(prefix)
    try {
      const uname = join(cwd, "uname")
      writeFileSync(uname, "#!/bin/sh\nprintf 'Darwin\\n'\n")
      chmodSync(uname, 0o755)
      const result = run(["default", "--memory-max", "8M", "--", "/bin/sh", "-c", `printf '%s\\n' "$PWD" "$HB_EXPECT" "$1"; exit 27`, "fixture", "arg with spaces"], cwd)
      expect(result).toEqual({ code: 27, out: `${cwd}\nvalue with spaces\narg with spaces\n`, err: "workbox-run: systemd is absent; running without cgroup limits\n" })
    } finally {
      if (cwd.startsWith(prefix)) rmSync(cwd, { recursive: true })
    }
  })
})
