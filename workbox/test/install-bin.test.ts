// workbox/install-bin.sh, run for real in a scratch HOME: it must replace each installed script with a new file,
// never rewrite the old one in place, since a running `sh` reads its script as it goes (a workrift create runs for
// minutes; 2026-11-22). `install` unlinks the target before it writes (GNU coreutils and the BSD install on macOS,
// both measured): the old file stays whole for the processes that have it open.
import { afterAll, expect, test } from "bun:test"
import { chmodSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repo = join(import.meta.dir, "..", "..")
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "install-bin-test-")))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

test("an installed script is replaced by a new file: a process that has the old one open reads the old one to its end", () => {
  const box = join(scratch, "workbox")
  const home = join(scratch, "home")
  mkdirSync(join(box, "bin"), { recursive: true })
  mkdirSync(join(home, ".local/bin"), { recursive: true })
  copyFileSync(join(repo, "workbox/install-bin.sh"), join(box, "install-bin.sh"))
  chmodSync(join(box, "install-bin.sh"), 0o755)
  const next = "#!/bin/sh\necho new\n"
  writeFileSync(join(box, "bin/workrift"), next)
  const installed = join(home, ".local/bin/workrift")
  const old = `#!/bin/sh\n${"echo old\n".repeat(200)}`
  writeFileSync(installed, old)
  const before = statSync(installed).ino
  // A running sh: it holds the script open, part read.
  const fd = openSync(installed, "r")
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const ran = Bun.spawnSync(["sh", join(box, "install-bin.sh")], { env: { PATH: process.env.PATH ?? "", HOME: home }, stdout: "pipe", stderr: "pipe" })
  expect(ran.exitCode, ran.stderr.toString()).toBe(0)
  const rest = Buffer.alloc(old.length)
  const got = readSync(fd, rest, 0, old.length, 0)
  closeSync(fd)
  expect(rest.subarray(0, got).toString()).toBe(old)
  expect(statSync(installed).ino).not.toBe(before)
  expect(readFileSync(installed, "utf8")).toBe(next)
  expect(statSync(installed).mode & 0o777).toBe(0o755)
})
