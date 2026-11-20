// workbox/bin/workrift, run for real in a scratch HOME with a bare origin, a
// no-op `flock` (macOS has none) and WORKRIFT_ROOT inside the scratch folder.
// With no backend file it must make the calls it made before the work backend
// (the script at e722240e, run beside it under shims that record every `rift`,
// `git` and `sqlite3` call). With the backend file saying `work` it runs over
// the `work` binary WORK_BIN names, held to a reference model and to the
// workflow the Rift backend gives: refresh first, track origin's branch,
// install once, gh stack metadata, the removal rule, a prune that spares kept
// bases. Nothing here touches the real host: every path is under the scratch.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const repo = join(import.meta.dir, "..", "..")
const SCRIPT = join(repo, "workbox/bin/workrift")
const OFF_BASE = "e722240e"
const WORK_BIN = process.env.WORK_BIN ?? Bun.which("work") ?? undefined
const REAL = { git: Bun.which("git"), rift: Bun.which("rift"), sqlite3: Bun.which("sqlite3") }

const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "workrift-test-")))
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }))
let scratchCount = 0

type Env = Record<string, string>

interface Ran {
  readonly code: number
  readonly out: string
  readonly err: string
}

const run = (cwd: string, env: Env, argv: ReadonlyArray<string>): Ran => {
  const ran = Bun.spawnSync([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" })
  return { code: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() }
}

/** Runs `argv` and returns its standard output; a failure throws with what it printed. */
const sh = (cwd: string, env: Env, ...argv: ReadonlyArray<string>) => {
  const ran = run(cwd, env, argv)
  if (ran.code !== 0) throw new Error(`${argv.join(" ")} failed (${ran.code}): ${ran.err}${ran.out}`)
  return ran.out
}

const lines = (text: string) => text.split("\n").filter((line) => line !== "")
const exe = (path: string, body: string) => {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

/**
 * A scratch HOME, a bin of `flock` (a no-op) first on PATH, a bare origin with one commit on `main`, and a
 * root folder for warm sources. The environment is the process's without anything that would point the
 * script or Git at the real host (WORKRIFT_*, RIFT_*, WORK_*, XDG_*, GIT_*).
 */
const bench = (label: string) => {
  const dir = join(scratchRoot, `${label}-${scratchCount++}`)
  const home = join(dir, "home")
  const bin = join(dir, "bin")
  const root = join(dir, "root")
  for (const each of [home, bin, root]) mkdirSync(each, { recursive: true })
  exe(join(bin, "flock"), "#!/bin/sh\nexit 0\n")
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !/^(WORKRIFT_|RIFT_|WORK_|WORK$|XDG_|GIT_)/.test(entry[0]),
    ),
  )
  const env: Env = {
    ...inherited,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    WORKRIFT_ROOT: root,
    WORKRIFT_ARCHIVE: join(home, "rift-archive"),
    GIT_AUTHOR_NAME: "Workrift Test",
    GIT_AUTHOR_EMAIL: "workrift@example.invalid",
    GIT_COMMITTER_NAME: "Workrift Test",
    GIT_COMMITTER_EMAIL: "workrift@example.invalid",
    GIT_AUTHOR_DATE: "2026-11-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-11-01T00:00:00Z",
    GIT_CONFIG_NOSYSTEM: "1",
    // No background gc or maintenance: it would move packs while a copy reads them.
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "gc.auto",
    GIT_CONFIG_VALUE_0: "0",
    GIT_CONFIG_KEY_1: "maintenance.auto",
    GIT_CONFIG_VALUE_1: "false",
  }
  const origin = join(dir, "origin.git")
  sh(dir, env, "git", "init", "-q", "--bare", "-b", "main", origin)
  const seed = join(dir, "seed")
  sh(dir, env, "git", "clone", "-q", origin, seed)
  sh(seed, env, "git", "switch", "-q", "-c", "main")
  writeFileSync(join(seed, "README.md"), "app\n")
  sh(seed, env, "git", "add", "README.md")
  sh(seed, env, "git", "commit", "-q", "-m", "init")
  sh(seed, env, "git", "push", "-q", "-u", "origin", "main")
  /** A commit of `files` on `branch` (made from main when new), pushed to origin; its hash. */
  const push = (branch: string, files: Record<string, string>, message = `change ${branch}`) => {
    sh(seed, env, "git", "fetch", "-q", "origin")
    const exists = run(seed, env, ["git", "rev-parse", "--verify", "--quiet", `origin/${branch}`]).code === 0
    sh(seed, env, "git", "switch", "-q", "-C", branch, exists ? `origin/${branch}` : "origin/main")
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(seed, name)), { recursive: true })
      writeFileSync(join(seed, name), text)
      sh(seed, env, "git", "add", name)
    }
    sh(seed, env, "git", "commit", "-q", "--allow-empty", "-m", message)
    sh(seed, env, "git", "push", "-q", "origin", `HEAD:refs/heads/${branch}`)
    return sh(seed, env, "git", "rev-parse", "HEAD").trim()
  }
  /** A clone of origin at `root/<name>`, its origin HEAD set. */
  const clone = (name: string) => {
    const path = join(root, name)
    sh(dir, env, "git", "clone", "-q", origin, path)
    sh(path, env, "git", "remote", "set-head", "origin", "--auto")
    return path
  }
  return { dir, home, bin, root, env, origin, push, clone }
}

type Bench = ReturnType<typeof bench>

const workrift = (b: Bench, cwd: string, ...argv: ReadonlyArray<string>) => run(cwd, b.env, [SCRIPT, ...argv])

/**
 * The sqlite3 shim's lines that point a call at a fresh copy of Rift's registry in journal_mode=delete, so the
 * script's `sqlite3 -readonly` reads it with any host sqlite3. Rift keeps its registry in WAL, and once Rift has
 * closed it (no -shm left) macOS's sqlite3 3.54 refuses to open it read-only (batch cy: the trace test red on the
 * Mac). The trace keeps the argument as the script gave it; only the call goes to the copy.
 */
const registryCopy = (real: string, registry: string, copies: string) =>
  [
    `registry='${registry}'`,
    `if [ -f "$registry" ]; then`,
    `  dir=$(mktemp -d '${copies}/c.XXXXXX')`,
    `  cp "$registry" "$dir/registry.sqlite"`,
    `  if [ -f "$registry-wal" ]; then cp "$registry-wal" "$dir/registry.sqlite-wal"; fi`,
    `  '${real}' "$dir/registry.sqlite" 'pragma journal_mode=delete;' >/dev/null`,
    `  for a do shift; if [ "$a" = "$registry" ]; then set -- "$@" "$dir/registry.sqlite"; else set -- "$@" "$a"; fi; done`,
    `fi`,
    "",
  ].join("\n")

