// workbox/install-bin.sh, as the fleet update runs it from the installed build's tree (`current.plugins/workbox/`)
// once a build is proven: it installs that tree's commands and shell files, so the workbox's ~/.zshenv and
// ~/.zshrc are the verified build's, whatever the live checkout holds. It runs here in a scratch HOME on a
// copy of the script in a scratch tree; nothing touches the real host. INSTALL_BIN_UNDER_TEST names another
// copy of the script to run (an older one, to see these cases red against it).
import { afterAll, describe, expect, test } from "bun:test"
import { closeSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hangGuard } from "../../opencode/tests/hang-guard.ts"

const scratch = mkdtempSync(join(tmpdir(), "install-bin-test-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const underTest = process.env.INSTALL_BIN_UNDER_TEST ?? join(import.meta.dir, "..", "install-bin.sh")
const workboxDir = join(import.meta.dir, "..")

let n = 0
/** A scratch tree's workbox/ holding the script and `files` (paths under workbox/), in a fresh root beside a scratch HOME. */
const tree = (root: string, label: string, files: Record<string, string>) => {
  const workbox = join(root, label, "workbox")
  mkdirSync(join(workbox, "bin"), { recursive: true })
  copyFileSync(underTest, join(workbox, "install-bin.sh"))
  copyFileSync(join(workboxDir, "host-identity.sh"), join(workbox, "host-identity.sh"))
  for (const [path, text] of Object.entries(files)) writeFileSync(join(workbox, path), text)
  return workbox
}

/** A scratch tree's workbox/ (the script, a command, both shell files) and a scratch HOME. */
const host = (zshenv = "export FROM=tree\n") => {
  const root = join(scratch, `host-${n++}`)
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  const workbox = tree(root, "tree", { "bin/workrift": "#!/bin/sh\necho tree\n", zshenv, zshrc: "alias from=tree\n" })
  return { root, workbox, home, installed: join(home, ".local", "share", "workbox") }
}

const identity = Bun.spawnSync(["sh", "-c", '. "$1"; workbox_host_identity', "test", join(workboxDir, "host-identity.sh")]).stdout.toString().trim()
const env = (home: string) => ({ HOME: home, PATH: "/usr/bin:/bin", TMPDIR: home, WORKBOX_EXPECT_MACHINE_ID: identity })

const run = (workbox: string, home: string) => {
  const done = Bun.spawnSync(["sh", join(workbox, "install-bin.sh")], { cwd: home, env: env(home), stdout: "pipe", stderr: "pipe" })
  return { code: done.exitCode, stderr: done.stderr.toString() }
}

/** Where ~/<name> points, or "file" when it is no link. */
const pointer = (home: string, name: string) => (lstatSync(join(home, name)).isSymbolicLink() ? readlinkSync(join(home, name)) : "file")

const hash = (path: string) => Bun.hash(readFileSync(path)).toString()

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

  test("a real ~/.zshrc (no link) is never overwritten: the script says what to do and exits 1, so the update logs it; the rest is installed", () => {
    const { workbox, home, installed } = host()
    writeFileSync(join(home, ".zshrc"), "# the owner's own\n")
    const done = run(workbox, home)
    expect(done.code).toBe(1)
    expect(done.stderr).toBe(
      `install-bin: ${home}/.zshrc is a file of its own, not the link to ${installed}/zshrc, so new shells do not read the installed zshrc. It was left as it is. To fix: move what you want to keep from it into ~/.config/secrets.env (sourced by zshenv), then \`mv ${home}/.zshrc ${home}/.zshrc.mine\`; the next install links it.\n`,
    )
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# the owner's own\n")
    expect(pointer(home, ".zshenv")).toBe(join(installed, "zshenv"))
    expect(readFileSync(join(home, ".local", "bin", "workrift"), "utf8")).toBe("#!/bin/sh\necho tree\n")
  })
})

