// workbox/install-bin.sh, as the fleet update runs it from the installed build's tree (`current.plugins/workbox/`)
// once a build is proven: it installs that tree's commands and shell files, so the workbox's ~/.zshenv and
// ~/.zshrc are the verified build's, whatever the live checkout holds. It runs here in a scratch HOME on a
// copy of the script in a scratch tree; nothing touches the real host.
import { afterAll, describe, expect, test } from "bun:test"
import { closeSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const scratch = mkdtempSync(join(tmpdir(), "install-bin-test-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let n = 0
/** A scratch tree's workbox/ (the script, a command, both shell files) and a scratch HOME. */
const host = (zshenv = "export FROM=tree\n") => {
  const root = join(scratch, `host-${n++}`)
  const workbox = join(root, "tree", "workbox")
  const home = join(root, "home")
  mkdirSync(join(workbox, "bin"), { recursive: true })
  mkdirSync(home, { recursive: true })
  copyFileSync(join(import.meta.dir, "..", "install-bin.sh"), join(workbox, "install-bin.sh"))
  writeFileSync(join(workbox, "bin", "workrift"), "#!/bin/sh\necho tree\n")
  writeFileSync(join(workbox, "zshenv"), zshenv)
  writeFileSync(join(workbox, "zshrc"), "alias from=tree\n")
  return { workbox, home, installed: join(home, ".local", "share", "workbox") }
}

const run = (workbox: string, home: string) => {
  const done = Bun.spawnSync(["sh", join(workbox, "install-bin.sh")], {
    cwd: home,
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: done.exitCode, stderr: done.stderr.toString() }
}

/** Where ~/<name> points, or "file" when it is no link. */
const pointer = (home: string, name: string) => (lstatSync(join(home, name)).isSymbolicLink() ? readlinkSync(join(home, name)) : "file")

describe("install-bin.sh delivers the tree's shell files", () => {
  test("a ~/.zshenv linked into a stale checkout is pointed at the tree's copy, installed beside the commands; twice alike", () => {
    const { workbox, home, installed } = host()
    writeFileSync(join(home, "stale-zshenv"), "export FROM=checkout\n")
    symlinkSync(join(home, "stale-zshenv"), join(home, ".zshenv"))
    symlinkSync(join(home, "stale-zshrc"), join(home, ".zshrc"))
    for (const _ of [1, 2]) {
      expect(run(workbox, home)).toEqual({ code: 0, stderr: "" })
      expect(pointer(home, ".zshenv")).toBe(join(installed, "zshenv"))
      expect(pointer(home, ".zshrc")).toBe(join(installed, "zshrc"))
      expect(readFileSync(join(home, ".zshenv"), "utf8")).toBe("export FROM=tree\n")
      expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("alias from=tree\n")
      expect(readFileSync(join(home, ".local", "bin", "workrift"), "utf8")).toBe("#!/bin/sh\necho tree\n")
    }
    // The stale checkout's file is left as it was.
    expect(readFileSync(join(home, "stale-zshenv"), "utf8")).toBe("export FROM=checkout\n")
  })

  test("a later tree replaces the installed copy by rename (a new file, never a write into the one a shell reads)", () => {
    const { workbox, home, installed } = host("export FROM=first\n")
    expect(run(workbox, home).code).toBe(0)
    const held = lstatSync(join(installed, "zshenv")).ino
    writeFileSync(join(workbox, "zshenv"), "export FROM=second\n")
    expect(run(workbox, home).code).toBe(0)
    expect(readFileSync(join(home, ".zshenv"), "utf8")).toBe("export FROM=second\n")
    expect(lstatSync(join(installed, "zshenv")).ino).not.toBe(held)
  })

  test("an installed command is replaced by a new file: a process that has the old one open (a running sh) reads the old one to its end", () => {
    // A workrift create runs for minutes and sh reads its script as it goes; `install` unlinks its target before it
    // writes (GNU coreutils and the BSD install on macOS, measured: a new inode each, 2026-11-22).
    const { workbox, home } = host()
    const installed = join(home, ".local", "bin", "workrift")
    mkdirSync(join(home, ".local", "bin"), { recursive: true })
    const old = `#!/bin/sh\n${"echo old\n".repeat(200)}`
    writeFileSync(installed, old)
    const before = statSync(installed).ino
    const fd = openSync(installed, "r")
    readSync(fd, Buffer.alloc(16), 0, 16, 0)
    expect(run(workbox, home).code).toBe(0)
    const rest = Buffer.alloc(old.length)
    const got = readSync(fd, rest, 0, old.length, 0)
    closeSync(fd)
    expect(rest.subarray(0, got).toString()).toBe(old)
    expect(statSync(installed).ino).not.toBe(before)
    expect(readFileSync(installed, "utf8")).toBe("#!/bin/sh\necho tree\n")
    expect(statSync(installed).mode & 0o777).toBe(0o755)
  })

  test("with no link there yet, it makes them", () => {
    const { workbox, home, installed } = host()
    expect(run(workbox, home)).toEqual({ code: 0, stderr: "" })
    expect(pointer(home, ".zshenv")).toBe(join(installed, "zshenv"))
    expect(pointer(home, ".zshrc")).toBe(join(installed, "zshrc"))
  })

  test("a real ~/.zshrc (no link) is left alone, and the script says so", () => {
    const { workbox, home, installed } = host()
    writeFileSync(join(home, ".zshrc"), "# the owner's own\n")
    const done = run(workbox, home)
    expect(done.code).toBe(0)
    expect(done.stderr).toBe(`install-bin: ${home}/.zshrc is a file, not a link; left as it is (the installed copy is ${installed}/zshrc)\n`)
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# the owner's own\n")
    expect(pointer(home, ".zshenv")).toBe(join(installed, "zshenv"))
  })
})