describe("workrift with no backend file", () => {
  const ready = REAL.git !== null && REAL.rift !== null && REAL.sqlite3 !== null && process.platform === "darwin"

  /**
   * One run of `script` through the verbs, in a fresh bench whose `rift`, `git` and `sqlite3` are shims that
   * append their argv to TRACE (when set) and run the real one. Each verb's trace, output and exit, with
   * the scratch path, Rift's ids and the temp folder put as placeholders.
   */
  const traces = (script: string) => {
    const b = bench("off")
    // Rift's registry on macOS (the script's default is Linux's).
    const registry = join(b.home, "Library/Application Support/rift/rift.sqlite")
    const copies = join(b.dir, "sqlite-copies")
    mkdirSync(copies)
    for (const [name, real] of Object.entries(REAL)) {
      exe(
        join(b.bin, name),
        `#!/bin/sh\nif [ -n "\${TRACE:-}" ]; then\n  { printf '%s' '${name}'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'; } >>"$TRACE"\nfi\n${name === "sqlite3" ? registryCopy(real ?? "", registry, copies) : ""}exec '${real}' "$@"\n`,
      )
    }
    const env: Env = { ...b.env, RIFT_REGISTRY: registry }
    const source = b.clone("app")
    sh(source, env, "rift", "init", "--here")
    b.push("feat/remote", { "remote.txt": "remote\n" })
    b.push("main", { "later.txt": "later\n" })
    const trace = join(b.dir, "trace")
    const normal = (text: string) =>
      text
        .replaceAll(b.dir, "<S>")
        .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, "<id>")
        .replace(/\/(tmp|var\/folders)\/[^\s\]]*tmp\.[A-Za-z0-9]+/g, "<tmp>")
    const verb = (cwd: string, ...argv: ReadonlyArray<string>) => {
      writeFileSync(trace, "")
      const ran = run(cwd, { ...env, TRACE: trace }, [script, ...argv])
      return { argv: normal(argv.join(" ")), code: ran.code, out: normal(ran.out), err: normal(ran.err), calls: lines(normal(readFileSync(trace, "utf8"))) }
    }
    const steps = [verb(source, "check"), verb(source, "sources"), verb(source, "refresh"), verb(source, "create", "feat/one")]
    const one = lines(steps.at(-1)?.out ?? "").at(-1) ?? ""
    steps.push(verb(source, "create", "feat/remote"))
    const remote = lines(steps.at(-1)?.out ?? "").at(-1) ?? ""
    sh(source, env, "rift", "create", join(b.dir, remote.replace("<S>/", "")), "--copy-all", "--name", "nested")
    const remotePath = remote.replace("<S>", b.dir)
    const onePath = one.replace("<S>", b.dir)
    steps.push(
      verb(source, "list"),
      verb(onePath, "deps"),
      verb(source, "prune", "--dry-run"),
      verb(source, "remove", onePath),
      verb(source, "remove", remotePath),
      verb(source, "remove", "--with-children", remotePath),
      verb(source, "list"),
    )
    return steps
  }

  test.skipIf(!ready)(
    "each verb calls rift, git and sqlite3 as the script before the work backend did, and prints the same",
    () => {
      const old = join(scratchRoot, "workrift-old")
      writeFileSync(old, sh(repo, process.env as Env, "git", "show", `${OFF_BASE}:workbox/bin/workrift`))
      chmodSync(old, 0o755)
      const before = traces(old)
      const after = traces(SCRIPT)
      // The run did reach each verb's real work: a created path, a list of two, a trashed child.
      expect(before.map((step) => step.code)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0])
      expect(before.find((step) => step.argv === "list")?.calls).toContainEqual(expect.stringMatching(/^rift \[list\]/))
      // deps now also keeps the build output in step (stale dist, 2026-11-18): it reads the workspace's warm
      // step once more, its last call, and with none set does nothing else. That call is the only difference.
      const deps = after.find((step) => step.argv === "deps")
      expect(deps?.calls.at(-1)).toMatch(/^git \[-C\] \[[^\]]+\] \[config\] \[--get\] \[workrift\.warm\]$/)
      expect(after.map((step) => (step === deps ? { ...step, calls: step.calls.slice(0, -1) } : step))).toEqual(before)
    },
    60_000,
  )

  test("a backend file holding anything but rift or work fails, naming the file", () => {
    const b = bench("bad-backend")
    const file = join(b.home, ".config/workrift/backend")
    mkdirSync(dirname(file), { recursive: true })
    for (const word of ["Work", "rift work", ""]) {
      writeFileSync(file, `${word}\n`)
      const ran = workrift(b, b.dir, "sources")
      expect(ran.code).toBe(1)
      expect(ran.out).toBe("")
      expect(ran.err).toContain(file)
    }
    const other = join(b.dir, "elsewhere")
    writeFileSync(other, "zfs\n")
    const ran = run(b.dir, { ...b.env, WORKRIFT_BACKEND_FILE: other }, [SCRIPT, "list"])
    expect(ran.code).toBe(1)
    expect(ran.err).toContain(other)
  })
})

/** A bench whose backend file says `work`, with WORK the binary, and `app` a base `work init` made. */
const workBench = (label: string, work: string) => {
  const b = bench(label)
  const file = join(b.home, ".config/workrift/backend")
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, "work\n")
  const env: Env = { ...b.env, WORK: work }
  /** A base at `root/<name>`, its work.toml kept out of Git's view (step C's exclude line) unless committed. */
  const base = (name: string) => {
    const path = b.clone(name)
    if (!existsSync(join(path, "work.toml"))) writeFileSync(join(path, ".git/info/exclude"), "work.toml\n", { flag: "a" })
    sh(path, env, work, "init")
    return path
  }
  const app = base("app")
  const inBase = (path: string, ...argv: ReadonlyArray<string>) => sh(path, { ...env, WORK_BASE: path }, work, ...argv)
  /** The base's workspaces as `work --json list` has them. */
  const listed = (path: string) =>
    JSON.parse(inBase(path, "--json", "list")) as ReadonlyArray<{ name: string; id: string; path: string; parent: string; state: { _tag: string } }>
  const active = (path: string) => listed(path).filter((each) => each.state._tag === "Active")
  const wr = (cwd: string, ...argv: ReadonlyArray<string>) => run(cwd, env, [SCRIPT, ...argv])
  /** `workrift create` that must succeed; the path it printed last. */
  const create = (cwd: string, branch: string) => {
    const ran = wr(cwd, "create", branch)
    if (ran.code !== 0) throw new Error(`workrift create ${branch} failed: ${ran.err}`)
    return lines(ran.out).at(-1) ?? ""
  }
  return { ...b, env, file, base, app, inBase, listed, active, wr, create }
}

const describeWork = WORK_BIN === undefined ? describe.skip : describe