describe("install-bin.sh refuses a file that would not run, before it replaces any", () => {
  /** Installs a good tree, then a tree with one bad file; answers what the second install said, and whether every installed file is still the first tree's. */
  const refusedOver = (bad: Record<string, string>) => {
    const { root, workbox, home, installed } = host()
    expect(run(workbox, home)).toEqual({ code: 0, stderr: "" })
    const watched = [join(home, ".local", "bin", "workrift"), join(installed, "zshenv"), join(installed, "zshrc")]
    const before = watched.map(hash)
    const next = tree(root, `bad-${n++}`, { "bin/workrift": "#!/bin/sh\necho next\n", zshenv: "export FROM=next\n", zshrc: "alias from=next\n", ...bad })
    const done = run(next, home)
    return { done, next, unchanged: watched.map(hash).every((each, at) => each === before[at]) }
  }

  test.each([
    ["a zshenv that does not parse", { zshenv: "export A=1\nif [[ ;\n" }, "zshenv", "zsh -n fails"],
    ["a zshrc that does not parse", { zshrc: "alias a=b\nif [[ ;\n" }, "zshrc", "zsh -n fails"],
    ["an sh command that does not parse", { "bin/workrift": "#!/bin/sh\nif then fi\n" }, "bin/workrift", "sh -n fails"],
    ["a bash command that does not parse", { "bin/trash": "#!/usr/bin/env bash\nif then fi\n" }, "bin/trash", "bash -n fails"],
  ])("%s: named, nothing replaced, exit 1", (_, bad, file, why) => {
    const { done, next, unchanged } = refusedOver(bad)
    expect(done.code).toBe(1)
    expect(done.stderr).toContain(`install-bin: refused ${next}/${file}: ${why}`)
    expect(done.stderr).toContain("install-bin: nothing was installed; every file stays as it was")
    expect(unchanged).toBe(true)
  })

  test("a zshenv that parses but makes every shell print (or fail) is refused the same way", () => {
    const { done, next, unchanged } = refusedOver({ zshenv: "echo hello from zshenv\n" })
    expect(done.code).toBe(1)
    expect(done.stderr).toContain(`install-bin: refused ${next}/zshenv: a zsh that reads it exits 0 and prints: hello from zshenv`)
    expect(unchanged).toBe(true)
  })

  test("the repository's own zshenv, zshrc and commands pass the checks", () => {
    const { home } = host()
    const done = Bun.spawnSync(["sh", join(workboxDir, "install-bin.sh")], { cwd: home, env: env(home), stdout: "pipe", stderr: "pipe" })
    expect({ code: done.exitCode, stderr: done.stderr.toString() }).toEqual({ code: 0, stderr: "" })
  })
})

