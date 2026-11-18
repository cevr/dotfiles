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
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
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
      expect(after).toEqual(before)
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

      // A failed warm step warns, records nothing, and runs again at the next deps.
      sh(path, w.env, "git", "switch", "-q", "--detach", "origin/feat/x")
      sh(path, w.env, "git", "config", "workrift.warm", "exit 3")
      const failed = w.wr(path, "deps")
      expect(failed.code).toBe(0)
      expect(failed.err).toContain("warm step failed")
      sh(path, w.env, "git", "config", "workrift.warm", `git rev-parse 'HEAD^{tree}' >>'${warmed}'`)
      expect(w.wr(path, "deps").code).toBe(0)
      expect(trees()).toEqual([mainTree, xTree, mainTree, xTree])
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
    "remove refuses a workspace with uncommitted changes or commits on no remote, and trashes it clean and pushed",
    () => {
      const w = workBench("remove", work)
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
    60_000,
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