describeWork("workrift with the work backend", () => {
  const work = WORK_BIN ?? "work"

  test("WORK_BIN is a work binary that answers", () => {
    expect(JSON.parse(sh(scratchRoot, { ...process.env, XDG_DATA_HOME: join(scratchRoot, "data") } as Env, work, "--json", "bases"))).toEqual([])
  })

  /** mulberry32: a small seeded generator, so a failing sequence can be run again from its seed. */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  for (const seed of [1, 7, 42]) {
    test(
      `random create, nest, remove, remove --with-children, list and sources agree with a reference (seed ${seed})`,
      () => {
        const w = workBench(`model-${seed}`, work)
        const next = random(seed)
        const pick = <A>(items: ReadonlyArray<A>) => items[Math.floor(next() * items.length)] as A
        /** The reference: each live workspace's path, by its branch, with the path it was made on. */
        const reference = new Map<string, { path: string; parent: string }>()
        const below = (path: string): ReadonlyArray<string> =>
          [...reference.entries()].filter(([, each]) => each.parent === path).flatMap(([branch, each]) => [branch, ...below(each.path)])
        const branches = ["feat/a", "feat/b", "fix/c", "d"]
        let nests = 0
        const log: Array<string> = []
        for (let step = 0; step < 14; step++) {
          const live = [...reference.keys()]
          const action = live.length === 0 ? "create" : pick(["create", "create", "nest", "remove", "remove --with-children", "list", "sources"])
          log.push(action)
          const context = () => `seed ${seed}, steps ${log.join(", ")}`
          if (action === "create") {
            const branch = pick(branches)
            log.push(branch)
            const ran = w.wr(w.app, "create", branch)
            if (reference.has(branch)) expect(ran.code, context()).toBe(1)
            else {
              expect(ran.code, `${context()}: ${ran.err}`).toBe(0)
              const path = lines(ran.out).at(-1) ?? ""
              expect(dirname(path), context()).toBe(join(w.root, ".work/app"))
              expect(sh(path, w.env, "git", "branch", "--show-current").trim()).toBe(branch)
              reference.set(branch, { path, parent: w.app })
            }
          } else if (action === "nest") {
            // A workspace made on another (the plugin's stacked case), by work itself.
            const on = pick(live)
            const name = `nest-${nests++}`
            const onName = w.active(w.app).find((each) => each.path === reference.get(on)?.path)?.name ?? ""
            const made = JSON.parse(w.inBase(w.app, "--json", "new", "-on", onName, "-branch", name, name)) as { path: string }
            reference.set(name, { path: made.path, parent: reference.get(on)?.path ?? "" })
          } else if (action === "remove" || action === "remove --with-children") {
            const target = pick(live)
            const path = reference.get(target)?.path ?? ""
            const withChildren = action === "remove --with-children"
            const ran = w.wr(w.app, "remove", ...(withChildren ? ["--with-children"] : []), path)
            const doomed = below(path)
            if (doomed.length > 0 && !withChildren) {
              expect(ran.code, context()).toBe(1)
              expect(ran.err).toContain("--with-children")
            } else {
              expect(ran.code, `${context()}: ${ran.err}`).toBe(0)
              for (const branch of [target, ...doomed]) reference.delete(branch)
              expect(existsSync(path)).toBe(false)
            }
          } else if (action === "sources") {
            expect(lines(sh(w.app, w.env, SCRIPT, "sources"))).toEqual([w.app])
          }
          const made = [...reference.values()]
          expect(lines(sh(w.app, w.env, SCRIPT, "list")).sort(), context()).toEqual(made.filter((each) => each.parent === w.app).map((each) => each.path).sort())
          expect(w.active(w.app).map((each) => each.path).sort(), context()).toEqual(made.map((each) => each.path).sort())
        }
      },
      60_000,
    )
  }

  test(
    "create refreshes the source, tracks origin's branch, starts a new branch at the source's head, and prints the path last",
    () => {
      const w = workBench("create", work)
      const later = w.push("main", { "later.txt": "later\n" })
      const ran = w.wr(w.app, "create", "feat/new")
      expect(ran.code, ran.err).toBe(0)
      const path = lines(ran.out).at(-1) ?? ""
      expect(lines(ran.out)).toEqual([path])
      expect(path).toBe(join(w.root, ".work/app/feat-new"))
      // The warm source was fast-forwarded to origin's main before the copy.
      expect(sh(w.app, w.env, "git", "rev-parse", "HEAD").trim()).toBe(later)
      expect(sh(path, w.env, "git", "rev-parse", "HEAD").trim()).toBe(later)
      expect(sh(path, w.env, "git", "branch", "--show-current").trim()).toBe("feat/new")
      expect(run(path, w.env, ["git", "rev-parse", "--abbrev-ref", "feat/new@{u}"]).code).not.toBe(0)
      // A branch made here pushes to origin, as one in a Rift does.
      expect(run(path, w.env, ["git", "config", "--get", "remote.origin.pushurl"]).code).not.toBe(0)

      const remote = w.push("feat/remote", { "remote.txt": "remote\n" })
      const tracked = w.create(w.app, "feat/remote")
      expect(sh(tracked, w.env, "git", "rev-parse", "HEAD").trim()).toBe(remote)
      expect(sh(tracked, w.env, "git", "rev-parse", "--abbrev-ref", "feat/remote@{u}").trim()).toBe("origin/feat/remote")
      expect(readFileSync(join(tracked, "remote.txt"), "utf8")).toBe("remote\n")
      expect(sh(tracked, w.env, "git", "status", "--porcelain")).toBe("")
    },
    30_000,
  )

  test(
    "create installs once when a lock file changed since the last install, in the source or in the workspace",
    () => {
      const w = workBench("install", work)
      const counter = join(w.dir, "installs")
      w.push("main", { "bun.lock": "v1\n" })
      sh(w.app, w.env, "git", "config", "workrift.install", `pwd -P >>'${counter}'`)
      expect(w.wr(w.app, "refresh").code).toBe(0)
      const installs = () => lines(existsSync(counter) ? readFileSync(counter, "utf8") : "")
      expect(installs()).toEqual([w.app])

      // A new lock on main: the source installs as it advances, and the copy carries the install.
      w.push("main", { "bun.lock": "v2\n" })
      const first = w.create(w.app, "feat/first")
      expect(installs()).toEqual([w.app, w.app])
      expect(readFileSync(join(first, "bun.lock"), "utf8")).toBe("v2\n")

      // A branch on origin with its own lock: the workspace installs, once.
      w.push("feat/locked", { "bun.lock": "v3\n" })
      const locked = w.create(w.app, "feat/locked")
      expect(installs()).toEqual([w.app, w.app, locked])

      // The same lock again: nothing installs.
      w.create(w.app, "feat/same")
      expect(installs()).toEqual([w.app, w.app, locked])
    },
    30_000,
  )

  test(
    "a base whose work.toml has [deps]: a changed lock installs once, never by both work and workrift",
    () => {
      const w = workBench("deps", work)
      const byWork = join(w.dir, "by-work")
      const byWorkrift = join(w.dir, "by-workrift")
      w.push("main", { "bun.lock": "v1\n", "work.toml": `[deps]\nlock = "bun.lock"\ninstall = "pwd -P >>'${byWork}'"\n` })
      const lib = w.base("lib")
      sh(lib, w.env, "git", "config", "workrift.install", `pwd -P >>'${byWorkrift}'`)
      w.push("feat/locked", { "bun.lock": "v2\n" })
      const path = w.create(lib, "feat/locked")
      const read = (file: string) => lines(existsSync(file) ? readFileSync(file, "utf8") : "")
      // The changed lock installs once in the workspace, by one of the two (work new reports the lock
      // unchanged at creation, so today it is workrift's), and the next `workrift deps` installs nothing.
      const here = () => [...read(byWork), ...read(byWorkrift)].filter((line) => line === path)
      expect(here()).toEqual([path])
      expect(run(path, w.env, [SCRIPT, "deps"]).code).toBe(0)
      expect(here()).toEqual([path])
    },
    30_000,
  )

  test(
    "deps runs the warm step once for each tree HEAD moves to, so the build output follows the checkout (stale dist, 2026-11-18)",
    () => {
      const w = workBench("warm", work)
      const warmed = join(w.dir, "warmed")
      sh(w.app, w.env, "git", "config", "workrift.warm", `git rev-parse 'HEAD^{tree}' >>'${warmed}'`)
      const trees = () => lines(existsSync(warmed) ? readFileSync(warmed, "utf8") : "")
      const treeOf = (path: string, at = "HEAD") => sh(path, w.env, "git", "rev-parse", `${at}^{tree}`).trim()
      expect(w.wr(w.app, "refresh").code).toBe(0)
      const mainTree = treeOf(w.app)
      expect(trees()).toEqual([mainTree])

      // A branch with its own tree: the workspace builds it once.
      w.push("feat/x", { "src.txt": "x\n" })
      const path = w.create(w.app, "feat/x")
      const xTree = treeOf(path)
      expect(trees()).toEqual([mainTree, xTree])

      // HEAD moves inside the workspace (a detach, a merge, a switch): the hook's `workrift deps` builds the new tree.
      sh(path, w.env, "git", "switch", "-q", "--detach", "origin/main")
      expect(w.wr(path, "deps").code).toBe(0)
      expect(trees()).toEqual([mainTree, xTree, mainTree])
      // The same tree again builds nothing.
      expect(w.wr(path, "deps").code).toBe(0)
      expect(trees()).toEqual([mainTree, xTree, mainTree])

      // A workspace whose tree is the source's keeps the copied build: nothing runs.
      w.create(w.app, "feat/same")
      expect(trees()).toEqual([mainTree, xTree, mainTree])

      // The warm says it starts, and leaves its output in a log in the Git directory, not on the terminal.
      const log = sh(path, w.env, "git", "rev-parse", "--path-format=absolute", "--git-path", "workrift-warm.log").trim()
      sh(path, w.env, "git", "config", "workrift.warm", `echo built-output; git rev-parse 'HEAD^{tree}' >>'${warmed}'`)
      sh(path, w.env, "git", "switch", "-q", "--detach", "origin/feat/x")
      const loud = w.wr(path, "deps")
      expect(loud.code).toBe(0)
      expect(loud.err).toContain("workrift: rebuilding changed packages (WORKRIFT_WARM=0 skips)")
      expect(loud.err).toContain(log)
      expect(loud.out + loud.err).not.toContain("built-output")
      expect(readFileSync(log, "utf8")).toContain("built-output")
      expect(trees()).toEqual([mainTree, xTree, mainTree, xTree])

      // WORKRIFT_WARM=0 skips the warm alone, and leaves the marker: the next deps builds.
      sh(path, w.env, "git", "switch", "-q", "--detach", "origin/main")
      const skipped = run(path, { ...w.env, WORKRIFT_WARM: "0" }, [SCRIPT, "deps"])
      expect(skipped.code).toBe(0)
      expect(trees()).toEqual([mainTree, xTree, mainTree, xTree])
      expect(w.wr(path, "deps").code).toBe(0)
      expect(trees()).toEqual([mainTree, xTree, mainTree, xTree, mainTree])

      // A failed warm step can leave the output half gone (a build cleans first): it warns, clears the
      // marker, and a return to the last tree that built builds again.
      sh(path, w.env, "git", "switch", "-q", "--detach", "origin/feat/x")
      sh(path, w.env, "git", "config", "workrift.warm", "exit 3")
      const failed = w.wr(path, "deps")
      expect(failed.code).toBe(0)
      expect(failed.err).toContain("warm step failed")
      expect(failed.err).toContain(log)
      sh(path, w.env, "git", "config", "workrift.warm", `git rev-parse 'HEAD^{tree}' >>'${warmed}'`)
      sh(path, w.env, "git", "switch", "-q", "--detach", "origin/main")
      expect(w.wr(path, "deps").code).toBe(0)
      expect(trees()).toEqual([mainTree, xTree, mainTree, xTree, mainTree, mainTree])
    },
    30_000,
  )

  test(
    "deps on an unborn branch (git switch --orphan) exits 0 and builds nothing",
    () => {
      const w = workBench("orphan", work)
      const warmed = join(w.dir, "warmed")
      sh(w.app, w.env, "git", "config", "workrift.warm", `git rev-parse 'HEAD^{tree}' >>'${warmed}'`)
      const path = w.create(w.app, "feat/orphan")
      const before = existsSync(warmed) ? readFileSync(warmed, "utf8") : ""
      sh(path, w.env, "git", "switch", "-q", "--orphan", "fresh")
      const ran = w.wr(path, "deps")
      expect(ran.code, ran.err).toBe(0)
      expect(existsSync(warmed) ? readFileSync(warmed, "utf8") : "").toBe(before)
    },
    30_000,
  )

  test(
    "with the hooks installed, a rebase that stops on a conflict builds nothing until it ends, then once; an amend that keeps the tree builds nothing",
    () => {
      const w = workBench("rebase", work)
      const warmed = join(w.dir, "warmed")
      w.push("main", { "a.txt": "base\n", "b.txt": "base\n", "lefthook.yml": "{}\n" })
      sh(w.app, w.env, "git", "config", "workrift.warm", `git rev-parse 'HEAD^{tree}' >>'${warmed}'`)
      expect(w.wr(w.app, "refresh").code).toBe(0)
      w.push("feat/r", { "b.txt": "r\n" }, "first")
      w.push("feat/r", { "a.txt": "r\n" }, "second")
      const path = w.create(w.app, "feat/r")
      // The hooks lefthook-local.yml installs, as plain Git hooks: post-rewrite passes its first argument.
      for (const hook of ["post-checkout", "post-merge"]) exe(join(path, ".git/hooks", hook), `#!/bin/sh\nexec '${SCRIPT}' deps\n`)
      exe(join(path, ".git/hooks/post-rewrite"), `#!/bin/sh\nexec '${SCRIPT}' deps "$1"\n`)
      expect(readFileSync(join(w.app, "lefthook-local.yml"), "utf8")).toContain("post-rewrite:\n  jobs:\n    - name: workrift deps\n      run: workrift deps {1}\n")
      w.push("main", { "a.txt": "main\n" })
      sh(path, w.env, "git", "fetch", "-q", "origin")
      const trees = () => lines(existsSync(warmed) ? readFileSync(warmed, "utf8") : "")
      const before = trees()

      const stopped = run(path, w.env, ["git", "rebase", "origin/main"])
      expect(stopped.code).not.toBe(0)
      expect(readFileSync(join(path, "a.txt"), "utf8")).toContain("<<<<<<<")
      // A path checkout mid-rebase runs post-checkout: no build over conflict markers.
      sh(path, w.env, "git", "checkout", "--", "b.txt")
      expect(w.wr(path, "deps").code).toBe(0)
      expect(trees()).toEqual(before)

      writeFileSync(join(path, "a.txt"), "both\n")
      sh(path, w.env, "git", "add", "a.txt")
      sh(path, { ...w.env, GIT_EDITOR: "true" }, "git", "rebase", "--continue")
      const done = sh(path, w.env, "git", "rev-parse", "HEAD^{tree}").trim()
      expect(trees()).toEqual([...before, done])

      sh(path, w.env, "git", "commit", "-q", "--amend", "--no-edit")
      expect(trees()).toEqual([...before, done])
      // A plain commit runs no hook, so its tree is not the marker's; an amend after it builds nothing either.
      writeFileSync(join(path, "c.txt"), "c\n")
      sh(path, w.env, "git", "add", "c.txt")
      sh(path, w.env, "git", "commit", "-q", "-m", "c")
      sh(path, w.env, "git", "commit", "-q", "--amend", "--no-edit")
      expect(trees()).toEqual([...before, done])
    },
    30_000,
  )

  /** A base with lefthook.yml and a warm step that logs the tree it built, and a workspace for `branch` with the managed hooks as plain Git hooks. */
  const hooked = (label: string, branch: string, files: Record<string, string> = {}) => {
    const w = workBench(label, work)
    const warmed = join(w.dir, "warmed")
    w.push("main", { "a.txt": "base\n", "b.txt": "base\n", "lefthook.yml": "{}\n" })
    sh(w.app, w.env, "git", "config", "workrift.warm", `git rev-parse 'HEAD^{tree}' >>'${warmed}'`)
    expect(w.wr(w.app, "refresh").code).toBe(0)
    if (Object.keys(files).length > 0) w.push(branch, files)
    const path = w.create(w.app, branch)
    for (const hook of ["post-checkout", "post-merge"]) exe(join(path, ".git/hooks", hook), `#!/bin/sh\nexec '${SCRIPT}' deps\n`)
    exe(join(path, ".git/hooks/post-rewrite"), `#!/bin/sh\nexec '${SCRIPT}' deps "$1"\n`)
    const trees = () => lines(existsSync(warmed) ? readFileSync(warmed, "utf8") : "")
    const tree = () => sh(path, w.env, "git", "rev-parse", "HEAD^{tree}").trim()
    return { w, path, trees, tree }
  }

  test(
    "a rebase that only moves HEAD (no own commits, so no post-rewrite) builds the new tree once",
    () => {
      const { w, path, trees, tree } = hooked("rebase-ff", "feat/none")
      w.push("main", { "a.txt": "main\n" })
      sh(path, w.env, "git", "fetch", "-q", "origin")
      const before = trees()
      sh(path, w.env, "git", "rebase", "-q", "origin/main")
      expect(trees()).toEqual([...before, tree()])
    },
    30_000,
  )

  test(
    "a merge that stops on a conflict, or a stash that leaves unmerged paths, builds nothing",
    () => {
      const { w, path, trees } = hooked("unmerged", "feat/m", { "a.txt": "m\n" })
      w.push("main", { "a.txt": "main\n" })
      sh(path, w.env, "git", "fetch", "-q", "origin")
      const marker = sh(path, w.env, "git", "rev-parse", "--path-format=absolute", "--git-path", "workrift-warmed-tree").trim()
      const before = trees()
      expect(run(path, w.env, ["git", "merge", "-q", "origin/main"]).code).not.toBe(0)
      // A marker that no longer matches, so only the in-progress check stops the build.
      writeFileSync(marker, "none\n")
      sh(path, w.env, "git", "checkout", "--", "b.txt")
      expect(trees()).toEqual(before)
      // Resolved but not committed: MERGE_HEAD alone holds the merge open.
      writeFileSync(join(path, "a.txt"), "both\n")
      sh(path, w.env, "git", "add", "a.txt")
      expect(sh(path, w.env, "git", "ls-files", "-u")).toBe("")
      sh(path, w.env, "git", "checkout", "--", "b.txt")
      expect(trees()).toEqual(before)
      sh(path, w.env, "git", "merge", "--abort")

      // Unmerged paths with no operation's state file: a stash applied over a conflicting change.
      writeFileSync(join(path, "a.txt"), "stashed\n")
      sh(path, w.env, "git", "stash", "-q")
      writeFileSync(join(path, "a.txt"), "committed\n")
      sh(path, w.env, "git", "commit", "-q", "-am", "conflicting")
      expect(run(path, w.env, ["git", "stash", "apply", "-q"]).code).not.toBe(0)
      expect(sh(path, w.env, "git", "ls-files", "-u")).not.toBe("")
      writeFileSync(marker, "none\n")
      sh(path, w.env, "git", "checkout", "--", "b.txt")
      expect(trees()).toEqual(before)
    },
    30_000,
  )

  test(
    "deps brings a workspace's managed lefthook-local.yml up to date and leaves an unmanaged one alone",
    () => {
      const { w, path } = hooked("hookfile", "feat/h")
      const managed = readFileSync(join(w.app, "lefthook-local.yml"), "utf8")
      const local = join(path, "lefthook-local.yml")
      const old = managed.replace("run: workrift deps {1}", "run: workrift deps")
      expect(old).not.toBe(managed)
      writeFileSync(local, old)
      expect(w.wr(path, "deps").code).toBe(0)
      expect(readFileSync(local, "utf8")).toBe(managed)

      writeFileSync(local, "# mine\npost-merge:\n  jobs: []\n")
      expect(w.wr(path, "deps").code).toBe(0)
      expect(readFileSync(local, "utf8")).toBe("# mine\npost-merge:\n  jobs: []\n")
    },
    30_000,
  )

  test(
    "create run from a checkout with gh stack metadata for the branch carries the metadata into the workspace",
    () => {
      const w = workBench("stack", work)
      const caller = w.clone("caller")
      const metadata = JSON.stringify({ stacks: [{ trunk: { branch: "main" }, branches: [{ branch: "feat/stacked" }] }] })
      writeFileSync(join(caller, ".git/gh-stack"), metadata)
      // From a plain checkout: the base is found by its origin.
      const ran = w.wr(caller, "create", "feat/stacked")
      expect(ran.code, ran.err).toBe(0)
      const path = lines(ran.out).at(-1) ?? ""
      expect(dirname(path)).toBe(join(w.root, ".work/app"))
      expect(readFileSync(join(path, ".git/gh-stack"), "utf8")).toBe(metadata)
      expect(ran.err).toContain("Imported gh stack metadata")
    },
    30_000,
  )

  test(
    "off the workbox (WORKRIFT_PURGE=0, the Mac's default) remove refuses a workspace with uncommitted changes or commits on no remote, and trashes it clean and pushed",
    () => {
      const w0 = workBench("remove", work)
      const w = { ...w0, wr: (cwd: string, ...argv: ReadonlyArray<string>) => run(cwd, { ...w0.env, WORKRIFT_PURGE: "0" }, [SCRIPT, ...argv]) }
      const path = w.create(w.app, "feat/rm")
      writeFileSync(join(path, "unsaved.txt"), "unsaved\n")
      let ran = w.wr(w.app, "remove", path)
      expect(ran.code).toBe(1)
      expect(ran.err).toContain("uncommitted")
      expect(existsSync(path)).toBe(true)

      sh(path, w.env, "git", "add", "unsaved.txt")
      sh(path, w.env, "git", "commit", "-q", "-m", "only here")
      ran = w.wr(w.app, "remove", path)
      expect(ran.code).toBe(1)
      expect(ran.err).toContain("commits on no remote")
      expect(w.active(w.app).map((each) => each.path)).toEqual([path])

      sh(path, w.env, "git", "push", "-q", "origin", "feat/rm")
      ran = w.wr(w.app, "remove", path)
      expect(ran.code, ran.err).toBe(0)
      expect(existsSync(path)).toBe(false)
      expect(w.active(w.app)).toEqual([])
      expect(readdirSync(join(w.root, ".work/app/.work-trash")).some((entry) => entry.startsWith("feat-rm."))).toBe(true)

      // The name a trashed workspace holds is not reused: the next one is feat-rm-2.
      expect(w.create(w.app, "feat/rm")).toBe(join(w.root, ".work/app/feat-rm-2"))
    },
    30_000,
  )

  /**
   * The workbox's removal (WORKRIFT_PURGE=1; the default on Linux): a bench with three sibling workspaces of `app`, one of
   * `lib`, a plain folder beside them in app's storage, an unrelated folder beside the bases, and one workspace already
   * in app's trash (removed with WORKRIFT_PURGE=0). `work` is a shim that logs each call (with the base it names) and
   * fails a `gc` when the file `fail-gc` is there. `files` is every file under the scratch root but the trash and Git's
   * folders, with its text, so a test proves that nothing but the removed workspace went.
   */
  const purgeBench = (label: string) => {
    const w = workBench(label, work)
    const calls = join(w.dir, "work-calls")
    const failGc = join(w.dir, "fail-gc")
    const lieTrash = join(w.dir, "lie-trash")
    exe(
      join(w.bin, "work-logged"),
      `#!/bin/sh\nprintf '%s %s\\n' "\${WORK_BASE:-}" "$*" >>'${calls}'\nfor a do\n  [ "$a" = gc ] && [ -e '${failGc}' ] && { echo '{"_tag":"Locked"}'; exit 1; }\n  [ "$a" = rm ] && [ -e '${lieTrash}' ] && { '${work}' "$@" | jq -c --arg t "$(cat '${lieTrash}')" 'map(.trash = $t)'; exit; }\ndone\nexec '${work}' "$@"\n`,
    )
    const env: Env = { ...w.env, WORK: join(w.bin, "work-logged"), WORKRIFT_PURGE: "1" }
    const wr = (cwd: string, ...argv: ReadonlyArray<string>) => run(cwd, env, [SCRIPT, ...argv])
    const lib = w.base("lib")
    const [one, two, three] = [w.create(w.app, "feat/one"), w.create(w.app, "feat/two"), w.create(w.app, "feat/three")]
    const other = w.create(lib, "feat/other")
    for (const path of [one, two, three, other]) writeFileSync(join(path, "mark.txt"), `${path}\n`)
    for (const path of [one, two, three, other]) sh(path, w.env, "git", "add", "mark.txt")
    for (const path of [one, two, three, other]) sh(path, w.env, "git", "commit", "-q", "-m", "mark")
    for (const path of [one, two, three, other]) sh(path, w.env, "git", "push", "-q", "origin", "HEAD")
    const plain = join(w.root, ".work/app/plain-folder")
    mkdirSync(join(plain, "inner"), { recursive: true })
    writeFileSync(join(plain, "inner/keep.txt"), "plain\n")
    const unrelated = join(w.root, "unrelated")
    mkdirSync(unrelated)
    writeFileSync(join(unrelated, "keep.txt"), "unrelated\n")
    const old = w.create(w.app, "feat/old")
    const trashed = run(w.app, { ...w.env, WORKRIFT_PURGE: "0" }, [SCRIPT, "remove", old])
    expect(trashed.code, trashed.err).toBe(0)
    const trash = join(w.root, ".work/app/.work-trash")
    const oldTrash = readdirSync(trash)
    expect(oldTrash.length).toBe(1)
    writeFileSync(calls, "")
    const files = (): Record<string, string> => {
      const out: Record<string, string> = {}
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry)
          if (entry === ".git" || entry === ".work-trash" || entry.startsWith(".registry") || entry.startsWith(".lock")) continue
          if (lstatSync(path).isDirectory()) walk(path)
          else if (lstatSync(path).isFile()) out[path] = readFileSync(path, "utf8")
        }
      }
      walk(w.root)
      return out
    }
    const without = (all: Record<string, string>, folder: string) =>
      Object.fromEntries(Object.entries(all).filter(([path]) => !path.startsWith(`${folder}/`)))
    const gcCalls = () => lines(readFileSync(calls, "utf8")).filter((line) => /\bgc\b/.test(line))
    return { w, env, wr, lib, one, two, three, other, plain, unrelated, trash, oldTrash, failGc, lieTrash, files, without, gcCalls }
  }

  test.each([
    ["the base", (p: ReturnType<typeof purgeBench>) => p.w.app],
    ["the workspaces' folder", (p: ReturnType<typeof purgeBench>) => join(p.w.root, ".work/app")],
    ["a sibling workspace", (p: ReturnType<typeof purgeBench>) => p.three],
    ["a trash entry of another folder", (p: ReturnType<typeof purgeBench>) => join(p.w.root, ".work/lib/.work-trash/x.1")],
  ] as const)(
    "a work rm answer whose trash folder is %s runs no gc: nothing is deleted and the trash is named",
    (_label, at) => {
      const p = purgeBench("purge-lie")
      writeFileSync(p.lieTrash, at(p))
      const before = p.files()
      const ran = p.wr(p.w.app, "remove", p.two)
      expect(ran.code).toBe(1)
      expect(ran.err).toContain("nothing deleted")
      expect(p.gcCalls()).toEqual([])
      // work moved feat-two to its trash; every other file stays.
      expect(p.files()).toEqual(p.without(before, p.two))
      expect(existsSync(p.three)).toBe(true)
      expect(existsSync(p.w.app)).toBe(true)
    },
    60_000,
  )

  test(
    "on the workbox remove deletes the one workspace for good, by work gc -id: its siblings, the base, another base's workspace, a plain folder beside it, an unrelated folder and a workspace already in the trash all stay",
    () => {
      const p = purgeBench("purge")
      const id = p.w.active(p.w.app).find((each) => each.path === p.two)?.id ?? ""
      expect(id).not.toBe("")
      const before = p.files()
      const ran = p.wr(p.w.app, "remove", p.two)
      expect(ran.code, ran.err).toBe(0)
      expect(lines(ran.out)).toEqual([`deleted: ${p.two}`])
      expect(existsSync(p.two)).toBe(false)
      // Every other file under the scratch root is there with its text: only feat-two's files went.
      expect(p.files()).toEqual(p.without(before, p.two))
      expect(Object.keys(p.without(before, p.two)).length).toBeGreaterThan(5)
      // The workspace already in the trash stays (gc took that one id), and feat-two left no trash.
      expect(readdirSync(p.trash)).toEqual(p.oldTrash)
      expect(p.gcCalls()).toEqual([`${p.w.app} --json gc -id ${id}`])
      // Its record is gone, not trashed; the others are as they were.
      expect(p.w.listed(p.w.app).some((each) => each.id === id)).toBe(false)
      expect(p.w.active(p.w.app).map((each) => each.path).sort()).toEqual([p.one, p.three].sort())
      expect(p.w.active(p.lib).map((each) => each.path)).toEqual([p.other])
      // The name is free again: no -2 suffix.
      expect(p.w.create(p.w.app, "feat/two")).toBe(p.two)
    },
    60_000,
  )

  test(
    "remove --dry-run prints the exact folders it would delete and changes nothing; --with-children deletes the workspace and the one made on it, each by its own id",
    () => {
      const p = purgeBench("purge-tree")
      const oneName = p.w.active(p.w.app).find((each) => each.path === p.one)?.name ?? ""
      const nested = (JSON.parse(p.w.inBase(p.w.app, "--json", "new", "-on", oneName, "-branch", "nested", "nested")) as { path: string }).path
      const before = p.files()
      const listedBefore = p.w.listed(p.w.app)

      const dry = p.wr(p.w.app, "remove", "--dry-run", p.three)
      expect(dry.code, dry.err).toBe(0)
      expect(lines(dry.out)).toEqual([`would delete: ${p.three}`])
      const dryTree = p.wr(p.w.app, "remove", "--dry-run", "--with-children", p.one)
      expect(dryTree.code, dryTree.err).toBe(0)
      expect(lines(dryTree.out)).toEqual([`would delete: ${p.one}`, `would delete: ${nested}`])
      expect(p.files()).toEqual(before)
      expect(p.w.listed(p.w.app)).toEqual(listedBefore)
      expect(p.gcCalls()).toEqual([])

      const ids = [p.one, nested].map((path) => p.w.active(p.w.app).find((each) => each.path === path)?.id ?? "")
      const ran = p.wr(p.w.app, "remove", "--with-children", p.one)
      expect(ran.code, ran.err).toBe(0)
      expect(lines(ran.out).sort()).toEqual([`deleted: ${p.one}`, `deleted: ${nested}`].sort())
      expect(p.files()).toEqual(p.without(p.without(before, p.one), nested))
      expect(readdirSync(p.trash)).toEqual(p.oldTrash)
      expect(p.gcCalls().sort()).toEqual(ids.map((id) => `${p.w.app} --json gc -id ${id}`).sort())
    },
    60_000,
  )

  test(
    "remove refuses a workspace a process works in, naming the process, and deletes and trashes nothing",
    () => {
      const p = purgeBench("purge-busy")
      // A /proc of one process whose working folder is inside feat-two.
      const proc = join(p.w.dir, "proc")
      mkdirSync(join(proc, "4242"), { recursive: true })
      mkdirSync(join(p.two, "src"))
      symlinkSync(join(p.two, "src"), join(proc, "4242/cwd"))
      writeFileSync(join(proc, "4242/comm"), "zsh\n")
      const before = p.files()
      const ran = run(p.w.app, { ...p.env, WORKRIFT_PROC: proc }, [SCRIPT, "remove", p.two])
      expect(ran.code).toBe(1)
      expect(ran.err).toContain(`a process works in ${p.two} (pid 4242 zsh)`)
      expect(p.files()).toEqual(before)
      expect(readdirSync(p.trash)).toEqual(p.oldTrash)
      expect(p.gcCalls()).toEqual([])
      expect(p.w.active(p.w.app).map((each) => each.path)).toContain(p.two)
    },
    60_000,
  )

  test(
    "a work gc -id that fails after the rm leaves the trash, names it and exits 1; nothing else is deleted",
    () => {
      const p = purgeBench("purge-fail")
      writeFileSync(p.failGc, "")
      const before = p.files()
      const ran = p.wr(p.w.app, "remove", p.two)
      expect(ran.code).toBe(1)
      const left = readdirSync(p.trash).filter((entry) => !p.oldTrash.includes(entry))
      expect(left.length).toBe(1)
      expect(left[0]).toStartWith("feat-two.")
      expect(ran.err).toContain(join(p.trash, left[0] ?? ""))
      expect(ran.err).toContain("not deleted")
      // The workspace's files are in its trash folder, whole; everything else is where it was.
      expect(readFileSync(join(p.trash, left[0] ?? "", "mark.txt"), "utf8")).toBe(`${p.two}\n`)
      expect(p.files()).toEqual(p.without(before, p.two))
      expect(p.gcCalls().length).toBe(1)
    },
    60_000,
  )

  /**
   * A folder a cut `workrift create` left (the server restarted mid-create, 2026-11-19): under app's storage, no .git
   * and no record, a few files, a `.env` link to a file outside the scratch root and a link to a folder inside it.
   * `proc` is a /proc of the test's own: a mount table (self/mountinfo) and one process (100) whose working folder
   * is the base and which holds a file of feat-one open. `stat` and `btrfs` are shims: a path the file `subvolumes`
   * names is a btrfs subvolume (`stat -f -c %T` btrfs, inode 256), and `btrfs subvolume delete` of one removes
   * it; every btrfs call is logged.
   */
  const halfMade = (p: ReturnType<typeof purgeBench>) => {
    const path = join(p.w.root, ".work/app/scratch-vfy-sync-parity")
    mkdirSync(join(path, "src"), { recursive: true })
    writeFileSync(join(path, "package.json"), "{}\n")
    writeFileSync(join(path, "src/index.ts"), "export {}\n")
    const secret = join(p.w.dir, "outside.env")
    writeFileSync(secret, "KEEP=1\n")
    symlinkSync(secret, join(path, ".env"))
    const linked = join(p.w.root, "linked-dir")
    mkdirSync(linked)
    writeFileSync(join(linked, "keep.txt"), "linked\n")
    symlinkSync(linked, join(path, "linked-dir"))
    const proc = join(p.w.dir, "proc")
    mkdirSync(join(proc, "self"), { recursive: true })
    const mounts = join(proc, "self/mountinfo")
    const table = "22 1 0:21 / / rw,relatime shared:1 - apfs /dev/disk3s1 rw\n"
    writeFileSync(mounts, table)
    mkdirSync(join(proc, "100/fd"), { recursive: true })
    symlinkSync(p.w.app, join(proc, "100/cwd"))
    symlinkSync(join(p.one, "mark.txt"), join(proc, "100/fd/3"))
    const subvolumes = join(p.w.dir, "subvolumes")
    writeFileSync(subvolumes, "")
    const btrfsLog = join(p.w.dir, "btrfs-calls")
    writeFileSync(btrfsLog, "")
    exe(
      join(p.w.bin, "stat"),
      `#!/bin/sh\nfor p do :; done\nhit=\ngrep -qxF -- "$p" '${subvolumes}' && hit=1\ncase "$*" in\n  "-f -c %T "*) if [ -n "$hit" ]; then echo btrfs; else echo apfs; fi ;;\n  "-c %i "*) if [ -n "$hit" ]; then echo 256; else echo 1000; fi ;;\n  *) exec /usr/bin/stat "$@" ;;\nesac\n`,
    )
    exe(
      join(p.w.bin, "btrfs"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >>'${btrfsLog}'\n[ "$1 $2" = "subvolume delete" ] && [ "$#" -eq 3 ] || exit 1\ngrep -qxF -- "$3" '${subvolumes}' || { echo "ERROR: Not a Btrfs subvolume: $3" >&2; exit 1; }\nexec /bin/rm -rf "$3"\n`,
    )
    const env: Env = { ...p.env, WORKRIFT_PROC: proc }
    const wr = (cwd: string, ...argv: ReadonlyArray<string>) => run(cwd, env, [SCRIPT, ...argv])
    const btrfsCalls = () => lines(readFileSync(btrfsLog, "utf8"))
    const workCalls = () => lines(readFileSync(join(p.w.dir, "work-calls"), "utf8")).filter((line) => /\b(rm|gc)\b/.test(line))
    return { path, secret, linked, proc, mounts, table, subvolumes, env, wr, btrfsCalls, workCalls }
  }

  test(
    "remove of a half-made workspace (no .git, no record) says what it is and deletes that one folder for good: a link in it is unlinked, not followed; --dry-run deletes nothing; a btrfs subvolume goes by one btrfs subvolume delete of its path",
    () => {
      const p = purgeBench("half-made")
      const h = halfMade(p)
      const before = p.files()
      expect(Object.keys(before)).toContain(join(h.path, "src/index.ts"))

      const dry = h.wr(p.w.app, "remove", "--dry-run", h.path)
      expect(dry.code, dry.err).toBe(0)
      expect(dry.out).toContain(`half-made workspace: ${h.path}`)
      expect(dry.out).toContain("no .git, no record in any work base")
      expect(dry.out).toContain("5 entries")
      expect(dry.out).toContain("no process works in it or holds a file open under it")
      expect(dry.out).toContain("a plain folder")
      expect(lines(dry.out).at(-1)).toBe(`would delete: ${h.path}`)
      expect(p.files()).toEqual(before)

      const ran = h.wr(p.w.app, "remove", h.path)
      expect(ran.code, ran.err).toBe(0)
      expect(lines(ran.out).at(-1)).toBe(`deleted: ${h.path}`)
      expect(existsSync(h.path)).toBe(false)
      // Only its files went: the linked folder, the .env's target, the siblings, the base, the trash all stay.
      expect(p.files()).toEqual(p.without(before, h.path))
      expect(readFileSync(h.secret, "utf8")).toBe("KEEP=1\n")
      expect(readFileSync(join(h.linked, "keep.txt"), "utf8")).toBe("linked\n")
      expect(readdirSync(p.trash)).toEqual(p.oldTrash)
      expect(h.workCalls()).toEqual([])
      expect(h.btrfsCalls()).toEqual([])
      expect(p.w.active(p.w.app).map((each) => each.path).sort()).toEqual([p.one, p.two, p.three].sort())

      // The same folder as a btrfs subvolume with no record: one `btrfs subvolume delete` of that exact path.
      const sub = join(p.w.root, ".work/app/scratch-sub")
      mkdirSync(join(sub, "inner"), { recursive: true })
      writeFileSync(join(sub, "inner/a.txt"), "a\n")
      symlinkSync(h.secret, join(sub, ".env"))
      writeFileSync(h.subvolumes, `${sub}\n`)
      const subBefore = p.files()
      const gone = h.wr(p.w.app, "remove", sub)
      expect(gone.code, gone.err).toBe(0)
      expect(gone.out).toContain("a btrfs subvolume with no record")
      expect(lines(gone.out).at(-1)).toBe(`deleted: ${sub}`)
      expect(h.btrfsCalls()).toEqual([`subvolume delete ${sub}`])
      expect(existsSync(sub)).toBe(false)
      expect(p.files()).toEqual(p.without(subBefore, sub))
      expect(readFileSync(h.secret, "utf8")).toBe("KEEP=1\n")
    },
    60_000,
  )

  test(
    "remove refuses, and deletes nothing, any folder but an absolute, resolved direct child of a base's .work/<repo>/ with no .git, no record, no mount, no process and no running create",
    () => {
      const p = purgeBench("half-made-refuse")
      const h = halfMade(p)
      const root = p.w.root
      const viaLink = join(p.w.dir, "link-to-half")
      symlinkSync(h.path, viaLink)
      const ghost = join(root, ".work/ghost/x")
      mkdirSync(ghost, { recursive: true })
      const withGit = join(root, ".work/app/with-git")
      mkdirSync(withGit)
      writeFileSync(join(withGit, ".git"), "gitdir: /nonexistent/loop-probe-x\n")
      // feat-three with its .git moved aside, and a subvolume: its record names it. (A trashed record names its
      // trash folder, which is work's own, not the path it had.)
      renameSync(join(p.three, ".git"), join(p.three, ".git-aside"))
      writeFileSync(h.subvolumes, `${p.three}\n`)
      const flock = join(p.w.bin, "flock")
      const cases: ReadonlyArray<{ label: string; cwd?: string; arg: string; says: string; arrange?: () => void; undo?: () => void; env?: Env }> = [
        { label: "relative", cwd: join(root, ".work/app"), arg: "scratch-vfy-sync-parity", says: "absolute path" },
        { label: "through a link", arg: viaLink, says: "symbolic link" },
        { label: "through ..", arg: `${root}/.work/app/../app/scratch-vfy-sync-parity`, says: `resolves to ${h.path}` },
        { label: "the storage folder", arg: join(root, ".work/app"), says: "not a direct child of a .work/<repo>/ folder" },
        { label: "the trash", arg: p.trash, says: "work's own" },
        { label: "a folder of no base", arg: ghost, says: "no work base" },
        { label: "unrelated", arg: p.unrelated, says: "not a direct child of a .work/<repo>/ folder" },
        { label: "a .git file", arg: withGit, says: "holds a .git" },
        { label: "a live record, a subvolume", arg: p.three, says: "record" },
        {
          label: "a mount point",
          arg: h.path,
          says: "mount",
          arrange: () => writeFileSync(h.mounts, `${h.table}40 22 0:40 / ${h.path} rw - tmpfs tmpfs rw\n`),
          undo: () => writeFileSync(h.mounts, h.table),
        },
        {
          label: "a mount below",
          arg: h.path,
          says: "mount",
          arrange: () => writeFileSync(h.mounts, `${h.table}40 22 0:40 / ${h.path}/src rw - tmpfs tmpfs rw\n`),
          undo: () => writeFileSync(h.mounts, h.table),
        },
        {
          label: "a process's working folder",
          arg: h.path,
          says: "pid 4242",
          arrange: () => {
            mkdirSync(join(h.proc, "4242"))
            symlinkSync(join(h.path, "src"), join(h.proc, "4242/cwd"))
          },
          undo: () => rmSync(join(h.proc, "4242"), { recursive: true }),
        },
        {
          label: "a process's open file",
          arg: h.path,
          says: "pid 4243",
          arrange: () => {
            mkdirSync(join(h.proc, "4243/fd"), { recursive: true })
            symlinkSync(join(h.path, "package.json"), join(h.proc, "4243/fd/7"))
          },
          undo: () => rmSync(join(h.proc, "4243"), { recursive: true }),
        },
        { label: "no mount table to read", arg: h.path, says: "mount table", env: { ...h.env, WORKRIFT_PROC: join(p.w.dir, "no-proc") } },
        {
          label: "a create holds the base's lock",
          arg: h.path,
          says: "lock",
          arrange: () => exe(flock, "#!/bin/sh\nexit 1\n"),
          undo: () => exe(flock, "#!/bin/sh\nexit 0\n"),
        },
      ]
      const before = p.files()
      for (const each of cases) {
        each.arrange?.()
        const ran = run(each.cwd ?? p.w.app, each.env ?? h.env, [SCRIPT, "remove", each.arg])
        each.undo?.()
        expect({ label: each.label, code: ran.code }).toEqual({ label: each.label, code: 1 })
        expect(ran.err, each.label).toContain(each.says)
        expect(ran.out, each.label).not.toContain("deleted")
        expect(p.files(), each.label).toEqual(before)
        expect(h.btrfsCalls(), each.label).toEqual([])
        expect(h.workCalls(), each.label).toEqual([])
      }
      for (const kept of [h.path, withGit, ghost, p.three, p.trash, viaLink]) expect(existsSync(kept)).toBe(true)
      expect(readFileSync(h.secret, "utf8")).toBe("KEEP=1\n")
      renameSync(join(p.three, ".git-aside"), join(p.three, ".git"))
    },
    60_000,
  )

  test(
    "remove takes a workspace whose commits a land put on origin's main from elsewhere, or whose only unpushed commits are clean merges of pushed parents; a commit behind such a merge, or a merge with an edit of its own, is still refused",
    () => {
      const w = workBench("remove-landed", work)
      const wr = (cwd: string, ...argv: ReadonlyArray<string>) => run(cwd, { ...w.env, WORKRIFT_PURGE: "0" }, [SCRIPT, ...argv])
      const commitIn = (path: string, file: string, message: string) => {
        writeFileSync(join(path, file), `${message}\n`)
        sh(path, w.env, "git", "add", file)
        sh(path, w.env, "git", "commit", "-q", "-m", message)
      }
      const mergeMain = (path: string) => {
        sh(path, w.env, "git", "fetch", "-q", "origin")
        sh(path, w.env, "git", "merge", "-q", "--no-edit", "origin/main")
      }

      // Landed: the branch was never pushed; a land in another workspace pushed its commit as origin's main, so
      // this workspace's origin/main does not know it.
      const landed = w.create(w.app, "feat/landed")
      commitIn(landed, "landed.txt", "landed")
      const seed = join(w.dir, "seed")
      sh(seed, w.env, "git", "fetch", "-q", landed, "feat/landed")
      sh(seed, w.env, "git", "push", "-q", "origin", "FETCH_HEAD:refs/heads/main")
      expect(sh(landed, w.env, "git", "rev-parse", "origin/main")).not.toBe(sh(landed, w.env, "git", "rev-parse", "HEAD"))
      let ran = wr(w.app, "remove", landed)
      expect(ran.code, ran.err).toBe(0)
      expect(existsSync(landed)).toBe(false)

      // Merged: its branch pushed, then origin's main merged in here, cleanly, and the merge not pushed.
      const merged = w.create(w.app, "feat/merged")
      commitIn(merged, "merged.txt", "merged")
      sh(merged, w.env, "git", "push", "-q", "origin", "feat/merged")
      w.push("main", { "later.txt": "later\n" })
      mergeMain(merged)
      expect(sh(merged, w.env, "git", "rev-list", "--count", "HEAD", "--not", "--remotes").trim()).toBe("1")
      ran = wr(w.app, "remove", merged)
      expect(ran.code, ran.err).toBe(0)
      expect(existsSync(merged)).toBe(false)

      // A commit only here, then a clean merge of pushed main over it: the commit is still refused, by name.
      const hidden = w.create(w.app, "feat/hidden")
      commitIn(hidden, "hidden.txt", "only here behind a merge")
      w.push("main", { "again.txt": "again\n" })
      mergeMain(hidden)
      ran = wr(w.app, "remove", hidden)
      expect(ran.code).toBe(1)
      expect(ran.err).toContain("commits on no remote")
      expect(ran.err).toContain("only here behind a merge")
      expect(existsSync(hidden)).toBe(true)

      // A merge of pushed parents that carries an edit of its own (amended into it): refused.
      const edited = w.create(w.app, "feat/edited")
      commitIn(edited, "edited.txt", "edited")
      sh(edited, w.env, "git", "push", "-q", "origin", "feat/edited")
      w.push("main", { "third.txt": "third\n" })
      mergeMain(edited)
      writeFileSync(join(edited, "own.txt"), "own\n")
      sh(edited, w.env, "git", "add", "own.txt")
      sh(edited, w.env, "git", "commit", "-q", "--amend", "--no-edit")
      ran = wr(w.app, "remove", edited)
      expect(ran.code).toBe(1)
      expect(ran.err).toContain("commits on no remote")
      expect(existsSync(edited)).toBe(true)
    },
    60_000,
  )

  test(
    "prune lists by Rift's rules what it would remove, skips a base with a kept path, and calls no work gc while gc is held",
    () => {
      const w = workBench("prune", work)
      const lib = w.base("lib")
      const idle = [w.create(w.app, "idle/one"), w.create(w.app, "idle/two")]
      const kept = w.create(lib, "kept")
      const libIdle = w.create(lib, "lib/idle")
      writeFileSync(join(idle[1] ?? "", "unsaved.txt"), "keep me in the archive\n")
      // Age every record three days: `since` is the eighth field of a registry `put` line.
      const old = Math.floor(Date.now() / 1000) - 3 * 86400
      for (const base of ["app", "lib"]) {
        const registry = join(w.root, ".work", base, ".registry")
        writeFileSync(registry, readFileSync(registry, "utf8").replace(/^(put(?:\t[^\t]*){6}\t)\d+/gm, `$1${old}`))
      }
      const fresh = w.create(w.app, "fresh")
      const keep = join(w.home, ".config/workrift/keep")
      writeFileSync(keep, `${kept}\n`)

      // A logging work: what prune asks of it, with the base it names.
      const calls = join(w.dir, "work-calls")
      exe(join(w.bin, "work-logged"), `#!/bin/sh\nprintf '%s %s\\n' "\${WORK_BASE:-}" "$*" >>'${calls}'\nexec '${work}' "$@"\n`)
      const env = { ...w.env, WORK: join(w.bin, "work-logged") }

      // Rift's rules read the folder, not the record: age every file and folder of the idle ones three days,
      // then write one file in the workspace made on idle-one, which keeps it and so its parent.
      const age = (path: string) => {
        if (lstatSync(path).isSymbolicLink()) return
        if (lstatSync(path).isDirectory()) for (const entry of readdirSync(path)) age(join(path, entry))
        utimesSync(path, old, old)
      }
      const onName = w.active(w.app).find((each) => each.path === idle[0])?.name ?? ""
      const nested = (JSON.parse(w.inBase(w.app, "--json", "new", "-on", onName, "-branch", "nested", "nested")) as { path: string }).path
      for (const path of [...idle, nested, kept, libIdle]) age(path)
      writeFileSync(join(nested, "fresh-edit.txt"), "today\n")
      const listing = [
        `skip parent of kept workspaces: ${idle[0]}`,
        `would remove: ${idle[1]}`,
        `skip recent: ${nested}`,
        `skip recent: ${fresh}`,
        `skip base with kept workspaces: ${lib} (kept: ${kept})`,
      ].sort()
      const everyone = () => [...w.active(w.app), ...w.active(lib)].map((each) => each.path).sort()
      const before = everyone()

      const dry = run(w.app, env, [SCRIPT, "prune", "--dry-run"])
      expect(dry.code, dry.err).toBe(0)
      expect(lines(dry.out).sort()).toEqual(listing)

      // work gc is held (work's own verify found it can lose data): prune lists the same and says so.
      const pruned = run(w.app, env, [SCRIPT, "prune"])
      expect(pruned.code, pruned.err).toBe(0)
      expect(lines(pruned.out)[0]).toBe("held: work gc is not safe yet (data-loss finding in work's verify)")
      expect(lines(pruned.out).slice(1).sort()).toEqual(listing)

      // No gc call reached work, nothing moved, nothing went to the trash or the archive.
      expect(lines(readFileSync(calls, "utf8")).filter((line) => /\bgc\b/.test(line))).toEqual([])
      expect(everyone()).toEqual(before)
      for (const path of before) expect(existsSync(path)).toBe(true)
      expect(readFileSync(join(idle[1] ?? "", "unsaved.txt"), "utf8")).toBe("keep me in the archive\n")
      expect(existsSync(join(w.root, ".work/app/.work-trash"))).toBe(false)
      expect(sh(w.app, w.env, "git", "for-each-ref", "refs/work/archive")).toBe("")
    },
    // Two prunes over five workspaces each scan /proc and the folders: 46 s alone at load 74 on the workbox
    // (2026-11-18), past 60 s in a full-file run there, at the parent too.
    180_000,
  )

  /**
   * A `work` that runs `real` but still lists in `--json bases` each path the file `listed-extra` beside it names, as
   * work before 34f3ef01f listed a base whose folder is gone: the installed work drops one itself, so only through
   * this does the stale-base case prove workrift's own skip (`work_bases`), whatever work version is installed.
   */
  const listingGone = (real: string) => {
    const dir = mkdtempSync(join(scratchRoot, "listing-gone-"))
    const shim = join(dir, "work")
    exe(
      shim,
      `#!/bin/sh\nif [ "$#" -eq 2 ] && [ "$1" = "--json" ] && [ "$2" = "bases" ]; then\n  listed=$('${real}' --json bases) || exit\n  extra=$(cat "${dir}/listed-extra" 2>/dev/null)\n  printf '%s' "$listed" | jq -c --arg extra "$extra" 'if $extra == "" then . else (. + [$extra] | unique) end'\n  exit\nfi\nexec '${real}' "$@"\n`,
    )
    return { shim, list: (path: string) => writeFileSync(join(dir, "listed-extra"), path) }
  }

  test.each([
    ["the installed work", false],
    ["a work that still lists the gone base (workrift's own skip)", true],
  ] as const)(
    "a base work still lists whose folder is gone is no base: create, remove, list, prune and sources skip it with no error (2026-11-16, the workbox's scratch bases), on %s",
    (_label, shimmed) => {
      const gone = listingGone(work)
      const w = workBench("stale", (shimmed && gone.shim) || work)
      // Registered before the real base, and in path order before it too: the loops reach it first.
      const stale = w.base("aa-stale")
      const real = w.base("zz-real")
      rmSync(stale, { recursive: true, force: true })
      // Older work binaries still list it; work 34f3ef01f and later drop it themselves. Either way workrift must skip it.
      gone.list(stale)
      if (shimmed) expect(JSON.parse(sh(real, w.env, gone.shim, "--json", "bases"))).toContain(stale)

      const made = w.wr(real, "create", "feat/after-stale")
      expect(made.code, made.err).toBe(0)
      expect(made.err).not.toContain(stale)
      const path = lines(made.out).at(-1) ?? ""
      expect(w.active(real).map((each) => each.path)).toEqual([path])

      const listed = w.wr(real, "list")
      expect(listed.code, listed.err).toBe(0)
      expect(lines(listed.out)).toEqual([path])

      const sources = w.wr(real, "sources")
      expect(sources.code, sources.err).toBe(0)
      expect(lines(sources.out).sort()).toEqual([w.app, real].sort())

      const dry = w.wr(real, "prune", "--dry-run")
      expect(dry.code, dry.err).toBe(0)
      expect(dry.out).not.toContain(stale)
      expect(dry.err).toBe("")

      const removed = w.wr(real, "remove", path)
      expect(removed.code, removed.err).toBe(0)
      expect(w.active(real)).toEqual([])
    },
    30_000,
  )

  test("sources prints work bases, one path a line, and check finds the base of an adopted or plain checkout", () => {
    const w = workBench("sources", work)
    const lib = w.base("lib")
    expect(lines(sh(w.app, w.env, SCRIPT, "sources"))).toEqual(JSON.parse(w.inBase(w.app, "--json", "bases")))
    expect(lines(sh(w.app, w.env, SCRIPT, "sources")).sort()).toEqual([w.app, lib].sort())
    const path = w.create(w.app, "feat/check")
    expect(sh(join(path), w.env, SCRIPT, "check").trim()).toBe(`Warm source checks passed: ${w.app}`)
    expect(sh(lib, w.env, SCRIPT, "check").trim()).toBe(`Warm source checks passed: ${lib}`)
  })
})