// Hold each install at its open-for-write boundary. Across 20 installs a reader sees only complete old or new files
// while the writer's destination is empty. GNU `install` alone can unlink a live target before writing it.
describe("install-bin.sh replaces each file whole", () => {
  test(
    "across 20 installs every installed command and shell file is always the old or the new one, whole",
    async () => {
      const root = join(scratch, `atomic-${n++}`)
      const home = join(root, "home")
      mkdirSync(home, { recursive: true })
      const names = Array.from({ length: 10 }, (_, at) => `cmd-${at}`)
      const big = (label: string, name: string) => `#!/bin/sh\n${`# ${label} ${name} ${"x".repeat(100)}\n`.repeat(800)}echo ${label}\n`
      const files = (label: string) => ({
        ...Object.fromEntries(names.map((name) => [`bin/${name}`, big(label, name)])),
        zshenv: `export FROM=${label}\n${`# ${"z".repeat(100)}\n`.repeat(800)}`,
        zshrc: `alias from=${label}\n${`# ${"r".repeat(100)}\n`.repeat(800)}`,
      })
      const trees = [tree(root, "a", files("a")), tree(root, "b", files("b"))]
      const watched = [...names.map((name) => join(home, ".local", "bin", name)), join(home, ".zshenv"), join(home, ".zshrc")]
      const allowed = new Set<string>()
      for (const workbox of trees) {
        expect(run(workbox, home)).toEqual({ code: 0, stderr: "" })
        for (const path of watched) allowed.add(hash(path))
      }
      // The `install` GNU coreutils has (the workbox's): it unlinks the target, then writes it. The Mac's BSD
      // `install` writes a temporary file and renames it, so there the script's own care cannot show.
      const gnu = join(root, "gnu-bin")
      mkdirSync(gnu, { recursive: true })
      writeFileSync(
        join(gnu, "install"),
        `#!/bin/sh\nmode=644\nif [ "$1" = -m ]; then mode=$2; shift 2; fi\nrm -f "$2"\n: >"$2"\nprintf 'opened\\n'\nread release || exit 1\ncat "$1" >"$2"\nchmod "$mode" "$2"\n`,
        { mode: 0o755 },
      )
      const gnuEnv = { ...env(home), PATH: `${gnu}:/usr/bin:/bin` }
      const seen = { reads: 0, missing: 0, empty: 0, partial: 0 }
      for (let at = 0; at < 20; at++) {
        const install = Bun.spawn(["sh", join(trees[at % 2]!, "install-bin.sh")], { cwd: home, env: gnuEnv, stdin: "pipe", stdout: "pipe", stderr: "inherit" })
        let carry = ""
        let checkpoints = 0
        try {
          for await (const chunk of install.stdout.pipeThrough(new TextDecoderStream())) {
            carry += chunk
            const newline = carry.indexOf("\n")
            if (newline < 0) continue
            expect(carry.slice(0, newline)).toBe("opened")
            carry = carry.slice(newline + 1)
            checkpoints++
            for (const path of watched) {
              seen.reads++
              try {
                const bytes = readFileSync(path)
                if (bytes.length === 0) seen.empty++
                else if (!allowed.has(Bun.hash(bytes).toString())) seen.partial++
              } catch {
                seen.missing++
              }
            }
            install.stdin.write("go\n")
            install.stdin.flush()
          }
          expect(await install.exited).toBe(0)
          expect(checkpoints).toBe(watched.length)
        } finally {
          install.stdin.end()
        }
      }
      expect(seen).toEqual({ reads: 20 * watched.length ** 2, missing: 0, empty: 0, partial: 0 })
    },
    hangGuard("installer"),
  )
})

// The health check a person runs is the installed build's (`workbox-check`, installed by install-bin.sh),
// never the live checkout's copy of bootstrap.sh, which mirrors the Mac's base and can lag.
describe("workbox-check runs the installed tree's bootstrap.sh --check", () => {
  const check = join(workboxDir, "bin", "workbox-check")

  test("it runs the tree's copy with --check, and says so when the tree has none", () => {
    const home = join(scratch, `check-${n++}`)
    const box = join(home, ".local", "share", "opencode-prime", "current.plugins", "workbox")
    mkdirSync(home, { recursive: true })
    const none = Bun.spawnSync(["sh", check], { env: env(home), stdout: "pipe", stderr: "pipe" })
    expect({ code: none.exitCode, stderr: none.stderr.toString() }).toEqual({
      code: 1,
      stderr: `workbox-check: ${box}/bootstrap.sh is not there: the installed build holds no workbox/ yet (the next install brings it)\n`,
    })
    mkdirSync(box, { recursive: true })
    writeFileSync(join(box, "bootstrap.sh"), `printf 'tree bootstrap %s\\n' "$*"\n`)
    const ran = Bun.spawnSync(["sh", check], { env: env(home), stdout: "pipe", stderr: "pipe" })
    expect({ code: ran.exitCode, stdout: ran.stdout.toString() }).toEqual({ code: 0, stdout: "tree bootstrap --check\n" })
  })

  test("the README and the runbook name workbox-check, never the checkout's bootstrap.sh --check", () => {
    for (const doc of [join(workboxDir, "README.md"), join(workboxDir, "..", "linux", "hetzner-workbox", "RUNBOOK.md")]) {
      const text = readFileSync(doc, "utf8")
      expect({ doc, mirror: /dotfiles\/workbox\/bootstrap\.sh --check/.test(text), check: text.includes("workbox-check") }).toEqual({ doc, mirror: false, check: true })
    }
  })
})
