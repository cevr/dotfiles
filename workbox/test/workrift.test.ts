// workbox/bin/workrift, run for real in a scratch HOME with a bare origin, a
// no-op `flock` (macOS has none) and WORKRIFT_ROOT inside the scratch folder.
// It runs over the `work` binary WORK_BIN names (a backend file, when there is
// one, must say `work`: any other word stops every command before it does
// anything), held to a reference model and to the
// workflow the Rift backend gave: refresh first, track origin's branch,
// install once, gh stack metadata, the removal rule, a prune that spares kept
// bases. Nothing here touches the real host: every path is under the scratch.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { hangGuard } from "../../opencode/tests/hang-guard.ts"

const repo = join(import.meta.dir, "..", "..")
// WORKRIFT_SCRIPT runs the suite against another script (an older one, for a test's red run).
const SCRIPT = process.env.WORKRIFT_SCRIPT ?? join(repo, "workbox/bin/workrift")
const WORK_BIN = process.env.WORK_BIN ?? Bun.which("work") ?? undefined

const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "workrift-test-")))
/** A planted ticket's since (2026-11-18): workrift reads it only to name the time in words. */
const TICKET_SINCE = 1_795_000_000
// Hang guard, not a cleanup performance requirement. This tree holds every workspace the suite created.
const CLEANUP_HANG_GUARD_MS = 120_000
afterAll(() => rm(scratchRoot, { recursive: true, force: true }), CLEANUP_HANG_GUARD_MS)
let scratchCount = 0

// Run the real registered afterAll in a child runner. The child can pass its
// own test even if the hook never removes anything; only the parent judges it.
describe("workrift suite cleanup", () => {
  test.skipIf(!process.env.WORKRIFT_CLEANUP_WITNESS)("publish a scratch tree for the cleanup witness", () => {
    const witness = process.env.WORKRIFT_CLEANUP_WITNESS
    if (!witness) throw new Error("missing cleanup witness file")
    mkdirSync(join(scratchRoot, "nested"))
    writeFileSync(join(scratchRoot, "nested", "keep-until-teardown"), "fixture")
    writeFileSync(witness, scratchRoot)
  })

  test("the registered cleanup removes the scratch tree after the test exits", async () => {
    const witness = join(scratchRoot, "cleanup-witness")
    const child = Bun.spawn(
      [process.execPath, "test", import.meta.path, "-t", "publish a scratch tree for the cleanup witness"],
      { env: { ...process.env, TMPDIR: scratchRoot, WORKRIFT_CLEANUP_WITNESS: witness }, stdout: "ignore", stderr: "pipe" },
    )
    const watchdog = setTimeout(() => child.kill(), 15_000)
    try {
      const errors = await new Response(child.stderr).text()
      expect(await child.exited, errors).toBe(0)
      const tree = readFileSync(witness, "utf8")
      expect(tree).toStartWith(join(scratchRoot, "workrift-test-"))
      expect(existsSync(tree), `registered cleanup left ${tree}`).toBe(false)
    } finally {
      clearTimeout(watchdog)
    }
  }, 30_000)
})

type Env = Record<string, string>

interface Ran {
  readonly code: number
  readonly out: string
  readonly err: string
}

/** Whether the process `pid` still runs. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The pids of the base advances a create's stderr says it started in the background. */
const advancePids = (err: string) => [...err.matchAll(/advance in the background \(pid (\d+)/g)].map((m) => Number(m[1]))

/**
 * Runs `argv` and, when it is a create that started an advance of the base in the background, waits for that
 * advance to end, so a test reads the base as the advance left it (a test of the overlap itself spawns its own).
 */
const run = (cwd: string, env: Env, argv: ReadonlyArray<string>): Ran => {
  const ran = Bun.spawnSync([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const err = ran.stderr.toString()
  const until = Date.now() + 60_000
  for (const pid of advancePids(err))
    while (alive(pid)) {
      if (Date.now() > until) throw new Error(`the background advance ${pid} did not end in 60 s`)
      Bun.sleepSync(20)
    }
  return { code: ran.exitCode, out: ran.stdout.toString(), err }
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

/** Every file and folder under `dir`, relative to it, sorted. */
const filesUnder = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map(String)
    .sort()

describe("workrift's backend file", () => {
  test("a backend file saying rift (the old default) or any word but work fails every command in one line naming the fix, and does nothing", () => {
    const b = bench("rift-backend")
    const app = b.clone("app")
    // A `work` that records each call: none may reach it.
    const calls = join(b.dir, "work-calls")
    exe(join(b.bin, "work"), `#!/bin/sh\nprintf '%s\\n' "$*" >>'${calls}'\nexit 0\n`)
    const file = join(b.home, ".config/workrift/backend")
    mkdirSync(dirname(file), { recursive: true })
    const verbs: ReadonlyArray<ReadonlyArray<string>> = [
      ["init", b.origin, join(b.root, "fresh")],
      ["create", "feat/x"],
      ["deps"],
      ["refresh"],
      ["advance"],
      ["hold", "--", "touch", join(b.dir, "held")],
      ["list"],
      ["remove", "feat/x"],
      ["prune"],
      ["sources"],
      ["check"],
      ["settings"],
      ["--help"],
    ]
    const cases: ReadonlyArray<readonly [string, string, Env]> = [
      ["rift", file, b.env],
      ...["Work", "rift work", ""].map((word): readonly [string, string, Env] => [word, file, b.env]),
      ["zfs", join(b.dir, "elsewhere"), { ...b.env, WORKRIFT_BACKEND_FILE: join(b.dir, "elsewhere") }],
    ]
    for (const [word, at, env] of cases) {
      writeFileSync(at, `${word}\n`)
      const before = { root: filesUnder(b.root), home: filesUnder(b.home), dir: filesUnder(b.dir) }
      for (const argv of verbs) {
        const ran = run(app, { ...env, WORK: join(b.bin, "work") }, [SCRIPT, ...argv])
        const said = { word, argv: argv.join(" "), code: ran.code, out: ran.out, err: ran.err }
        expect(said).toEqual({
          word,
          argv: argv.join(" "),
          code: 1,
          out: "",
          err: `workrift: ${at} says '${word.replace(/\s/g, "")}', but work is the only backend now (Rift is gone): write work into it (printf 'work\\n' >${at})\n`,
        })
      }
      expect({ root: filesUnder(b.root), home: filesUnder(b.home), dir: filesUnder(b.dir) }).toEqual(before)
    }
    expect(existsSync(calls)).toBe(false)
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

  test("with no backend file it runs on work, as with one saying work (before the Rift backend went, no file meant Rift)", () => {
    const w = workBench("absent", work)
    rmSync(w.file)
    const sources = w.wr(w.app, "sources")
    expect(sources.code, sources.err).toBe(0)
    expect(lines(sources.out)).toContain(w.app)
    const path = w.create(w.app, "feat/absent")
    expect(dirname(path)).toBe(join(w.root, ".work", "app"))
    expect(sh(path, w.env, "git", "branch", "--show-current").trim()).toBe("feat/absent")
    expect(lines(w.wr(w.app, "list").out)).toEqual([path])
    const removed = w.wr(w.app, "remove", "feat/absent")
    expect(removed.code, removed.err).toBe(0)
    expect(existsSync(path)).toBe(false)
  }, hangGuard("process-fixture"))

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
      // The warm source was fast-forwarded to origin's main by the advance the create started after its copy (run
      // waits for it), and the workspace starts at origin's main all the same.
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

      // A new lock on main: the copy is made of the base as it was (v1), so the workspace installs v2 once, and the
      // advance the create started after its copy installs v2 in the base once (2026-11-21: no copy waits for it).
      w.push("main", { "bun.lock": "v2\n" })
      const first = w.create(w.app, "feat/first")
      expect([...installs()].sort()).toEqual([w.app, w.app, first].sort())
      expect(readFileSync(join(first, "bun.lock"), "utf8")).toBe("v2\n")

      // A branch on origin with its own lock: the workspace installs, once.
      w.push("feat/locked", { "bun.lock": "v3\n" })
      const locked = w.create(w.app, "feat/locked")
      expect(installs().slice(3)).toEqual([locked])

      // The same lock again (the base advanced: its copy carries v2's install): nothing installs.
      w.create(w.app, "feat/same")
      expect(installs().slice(3)).toEqual([locked])
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
      // The changed lock installs once in the workspace, by one of the two (work new starts at the base's head and
      // reports its lock unchanged; the branch's comes after, by work deps), and the next `workrift deps` installs nothing.
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

  /** The Bite row of workrift's table, for a bench: its warm step and the file its .env links to. */
  const biteSettings = (w: ReturnType<typeof workBench>) => ({
    warm: `TURBO_CACHE=local:rw TURBO_CACHE_DIR=${w.root}/.cache/turbo bun run compile`,
    env: join(w.home, ".config/bite-workbox/bite-env/.env"),
  })
  /** A `bun` first on PATH that logs where it ran, its turbo cache folder and its arguments. */
  const fakeBun = (w: ReturnType<typeof workBench>) => {
    const log = join(w.dir, "bun-calls")
    exe(join(w.bin, "bun"), `#!/bin/sh\nprintf '%s %s %s\\n' "$(pwd -P)" "$TURBO_CACHE_DIR" "$*" >>'${log}'\n`)
    return () => lines(existsSync(log) ? readFileSync(log, "utf8") : "")
  }

  test(
    "init of a work base (no .rift) the table names gives it its warm step and .env link, then warms it (Bite base re-created cold, 2026-11-19)",
    () => {
      const w = workBench("init-bite", work)
      const bun = fakeBun(w)
      const want = biteSettings(w)
      const bite = join(w.root, "bite")
      const ran = w.wr(w.dir, "init", w.origin, bite)
      expect(ran.code, ran.err).toBe(0)
      expect(existsSync(join(bite, ".rift"))).toBe(false)
      expect(sh(bite, w.env, "git", "config", "--get", "workrift.warm").trim()).toBe(want.warm)
      expect(lstatSync(join(bite, ".env")).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(bite, ".env"))).toBe(want.env)
      // The refresh init ends with ran the warm step in the base, with the shared turbo cache.
      expect(bun()).toEqual([`${bite} ${w.root}/.cache/turbo run compile`])
      expect(ran.err).not.toContain("start cold")
      // The link is no change of the base: a create runs, and no note of a cold base.
      expect(sh(bite, w.env, "git", "status", "--porcelain")).toBe("")
      const made = w.wr(bite, "create", "feat/warm")
      expect(made.code, made.err).toBe(0)
      expect(made.err).not.toContain("start cold")
    },
    30_000,
  )

  test(
    "a base with no warm step and no marker: refresh and create say in one line that its workspaces start cold, and succeed",
    () => {
      const w = workBench("cold", work)
      const refreshed = w.wr(w.app, "refresh")
      expect(refreshed.code, refreshed.err).toBe(0)
      const note = `workrift: ${w.app} has no warm step (git config workrift.warm) and was never warmed; its workspaces start cold`
      expect(lines(refreshed.err).filter((line) => line.includes("start cold"))).toEqual([note])
      const made = w.wr(w.app, "create", "feat/cold")
      expect(made.code, made.err).toBe(0)
      expect(lines(made.err).filter((line) => line.includes("start cold"))).toEqual([note])
      // A base the table does not name gets nothing from init.
      expect(run(w.app, w.env, ["git", "config", "--get", "workrift.warm"]).code).not.toBe(0)
      expect(existsSync(join(w.app, ".env"))).toBe(false)
    },
    30_000,
  )

  test(
    "bootstrap's path: check finds a work base with no .rift, and settings gives it the same warm step and link as init",
    () => {
      const w = workBench("bootstrap-path", work)
      const want = biteSettings(w)
      const bite = w.base("bite")
      const env = { ...w.env, WORKRIFT_SOURCE: bite }
      // As bootstrap.sh runs them, from no checkout.
      expect(run(w.dir, env, [SCRIPT, "check"]).code).toBe(0)
      const ran = run(w.dir, env, [SCRIPT, "settings"])
      expect(ran.code, ran.err).toBe(0)
      expect(ran.err).toBe("")
      expect(sh(bite, w.env, "git", "config", "--get", "workrift.warm").trim()).toBe(want.warm)
      expect(readlinkSync(join(bite, ".env"))).toBe(want.env)
      // Again: nothing changes, nothing is said.
      const again = run(w.dir, env, [SCRIPT, "settings"])
      expect({ code: again.code, err: again.err }).toEqual({ code: 0, err: "" })
      expect(sh(bite, w.env, "git", "status", "--porcelain")).toBe("")
      // bootstrap carries no copy of its own and no .rift test: it asks workrift.
      const bootstrap = readFileSync(join(repo, "workbox/bootstrap.sh"), "utf8")
      expect(bootstrap).not.toContain("workrift.warm")
      expect(bootstrap).not.toContain(".rift")
      expect(bootstrap).toContain(`"$local_bin_dir/workrift" settings`)
    },
    30_000,
  )

  test(
    "settings keeps a warm step set to something else and an .env of its own, and reports each",
    () => {
      const w = workBench("kept", work)
      const want = biteSettings(w)
      const bite = w.base("bite")
      sh(bite, w.env, "git", "config", "workrift.warm", "make warm")
      writeFileSync(join(bite, ".env"), "own\n")
      const ran = run(w.dir, { ...w.env, WORKRIFT_SOURCE: bite }, [SCRIPT, "settings"])
      expect(ran.code, ran.err).toBe(0)
      expect(sh(bite, w.env, "git", "config", "--get", "workrift.warm").trim()).toBe("make warm")
      expect(ran.err).toContain(`${bite} keeps its warm step 'make warm'; workrift's table has '${want.warm}'`)
      expect(lstatSync(join(bite, ".env")).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(bite, ".env"), "utf8")).toBe("own\n")
      expect(ran.err).toContain(`${bite}/.env is a file of its own`)
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
   *
   * `mode` "no-trash" is work with `trash = false` (Ergo's measured answers, ergo-install-checks.md 2 to 4): `rm`
   * deletes the folder and the record at once and answers `"trash": ""`; `gc -id` of an id with no record answers
   * `{"purged":[],"idle":[]}` exit 0; the guard binary's `gc -id` of a Creating record over a .git answers the same
   * and keeps it, and its `rm` of one is `NotHeld`, exit 1. The rest is the real binary's, and only the calls
   * workrift makes are logged. In that mode, `fake-rm` makes `rm` answer `"trash": ""` for the id it expects without
   * removing the record: the folder moves into the folder the file names (it stays where it is when the file is
   * empty). Once an rm ran, `list` prints `list-lie` and exits with `list-code` while `list-lie` is there.
   * `gc-purged` (either mode) runs the real gc and answers that file's JSON as its `purged`.
   */
  const purgeBench = (label: string, mode: "trash" | "no-trash" = "trash") => {
    const w = workBench(label, work)
    const calls = join(w.dir, "work-calls")
    const failGc = join(w.dir, "fail-gc")
    const lieTrash = join(w.dir, "lie-trash")
    const noTrash = join(w.dir, "no-trash")
    const fakeRm = join(w.dir, "fake-rm")
    const rmDone = join(w.dir, "rm-done")
    const listLie = join(w.dir, "list-lie")
    const listCode = join(w.dir, "list-code")
    const gcPurged = join(w.dir, "gc-purged")
    if (mode === "no-trash") writeFileSync(noTrash, "")
    exe(
      join(w.bin, "work-logged"),
      [
        "#!/bin/sh",
        `printf '%s %s\\n' "\${WORK_BASE:-}" "$*" >>'${calls}'`,
        `real='${work}'`,
        "verb= id= last= prev=",
        "for a do",
        '  case "$a" in rm | gc | list) [ -n "$verb" ] || verb=$a ;; esac',
        '  case "$prev" in -id | -expect) id=$a ;; esac',
        "  prev=$a last=$a",
        "done",
        `[ "$verb" = gc ] && [ -e '${failGc}' ] && { echo '{"_tag":"Locked"}'; exit 1; }`,
        `[ "$verb" = gc ] && [ -e '${gcPurged}' ] && { "$real" "$@" | jq -c --argjson p "$(cat '${gcPurged}')" '.purged = $p'; exit; }`,
        `[ "$verb" = rm ] && [ -e '${lieTrash}' ] && { "$real" "$@" | jq -c --arg t "$(cat '${lieTrash}')" 'map(.trash = $t)'; exit; }`,
        `if [ -e '${noTrash}' ]; then`,
        "  creating_git() {",
        `    "$real" --json list | jq -r --arg k "$1" --arg v "$2" '.[] | select(.state._tag == "Creating" and .[$k] == $v) | .path' |`,
        '      while IFS= read -r p; do if [ -e "$p/.git" ]; then printf "%s\\n" "$p"; fi; done',
        "  }",
        '  case "$verb" in',
        "    gc)",
        `      if [ -n "$id" ] && [ -n "$(creating_git id "$id")" ]; then echo '{"purged":[],"idle":[]}'; exit 0; fi ;;`,
        "    rm)",
        "      for n do",
        '        p=$(creating_git name "$n")',
        `        if [ -n "$p" ]; then printf '{"_tag":"NotHeld","name":"%s","path":"%s"}\\n' "$n" "$p"; exit 1; fi`,
        "      done",
        `      : >'${rmDone}'`,
        `      if [ -e '${fakeRm}' ]; then`,
        `        to=$(cat '${fakeRm}')`,
        `        p=$("$real" --json list | jq -r --arg id "$id" '.[] | select(.id == $id) | .path')`,
        '        if [ -n "$to" ]; then mv "$p" "$to/" || exit 1; fi',
        `        printf '[{"name":"%s","id":"%s","trash":"","already":false}]\\n' "$last" "$id"`,
        "        exit 0",
        "      fi",
        '      out=$("$real" "$@") || { c=$?; printf "%s\\n" "$out"; exit $c; }',
        `      for i in $(printf '%s' "$out" | jq -r '.[].id'); do "$real" --json gc -id "$i" >/dev/null || exit 1; done`,
        `      printf '%s' "$out" | jq -c 'map(.trash = "")'`,
        "      exit 0 ;;",
        `    list) if [ -e '${rmDone}' ] && [ -e '${listLie}' ]; then cat '${listLie}'; exit "$(cat '${listCode}')"; fi ;;`,
        "  esac",
        "fi",
        'exec "$real" "$@"',
        "",
      ].join("\n"),
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
          // work's own bookkeeping, and workrift's (.workrift: the base's lock queue, which a removal takes its ticket in).
          if (entry === ".git" || entry === ".work-trash" || entry === ".workrift" || entry.startsWith(".registry") || entry.startsWith(".lock")) continue
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
    return { w, env, wr, lib, one, two, three, other, plain, unrelated, trash, oldTrash, failGc, lieTrash, fakeRm, rmDone, listLie, listCode, gcPurged, files, without, gcCalls }
  }
  /** The gc calls a removal of these ids makes: one `gc -id` each when work trashed them, none when it deleted them. */
  const gcFor = (mode: "trash" | "no-trash", base: string, ids: ReadonlyArray<string>) =>
    mode === "trash" ? ids.map((id) => `${base} --json gc -id ${id}`).sort() : []

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
    hangGuard("installer"),
  )

  test.each(["trash", "no-trash"] as const)(
    "on the workbox (work's %s) remove deletes the one workspace for good, by work gc -id when work trashed it: its siblings, the base, another base's workspace, a plain folder beside it, an unrelated folder and a workspace already in the trash all stay",
    (mode) => {
      const p = purgeBench("purge", mode)
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
      expect(p.gcCalls()).toEqual(gcFor(mode, p.w.app, [id]))
      // Its record is gone, not trashed; the others are as they were.
      expect(p.w.listed(p.w.app).some((each) => each.id === id)).toBe(false)
      expect(p.w.active(p.w.app).map((each) => each.path).sort()).toEqual([p.one, p.three].sort())
      expect(p.w.active(p.lib).map((each) => each.path)).toEqual([p.other])
      // The name is free again: no -2 suffix.
      expect(p.w.create(p.w.app, "feat/two")).toBe(p.two)
    },
    hangGuard("installer"),
  )

  test.each(["trash", "no-trash"] as const)(
    "(work's %s) remove --dry-run prints the exact folders it would delete and changes nothing; --with-children deletes the workspace and the one made on it, each by its own id",
    (mode) => {
      const p = purgeBench("purge-tree", mode)
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
      expect(p.gcCalls().sort()).toEqual(gcFor(mode, p.w.app, ids))
      for (const id of ids) expect(p.w.listed(p.w.app).some((each) => each.id === id)).toBe(false)
    },
    hangGuard("installer"),
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
    hangGuard("installer"),
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
    hangGuard("installer"),
  )

  test(
    "a work gc -id that answers another purge than the one name rm trashed is reported, not taken as deleted",
    () => {
      const p = purgeBench("purge-other")
      writeFileSync(p.gcPurged, '["feat-one"]')
      const ran = p.wr(p.w.app, "remove", p.two)
      expect(ran.code).toBe(1)
      expect(ran.out).not.toContain("deleted:")
      expect(ran.err).toContain('["feat-one"]')
      expect(ran.err).toContain("not deleted")
      expect(existsSync(p.one)).toBe(true)
    },
    hangGuard("installer"),
  )

  test(
    'with work\'s trash = false, a work rm that answers "trash": "" while the folder is still there, or its record is still listed (moved to the trash, or kept), is no deletion: workrift says what is left and exits 1',
    () => {
      const p = purgeBench("notrash-unproven", "no-trash")
      const aside = join(p.w.dir, "aside")
      mkdirSync(aside)
      const idOf = (path: string) => p.w.active(p.w.app).find((each) => each.path === path)?.id ?? ""
      const twoId = idOf(p.two)

      // rm answered no trash, but deleted nothing: the folder and the record are there.
      writeFileSync(p.fakeRm, "")
      const kept = p.wr(p.w.app, "remove", p.two)
      expect(kept.code).toBe(1)
      expect(kept.out).not.toContain("deleted:")
      expect(kept.err).toContain(`${p.two} is still there`)
      expect(existsSync(join(p.two, "mark.txt"))).toBe(true)

      // rm answered no trash and the folder went, but the record stays.
      rmSync(p.rmDone, { force: true })
      writeFileSync(p.fakeRm, aside)
      const listed = p.wr(p.w.app, "remove", p.two)
      expect(listed.code).toBe(1)
      expect(listed.out).not.toContain("deleted:")
      expect(listed.err).toContain(`still lists id ${twoId}`)
      renameSync(join(aside, "feat-two"), p.two)
      expect(p.gcCalls()).toEqual([])

      // The real binary trashed it but answered no trash: its Trashed record is still listed, and the trash stays.
      rmSync(p.fakeRm)
      const real = purgeBench("notrash-lie")
      writeFileSync(real.lieTrash, "")
      const lied = real.wr(real.w.app, "remove", real.two)
      expect(lied.code).toBe(1)
      expect(lied.out).not.toContain("deleted:")
      expect(lied.err).toContain("still lists id")
      expect(readdirSync(real.trash).length).toBe(real.oldTrash.length + 1)
      expect(real.gcCalls()).toEqual([])
    },
    hangGuard("installer"),
  )

  test(
    'with work\'s trash = false, after a work rm that answered "trash": "", a work --json list that is not a list of records, or fails, is no proof: workrift refuses to say deleted',
    () => {
      const p = purgeBench("notrash-list", "no-trash")
      const aside = join(p.w.dir, "aside")
      mkdirSync(aside)
      writeFileSync(p.fakeRm, aside)
      const outcomes = malformedLists(p.two).map((each) => {
        rmSync(p.rmDone, { force: true })
        writeFileSync(p.listLie, each.answer)
        writeFileSync(p.listCode, `${each.code}\n`)
        const ran = p.wr(p.w.app, "remove", p.two)
        rmSync(p.listLie)
        if (existsSync(join(aside, "feat-two"))) renameSync(join(aside, "feat-two"), p.two)
        return { label: each.label, code: ran.code, deleted: ran.out.includes("deleted:"), says: ran.err.includes("work --json list") }
      })
      expect(outcomes).toEqual(malformedLists(p.two).map((each) => ({ label: each.label, code: 1, deleted: false, says: true })))
    },
    hangGuard("installer"),
  )

  test("a jq that fails on work's list of workspaces is no empty list: nothing is deleted, the trash is named (no workspace kept is told from it otherwise)", () => {
    const p = purgeBench("purge-jq")
    const shim = failingShim(p.w.dir, "jq", 5)
    // m2-pactive: the list's jq failing read as no active workspace, so a trash holding one would have passed.
    const ran = run(p.w.app, { ...p.env, PATH: `${shim}:${p.env.PATH}`, FAKE_JQ_FAIL: '.[] | select(.state._tag == "Active") | .path' }, [SCRIPT, "remove", p.two])
    expect(ran.code).toBe(1)
    expect(ran.err).toContain("work's list of workspaces does not read (jq failed)")
    expect(ran.err).toContain("nothing deleted, the trash stays")
    expect(ran.out).not.toContain("deleted:")
    expect(p.gcCalls()).toEqual([])
  }, hangGuard("installer"))

  test("with work's trash = false, a jq -e that fails (neither listed nor not) on the list after the rm is no proof: workrift refuses to say deleted", () => {
    const p = purgeBench("notrash-jq", "no-trash")
    const aside = join(p.w.dir, "aside")
    mkdirSync(aside)
    writeFileSync(p.fakeRm, aside)
    const shim = failingShim(p.w.dir, "jq", 5)
    // m3-jqe: any status but 0 (listed) read as not listed, so a jq that failed said deleted.
    const ran = run(p.w.app, { ...p.env, PATH: `${shim}:${p.env.PATH}`, FAKE_JQ_FAIL: "any(.[]; .id == $id)" }, [SCRIPT, "remove", p.two])
    expect(ran.code).toBe(1)
    expect(ran.err).toContain("does not read (jq status 5)")
    expect(ran.out).not.toContain("deleted:")
  }, hangGuard("installer"))

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
    // A flock that answers held for each lock file the file `held` names (a maker still copying holds its
    // reservation's .lock-<id>), and free for anything else, the fd form workrift takes its own lock with included.
    const held = join(p.w.dir, "held")
    writeFileSync(held, "")
    exe(join(p.w.bin, "flock"), `#!/bin/sh\nfor a do\n  if [ -e "$a" ] && grep -qxF -- "$a" '${held}'; then exit 1; fi\ndone\nexit 0\n`)
    const env: Env = { ...p.env, WORKRIFT_PROC: proc }
    const wr = (cwd: string, ...argv: ReadonlyArray<string>) => run(cwd, env, [SCRIPT, ...argv])
    const btrfsCalls = () => lines(readFileSync(btrfsLog, "utf8"))
    const workCalls = () => lines(readFileSync(join(p.w.dir, "work-calls"), "utf8")).filter((line) => /\b(rm|gc)\b/.test(line))
    const home = join(p.w.root, ".work/app")
    /**
     * A record in state Creating for the folder `name` of app's storage, `ageS` seconds old, written as a `work new`
     * cut between its reservation and its clone leaves it: the registry line work itself writes (put, name, path,
     * parent, branch, no cloner, creating, since, base commit, latest, id, deps, token, moving).
     */
    const creating = (name: string, id: string, ageS: number) => {
      const since = Math.floor(Date.now() / 1000) - ageS
      const start = sh(p.w.app, p.w.env, "git", "rev-parse", "HEAD").trim()
      writeFileSync(
        join(home, ".registry"),
        `put\t"${name}"\t"${join(home, name)}"\t"${p.w.app}"\t"${name}"\t""\tcreating\t${since}\t"${start}"\t""\t"${id}"\t""\t""\t""\t-\t0\n`,
        { flag: "a" },
      )
      return join(home, name)
    }
    /** Every record of app, in any state, as `name state`. */
    const records = () => p.w.listed(p.w.app).map((each) => `${each.name} ${each.state._tag}`).sort()
    return { path, secret, linked, proc, mounts, table, subvolumes, held, env, wr, btrfsCalls, workCalls, home, creating, records }
  }

  test.each(["trash", "no-trash"] as const)(
    "(work's %s) remove of a create cut mid-way whose record says Creating (the real scratch-vfy-sync-parity: 7 hours old, no .git, a few files, a .env link) shows its proof, and deletes the folder and the record by work gc -id; --dry-run removes nothing",
    (mode) => {
      const p = purgeBench("creating", mode)
      const h = halfMade(p)
      const id = "e314d2db38131c91"
      expect(h.creating("scratch-vfy-sync-parity", id, 7 * 3600)).toBe(h.path)
      expect(h.records()).toContain("scratch-vfy-sync-parity Creating")
      const before = p.files()
      const recordsBefore = h.records()

      const dry = h.wr(p.w.app, "remove", "--dry-run", h.path)
      expect(dry.code, dry.err).toBe(0)
      for (const proof of [
        `half-made workspace: ${h.path}`,
        `record scratch-vfy-sync-parity (id ${id}) of ${p.w.app} is Creating, 7h old (at least 60 minutes)`,
        "no .git (a live lane has one)",
        "no create running: its reservation lock is free and no workrift create holds the base's lock",
        "no mount at or below it",
        "no process works in it or holds a file open under it",
        "5 entries",
        `work gc -id ${id}`,
      ])
        expect(dry.out).toContain(proof)
      expect(lines(dry.out).at(-1)).toBe(`would delete: ${h.path}`)
      expect(p.files()).toEqual(before)
      expect(h.records()).toEqual(recordsBefore)
      expect(h.workCalls()).toEqual([])

      const ran = h.wr(p.w.app, "remove", h.path)
      expect(ran.code, ran.err).toBe(0)
      expect(lines(ran.out).at(-1)).toBe(`deleted: ${h.path}`)
      expect(existsSync(h.path)).toBe(false)
      // work's own command took the folder and the record together, and nothing else.
      expect(h.workCalls()).toEqual([`${p.w.app} --json gc -id ${id}`])
      expect(h.records()).toEqual(recordsBefore.filter((each) => !each.startsWith("scratch-vfy-sync-parity ")))
      expect(p.files()).toEqual(p.without(before, h.path))
      expect(readFileSync(h.secret, "utf8")).toBe("KEEP=1\n")
      expect(readFileSync(join(h.linked, "keep.txt"), "utf8")).toBe("linked\n")
      expect(h.btrfsCalls()).toEqual([])
    },
    60_000,
  )

  test.each(["trash", "no-trash"] as const)(
    "(work's %s) remove refuses a Creating record that holds a .git (a live lane with a stale record), one whose create still runs, one too young, and one a process works in; nothing changes",
    (mode) => {
      const p = purgeBench("creating-refuse", mode)
      const h = halfMade(p)
      // A live lane: a complete clone with its .git, whose create never recorded its end; 13 hours old.
      const lane = h.creating("cristian-lab-bare-lab-cli", "1111111111111111", 13 * 3600)
      sh(p.w.dir, p.w.env, "git", "clone", "-q", p.w.origin, lane)
      writeFileSync(join(lane, "work-in-progress.txt"), "current work\n")
      // A cut create, but its maker still holds its reservation lock.
      const running = h.creating("scratch-running", "2222222222222222", 7 * 3600)
      mkdirSync(running)
      writeFileSync(join(running, "a.txt"), "a\n")
      writeFileSync(join(h.home, ".lock-2222222222222222"), "")
      writeFileSync(h.held, `${join(h.home, ".lock-2222222222222222")}\n`)
      // A cut create made ten minutes ago.
      const young = h.creating("scratch-young", "3333333333333333", 600)
      mkdirSync(young)
      writeFileSync(join(young, "a.txt"), "a\n")
      // The real shape, 7 hours old, but a process works in it.
      h.creating("scratch-vfy-sync-parity", "e314d2db38131c91", 7 * 3600)
      mkdirSync(join(h.proc, "4242"))
      symlinkSync(join(h.path, "src"), join(h.proc, "4242/cwd"))

      const before = p.files()
      const recordsBefore = h.records()
      for (const [label, path, says] of [
        ["a live lane", lane, "looks like a live lane whose create never recorded its end"],
        ["a live lane, dry run", lane, "stale"],
        ["a create still running", running, "a create still runs"],
        ["a young record", young, "younger than 60 minutes"],
        ["a process in it", h.path, "pid 4242"],
      ] as const) {
        const argv = label.endsWith("dry run") ? ["remove", "--dry-run", path] : ["remove", path]
        const ran = h.wr(p.w.app, ...argv)
        expect({ label, code: ran.code }).toEqual({ label, code: 1 })
        expect(ran.err, label).toContain(says)
        expect(ran.out, label).not.toContain("delete")
        expect(p.files(), label).toEqual(before)
        expect(h.records(), label).toEqual(recordsBefore)
        expect(h.workCalls(), label).toEqual([])
      }
      for (const kept of [lane, running, young, h.path]) expect(existsSync(kept)).toBe(true)
      expect(readFileSync(join(lane, "work-in-progress.txt"), "utf8")).toBe("current work\n")
    },
    60_000,
  )

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
          // A create's ticket in the base's line: its record names a process that runs (this test's), and its lock is
          // held (the bench's flock answers every try with "held").
          arrange: () => {
            const queue = join(stateOf(p.w.app), "base")
            mkdirSync(queue, { recursive: true })
            const start = sh(p.w.app, { ...h.env, LC_ALL: "C", TZ: "UTC0" }, "ps", "-o", "lstart=", "-p", String(process.pid)).trim()
            writeFileSync(join(queue, "99.r"), `${process.pid}\n${start}\n${Math.floor(Date.now() / 1000)}\ncreate feat/x\n`)
            exe(flock, `#!/bin/sh\ncase " $* " in *" -n "*) exit 1 ;; esac\nexit 0\n`)
          },
          undo: () => {
            rmSync(join(stateOf(p.w.app), "base", "99.r"), { force: true })
            exe(flock, "#!/bin/sh\nexit 0\n")
          },
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

  /**
   * `work --json list` answers that are not a list of records (each with a name, id, path and state): the half-made
   * folder's record check cannot read them, so it must refuse and say why, never take "no record" from them. `answer`
   * is what the list prints, `code` its exit. The rows name the real half-made folder or a path that is none.
   */
  const malformedLists = (path: string): ReadonlyArray<{ label: string; answer: string; code: number }> => {
    const since = Math.floor(Date.now() / 1000) - 7 * 3600
    const elsewhere = "/nonexistent/loop-probe-x"
    return [
      { label: "not JSON", answer: "half a line {", code: 0 },
      { label: "not a list", answer: `{"name":"scratch-vfy-sync-parity","path":"${path}"}`, code: 0 },
      { label: "a list of no records", answer: `["${path}"]`, code: 0 },
      { label: "a row without an id", answer: `[{"name":"other","path":"${elsewhere}","state":{"_tag":"Active"},"since":${since}}]`, code: 0 },
      {
        label: "a row without a path",
        answer: `[{"name":"scratch-vfy-sync-parity","id":"e314d2db38131c91","state":{"_tag":"Creating"},"since":${since}}]`,
        code: 0,
      },
      { label: "a row without a state", answer: `[{"name":"other","id":"4444444444444444","path":"${elsewhere}","since":${since}}]`, code: 0 },
      {
        label: "a state with no tag",
        answer: `[{"name":"scratch-vfy-sync-parity","id":"e314d2db38131c91","path":"${path}","state":"Creating","since":${since}}]`,
        code: 0,
      },
      { label: "empty output, exit 0", answer: "", code: 0 },
      { label: "empty output, exit 1", answer: "", code: 1 },
      { label: "work not found", answer: "", code: 127 },
    ]
  }

  for (const withRecord of [false, true])
    test(
      `remove of a half-made folder ${withRecord ? "with a Creating record (7 hours old, maker gone)" : "with no record"} refuses, says why and deletes nothing when work's list is not a list of records, or work is missing`,
      () => {
        const p = purgeBench(withRecord ? "half-made-list-creating" : "half-made-list")
        const h = halfMade(p)
        if (withRecord) h.creating("scratch-vfy-sync-parity", "e314d2db38131c91", 7 * 3600)
        const answer = join(p.w.dir, "list-answer")
        const code = join(p.w.dir, "list-code")
        // work-logged, but its `list` prints the file list-answer and exits with list-code while they are there.
        const lying = join(p.w.bin, "work-lying")
        exe(
          lying,
          `#!/bin/sh\nfor a do\n  if [ "$a" = list ] && [ -e '${answer}' ]; then cat '${answer}'; exit "$(cat '${code}')"; fi\ndone\nexec '${p.env.WORK}' "$@"\n`,
        )
        const before = p.files()
        const recordsBefore = h.records()
        const cases = [
          ...malformedLists(h.path).map((each) => ({ ...each, work: lying, says: "work --json list" })),
          { label: "work missing", answer: undefined, code: 0, work: "/nonexistent/loop-probe-x/work", says: "work --json bases" },
        ]
        // Every case runs (a delete would end the bench, so the dry run goes last), and all are held to the rule at once.
        const outcomes = cases.map((each) => {
          if (each.answer === undefined) rmSync(answer, { force: true })
          else writeFileSync(answer, each.answer)
          writeFileSync(code, `${each.code}\n`)
          const ran = run(p.w.app, { ...h.env, WORK: each.work }, [SCRIPT, "remove", "--dry-run", h.path])
          const real = existsSync(h.path) ? run(p.w.app, { ...h.env, WORK: each.work }, [SCRIPT, "remove", h.path]) : ran
          return {
            label: each.label,
            dryRun: { code: ran.code, says: ran.err.includes(each.says), refused: ran.err.includes("nothing deleted"), out: ran.out },
            remove: { code: real.code, says: real.err.includes(each.says), refused: real.err.includes("nothing deleted"), out: real.out },
            kept: existsSync(h.path),
          }
        })
        expect(outcomes).toEqual(
          cases.map((each) => ({
            label: each.label,
            dryRun: { code: 1, says: true, refused: true, out: "" },
            remove: { code: 1, says: true, refused: true, out: "" },
            kept: true,
          })),
        )
        expect(p.files()).toEqual(before)
        expect(h.records()).toEqual(recordsBefore)
        expect(h.workCalls()).toEqual([])
        expect(h.btrfsCalls()).toEqual([])
        expect(existsSync(h.path)).toBe(true)
        expect(readFileSync(h.secret, "utf8")).toBe("KEEP=1\n")
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

/**
 * A `flock` with util-linux's semantics, through perl's flock(2), first on PATH: `flock [-s|-x] [-n] [-w secs] FD`
 * locks the open file the caller's descriptor FD holds (the lock stays with that file once this exits, as
 * util-linux's does), and `flock [-n] FILE COMMAND…` runs COMMAND holding FILE. Exit 1 when -n or -w gives up.
 */
const realFlock = (bin: string) =>
  exe(
    join(bin, "flock"),
    [
      "#!/usr/bin/perl",
      "use strict; use Fcntl qw(:flock); use Time::HiRes qw(sleep time);",
      "my ($nb, $sh, $w) = (0, 0, undef);",
      "while (@ARGV && $ARGV[0] =~ /^-/) { my $o = shift; if ($o eq '-n') { $nb = 1 } elsif ($o eq '-s') { $sh = 1 } elsif ($o eq '-w') { $w = shift } }",
      "my $t = shift; my $fh;",
      // A descriptor open for writing, or for reading only (workrift opens the older workrift's lock file read-only).
      "if ($t =~ /^\\d+$/ && !@ARGV) { open($fh, '>>&=', $t) or open($fh, '<&=', $t) or exit 64 } else { open($fh, '>>', $t) or exit 64 }",
      "my $deadline = defined $w ? time + $w : undef;",
      "until (flock($fh, ($sh ? LOCK_SH : LOCK_EX) | LOCK_NB)) { exit 1 if $nb || (defined $deadline && time >= $deadline); sleep 0.05 }",
      "if (@ARGV) { exit(system(@ARGV) >> 8) }",
      "exit 0;",
      "",
    ].join("\n"),
  )

/** A base's state folder, where workrift keeps its locks and records: beside its workspaces, outside the base. */
const stateOf = (base: string) => join(dirname(base), ".work", basename(base), ".workrift")

/**
 * Writes the base's advance stamp (seconds since the epoch, then a newline): in its state folder, and where the
 * script on main (f5d1e180) kept it, .git/workrift-advanced-at, so a test run against that script (WORKRIFT_SCRIPT)
 * is red for what it tests, not for a stamp it cannot find.
 */
const stampAdvance = (base: string, text: string) => {
  mkdirSync(stateOf(base), { recursive: true })
  writeFileSync(join(stateOf(base), "advanced-at"), text)
  writeFileSync(join(base, ".git/workrift-advanced-at"), text)
}

/**
 * A `cp` first on PATH that makes the clones work's cloners ask for (`cp -c -pPR from to` on APFS, `cp -a
 * --reflink=always -- from to` on Linux) slowly, as on the workbox (96-239 s for the Bite base): it lists the whole
 * source first, waits `delay` seconds, then copies each entry it listed, so a file removed meanwhile fails the copy
 * (`cp: <path>: No such file or directory`) as a real cp's late read of it does. Any other cp is the real one. It
 * logs each clone (target, start, end); the reader returns them.
 */
const slowCopy = (bin: string, delay: number, gate?: string) => {
  const log = join(bin, "..", "copies")
  exe(
    join(bin, "cp"),
    [
      "#!/usr/bin/perl",
      "use strict; use warnings; use File::Find (); use File::Copy (); use Time::HiRes qw(time sleep);",
      "my @a = @ARGV;",
      "my $clone = (@a == 4 && $a[0] eq '-c' && $a[1] eq '-pPR') || (@a == 5 && $a[0] eq '-a' && $a[1] eq '--reflink=always' && $a[2] eq '--');",
      "my $real = -x '/bin/cp' ? '/bin/cp' : '/usr/bin/cp';",
      "unless ($clone) { exec($real, @a) or die \"cp: $!\\n\" }",
      "my ($from, $to) = @a[-2, -1];",
      "my $start = time;",
      `open(my $begun, '>>', '${log}.begun') or die; print $begun "$to\\n"; close $begun;`,
      "my @paths;",
      "File::Find::find({ no_chdir => 1, wanted => sub { push @paths, $File::Find::name } }, $from);",
      `sleep(${delay});`,
      gate === undefined ? "" : `sleep(0.05) until -e '${gate}';`,
      "for my $p (@paths) {",
      "  my $dst = $to . substr($p, length $from);",
      "  my @st = lstat($p) or do { print STDERR \"cp: $p: No such file or directory\\n\"; exit 1 };",
      "  if (-l _) { symlink(readlink($p), $dst) or do { print STDERR \"cp: $dst: $!\\n\"; exit 1 } }",
      "  elsif (-d _) { mkdir($dst) or -d $dst or do { print STDERR \"cp: $dst: $!\\n\"; exit 1 }; chmod($st[2] & 07777, $dst) }",
      "  else { File::Copy::copy($p, $dst) or do { print STDERR \"cp: $p: $!\\n\"; exit 1 }; chmod($st[2] & 07777, $dst); utime($st[8], $st[9], $dst) }",
      "}",
      `open(my $log, '>>', '${log}') or die; printf $log "%s %.3f %.3f\\n", $to, $start, time; close $log;`,
      "exit 0;",
      "",
    ].join("\n"),
  )
  return () =>
    lines(existsSync(log) ? readFileSync(log, "utf8") : "").map((line) => {
      const [to = "", start = "0", end = "0"] = line.split(" ")
      return { to, start: Number(start), end: Number(end) }
    })
}

describeWork("workrift create under load (a create waited 1059 s on the workbox, 2026-11-20)", () => {
  const work = WORK_BIN ?? "work"

  interface Spawned {
    readonly code: number
    readonly out: string
    readonly err: string
  }
  const spawnAll = (cwd: string, env: Env, argvs: ReadonlyArray<ReadonlyArray<string>>) =>
    Promise.all(
      argvs.map(async (argv): Promise<Spawned> => {
        const child = Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" })
        const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
        return { code: await child.exited, out, err }
      }),
    )

  /** A shell test of whether the base's lock is held: a ticket (waiting or holding) in its state folder's queue. */
  const heldTest = (base: string) => `if ls '${stateOf(base)}/base/'*.[rw] >/dev/null 2>&1; then s=held; else s=free; fi`

  /** A work bench with a real flock and a warm step that logs where it ran and whether the base's lock was held. */
  const loaded = (label: string) => {
    const w = workBench(label, work)
    realFlock(w.bin)
    const warmed = join(w.dir, "warmed")
    sh(w.app, w.env, "git", "config", "workrift.warm", `${heldTest(w.app)}; printf '%s %s\\n' "$(pwd -P)" "$s" >>'${warmed}'`)
    const warms = () => lines(existsSync(warmed) ? readFileSync(warmed, "utf8") : "")
    const head = (path: string) => sh(path, w.env, "git", "rev-parse", "HEAD").trim()
    return { w, warms, head }
  }

  /** Waits until every advance a create's stderr says it started in the background has ended. */
  const settle = async (...errs: ReadonlyArray<string>) => {
    const pids = errs.flatMap(advancePids)
    const until = Date.now() + 60_000
    while (pids.some(alive)) {
      if (Date.now() > until) throw new Error(`the background advances ${pids.join(" ")} did not end in 60 s`)
      await Bun.sleep(50)
    }
    return pids
  }

  /** Seconds since the epoch, with milliseconds, as the shims log them. */
  const nowLine = `perl -MTime::HiRes=time -e 'printf "%.3f\\n", time'`

  test(
    "seven creates at once after main's lock changed: each takes the base's lock while the first is still in its copy; one advance moves and installs the base after the copies, in the background, and warms nothing; every workspace ends installed for its own lock",
    async () => {
      const { w, head } = loaded("seven")
      const installs = join(w.dir, "installs")
      const baseWarms = join(w.dir, "base-warms")
      sh(w.app, w.env, "git", "config", "workrift.install", `cat bun.lock >"$(git rev-parse --absolute-git-dir)/installed-lock"; pwd -P >>'${installs}'`)
      sh(w.app, w.env, "git", "config", "workrift.warm", `pwd -P >>'${baseWarms}'`)
      const read = (file: string) => lines(existsSync(file) ? readFileSync(file, "utf8") : "")
      w.push("main", { "bun.lock": "main-1\n" })
      expect(w.wr(w.app, "refresh").code).toBe(0)
      const warmedTree = readFileSync(join(w.app, ".git/workrift-warmed-tree"), "utf8").trim()
      const landed = w.push("main", { "bun.lock": "main-2\n" })
      // The last advance is older than the window: the next create advances the base.
      stampAdvance(w.app, `${Math.floor(Date.now() / 1000) - 601}\n`)
      const branches = Array.from({ length: 7 }, (_, i) => `feat/p${i}`)
      // Hold the first create inside work new while it still owns the base's shared lock.
      // Every other create must reach "locked" without waiting for that copy to finish.
      // A separate clone lock may serialize the actual file-copy step.
      const inClone = join(w.dir, "first-in-clone")
      const release = join(w.dir, "release-first-clone")
      const wrap = join(w.bin, "work-ordered")
      exe(wrap, [
        "#!/bin/sh",
        'case " $* " in',
        '  *" new "*" feat-p0 "*)',
        "    : >'" + inClone + "'",
        "    until [ -e '" + release + "' ]; do sleep 0.05; done ;;",
        "esac",
        "exec '" + work + "' \"$@\"",
        "",
      ].join("\n"))
      const children: Array<Grouped> = []
      const create = (branch: string, i: number) => startGroup(
        w.app, { ...w.env, WORK: wrap }, [SCRIPT, "create", branch], join(w.dir, "create-" + i + ".err"),
      )
      const results = async () => {
        try {
          children.push(create(branches[0]!, 0))
          await until("the first create at work new under the shared base lock", () => existsSync(inClone), 120_000)
          for (const [i, branch] of branches.entries()) if (i > 0) children.push(create(branch, i))
          const locked = (i: number) => new RegExp("^workrift: create " + branches[i] + ": locked \\(\\d+s\\)$", "m").test(children[i]!.err())
          await until("all seven creates holding the shared base lock before the first copy ended", () => children.every((_, i) => locked(i)), 120_000)
          expect(children.map((_, i) => locked(i))).toEqual(branches.map(() => true))
          expect(head(w.app)).not.toBe(landed)
          writeFileSync(release, "")
          return await Promise.all(children.map(async (child) => {
            const ran = await within(child, 120_000)
            if (!ran) throw new Error("create did not finish after release: " + child.err())
            return ran
          }))
        } finally {
          writeFileSync(release, "")
          for (const child of children) if (alive(child.pid)) child.kill()
        }
      }
      const ran = await results()
      const paths = ran.map((each) => lines(each.out).at(-1) ?? "")
      for (const [i, each] of ran.entries()) {
        expect(each.code, each.err).toBe(0)
        expect(lines(each.out)).toEqual([paths[i]])
      }
      const pids = await settle(...ran.map((each) => each.err))
      expect(pids.length).toBeGreaterThanOrEqual(1)
      // One advance moved the base: fast-forwarded and installed once (beside the refresh's), and warmed nothing.
      expect(head(w.app)).toBe(landed)
      expect(readFileSync(join(w.app, ".git/installed-lock"), "utf8")).toBe("main-2\n")
      expect(read(installs).filter((line) => line === w.app)).toHaveLength(2)
      expect(read(baseWarms).filter((line) => line === w.app)).toHaveLength(1)
      // Its build output stays the refresh's, and says so: the marker names the tree it was built for.
      expect(readFileSync(join(w.app, ".git/workrift-warmed-tree"), "utf8").trim()).toBe(warmedTree)
      expect(readFileSync(join(stateOf(w.app), "staleness"), "utf8").split(" ")[0]).toBe("1")
      expect(existsSync(join(stateOf(w.app), "moving"))).toBe(false)
      // Each workspace starts at today's main and ends installed for its own lock.
      for (const path of paths) {
        expect(head(path)).toBe(landed)
        expect(readFileSync(join(path, "bun.lock"), "utf8")).toBe("main-2\n")
        expect(readFileSync(join(path, ".git/installed-lock"), "utf8")).toBe("main-2\n")
      }
      // A create after the advance's end copies what it made: nothing to install, nothing to advance; it says how
      // far the base's build output lags.
      const after = w.wr(w.app, "create", "feat/after")
      expect(after.code, after.err).toBe(0)
      expect(after.err).not.toContain("advance in the background")
      expect(after.err).toContain("base: moved 1 times since its build output was made")
      const afterPath = lines(after.out).at(-1) ?? ""
      expect(read(installs)).not.toContain(afterPath)
    },
    // Hang guard for reaching the two gates, then completing the creates.
    hangGuard("deep-scenario"),
  )

  test(
    "four creates at once on a base whose last warm was cut: no advance warms it; each copy (made with no warm marker) builds itself; a refresh warms the base, under its lock",
    async () => {
      const { w, warms } = loaded("cut-warm")
      expect(w.wr(w.app, "refresh").code).toBe(0)
      // refresh warms under the exclusive lock (2026-11-22): no copy reads a base its build is writing.
      expect(warms()).toEqual([`${w.app} held`])
      // A warm cut short (a restart) leaves the marker empty.
      writeFileSync(join(w.app, ".git/workrift-warmed-tree"), "")
      const ran = await spawnAll(w.app, w.env, ["feat/a", "feat/b", "fix/c", "d"].map((branch) => [SCRIPT, "create", branch]))
      for (const each of ran) expect(each.code, each.err).toBe(0)
      await settle(...ran.map((each) => each.err))
      const paths = ran.map((each) => lines(each.out).at(-1) ?? "")
      const where = (line: string) => line.replace(/ (free|held)$/, "")
      expect(warms().slice(1).map(where).sort()).toEqual([...paths].sort())
      expect(w.wr(w.app, "refresh").code).toBe(0)
      expect(warms().at(-1)).toBe(`${w.app} held`)
    },
    60_000,
  )

  test(
    "the workspace's own install and build run after the base's lock is free, never through the hook its branch switch fires under it",
    () => {
      const { w, warms } = loaded("hook-under-lock")
      const hooked = join(w.dir, "hooked")
      // The copied post-checkout hook, as lefthook-local.yml runs it: it says whether the base's lock was held, then runs `workrift deps`.
      exe(join(w.app, ".git/hooks/post-checkout"), `#!/bin/sh\n${heldTest(w.app)}\nprintf '%s %s\\n' "$(pwd -P)" "$s" >>'${hooked}'\nexec '${SCRIPT}' deps\n`)
      expect(w.wr(w.app, "refresh").code).toBe(0)
      const before = warms()
      w.push("feat/own", { "own.txt": "own\n" })
      const path = w.create(w.app, "feat/own")
      // work new starts the workspace at the base's own head, which writes two refs and fires no hook; the move to
      // the branch is a reset after the lock is given back, which fires none either. The build ran once, the lock free.
      const fired = existsSync(hooked) ? lines(readFileSync(hooked, "utf8")) : []
      expect(fired.filter((line) => line.startsWith(`${path} `))).not.toContain(`${path} held`)
      expect(warms()).toEqual([...before, `${path} free`])
    },
    60_000,
  )

  test(
    "main moving between creates advances the base at most once a window, without warming it; a lane in the window starts at today's main, installs a changed lock and builds itself",
    () => {
      const { w, warms, head } = loaded("window")
      const installs = join(w.dir, "installs")
      sh(w.app, w.env, "git", "config", "workrift.install", `pwd -P >>'${installs}'`)
      const installed = () => lines(existsSync(installs) ? readFileSync(installs, "utf8") : "")
      w.push("main", { "bun.lock": "v1\n" })
      expect(w.wr(w.app, "refresh").code).toBe(0)
      expect(warms()).toEqual([`${w.app} held`])
      const sorted = (items: ReadonlyArray<string>) => [...items].sort()
      const where = (line: string) => line.replace(/ (free|held)$/, "")
      // main moved: the copy is of the base as it was; the workspace installs and builds itself, and the advance the
      // create started after its copy moves and installs the base.
      const second = w.push("main", { "bun.lock": "v2\n" })
      const a = w.create(w.app, "feat/a")
      expect(head(w.app)).toBe(second)
      expect(head(a)).toBe(second)
      expect(sorted(installed())).toEqual(sorted([w.app, a, w.app]))
      expect(warms().slice(1).map(where)).toEqual([a])

      // Inside the window: no advance; the lane starts at today's main and installs and builds itself.
      const third = w.push("main", { "bun.lock": "v3\n" })
      const ran = w.wr(w.app, "create", "feat/b")
      expect(ran.code, ran.err).toBe(0)
      const b = lines(ran.out).at(-1) ?? ""
      expect(lines(ran.out)).toEqual([b])
      expect(head(w.app)).toBe(second)
      expect(head(b)).toBe(third)
      expect(readFileSync(join(b, "bun.lock"), "utf8")).toBe("v3\n")
      expect(installed().slice(3)).toEqual([b])
      expect(warms().slice(2).map(where)).toEqual([b])
      expect(ran.err).toContain(`${w.app} is behind origin/main`)
      expect(ran.err).not.toContain("advance in the background")

      // Once the window is over, the next create starts an advance again.
      stampAdvance(w.app, `${Math.floor(Date.now() / 1000) - 601}\n`)
      const c = w.create(w.app, "feat/c")
      expect(head(w.app)).toBe(third)
      expect(sorted(installed().slice(4))).toEqual(sorted([c, w.app]))
      expect(warms().slice(3).map(where)).toEqual([c])
      expect(head(c)).toBe(third)
    },
    60_000,
  )

  test(
    "create says each step on stderr with the seconds since it began, and whom it waits for; stdout is the path alone",
    async () => {
      const { w } = loaded("phases")
      expect(w.wr(w.app, "refresh").code).toBe(0)
      // A hold of the base's lock, in line before the create, until the test opens its gate.
      const ready = join(w.dir, "held-ready")
      const release = join(w.dir, "held-release")
      exe(join(w.bin, "held"), `#!/bin/sh\n: >'${ready}'\nuntil [ -e '${release}' ]; do sleep 0.05; done\n`)
      const holder = startGroup(w.app, w.env, [SCRIPT, "hold", "--", "held"], join(w.dir, "holder.err"))
      const groups: Array<Grouped> = [holder]
      const waited = async () => {
        try {
          await until("the hold holds the base", () => existsSync(ready), 120_000)
          const create = startGroup(w.app, w.env, [SCRIPT, "create", "feat/p"], join(w.dir, "create.err"))
          groups.push(create)
          await until("the create waits behind the hold", () => create.err().includes("workrift: waiting for the lock"), 120_000)
          // In line, not in: the lock is the hold's until its gate opens.
          expect(create.err()).not.toContain(": locked")
          writeFileSync(release, "")
          const held = await within(holder, 120_000)
          expect(held?.code, held?.err).toBe(0)
          return await within(create, 120_000)
        } finally {
          writeFileSync(release, "")
          for (const each of groups) if (alive(each.pid)) each.kill()
        }
      }
      const ran = await waited()
      expect(ran?.code, ran?.err).toBe(0)
      const path = join(w.root, ".work/app/feat-p")
      expect(ran?.out).toBe(`${path}\n`)
      const said = lines(ran?.err ?? "")
      expect(said.filter((line) => line.startsWith("workrift: waiting"))).toEqual([
        expect.stringMatching(new RegExp(`^workrift: waiting for the lock of ${w.app}: behind 1; the first pid ${holder.pid} \\(hold held\\), holding since \\d\\d:\\d\\d:\\d\\dZ$`)),
      ])
      const steps = said.filter((line) => line.startsWith("workrift: create feat/p: ")).map((line) => line.replace(/ \(\d+s\)$/, ""))
      expect(steps).toEqual([
        "workrift: create feat/p: look up feat/p and main on origin",
        `workrift: create feat/p: lock ${w.app}`,
        "workrift: create feat/p: locked",
        "workrift: create feat/p: clone turn",
        "workrift: create feat/p: clone feat-p",
        "workrift: create feat/p: fetch feat/p and main into the workspace",
        "workrift: create feat/p: workspace: install if its lock file changed",
        "workrift: create feat/p: workspace: warm step if its tree changed",
        `workrift: create feat/p: done: ${path}`,
      ])
      for (const line of said.filter((line) => line.startsWith("workrift: create feat/p: "))) expect(line).toMatch(/ \(\d+s\)$/)
      // It went in after the hold, and no ticket is left.
      expect(said.some((line) => line.startsWith("workrift: create feat/p: locked"))).toBe(true)
      expect(readdirSync(join(stateOf(w.app), "base"))).toEqual([])
    },
    // Hang guard: three event waits and two ends of 2 minutes each.
    hangGuard("deep-scenario"),
  )

  test(
    "remove takes the branch name create was given, from anywhere, and refuses a name that is no workspace, that two bases answer to, or a folder inside a checkout",
    () => {
      const w0 = workBench("by-name", work)
      const w = { ...w0, wr: (cwd: string, ...argv: ReadonlyArray<string>) => run(cwd, { ...w0.env, WORKRIFT_PURGE: "0" }, [SCRIPT, ...argv]) }
      const x = w.create(w.app, "scratch/x")
      expect(x).toBe(join(w.root, ".work/app/scratch-x"))
      // From outside any checkout, and from the base, by the name create was given.
      let ran = w.wr(w.dir, "remove", "--dry-run", "scratch/x")
      expect(ran.code, ran.err).toBe(0)
      expect(ran.out).toBe(`would trash: ${x}\n`)
      ran = w.wr(w.app, "remove", "scratch/x")
      expect(ran.code, ran.err).toBe(0)
      expect(existsSync(x)).toBe(false)

      // The trash still holds scratch-x, so the next create of the branch makes scratch-x-2: its name finds that one.
      const again = w.create(w.app, "scratch/x")
      expect(again).toBe(join(w.root, ".work/app/scratch-x-2"))
      ran = w.wr(w.dir, "remove", "scratch/x")
      expect(ran.code, ran.err).toBe(0)
      expect(existsSync(again)).toBe(false)

      // A folder inside a checkout is no name: it never stands for the checkout around it.
      const a = w.create(w.app, "feat/a")
      mkdirSync(join(a, "src"))
      ran = w.wr(a, "remove", "src")
      expect(ran.code).toBe(1)
      expect(ran.err).toContain("no active workspace of any work base is named src")
      expect(ran.err).toContain("absolute path")
      expect(existsSync(a)).toBe(true)

      // Two bases with a workspace for one branch: the name picks neither.
      const lib = w.base("lib")
      const one = w.create(w.app, "feat/dup")
      const two = w.create(lib, "feat/dup")
      ran = w.wr(w.dir, "remove", "feat/dup")
      expect(ran.code).toBe(1)
      expect(ran.err).toContain("several workspaces answer to feat/dup")
      expect(ran.err).toContain(one)
      expect(ran.err).toContain(two)
      for (const kept of [one, two, a]) expect(existsSync(kept)).toBe(true)

      // A name of nothing.
      ran = w.wr(w.dir, "remove", "no/such")
      expect(ran.code).toBe(1)
      expect(ran.err).toContain("no-such")

      // A workspace named like a suffixed one (feat-y-2) but made for another branch (feat/y-2) is not feat/y's.
      const y2 = w.create(w.app, "feat/y-2")
      expect(y2).toBe(join(w.root, ".work/app/feat-y-2"))
      ran = w.wr(w.dir, "remove", "feat/y")
      expect(ran.code).toBe(1)
      expect(ran.err).toContain("no active workspace of any work base is named feat-y")
      expect(existsSync(y2)).toBe(true)
      expect(w.active(w.app).map((each) => each.path).sort()).toEqual([a, one, y2].sort())
    },
    60_000,
  )

  test(
    "red on main: thirty creates at once, twice, over a slow copy (the workbox's minutes-wide window): none fails on a sibling's bookkeeping; nothing workrift keeps is inside the base",
    async () => {
      const { w } = loaded("thirty")
      slowCopy(w.bin, 0.3)
      sh(w.app, w.env, "git", "config", "workrift.install", "true")
      w.push("main", { "bun.lock": "main-1\n" })
      expect(w.wr(w.app, "refresh").code).toBe(0)
      const failures: Array<string> = []
      for (const round of [0, 1]) {
        // main moves before each round, so the creates also look it up and an advance moves the base meanwhile.
        w.push("main", { [`r${round}.txt`]: `${round}\n` })
        stampAdvance(w.app, "0\n")
        const ran = await spawnAll(w.app, w.env, Array.from({ length: 30 }, (_, i) => [SCRIPT, "create", `r${round}/c${i}`]))
        for (const each of ran)
          if (each.code !== 0) failures.push(each.err.split("\n").filter((line) => /fail|Failed|error/i.test(line)).join(" | ").slice(-400))
        await settle(...ran.map((each) => each.err))
      }
      expect(failures).toEqual([])
      expect(w.active(w.app)).toHaveLength(60)
      // workrift keeps no file of its own in the base's Git directory beyond what a copy carries on purpose: the
      // install fingerprint, the warm marker and the warm's log (and the stamp stampAdvance plants for main's script),
      // and the older workrift's empty lock file, made once by a writer before any copy relies on it (legacy_take).
      const own = readdirSync(join(w.app, ".git")).filter((name) => name.startsWith("workrift") && name !== "workrift-advanced-at")
      expect(own.sort()).toEqual(
        ["workrift-installed-locks", "workrift-warm.log", "workrift-warmed-tree", "workrift.lock"].filter((name) => existsSync(join(w.app, ".git", name))),
      )
    },
    hangGuard("deep-scenario"),
  )

  test(
    "red on main: creates with no advance due leave every file of the base as it was, its .git too: same inode, size and time",
    async () => {
      const { w } = loaded("untouched")
      sh(w.app, w.env, "git", "config", "workrift.install", "true")
      w.push("main", { "bun.lock": "main-1\n" })
      const refreshed = w.wr(w.app, "refresh")
      expect(refreshed.code, refreshed.err).toBe(0)
      // main moves on origin, inside the window: a create looks it up, and nothing may fetch it into the base.
      w.push("main", { "two.txt": "2\n" })
      stampAdvance(w.app, `${Math.floor(Date.now() / 1000)}\n`)
      const snapshot = () => {
        const out: Record<string, string> = {}
        const walk = (dir: string) => {
          for (const entry of readdirSync(dir)) {
            const path = join(dir, entry)
            const st = lstatSync(path)
            out[path] = `${st.ino} ${st.size} ${st.mtimeMs}`
            if (st.isDirectory()) walk(path)
          }
        }
        walk(w.app)
        return out
      }
      const before = snapshot()
      const ran = await spawnAll(w.app, w.env, ["feat/a", "feat/b", "feat/c"].map((branch) => [SCRIPT, "create", branch]))
      for (const each of ran) expect(each.code, each.err).toBe(0)
      await settle(...ran.map((each) => each.err))
      expect(snapshot()).toEqual(before)
    },
    60_000,
  )

  test(
    "a running refresh holds the base's lock under its own name: its ticket is a writer's, names its pid and purpose, says it holds, and a create waiting behind it names it",
    async () => {
      const { w } = loaded("refresh-holds")
      const gate = join(w.dir, "gate")
      sh(w.app, w.env, "git", "config", "workrift.install", `until [ -e '${gate}' ]; do sleep 0.05; done`)
      w.push("main", { "bun.lock": "main-1\n" })
      const refresh = startGroup(w.app, w.env, [SCRIPT, "refresh"], join(w.dir, "refresh.err"))
      const groups: Array<Grouped> = [refresh]
      const queue = join(stateOf(w.app), "base")
      const writers = () => (existsSync(queue) ? readdirSync(queue).filter((name) => name.endsWith(".w")) : [])
      const ended = async () => {
        try {
          await until("the refresh has a writer's ticket that says it holds", () => writers().some((name) => existsSync(join(queue, `${name}.in`))), 120_000)
          const [ticket] = writers()
          const record = lines(readFileSync(join(queue, ticket!), "utf8"))
          // The refresh re-runs itself under nice: the holder is the process that runs now, a descendant of the one spawned.
          expect(record[3]).toBe("refresh")
          // Its identity as process_identity has it on macOS: the start under LC_ALL=C and TZ=UTC0, whoever reads it.
          expect(sh(w.app, { ...w.env, LC_ALL: "C", TZ: "UTC0" }, "ps", "-o", "lstart=", "-p", record[0]!).trim()).toBe(record[1])
          expect(existsSync(join(queue, `${ticket}.in`))).toBe(true)
          const create = startGroup(w.app, w.env, [SCRIPT, "create", "feat/behind"], join(w.dir, "create.err"))
          groups.push(create)
          await until("the create in line behind the refresh", () => readdirSync(queue).filter((name) => /\.[rw]$/.test(name)).length >= 2, 120_000)
          // The refresh ends once the gate opens: the create's line must be said before, while the refresh holds.
          const createErr = join(w.dir, "create.err")
          await until("the create says whom it waits for", () => existsSync(createErr) && readFileSync(createErr, "utf8").includes("waiting for the lock of"), 120_000)
          writeFileSync(gate, "")
          const [refreshed, created] = [await within(refresh, 120_000), await within(create, 120_000)]
          expect(refreshed?.code, refreshed?.err).toBe(0)
          expect(created?.code, created?.err).toBe(0)
          return { record, err: created?.err ?? "" }
        } finally {
          writeFileSync(gate, "")
          for (const each of groups) if (alive(each.pid)) each.kill()
        }
      }
      const { record, err } = await ended()
      expect(err).toMatch(new RegExp(`waiting for the lock of ${w.app}: behind 1; the first pid ${record[0]} \\(refresh\\), holding since`))
      expect(readdirSync(queue)).toEqual([])
    },
    // Hang guard: two event waits and two ends of 2 minutes each.
    hangGuard("deep-scenario"),
  )

  test(
    "a ticket removed while a waiting create reads it (its holder left) has no words: no read of a missing record, the line is read again (receipt-6)",
    () => {
      const w = workBench("ticket-gone", work)
      const queue = join(stateOf(w.app), "base")
      mkdirSync(queue, { recursive: true })
      // A holder's ticket, held (the flock below answers so). The holder leaves as the create sorts the line it
      // found the second time (the words of whom it waits for): after its test of the lock, before its read of the
      // record.
      // Its owner is this test run, by the identity workrift reads on macOS (lstart under LC_ALL=C and TZ=UTC0).
      const start = sh(w.app, { ...w.env, LC_ALL: "C", TZ: "UTC0" }, "ps", "-o", "lstart=", "-p", String(process.pid)).trim()
      writeFileSync(join(queue, "1.w"), `${process.pid}\n${start}\n${TICKET_SINCE}\nrefresh\n`)
      exe(
        join(w.bin, "flock"),
        [
          "#!/bin/sh",
          `echo "$*" >>'${queue}.calls'`,
          `case "$*" in "-n -x ${queue}/1.w true") exit 1 ;; esac`,
          "exit 0",
          "",
        ].join("\n"),
      )
      const realSort = Bun.which("sort") ?? "/usr/bin/sort"
      exe(
        join(w.bin, "sort"),
        [
          "#!/bin/sh",
          `if [ "$1" = -n ] && [ -e '${queue}/1.w' ]; then`,
          `  if [ -e '${queue}.sorted' ]; then rm -f '${queue}/1.w'; else : >'${queue}.sorted'; fi`,
          "fi",
          `exec '${realSort}' "$@"`,
          "",
        ].join("\n"),
      )
      const ran = w.wr(w.app, "create", "feat/gone")
      // The race was met: the create found the holder in line twice, and it went between.
      const calls = readFileSync(`${queue}.calls`, "utf8")
      expect(calls.split(`-n -x ${queue}/1.w true`).length - 1, calls).toBeGreaterThanOrEqual(2)
      expect(existsSync(join(queue, "1.w"))).toBe(false)
      expect(ran.code, ran.err).toBe(0)
      expect(ran.err).not.toContain("No such file")
      expect(ran.err).not.toMatch(/pid \d* \(\)/)
    },
    // Hang guard: one create on a bench.
    hangGuard("process-fixture"),
  )

  test(
    "red on main: twelve refreshes against a slow one are served in the order they came",
    async () => {
      const { w } = loaded("fifo")
      const order = join(w.dir, "order")
      // The first holds the base until every other one is in line behind it (the gate file).
      const gate = join(w.dir, "gate")
      sh(w.app, w.env, "git", "config", "workrift.warm", "true")
      sh(w.app, w.env, "git", "config", "workrift.install", `if [ "$LABEL" = first ]; then i=0; until [ -e '${gate}' ] || [ "$i" -ge 2400 ]; do sleep 0.05; i=$((i + 1)); done; fi; printf '%s\\n' "$LABEL" >>'${order}'`)
      expect(w.wr(w.app, "refresh").code).toBe(0)
      writeFileSync(order, "")
      const spawned: Array<ReturnType<typeof Bun.spawn>> = []
      const labels = ["first", ...Array.from({ length: 12 }, (_, i) => `r${i}`)]
      // A refresh comes when its ticket is in the line, not when it is spawned: under load a process spawned later can
      // reach the line first (it starts, re-runs itself under nice, then takes its ticket). Each is spawned once the one
      // before holds its ticket, so the order they came is the order spawned, at any load.
      // A refresh takes its place in the advance line first (one refresh or advance at a time), then the base's lock.
      const queue = join(stateOf(w.app), "advance")
      const seen = new Set<string>()
      const tickets = () => (existsSync(queue) ? readdirSync(queue).filter((name) => /\.[rw]$/.test(name)) : [])
      // Each refresh runs in its own process group; whatever the test's end, the gate opens and every group still
      // running is ended, so none outlives it.
      try {
        for (const label of labels) {
          spawned.push(Bun.spawn([SCRIPT, "refresh"], { cwd: w.app, env: { ...w.env, LABEL: label }, stdout: "ignore", stderr: "ignore", detached: true }))
          let fresh: string | undefined
          // At most 3000 looks 20 ms apart: 60 s or more, counted, not read off a clock.
          for (let look = 0; look < 3000 && !(fresh = tickets().find((name) => !seen.has(name))); look++) await Bun.sleep(20)
          expect(fresh, `${label} took no ticket within 60 s`).toBeDefined()
          seen.add(fresh!)
        }
        writeFileSync(gate, "")
        for (const child of spawned) expect(await child.exited).toBe(0)
      } finally {
        writeFileSync(gate, "")
        for (const child of spawned) {
          if (child.exitCode !== null || child.signalCode !== null) continue
          try {
            process.kill(-child.pid, "SIGKILL")
          } catch {
            // ended meanwhile
          }
        }
      }
      expect(lines(readFileSync(order, "utf8"))).toEqual(labels)
    },
    // Above the 13 ticket waits of 60 s: a slow line fails on its own message, and the finally always runs.
    hangGuard("isolated-seed-pair"),
  )

  test(
    "creates and exclusive holds in one line: the creates between two holds copy after the first and before the second, one at a time (the clone turn)",
    async () => {
      const { w } = loaded("batches")
      const copies = slowCopy(w.bin, 0.2)
      const holds = join(w.dir, "holds")
      expect(w.wr(w.app, "refresh").code).toBe(0)
      // A hold logs its start, holds until the test opens its gate (<label>.release), then logs its end.
      const hold = (label: string) =>
        startGroup(
          w.app,
          w.env,
          [SCRIPT, "hold", "--", "sh", "-c", `printf '${label} start %s\\n' "$(${nowLine})" >>'${holds}'; until [ -e '${join(w.dir, label)}.release' ]; do sleep 0.05; done; printf '${label} end %s\\n' "$(${nowLine})" >>'${holds}'`],
          join(w.dir, `${label}.err`),
        )
      const said = (what: string) => existsSync(holds) && lines(readFileSync(holds, "utf8")).some((line) => line.startsWith(`${what} `))
      const queue = join(stateOf(w.app), "base")
      const tickets = (end: string) => (existsSync(queue) ? readdirSync(queue).filter((name) => name.endsWith(end)).length : 0)
      const groups: Array<Grouped> = []
      const go = (label: string, argv: ReadonlyArray<string>) => {
        const each = startGroup(w.app, w.env, argv, join(w.dir, `${label}.err`))
        groups.push(each)
        return each
      }
      const open = (label: string) => writeFileSync(join(w.dir, `${label}.release`), "")
      const all = async () => {
        try {
          groups.push(hold("h0"))
          await until("h0 holds the base", () => said("h0 start"), 120_000)
          for (const i of [0, 1, 2, 3]) go(`a${i}`, [SCRIPT, "create", `feat/a${i}`])
          await until("the four creates of batch A in line", () => tickets(".r") >= 4, 120_000)
          groups.push(hold("h1"))
          await until("h1 in line behind batch A", () => tickets(".w") >= 2, 120_000)
          for (const i of [0, 1, 2, 3]) go(`b${i}`, [SCRIPT, "create", `feat/b${i}`])
          await until("the four creates of batch B in line behind h1", () => tickets(".r") >= 8, 120_000)
          open("h0")
          // h1 goes in only once batch A has ended (it came after it).
          await until("h1 holds the base", () => said("h1 start"), 120_000)
          open("h1")
          return await Promise.all(groups.map(async (each) => {
            const ran = await within(each, 120_000)
            if (!ran) throw new Error(`a hold or create did not end: ${each.err()}`)
            return ran
          }))
        } finally {
          open("h0")
          open("h1")
          for (const each of groups) if (alive(each.pid)) each.kill()
        }
      }
      for (const ran of await all()) expect(ran.code, ran.err).toBe(0)
      const at = (what: string) => Number(lines(readFileSync(holds, "utf8")).find((line) => line.startsWith(`${what} `))?.split(" ")[2])
      const copy = copies()
      const of = (prefix: string) => copy.filter((each) => each.to.includes(`/feat-${prefix}`))
      expect(of("a")).toHaveLength(4)
      expect(of("b")).toHaveLength(4)
      for (const each of of("a")) expect({ to: each.to, afterH0: each.start >= at("h0 end"), beforeH1: each.end <= at("h1 start") }).toEqual({ to: each.to, afterH0: true, beforeH1: true })
      for (const each of of("b")) expect({ to: each.to, afterH1: each.start >= at("h1 end") }).toEqual({ to: each.to, afterH1: true })
      // The creates between the holds held the base together, but on a base of file copies their clones took turns:
      // no two overlap (clone-one-at-a-time, 2026-11-22; before it they copied side by side).
      const a = [...of("a")].sort((x, y) => x.start - y.start)
      for (let i = 1; i < a.length; i++) expect({ to: a[i]!.to, afterPrevious: a[i]!.start >= a[i - 1]!.end }).toEqual({ to: a[i]!.to, afterPrevious: true })
    },
    // Hang guard: five event waits and ten ends of 2 minutes each, at most.
    hangGuard("sim-parity"),
  )

  test(
    "kill -9 of a create waiting in line, and of a hold holding the lock: the line goes on while the hold's command still runs, and no ticket is left",
    async () => {
      const { w } = loaded("killed")
      expect(w.wr(w.app, "refresh").code).toBe(0)
      const queue = join(stateOf(w.app), "base")
      const tickets = () => (existsSync(queue) ? readdirSync(queue) : [])
      const pidFile = join(w.dir, "held-pid")
      const release = join(w.dir, "held-release")
      // A hold whose command we can find: it records its pid, then waits for the test's gate (its own process group,
      // so the kill of the hold below leaves it running).
      // The two killed here run with their stdout ignored: a pipe the hold's command inherits would never end.
      const killable = (argv: ReadonlyArray<string>, name: string) => spawnOwned(argv, { cwd: w.app, env: w.env, stderr: Bun.file(join(w.dir, name)) })
      const command = killable([SCRIPT, "hold", "--", "sh", "-c", `echo $$ >'${pidFile}'; until [ -e '${release}' ]; do sleep 0.05; done`], "holder.err")
      const killed: Array<ReturnType<typeof killable>> = [command]
      const groups: Array<Grouped> = []
      const after = async () => {
        try {
          await until("the hold's command runs", () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 120_000)
          const commandPid = Number(readFileSync(pidFile, "utf8").trim())
          // A create waits behind it; it is killed while it waits.
          const waiter = killable([SCRIPT, "create", "feat/killed"], "waiter.err")
          killed.push(waiter)
          await until("the create in line behind the hold", () => tickets().filter((name) => /\.[rw]$/.test(name)).length >= 2, 120_000)
          waiter.kill("SIGKILL")
          await waiter.exited
          // The hold is killed while it holds: its command lives on (it inherited the lock's descriptor), but holds no
          // ticket of the line's.
          command.kill("SIGKILL")
          await command.exited
          expect(alive(commandPid)).toBe(true)
          const next = startGroup(w.app, w.env, [SCRIPT, "create", "feat/after"], join(w.dir, "after.err"))
          groups.push(next)
          const ran = await within(next, 120_000)
          expect(ran?.code, ran?.err).toBe(0)
          // It went in while the old command still ran: the line never waits on a process that is not in it.
          expect(alive(commandPid)).toBe(true)
          return commandPid
        } finally {
          writeFileSync(release, "")
          for (const each of groups) if (alive(each.pid)) each.kill()
          await endOwned(killed.map((each) => each.pid))
        }
      }
      const commandPid = await after()
      expect(tickets()).toEqual([])
      expect(w.active(w.app).map((each) => each.name)).toEqual(["feat-after"])
      await until("the hold's command ends once its gate opens", () => !alive(commandPid), 120_000)
    },
    // Hang guard: two event waits, the create's end and the command's end, of 2 minutes each.
    hangGuard("deep-scenario"),
  )

  test(
    "a work new that dies mid-copy leaves a Creating record: the create hands it to work gc -id and fails, leaving no record and no folder",
    () => {
      const { w } = loaded("died")
      // The clone waits at this gate after it has begun, so the kill below lands mid-copy at any load; the test
      // opens it after, so no copy outlives the test.
      const copyGate = join(w.dir, "copy-gate")
      slowCopy(w.bin, 0, copyGate)
      expect(w.wr(w.app, "refresh").code).toBe(0)
      // A work that is killed once its clone has begun (as a host's OOM killer would).
      const dying = join(w.bin, "dying-work")
      exe(
        dying,
        `#!/bin/sh\ncase " $* " in\n  *" new "*) ;;\n  *) exec '${work}' "$@" ;;\nesac\n'${work}' "$@" &\nchild=$!\nuntil grep -q feat-died '${join(w.bin, "..", "copies.begun")}' 2>/dev/null; do sleep 0.05; done\npkill -9 -P "$child"\nkill -9 "$child"\nwait "$child"\nexit 137\n`,
      )
      const ran = run(w.app, { ...w.env, WORK: dying }, [SCRIPT, "create", "feat/died"])
      writeFileSync(copyGate, "")
      expect(ran.code).toBe(1)
      expect(ran.err).toContain("work new left its Creating record feat-died")
      expect(ran.err).toContain("work new failed for feat/died")
      expect(w.listed(w.app).filter((each) => each.name === "feat-died")).toEqual([])
      expect(existsSync(join(w.root, ".work/app/feat-died"))).toBe(false)
      // The line is free: the next create goes in.
      expect(w.create(w.app, "feat/next")).toBe(join(w.root, ".work/app/feat-next"))
    },
    60_000,
  )

  test(
    "a move a kill cut short (its moving marker left): the next create installs the base again before it copies; one left with changes is refused and nothing is copied",
    () => {
      const { w } = loaded("killed-move")
      const installs = join(w.dir, "installs")
      sh(w.app, w.env, "git", "config", "workrift.install", `pwd -P >>'${installs}'`)
      w.push("main", { "bun.lock": "v1\n" })
      expect(w.wr(w.app, "refresh").code).toBe(0)
      const moving = join(stateOf(w.app), "moving")
      // An advance killed in its install: the marker stays and the install fingerprint is the old one.
      writeFileSync(moving, "")
      writeFileSync(join(w.app, ".git/workrift-installed-locks"), "bun.lock old\n")
      const ran = w.wr(w.app, "create", "feat/a")
      expect(ran.code, ran.err).toBe(0)
      expect(ran.err).toContain("base: repair a move a kill cut short")
      expect(existsSync(moving)).toBe(false)
      const a = lines(ran.out).at(-1) ?? ""
      // The base installed again before the copy, so the copy carries the install and installs nothing itself.
      expect(lines(readFileSync(installs, "utf8"))).toEqual([w.app, w.app])

      // A fast-forward cut in the middle of writing files: refused for a person, nothing copied, the line empty.
      writeFileSync(moving, "")
      writeFileSync(join(w.app, "README.md"), "half written\n")
      const refused = w.wr(w.app, "create", "feat/b")
      expect(refused.code).toBe(1)
      expect(refused.err).toContain("was left in the middle of a move")
      expect(refused.out).toBe("")
      expect(w.active(w.app).map((each) => each.path)).toEqual([a])
      for (const queue of ["base", "advance"]) expect(readdirSync(join(stateOf(w.app), queue)), queue).toEqual([])
    },
    60_000,
  )

  test(
    "where advances warm (workrift.advanceWarm), a failed base warm holds no window and says so; the same tree is not tried again",
    () => {
      const { w, head } = loaded("failed-warm")
      const tried = join(w.dir, "tried")
      expect(w.wr(w.app, "refresh").code).toBe(0)
      sh(w.app, w.env, "git", "config", "workrift.advanceWarm", "true")
      sh(w.app, w.env, "git", "config", "workrift.warm", `pwd -P >>'${tried}'; exit 3`)
      const inBase = () => lines(existsSync(tried) ? readFileSync(tried, "utf8") : "").filter((line) => line === w.app)
      w.push("main", { "one.txt": "1\n" })
      const a = w.wr(w.app, "create", "feat/a")
      expect(a.code, a.err).toBe(0)
      // The base warms in the background advance; its failure is in the advance's log, and the next create says it.
      expect(readFileSync(join(stateOf(w.app), "advance.log"), "utf8")).toContain(`warm step failed in ${w.app}`)
      expect(inBase()).toEqual([w.app])
      // The failure held no window: main moves, and the next create advances and tries again.
      const two = w.push("main", { "two.txt": "2\n" })
      expect(w.wr(w.app, "create", "feat/b").code).toBe(0)
      expect(head(w.app)).toBe(two)
      expect(inBase()).toEqual([w.app, w.app])
      // Nothing moved: the failed tree is not built again, and the create says why.
      const c = w.wr(w.app, "create", "feat/c")
      expect(c.code, c.err).toBe(0)
      expect(inBase()).toEqual([w.app, w.app])
      expect(c.err).toContain("is not tried again until main moves or a refresh")
    },
    60_000,
  )

  test("check warns once the base's build output is a dozen moves or a day behind its tree, and passes all the same", () => {
    const { w } = loaded("stale")
    expect(w.wr(w.app, "refresh").code).toBe(0)
    let ran = w.wr(w.app, "check")
    expect(ran.code, ran.err).toBe(0)
    expect(ran.err).not.toContain("warning")
    writeFileSync(join(stateOf(w.app), "staleness"), `12 ${Math.floor(Date.now() / 1000)}\n`)
    ran = w.wr(w.app, "check")
    expect(ran.code, ran.err).toBe(0)
    expect(ran.err).toContain(`warning: the build output of ${w.app} is 12 moves behind its tree`)
    writeFileSync(join(stateOf(w.app), "staleness"), `1 ${Math.floor(Date.now() / 1000) - 90_000}\n`)
    expect(w.wr(w.app, "check").err).toContain("run workrift refresh at a quiet time")
  })
})

/**
 * A base whose tracked work.toml declares `[deps]`, made by the real `work` (work-trust.md, 2026-11-20): `work init`
 * trusts its commands, and a later commit on main that changes the install command leaves the base untrusted
 * from the moment it fast-forwards. Then `work new` and `work deps` of a branch whose lock differs answer
 * Untrusted (work new exits 0, work deps 1) and install nothing.
 */
describeWork("workrift over a base whose work.toml commands work does not trust", () => {
  const work = WORK_BIN ?? "work"

  const untrusted = (label: string) => {
    const w = workBench(label, work)
    const byWork = join(w.dir, "by-work")
    const byWorkrift = join(w.dir, "by-workrift")
    const toml = (install: string) => `[deps]\nlock = "bun.lock"\ninstall = "${install}"\n`
    w.push("main", { "bun.lock": "v1\n", "work.toml": toml(`pwd -P >>'${byWork}'`) })
    const lib = w.base("lib")
    sh(lib, w.env, "git", "config", "workrift.install", `pwd -P >>'${byWorkrift}'`)
    const read = (file: string) => lines(existsSync(file) ? readFileSync(file, "utf8") : "")
    const trusted = () => (JSON.parse(w.inBase(lib, "--json", "doctor")) as { trusted: boolean }).trusted
    expect(trusted()).toBe(true)
    // A teammate's PR changes the install command: no host has trusted the new one.
    w.push("main", { "work.toml": toml(`pwd -P >>'${byWork}'; true`) })
    return { w, lib, byWork: () => read(byWork), byWorkrift: () => read(byWorkrift), trusted }
  }
  const note = (lib: string) => `workrift: ${lib}/work.toml runs commands work does not trust on this host`

  test(
    "create of a branch whose lock differs installs with workrift's own command, says so in one line, and never runs the untrusted one",
    () => {
      const u = untrusted("untrusted-create")
      // The base reaches the commit that changed the command (a create copies the base as it is, then advances it).
      expect(u.w.wr(u.lib, "refresh").code).toBe(0)
      u.w.push("feat/locked", { "bun.lock": "v2\n" })
      const ran = u.w.wr(u.lib, "create", "feat/locked")
      expect(ran.code, ran.err).toBe(0)
      const path = lines(ran.out).at(-1) ?? ""
      expect(lines(ran.out)).toEqual([path])
      expect(u.trusted()).toBe(false)
      expect(u.byWorkrift()).toContain(path)
      expect(u.byWork()).not.toContain(path)
      expect(lines(ran.err).filter((line) => line.startsWith(note(u.lib)))).toHaveLength(1)
      expect(ran.err).toContain(`work trust in ${u.lib}`)
    },
    60_000,
  )

  test(
    "deps after a switch to a branch with another lock falls back to workrift's own install when work deps answers Untrusted",
    () => {
      const u = untrusted("untrusted-deps")
      expect(u.w.wr(u.lib, "refresh").code).toBe(0)
      const path = u.w.create(u.lib, "feat/same")
      u.w.push("feat/other", { "bun.lock": "v3\n" })
      sh(path, u.w.env, "git", "fetch", "-q", "origin")
      sh(path, u.w.env, "git", "switch", "-q", "--detach", "origin/feat/other")
      const before = u.byWorkrift().filter((line) => line === path).length
      const ran = u.w.wr(path, "deps")
      expect(ran.code, ran.err).toBe(0)
      expect(u.byWorkrift().filter((line) => line === path).length).toBe(before + 1)
      expect(u.byWork()).not.toContain(path)
      expect(ran.err).toContain("Untrusted")
      expect(ran.err).toContain(`work trust in ${u.lib}`)
      // The same lock again: nothing installs.
      expect(u.w.wr(path, "deps").code).toBe(0)
      expect(u.byWorkrift().filter((line) => line === path).length).toBe(before + 1)
    },
    60_000,
  )

  test(
    "deps stays a loud failure when work's trusted install fails (DepsFailed)",
    () => {
      const w = workBench("deps-failed", work)
      w.push("main", { "bun.lock": "v1\n", "work.toml": `[deps]\nlock = "bun.lock"\ninstall = "exit 3"\n` })
      const lib = w.base("lib")
      sh(lib, w.env, "git", "config", "workrift.install", "true")
      const path = w.create(lib, "feat/f")
      w.push("feat/g", { "bun.lock": "v2\n" })
      sh(path, w.env, "git", "fetch", "-q", "origin")
      sh(path, w.env, "git", "switch", "-q", "--detach", "origin/feat/g")
      const ran = w.wr(path, "deps")
      expect(ran.code).not.toBe(0)
      expect(ran.err).toContain("DepsFailed")
    },
    60_000,
  )

  test(
    "refresh warns in one line when work doctor finds the base untrusted, and says nothing of trust when it is trusted",
    () => {
      const u = untrusted("untrusted-refresh")
      const ran = u.w.wr(u.lib, "refresh")
      expect(ran.code, ran.err).toBe(0)
      expect(lines(ran.err).filter((line) => line.startsWith(note(u.lib)))).toHaveLength(1)
      // A person reviews the file and allows it: no more warning.
      u.w.inBase(u.lib, "trust")
      const again = u.w.wr(u.lib, "refresh")
      expect(again.code, again.err).toBe(0)
      expect(again.err).not.toContain("does not trust")
    },
    60_000,
  )
})

/**
 * What a create installs is decided from the workspace's final head (batch 2026-11-20n, M1): `work_new` can
 * fast-forward a branch the base holds locally to origin's after `work new` installed, and the post-merge hook that
 * fires defers while the create runs. The install command records the lock it installed in the checkout's Git
 * directory (`installed-lock`), which a copy carries with the installed packages.
 */
describeWork("workrift create installs for the lock the workspace ends with", () => {
  const work = WORK_BIN ?? "work"
  const record = `cat bun.lock >"$(git rev-parse --absolute-git-dir)/installed-lock"`

  /** A base `lib` whose install is work's ([deps] in a tracked work.toml) or workrift's own, both recording; refreshed. */
  const installing = (label: string, by: "work" | "workrift") => {
    const w = workBench(label, work)
    const byWork = join(w.dir, "by-work")
    const files: Record<string, string> = { "bun.lock": "main-0\n" }
    if (by === "work") files["work.toml"] = `[deps]\nlock = "bun.lock"\ninstall = 'cat bun.lock >>"${byWork}"; ${record}'\n`
    w.push("main", files)
    const lib = w.base("lib")
    sh(lib, w.env, "git", "config", "workrift.install", record)
    // The managed hooks as plain Git hooks: post-merge runs `workrift deps`, as lefthook-local.yml has it.
    exe(join(lib, ".git/hooks/post-merge"), `#!/bin/sh\nexec '${SCRIPT}' deps\n`)
    const ran = w.wr(lib, "refresh")
    expect(ran.code, ran.err).toBe(0)
    const installed = (path: string) => readFileSync(join(path, ".git/installed-lock"), "utf8")
    const lock = (path: string) => readFileSync(join(path, "bun.lock"), "utf8")
    const byWorkLines = () => lines(existsSync(byWork) ? readFileSync(byWork, "utf8") : "")
    return { w, lib, installed, lock, byWorkLines }
  }

  test(
    "a branch the base holds locally, which origin has moved to a newer lock, ends installed for that lock (the verifier's P1)",
    () => {
      const { w, lib, installed, lock, byWorkLines } = installing("p1", "work")
      w.push("feat/local", { "bun.lock": "v2\n" })
      sh(lib, w.env, "git", "fetch", "-q", "origin")
      sh(lib, w.env, "git", "branch", "-q", "feat/local", "origin/feat/local")
      w.push("feat/local", { "bun.lock": "v3\n" })
      const ran = run(lib, { ...w.env, WORKRIFT_SOURCE: lib }, [SCRIPT, "create", "feat/local"])
      expect(ran.code, ran.err).toBe(0)
      const path = lines(ran.out).at(-1) ?? ""
      expect(lines(ran.out)).toEqual([path])
      expect(lock(path)).toBe("v3\n")
      expect(installed(path)).toBe("v3\n")
      // work installed v2 at the copy, then v3 for the head the fast-forward brought: once each.
      expect(byWorkLines()).toEqual(["v2", "v3"])
    },
    60_000,
  )

  for (const by of ["work", "workrift"] as const)
    test(
      `property: whatever the branch's kind, origin's lead and the advance window, the installed lock is the final one (install by ${by})`,
      () => {
        const { w, lib, installed, lock } = installing(`final-${by}`, by)
        const stamp = join(stateOf(lib), "advanced-at")
        let n = 0
        for (const kind of ["local", "remote", "both"] as const)
          for (const lead of ["lock changed", "lock unchanged"] as const)
            for (const window of ["inside", "outside"] as const) {
              n++
              const branch = `feat/c${n}`
              const what = `${kind}, ${lead}, ${window} the window`
              // main moved: the base is behind, and advances only outside the window.
              w.push("main", { "bun.lock": `main-${n}\n` })
              writeFileSync(stamp, `${Math.floor(Date.now() / 1000) - (window === "inside" ? 0 : 601)}\n`)
              if (kind !== "remote") {
                w.push(branch, { "bun.lock": `${branch}-v2\n` })
                sh(lib, w.env, "git", "fetch", "-q", "origin")
                sh(lib, w.env, "git", "branch", "-q", branch, `origin/${branch}`)
              }
              if (kind === "local") {
                sh(w.dir, w.env, "git", "--git-dir", w.origin, "branch", "-q", "-D", branch)
                sh(lib, w.env, "git", "fetch", "-q", "--prune", "origin")
              } else {
                w.push(branch, lead === "lock changed" ? { "bun.lock": `${branch}-v3\n` } : { [`other-${n}.txt`]: `${n}\n` })
              }
              const ran = w.wr(lib, "create", branch)
              if (ran.code !== 0) {
                // A create that cannot install the final lock fails, and says why.
                expect(ran.err, what).toMatch(/install|deps/i)
                continue
              }
              const path = lines(ran.out).at(-1) ?? ""
              expect(lines(ran.out), what).toEqual([path])
              expect({ what, installed: installed(path) }).toEqual({ what, installed: lock(path) })
            }
      },
      120_000,
    )
})

// ---------------------------------------------------------------------------
// Round 2 of create-fair (2026-11-22): the older workrift beside this one, the owner identity across TZ and locale,
// the queue's own files tampered with, a stopped waiter, `deps` in a base. The interval probe and the overlap rule are
// the verifier's (create-fair/receipts/harness/tail.ts).

/** `probe <log> <id> <kind> <seconds>`: logs `in` and `out` lines with times around a sleep. */
const PROBE = [
  "#!/usr/bin/perl",
  "use strict; use Time::HiRes qw(time sleep);",
  "my ($log, $id, $kind, $s) = @ARGV;",
  `open(my $f, '>>', $log) or die; printf $f "in %s %s %.3f\\n", $id, $kind, time; close $f;`,
  "if ($s =~ m{^/}) { sleep(0.05) until -e $s } else { sleep($s) }",
  `open($f, '>>', $log) or die; printf $f "out %s %s %.3f\\n", $id, $kind, time; close $f;`,
  "",
].join("\n")

interface Interval {
  readonly id: string
  /** w: changes the base, or holds it whole; r: reads it beside other readers. */
  readonly kind: string
  readonly t0: number
  readonly t1: number
}

/** The intervals a probe log holds; one never closed ends at Infinity. */
const intervals = (log: string): Array<Interval> => {
  const open = new Map<string, { kind: string; t0: number }>()
  const out: Array<Interval> = []
  for (const line of lines(existsSync(log) ? readFileSync(log, "utf8") : "")) {
    const [what, id = "", kind = "", t = "0"] = line.split(" ")
    if (what === "in") open.set(id, { kind, t0: Number(t) })
    else {
      const o = open.get(id)
      if (o) out.push({ id, kind: o.kind, t0: o.t0, t1: Number(t) })
      open.delete(id)
    }
  }
  for (const [id, o] of open) out.push({ id, kind: o.kind, t0: o.t0, t1: Infinity })
  return out
}

/** Pairs of intervals that overlap where one of them is a w, or where they are of two kinds that exclude each other. */
const overlaps = (ivs: ReadonlyArray<Interval>, exclude: (a: Interval, b: Interval) => boolean = () => false) => {
  const bad: Array<string> = []
  for (let i = 0; i < ivs.length; i++)
    for (let j = i + 1; j < ivs.length; j++) {
      const a = ivs[i]!
      const b = ivs[j]!
      if ((a.kind === "w" || b.kind === "w" || exclude(a, b)) && a.t0 < b.t1 && b.t0 < a.t1) bad.push(`${a.id}(${a.kind}) x ${b.id}(${b.kind})`)
    }
  return bad
}

interface Started {
  readonly pid: number
  /** Its stderr so far. */
  readonly err: () => string
  readonly done: Promise<{ readonly code: number; readonly out: string; readonly err: string }>
}

/** Starts argv with its stderr in a file one can read while it runs. */
const start = (cwd: string, env: Env, argv: ReadonlyArray<string>, errFile: string): Started => {
  writeFileSync(errFile, "")
  const child = Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: Bun.file(errFile) })
  const err = () => readFileSync(errFile, "utf8")
  const done = (async () => {
    const out = await new Response(child.stdout).text()
    const code = await child.exited
    return { code, out, err: err() }
  })()
  return { pid: child.pid, err, done }
}

const until = async (what: string, ok: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`waited ${ms} ms for ${what}`)
    await Bun.sleep(25)
  }
}

/**
 * The process groups this file's tests started and that may still have members. A group's id is never another
 * process's while one of its members lives, so a group is signalled only while ps lists a member of it, and leaves
 * the set once ps lists none.
 */
const ownedGroups = new Set<number>()

/** The pids ps lists in the process group pgid (none once it has ended). */
const groupMembers = (pgid: number): ReadonlyArray<number> =>
  lines(Bun.spawnSync(["ps", "-A", "-o", "pid=,pgid="]).stdout.toString())
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, group]) => group === pgid)
    .map(([pid]) => pid!)

/** Sends SIGKILL to the group pgid while it has members; else drops it from the set. */
const endGroup = (pgid: number) => {
  if (groupMembers(pgid).length === 0) {
    ownedGroups.delete(pgid)
    return
  }
  try {
    process.kill(-pgid, "SIGKILL")
  } catch {
    // ended meanwhile
  }
}

// An interrupted or failed run ends what its tests left (a finally does not run when the runner is killed).
process.on("exit", () => {
  for (const pgid of ownedGroups) endGroup(pgid)
})
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const)
  process.once(signal, () => {
    for (const pgid of ownedGroups) endGroup(pgid)
    process.exit(code)
  })

/** Starts argv as the leader of a process group of its own, owned by this file. */
const spawnOwned = (argv: ReadonlyArray<string>, options: { readonly cwd?: string; readonly env?: Env; readonly stderr?: "ignore" | ReturnType<typeof Bun.file> } = {}) => {
  const child = Bun.spawn([...argv], { ...options, stdout: "ignore", stderr: options.stderr ?? "ignore", detached: true })
  ownedGroups.add(child.pid)
  return child
}

/** Ends the process groups pgids and waits until ps lists no member of any (at most 10 s, then it throws). */
const endOwned = async (pgids: ReadonlyArray<number>) => {
  for (const pgid of pgids) endGroup(pgid)
  await until("the test's process groups ended", () => pgids.every((pgid) => groupMembers(pgid).length === 0), 10_000)
  for (const pgid of pgids) ownedGroups.delete(pgid)
}

/**
 * A folder with a stand-in for `name` that fails (status `code`, a word on stderr) when one of its arguments is
 * exactly FAKE_<NAME>_FAIL, or matches the glob FAKE_<NAME>_FAIL_GLOB; any other call runs the real one. Put first on
 * PATH for the one run that should meet the failure.
 */
const failingShim = (dir: string, name: string, code: number) => {
  const real = Bun.which(name)
  if (!real) throw new Error(`no ${name} on PATH`)
  const at = join(dir, `fail-${name}`)
  mkdirSync(at, { recursive: true })
  const key = `FAKE_${name.toUpperCase()}_FAIL`
  exe(
    join(at, name),
    [
      "#!/bin/sh",
      "for a do",
      `  if [ -n "\${${key}:-}" ] && [ "$a" = "$${key}" ]; then printf '%s: failed (injected)\\n' '${name}' >&2; exit ${code}; fi`,
      `  case "$a" in \${${key}_GLOB:-/nonexistent/fail-shim-none}) printf '%s: failed (injected)\\n' '${name}' >&2; exit ${code} ;; esac`,
      "done",
      `exec '${real}' "$@"`,
      "",
    ].join("\n"),
  )
  return at
}

/** The script before the ticket queue (a5821de8): an exclusive flock on .git/workrift.lock and holder files in .git. */
let oldScript = ""
const OLD_WORKRIFT = () => {
  if (!oldScript) {
    oldScript = join(scratchRoot, "workrift-a5821de8")
    writeFileSync(oldScript, sh(repo, process.env as Env, "git", "show", "a5821de8:workbox/bin/workrift"))
    chmodSync(oldScript, 0o755)
  }
  return oldScript
}

/** A refreshed base with the util-linux flock, the interval probe on PATH and a no-op install. */
const probeBench = (label: string, work: string) => {
  const w = workBench(label, work)
  realFlock(w.bin)
  exe(join(w.bin, "probe"), PROBE)
  const log = join(w.dir, "probe.log")
  sh(w.app, w.env, "git", "config", "workrift.install", "true")
  w.push("main", { "bun.lock": "main-1\n" })
  const refreshed = w.wr(w.app, "refresh")
  expect(refreshed.code, refreshed.err).toBe(0)
  return { w, log, ivs: () => intervals(log) }
}

describeWork("workrift beside the older workrift, and its line's owners whatever the environment (create-fair round 2)", () => {
  const work = WORK_BIN ?? "work"
  const OLD = OLD_WORKRIFT()
  const bench = (label: string) => probeBench(label, work)
  const hold = (w: ReturnType<typeof bench>["w"], env: Env, log: string, id: string, seconds: number, file: string) =>
    start(w.app, env, [SCRIPT, "hold", "--", "probe", log, id, "w", String(seconds)], join(w.dir, file))

  test(
    "red on round 1: ten creates of the older workrift (one advancing the base) and ten of this one, with a refresh and a hold, on one base: none fails; no old create beside a new copy; no base change beside any copy",
    async () => {
      const { w, log, ivs } = bench("upgrade")
      const copies = slowCopy(w.bin, 0.4)
      // Every change of the base, as the probe logs it: the installs and warms run in the base (an old create's
      // advance, the new refresh), never the workspaces' own.
      const inBase = (id: string, seconds: number) => `if [ "$(pwd -P)" = '${w.app}' ]; then probe '${log}' ${id}-$$ w ${seconds}; fi`
      sh(w.app, w.env, "git", "config", "workrift.install", inBase("install", 1))
      sh(w.app, w.env, "git", "config", "workrift.warm", inBase("warm", 1))
      w.push("main", { "bun.lock": "main-2\n", "two.txt": "2\n" })
      // Due an advance for both scripts: the old one's first create moves the base under its own lock.
      stampAdvance(w.app, `${Math.floor(Date.now() / 1000) - 601}\n`)
      const all: Array<{ who: string; run: Started }> = []
      // The old creates come one by one, each past its fetch (into the base, outside any lock: two at once fail on
      // `cannot lock ref`, main's own bug, OB1) before the next: as tonight, queued on the old lock when the new
      // script is installed.
      for (let i = 0; i < 10; i++) {
        const run = start(w.app, w.env, [OLD, "create", `old/c${i}`], join(w.dir, `old-${i}.err`))
        all.push({ who: `old${i}`, run })
        await until(`old/c${i} at its lock`, () => run.err().includes(`create old/c${i}: lock `))
      }
      // Each new one is started once the one before says it is at its lock (or waits in a line), so the order is
      // the order started at any load; the refresh and the hold likewise.
      const atLock = (run: Started) => () => /: lock \/|waiting for the lock|an older workrift/.test(run.err())
      // A refresh says no step: it is placed once a line (the advance's or the base's) holds its ticket, or it ended.
      const inLine = (purpose: string) =>
        ["advance", "base"].some((name) => {
          const dir = join(stateOf(w.app), name)
          return existsSync(dir) && readdirSync(dir).some((each) => /\.[rw]$/.test(each) && (lines(readFileSync(join(dir, each), "utf8"))[3] ?? "").startsWith(purpose))
        })
      const ended = (run: Started) => {
        let over = false
        void run.done.then(() => {
          over = true
        })
        return () => over
      }
      for (let i = 0; i < 10; i++) {
        const run = start(w.app, w.env, [SCRIPT, "create", `new/c${i}`], join(w.dir, `new-${i}.err`))
        all.push({ who: `new${i}`, run })
        await until(`new/c${i} at its lock`, atLock(run), 120_000)
        if (i === 4) {
          const refresh = start(w.app, w.env, [SCRIPT, "refresh"], join(w.dir, "refresh.err"))
          all.push({ who: "refresh", run: refresh })
          const over = ended(refresh)
          await until("the refresh in a line", () => inLine("refresh") || over(), 120_000)
        }
        if (i === 6) {
          const held = hold(w, w.env, log, "hold", 1, "hold.err")
          all.push({ who: "hold", run: held })
          const over = ended(held)
          await until("the hold in the base's line", () => inLine("hold") || over(), 120_000)
        }
      }
      const ran = await Promise.all(all.map(async (each) => ({ who: each.who, ...(await each.run.done) })))
      const failed = ran.filter((each) => each.code !== 0).map((each) => `${each.who}: ${each.err.split("\n").filter((l) => /fail|error|fatal/i.test(l)).join(" | ").slice(-300)}`)
      expect(failed).toEqual([])
      const copied = copies().map((c): Interval => {
        const name = c.to.split("/").at(-1) ?? ""
        return { id: `copy ${name}`, kind: name.startsWith("old-") ? "old" : "new", t0: c.start, t1: c.end }
      })
      expect(copied).toHaveLength(20)
      // An old create holds the base whole (it copies under an exclusive flock): no new copy beside an old one.
      const oldBesideNew = (a: Interval, b: Interval) => (a.kind === "old" && b.kind === "new") || (a.kind === "new" && b.kind === "old")
      const all2 = [...ivs(), ...copied]
      expect(all2.filter((each) => each.kind === "w").length).toBeGreaterThanOrEqual(3)
      expect(overlaps(all2, oldBesideNew)).toEqual([])
    },
    // Hang guard: twenty-two placements of 2 minutes each at most, then the runs.
    hangGuard("skewed-clock-search"),
  )

  test("on Linux a reader lets an older workrift's blocked exclusive flock go first (it reads /proc/locks), then goes in", async () => {
    const { w } = bench("yield")
    const legacy = join(w.app, ".git/workrift.lock")
    writeFileSync(legacy, "")
    const ino = lstatSync(legacy).ino
    const proc = join(w.dir, "proc")
    mkdirSync(proc, { recursive: true })
    // An old create blocked on it, as /proc/locks lists a blocked flock; and another file's lock, held.
    writeFileSync(join(proc, "locks"), `1: FLOCK  ADVISORY  WRITE 4242 00:2d:${ino + 1} 0 EOF\n1: -> FLOCK  ADVISORY  WRITE 4343 00:2d:${ino} 0 EOF\n`)
    // A sleep that logs each call: the yield's loop sleeps once per look at /proc/locks.
    const sleeps = join(w.dir, "sleeps")
    const shims = join(w.dir, "sleep-bin")
    mkdirSync(shims, { recursive: true })
    exe(join(shims, "sleep"), `#!/bin/sh\necho "$*" >>'${sleeps}'\nexec /bin/sleep "$@"\n`)
    const looked = () => (existsSync(sleeps) ? lines(readFileSync(sleeps, "utf8")).length : 0)
    const env = { ...w.env, WORKRIFT_PROC: proc, PATH: `${shims}:${w.env.PATH}` }
    const create = start(w.app, env, [SCRIPT, "create", "feat/yield"], join(w.dir, "yield.err"))
    await until("the yield", () => create.err().includes("an older workrift waits for the lock"), 120_000)
    // Two more looks with the blocked writer still listed: it stays out of the lock.
    const seen = looked()
    await until("two more looks at /proc/locks", () => looked() >= seen + 2, 120_000)
    expect(create.err()).not.toContain(": locked")
    writeFileSync(join(proc, "locks"), `1: FLOCK  ADVISORY  WRITE 4242 00:2d:${ino + 1} 0 EOF\n`)
    const ran = await create.done
    expect(ran.code, ran.err).toBe(0)
    expect(ran.err).toContain(": locked")
    // The file is the old script's: read, never written, never removed.
    expect(readFileSync(legacy, "utf8")).toBe("")
    expect(lstatSync(legacy).ino).toBe(ino)
  }, hangGuard("acceptance"))

  // TZ and locale pairs: zones east and west and half-hour, locales whose dates read in other words and orders.
  const ENVS: ReadonlyArray<Record<string, string>> = [
    {},
    { TZ: "UTC" },
    { TZ: "America/Montreal" },
    { TZ: "Asia/Kolkata", LANG: "en_CA.UTF-8" },
    { LANG: "de_DE.UTF-8", LC_TIME: "de_DE.UTF-8" },
    { LC_ALL: "fr_FR.UTF-8", TZ: "Pacific/Chatham" },
    { LC_ALL: "C", TZ: "Australia/Adelaide" },
    { LANG: "ja_JP.UTF-8", TZ: "Asia/Tokyo" },
  ]
  /** The bench's environment with these keys set, and the locale keys it does not name taken out. */
  const withEnv = (env: Env, extra: Record<string, string>): Env => {
    const out: Env = {}
    for (const [k, v] of Object.entries(env)) if (k !== "TZ" && k !== "LANG" && !k.startsWith("LC_")) out[k] = v
    return { ...out, ...extra }
  }

  test("property: for generated (TZ, LANG, LC_ALL, LC_TIME) of a holder and a waiter, a live holder is never taken for gone", async () => {
    const { w, log, ivs } = bench("identity")
    // Pairs drawn from ENVS by a fixed stream, holder and waiter always different.
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const pairs: Array<readonly [number, number]> = []
    while (pairs.length < 6) {
      const a = Math.floor(next() * ENVS.length)
      const b = Math.floor(next() * ENVS.length)
      if (a !== b) pairs.push([a, b])
    }
    for (const [i, [a, b]] of pairs.entries()) {
      const gate = join(w.dir, `holder-${i}.release`)
      const holder = start(w.app, withEnv(w.env, ENVS[a]!), [SCRIPT, "hold", "--", "probe", log, `holder${i}`, "w", gate], join(w.dir, `holder-${i}.err`))
      try {
        await until(`holder${i} in`, () => ivs().some((each) => each.id === `holder${i}`), 120_000)
        const waiter = hold(w, withEnv(w.env, ENVS[b]!), log, `waiter${i}`, 0.1, `waiter-${i}.err`)
        // Read in its own environment, the live holder is still the holder: the waiter waits behind it.
        await until(`waiter${i} waits behind holder${i}`, () => waiter.err().includes(`the first pid `), 120_000)
        expect(ivs().some((each) => each.id === `waiter${i}`)).toBe(false)
        writeFileSync(gate, "")
        const ran = await Promise.all([holder.done, waiter.done])
        for (const each of ran) expect(each.code, each.err).toBe(0)
      } finally {
        writeFileSync(gate, "")
      }
      expect({ pair: [ENVS[a], ENVS[b]], overlaps: overlaps(ivs()) }).toEqual({ pair: [ENVS[a], ENVS[b]], overlaps: [] })
    }
  }, hangGuard("sim-parity"))

  test("a ticket whose owner is gone is skipped, its lock held all the same (a child kept the descriptor): a dead pid, and a pid reused by another process", async () => {
    const { w } = bench("gone")
    const queue = join(stateOf(w.app), "base")
    mkdirSync(queue, { recursive: true })
    // The process that holds both tickets' locks, as a child that inherited them would.
    const exited = Bun.spawnSync(["true"])
    const dead = exited.pid
    const release = join(w.dir, "release")
    const gated = ["sh", "-c", `until [ -e '${release}' ]; do sleep 0.05; done`]
    // Each in a process group the test owns: the flock shim runs its command through a child, which a kill of the
    // shim alone would leave polling for a release file that afterAll deletes.
    const keeper = spawnOwned(gated)
    for (const [n, pid, identity] of [
      [1, dead, "Sat Nov 21 21:24:11 2026"],
      // The keeper runs, but its start is not the recorded one: its pid was another process's.
      [2, keeper.pid, "Mon Jan  1 00:00:00 2024"],
    ] as const) {
      const file = join(queue, `${n}.w`)
      writeFileSync(file, `${pid}\n${identity}\n${Math.floor(Date.now() / 1000)}\ncreate feat/gone${n}\n`)
    }
    // Lock both, held by a background flock of the bench's shim for as long as the keeper sleeps.
    const holders = [1, 2].map((n) => spawnOwned([join(w.bin, "flock"), join(queue, `${n}.w`), ...gated]))
    const locked = () => [1, 2].every((n) => Bun.spawnSync([join(w.bin, "flock"), "-n", join(queue, `${n}.w`), "true"]).exitCode === 1)
    try {
      await until("both locked", locked, 120_000)
      const holding = startGroup(w.app, w.env, [SCRIPT, "hold", "--", "true"], join(w.dir, "hold.err"))
      const ran = await within(holding, 120_000)
      expect(ran?.code, ran?.err).toBe(0)
      // Both holders of the locks still run, gated, after the hold went in and ended: it skipped their tickets, it
      // never waited them out.
      expect(holders.map((each) => each.exitCode)).toEqual([null, null])
    } finally {
      writeFileSync(release, "")
      await endOwned([...holders, keeper].map((each) => each.pid))
    }
  }, hangGuard("acceptance"))

  test("on Linux the identity is /proc/<pid>/stat's start in ticks (after a command name with spaces and parentheses) and the boot's id: the same tick is live, another is gone", async () => {
    const { w, log, ivs } = bench("stat")
    const queue = join(stateOf(w.app), "base")
    mkdirSync(queue, { recursive: true })
    const proc = join(w.dir, "statproc")
    const pid = 424242
    mkdirSync(join(proc, "self"), { recursive: true })
    mkdirSync(join(proc, String(pid)), { recursive: true })
    mkdirSync(join(proc, "sys/kernel/random"), { recursive: true })
    writeFileSync(join(proc, "self/stat"), "1 (sh) S 0\n")
    writeFileSync(join(proc, "sys/kernel/random/boot_id"), "b00t-1d\n")
    // Fields 3 to 52; field 22 (the 20th after the name) is the start.
    const stat = (tick: number) => `${pid} (a) b (c)) ${["S", ...Array.from({ length: 18 }, (_, i) => String(i + 4)), String(tick), ...Array.from({ length: 30 }, () => "0")].join(" ")}\n`
    writeFileSync(join(proc, String(pid), "stat"), stat(777))
    const file = join(queue, "1.w")
    writeFileSync(file, `${pid}\nboot b00t-1d tick 777\n${TICKET_SINCE}\nhold the line\n`)
    const release = join(w.dir, "release")
    const lockHolder = spawnOwned([join(w.bin, "flock"), file, "sh", "-c", `until [ -e '${release}' ]; do sleep 0.05; done`])
    const locked = () => Bun.spawnSync([join(w.bin, "flock"), "-n", file, "true"]).exitCode === 1
    await until("locked", locked, 120_000)
    const env = { ...w.env, WORKRIFT_STAT_PROC: proc }
    // The waiter's own stat in the fake /proc (its pid is the shell's, which execs it): a workrift whose own identity
    // does not read takes no place in line.
    const own = `mkdir -p '${proc}'/$$ && printf '%s\\n' "$$ (w) ${stat(999).split(") ").slice(2).join(") ").replace(/\n$/, "")}" >'${proc}'/$$/stat && exec "$@"`
    const waiter = start(w.app, env, ["/bin/sh", "-c", own, "sh", SCRIPT, "hold", "--", "probe", log, "waiter", "w", "0.1"], join(w.dir, "waiter.err"))
    try {
      // The same tick: live, so the waiter waits behind it; then the pid's start changes (reused): gone.
      await until("the waiter names the live pid", () => waiter.err().includes(`behind 1; the first pid ${pid} (hold the line)`), 120_000)
      expect(ivs()).toEqual([])
      expect(locked()).toBe(true)
      writeFileSync(join(proc, String(pid), "stat"), stat(778))
      const ran = await waiter.done
      expect(ran.code, ran.err).toBe(0)
      expect(ivs().map((each) => each.id)).toEqual(["waiter"])
    } finally {
      writeFileSync(release, "")
      await endOwned([lockHolder.pid])
    }
  }, hangGuard("acceptance"))

  test.each([
    // m1-boot: a boot id that does not read made the identity `boot  tick N`, another one: the holder taken for gone.
    ["the boot id", (proc: string) => rmSync(join(proc, "sys/kernel/random/boot_id"))],
    // m5-idempty-gone: an identity that does not read was taken for gone, though kill -0 finds the pid.
    ["the holder's stat", (proc: string, pid: number) => rmSync(join(proc, String(pid), "stat"))],
  ] as const)("on Linux, %s that stops reading while the holder lives leaves its identity unknown: the waiter keeps waiting until the lock is free, never takes it for gone", async (_what, unread) => {
    const { w, log, ivs } = bench("unread")
    const queue = join(stateOf(w.app), "base")
    mkdirSync(queue, { recursive: true })
    const proc = join(w.dir, "statproc")
    mkdirSync(join(proc, "self"), { recursive: true })
    mkdirSync(join(proc, "sys/kernel/random"), { recursive: true })
    writeFileSync(join(proc, "self/stat"), "1 (sh) S 0\n")
    writeFileSync(join(proc, "sys/kernel/random/boot_id"), "b00t-1d\n")
    const stat = (pid: number | string, tick: number) => `${pid} (a) ${["S", ...Array.from({ length: 18 }, (_, i) => String(i + 4)), String(tick), ...Array.from({ length: 30 }, () => "0")].join(" ")}\n`
    const file = join(queue, "1.w")
    writeFileSync(file, "")
    const release = join(w.dir, "release")
    // The holder is a live process (the flock it runs): kill -0 finds it.
    const lockHolder = spawnOwned([join(w.bin, "flock"), file, "sh", "-c", `until [ -e '${release}' ]; do sleep 0.05; done`])
    const pid = lockHolder.pid
    mkdirSync(join(proc, String(pid)), { recursive: true })
    writeFileSync(join(proc, String(pid), "stat"), stat(pid, 777))
    writeFileSync(file, `${pid}\nboot b00t-1d tick 777\n${TICKET_SINCE}\nhold the line\n`)
    const locked = () => Bun.spawnSync([join(w.bin, "flock"), "-n", file, "true"]).exitCode === 1
    const env = { ...w.env, WORKRIFT_STAT_PROC: proc }
    const own = `mkdir -p '${proc}'/$$ && printf '%s\\n' "$$ (w) ${stat(0, 999).split(") ").slice(1).join(") ").replace(/\n$/, "")}" >'${proc}'/$$/stat && exec "$@"`
    try {
      await until("locked", locked, 120_000)
      const waiter = start(w.app, env, ["/bin/sh", "-c", own, "sh", SCRIPT, "hold", "--", "probe", log, "waiter", "w", "0.1"], join(w.dir, "waiter.err"))
      let ended = false
      void waiter.done.then(() => (ended = true))
      await until("the waiter names the live holder", () => waiter.err().includes(`behind 1; the first pid ${pid} (hold the line)`), 120_000)
      unread(proc, pid)
      // Long enough for a waiter that took it for gone to go in (ticket_wait looks again every 5 s at most).
      await Bun.sleep(7000)
      expect(ended, waiter.err()).toBe(false)
      expect(ivs()).toEqual([])
      writeFileSync(release, "")
      const ran = await waiter.done
      expect(ran.code, ran.err).toBe(0)
      expect(ivs().map((each) => each.id)).toEqual(["waiter"])
    } finally {
      writeFileSync(release, "")
      await endOwned([pid])
    }
  }, hangGuard("acceptance"))

  test("a ticket whose rm fails as the holder leaves stays, said: the command still succeeds, and the line takes the ticket for ended (its lock is free)", () => {
    const { w } = bench("leave")
    const queue = join(stateOf(w.app), "base")
    const shim = failingShim(w.dir, "rm", 1)
    // m4-leave: queue_leave's plain rm stopped the script under set -e after the work was done.
    const ran = run(w.app, { ...w.env, PATH: `${shim}:${w.env.PATH}`, FAKE_RM_FAIL_GLOB: `${queue}/*.w` }, [SCRIPT, "hold", "--", "true"])
    expect(ran.code, ran.err).toBe(0)
    expect(ran.err).toMatch(/workrift: the ticket .*\.w stays \(rm failed\); its lock is free, so the line takes it for ended/)
    expect(readdirSync(queue).filter((name) => name.endsWith(".w"))).not.toEqual([])
    const next = run(w.app, w.env, [SCRIPT, "hold", "--", "true"])
    expect(next.code, next.err).toBe(0)
    expect(next.err).not.toContain("waiting for")
  }, hangGuard("process-fixture"))

  test("the queue's own files tampered with while a writer holds: a counter deleted or garbled, a holder's record emptied; no second holder goes in", async () => {
    const { w, log, ivs } = bench("tamper")
    const state = stateOf(w.app)
    const cases: ReadonlyArray<readonly [string, () => void]> = [
      ["counter deleted", () => rmSync(join(state, "next"), { force: true })],
      ["counter garbled", () => writeFileSync(join(state, "next"), "abc\n")],
      ["counter behind", () => writeFileSync(join(state, "next"), "0\n")],
      [
        "record emptied",
        () => {
          for (const name of readdirSync(join(state, "base"))) if (/^\d+\.w$/.test(name)) writeFileSync(join(state, "base", name), "")
        },
      ],
    ]
    for (const [i, [label, tamper]] of cases.entries()) {
      const holder = hold(w, w.env, log, `holder${i}`, 3, `holder-${i}.err`)
      await until(`holder${i} in`, () => ivs().some((each) => each.id === `holder${i}`))
      tamper()
      const waiter = hold(w, w.env, log, `waiter${i}`, 0.1, `waiter-${i}.err`)
      const ran = await Promise.all([holder.done, waiter.done])
      for (const each of ran) expect(each.code, `${label}: ${each.err}`).toBe(0)
      expect({ label, overlaps: overlaps(ivs()) }).toEqual({ label, overlaps: [] })
    }
  }, 120_000)

  test("a queue folder removed while a ticket waits in it: the waiter fails closed and does nothing", async () => {
    const { w, log, ivs } = bench("vanished")
    const holder = hold(w, w.env, log, "holder", 3, "holder.err")
    await until("holder in", () => ivs().some((each) => each.id === "holder"))
    const waiter = hold(w, w.env, log, "waiter", 0.1, "waiter.err")
    await until("waiter in line", () => readdirSync(join(stateOf(w.app), "base")).filter((name) => /\.[rw]$/.test(name)).length === 2)
    rmSync(join(stateOf(w.app), "base"), { recursive: true, force: true })
    const [h, ran] = await Promise.all([holder.done, waiter.done])
    expect(h.code).toBe(0)
    expect(ran.code).toBe(1)
    // Removed before its record was written (it cannot be) or after (it is gone): either way nothing done.
    expect(ran.err).toMatch(/was removed while it waited|could not be written: no place in line taken, nothing done/)
    expect(ivs().map((each) => each.id)).toEqual(["holder"])
  }, 60_000)

  test("a waiter stopped at the head of the line holds those behind it, and their line says so and how to go on", async () => {
    const { w, log, ivs } = bench("stopped")
    const holder = hold(w, w.env, log, "holder", 2, "holder.err")
    await until("holder in", () => ivs().some((each) => each.id === "holder"))
    const stopped = hold(w, w.env, log, "stopped", 0.1, "stopped.err")
    // Stopped once it waits: past the queue's mutex, which it holds for the milliseconds it takes its number.
    await until("in line", () => stopped.err().includes("waiting for the lock"))
    process.kill(stopped.pid, "SIGSTOP")
    expect((await holder.done).code).toBe(0)
    const behind = hold(w, w.env, log, "behind", 0.1, "behind.err")
    await until("its waiting line", () => behind.err().includes("waiting for the lock"))
    expect(behind.err()).toContain(`the first pid ${stopped.pid} (hold probe`)
    expect(behind.err()).toContain(`it is stopped: kill -CONT ${stopped.pid} to go on, or end it`)
    process.kill(stopped.pid, "SIGCONT")
    for (const each of await Promise.all([stopped.done, behind.done])) expect(each.code, each.err).toBe(0)
    expect(ivs().map((each) => each.id)).toEqual(["holder", "stopped", "behind"])
  }, 60_000)

  test("`workrift deps` run by hand in a base waits for the exclusive lock: its install never runs beside a hold", async () => {
    const { w, log, ivs } = bench("deps-in-base")
    sh(w.app, w.env, "git", "config", "workrift.install", `probe '${log}' deps-install w 0.2`)
    // The base's install fingerprint says another lock, so deps installs.
    writeFileSync(join(w.app, ".git/workrift-installed-locks"), "bun.lock old\n")
    const holder = start(w.app, w.env, [SCRIPT, "hold", "--shared", "--", "probe", log, "reader", "r", "2"], join(w.dir, "reader.err"))
    await until("reader in", () => ivs().some((each) => each.id === "reader"))
    const deps = start(w.app, w.env, [SCRIPT, "deps"], join(w.dir, "deps.err"))
    for (const each of await Promise.all([holder.done, deps.done])) expect(each.code, each.err).toBe(0)
    const got = ivs()
    expect(got.map((each) => each.id).sort()).toEqual(["deps-install", "reader"])
    expect(overlaps(got)).toEqual([])
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Round 3 of create-fair (2026-11-22): `workrift deps` fired by a hook of a command that holds the base (B2), the older
// workrift's lock file made before a copy relies on it (F1), and a holder whose ticket file went (T1).

interface Grouped extends Started {
  /** Kills its whole process group (it runs in its own). */
  readonly kill: () => void
}

/** Starts argv in a process group of its own, so a test that finds it hung can end everything it started. */
const startGroup = (cwd: string, env: Env, argv: ReadonlyArray<string>, errFile: string): Grouped => {
  writeFileSync(errFile, "")
  const child = Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: Bun.file(errFile), detached: true })
  ownedGroups.add(child.pid)
  const err = () => readFileSync(errFile, "utf8")
  const done = (async () => {
    const out = await new Response(child.stdout).text()
    const code = await child.exited
    return { code, out, err: err() }
  })()
  const kill = () => endGroup(child.pid)
  return { pid: child.pid, err, done, kill }
}

/** Its result once it ends within ms, else undefined, its group killed. */
const within = async (run: Grouped, ms: number) => {
  const ran = await Promise.race([run.done, Bun.sleep(ms).then(() => undefined)])
  if (ran === undefined) {
    run.kill()
    await run.done
  }
  return ran
}

describeWork("workrift deps fired inside a command that holds the base, and the older lock file (create-fair round 3)", () => {
  const work = WORK_BIN ?? "work"
  const OLD = OLD_WORKRIFT()
  /**
   * A probe bench whose base runs `workrift deps` from its Git hooks, as Bite's lefthook-local.yml has it
   * (post-checkout, post-merge, post-rewrite with its argument), the installed workrift being this script; its
   * install in the base is a probe interval `install-<pid>`, and origin's main has moved its lock file.
   */
  const hooked = (label: string) => {
    const b = probeBench(label, work)
    const { w, log } = b
    symlinkSync(SCRIPT, join(w.bin, "workrift"))
    for (const hook of ["post-checkout", "post-merge"]) exe(join(w.app, ".git/hooks", hook), "#!/bin/sh\nworkrift deps\n")
    exe(join(w.app, ".git/hooks/post-rewrite"), '#!/bin/sh\nworkrift deps "$1"\n')
    sh(w.app, w.env, "git", "config", "workrift.install", `if [ "$(pwd -P)" = '${w.app}' ]; then probe '${log}' install-$$ w 0.3; fi`)
    w.push("main", { "bun.lock": "main-2\n", "two.txt": "2\n" })
    sh(w.app, w.env, "git", "fetch", "-q", "origin")
    return b
  }
  /** The install's fingerprint made stale, so the next `deps` in the base installs. */
  const staleInstall = (app: string) => writeFileSync(join(app, ".git/workrift-installed-locks"), "bun.lock stale\n")
  const installs = (ivs: ReadonlyArray<Interval>) => ivs.filter((each) => each.id.startsWith("install-"))

  test("red on round 2: an older workrift's refresh, whose switch and fast-forward fire the base's hooks, ends: the hooks' deps see it holds the base and leave the install to it", async () => {
    const { w, ivs } = hooked("old-refresh")
    const refresh = startGroup(w.app, w.env, [OLD, "refresh"], join(w.dir, "refresh.err"))
    const ran = await within(refresh, 60_000)
    expect(ran?.code, refresh.err()).toBe(0)
    expect(refresh.err()).toContain("an older workrift this hook runs under; it installs the base itself")
    expect(sh(w.app, w.env, "git", "rev-parse", "HEAD").trim()).toBe(sh(w.app, w.env, "git", "rev-parse", "origin/main").trim())
    // The refresh's own install, once; none from the hooks.
    expect(installs(ivs())).toHaveLength(1)
    expect(readdirSync(join(stateOf(w.app), "base")).filter((name) => /\.[rw]$/.test(name))).toEqual([])
  }, 120_000)

  test("red on round 2: `hold -- git …` in a base fires the hooks: their deps install under the hold's exclusive lock and the hold ends", async () => {
    const { w, ivs } = hooked("hold-w")
    staleInstall(w.app)
    const held = startGroup(w.app, w.env, [SCRIPT, "hold", "--", "sh", "-c", "git checkout -q -b side && git checkout -q main && git merge -q --ff-only origin/main"], join(w.dir, "hold.err"))
    const ran = await within(held, 60_000)
    expect(ran?.code, held.err()).toBe(0)
    expect(installs(ivs()).length).toBeGreaterThanOrEqual(1)
    expect(overlaps(ivs())).toEqual([])
  }, 120_000)

  test("red on round 2: `hold --shared -- git …` in a base fires the hooks: their deps change nothing beside copies, say so, and the hold ends", async () => {
    const { w, ivs } = hooked("hold-r")
    staleInstall(w.app)
    const held = startGroup(w.app, w.env, [SCRIPT, "hold", "--shared", "--", "sh", "-c", "git checkout -q -b side && git checkout -q main"], join(w.dir, "hold.err"))
    const ran = await within(held, 60_000)
    expect(ran?.code, held.err()).toBe(0)
    expect(held.err()).toContain("which this hook runs under: no install beside copies; run `workrift deps`")
    expect(installs(ivs())).toEqual([])
  }, 120_000)

  test("the hooks fired inside an older create's advance, this script's refresh, advance and create (in the workspace) never wait for their own holder", async () => {
    const { w, ivs } = hooked("self-installing")
    const runs: Array<readonly [string, ReadonlyArray<string>, () => void]> = [
      ["old create advancing", [OLD, "create", "old/one"], () => stampAdvance(w.app, `${Math.floor(Date.now() / 1000) - 601}\n`)],
      ["refresh", [SCRIPT, "refresh"], () => w.push("main", { "bun.lock": "main-3\n" })],
      [
        "advance",
        [SCRIPT, "advance"],
        () => {
          w.push("main", { "bun.lock": "main-4\n" })
          sh(w.app, w.env, "git", "fetch", "-q", "origin")
          stampAdvance(w.app, `${Math.floor(Date.now() / 1000) - 601}\n`)
        },
      ],
      ["create", [SCRIPT, "create", "feat/hooked"], () => {}],
    ]
    for (const [label, argv, before] of runs) {
      before()
      const run = startGroup(w.app, w.env, argv, join(w.dir, `${label.replace(/ /g, "-")}.err`))
      const ran = await within(run, 90_000)
      expect({ label, code: ran?.code }, run.err()).toEqual({ label, code: 0 })
    }
    expect(overlaps(ivs())).toEqual([])
  }, 400_000)

  test("a `workrift deps` by hand in a base, beside an older create that is not its ancestor and holds the base mid-copy, waits for it, then installs", async () => {
    const { w, log, ivs } = hooked("unrelated-old")
    // Advanced just now: the old create only copies, holding the base whole.
    stampAdvance(w.app, `${Math.floor(Date.now() / 1000)}\n`)
    const copies = slowCopy(w.bin, 2)
    const old = startGroup(w.app, w.env, [OLD, "create", "old/copying"], join(w.dir, "old.err"))
    await until("the old copy", () => existsSync(join(w.bin, "..", "copies.begun")))
    staleInstall(w.app)
    const deps = startGroup(w.app, w.env, [SCRIPT, "deps"], join(w.dir, "deps.err"))
    const ran = await Promise.all([within(old, 90_000), within(deps, 90_000)])
    for (const each of ran) expect(each?.code).toBe(0)
    expect(deps.err()).not.toContain("this hook runs under")
    const copied = copies().map((c): Interval => ({ id: "old-copy", kind: "w", t0: c.start, t1: c.end }))
    expect(copied).toHaveLength(1)
    expect(installs(ivs())).toHaveLength(1)
    expect(overlaps([...intervals(log), ...copied])).toEqual([])
  }, 120_000)

  test("red on round 2: a base with no lock file of the older workrift gets one from the first copy, alone, so an older create that comes during the copy waits for it", async () => {
    const { w, log } = probeBench("no-legacy-file", work)
    const legacy = join(w.app, ".git/workrift.lock")
    rmSync(legacy, { force: true })
    writeFileSync(join(w.app, ".git/info/exclude"), "node_modules/\n", { flag: "a" })
    sh(w.app, w.env, "git", "config", "workrift.install", `if [ "$(pwd -P)" = '${w.app}' ]; then probe '${log}' "install-$WR_WHO" w 1; fi`)
    w.push("main", { "bun.lock": "main-2\n" })
    stampAdvance(w.app, `${Math.floor(Date.now() / 1000) - 601}\n`)
    const copies = slowCopy(w.bin, 3)
    const fresh = startGroup(w.app, { ...w.env, WR_WHO: "new" }, [SCRIPT, "create", "new/a"], join(w.dir, "new.err"))
    await until("the new copy", () => existsSync(join(w.bin, "..", "copies.begun")))
    const madeBeforeTheCopy = existsSync(legacy)
    const old = startGroup(w.app, { ...w.env, WR_WHO: "old" }, [OLD, "create", "old/a"], join(w.dir, "old.err"))
    const ran = await Promise.all([within(fresh, 90_000), within(old, 90_000)])
    expect(ran.map((each) => each?.code), `${fresh.err()}\n${old.err()}`).toEqual([0, 0])
    for (const pid of ran.flatMap((each) => advancePids(each?.err ?? ""))) await until(`advance ${pid}`, () => !alive(pid), 60_000)
    const copied = copies().map((c): Interval => ({ id: `copy ${basename(c.to)}`, kind: "r", t0: c.start, t1: c.end }))
    expect(copied).toHaveLength(2)
    expect(overlaps([...intervals(log), ...copied])).toEqual([])
    expect(madeBeforeTheCopy).toBe(true)
    expect(readFileSync(legacy, "utf8")).toBe("")
  }, 180_000)

  test("red on round 2: a queue folder removed while a ticket holds: the next writer and the next copy wait for the holder all the same (it holds the older lock file too)", async () => {
    const { w, log, ivs } = probeBench("vanished-holder", work)
    const copies = slowCopy(w.bin, 0)
    const holder = start(w.app, w.env, [SCRIPT, "hold", "--", "probe", log, "holder", "w", "3"], join(w.dir, "holder.err"))
    await until("holder in", () => ivs().some((each) => each.id === "holder"))
    rmSync(join(stateOf(w.app), "base"), { recursive: true, force: true })
    const writer = start(w.app, w.env, [SCRIPT, "hold", "--", "probe", log, "writer", "w", "0.2"], join(w.dir, "writer.err"))
    const reader = start(w.app, w.env, [SCRIPT, "create", "feat/after"], join(w.dir, "reader.err"))
    const ran = await Promise.all([holder.done, writer.done, reader.done])
    for (const each of ran) expect(each.code, each.err).toBe(0)
    const copied = copies().map((c): Interval => ({ id: "copy", kind: "r", t0: c.start, t1: c.end }))
    expect(overlaps([...ivs(), ...copied])).toEqual([])
    expect(writer.err()).toContain("a workrift whose ticket went")
  }, 60_000)

  test("a waiter's once-a-minute line ends quietly: the shell prints no report of its end (bash, macOS's sh)", async () => {
    const { w, log, ivs } = probeBench("quiet", work)
    const holder = start(w.app, w.env, [SCRIPT, "hold", "--", "probe", log, "holder", "w", "1.5"], join(w.dir, "holder.err"))
    await until("holder in", () => ivs().some((each) => each.id === "holder"))
    const waiter = start(w.app, w.env, [SCRIPT, "hold", "--", "true"], join(w.dir, "waiter.err"))
    const ran = await Promise.all([holder.done, waiter.done])
    for (const each of ran) expect(each.code, each.err).toBe(0)
    expect(waiter.err()).toContain("waiting for the lock")
    expect(waiter.err()).not.toContain("sleep 60")
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Round 4 of create-fair (2026-11-22): a holder is deps' ancestor by what that process is now, never by a pid in a
// file (B3: the older workrift leaves its holder file behind when killed, and a pid reused by deps' own shell passed
// for the holder, so deps skipped an install nobody did).

describeWork("workrift deps knows its holder by identity, not by a stale holder file (create-fair round 4)", () => {
  const work = WORK_BIN ?? "work"
  /** The older script under a name without "workrift" (the verifier's harness ran it as old-a5821de8). */
  const OLD = (() => {
    const path = join(scratchRoot, "old-a5821de8")
    writeFileSync(path, readFileSync(OLD_WORKRIFT()))
    chmodSync(path, 0o755)
    return path
  })()
  /**
   * A probe bench whose base runs `workrift deps` from its Git hooks, the installed workrift being this script; its
   * install in the base records the lock file it installed for in node_modules/lock, so `matches` says whether the
   * base ends installed for its lock file.
   */
  const recording = (label: string) => {
    const { w, log } = probeBench(label, work)
    writeFileSync(join(w.app, ".git/info/exclude"), "node_modules/\n", { flag: "a" })
    sh(w.app, w.env, "git", "config", "workrift.install", `if [ "$(pwd -P)" = '${w.app}' ]; then probe '${log}' install-$$ w 0.3; fi; mkdir -p node_modules; cat bun.lock >node_modules/lock`)
    symlinkSync(SCRIPT, join(w.bin, "workrift"))
    for (const hook of ["post-checkout", "post-merge"]) exe(join(w.app, ".git/hooks", hook), "#!/bin/sh\nworkrift deps\n")
    exe(join(w.app, ".git/hooks/post-rewrite"), '#!/bin/sh\nworkrift deps "$1"\n')
    /** The install made stale: the next deps in the base installs, and until it does the base does not match. */
    const stale = () => {
      writeFileSync(join(w.app, ".git/workrift-installed-locks"), "bun.lock stale\n")
      mkdirSync(join(w.app, "node_modules"), { recursive: true })
      writeFileSync(join(w.app, "node_modules/lock"), "stale\n")
    }
    const matches = () => {
      const lock = readFileSync(join(w.app, "bun.lock"), "utf8").trim()
      const inst = existsSync(join(w.app, "node_modules/lock")) ? readFileSync(join(w.app, "node_modules/lock"), "utf8").trim() : "none"
      return { lock, inst, matches: lock === inst }
    }
    return { w, log, stale, matches }
  }
  const holders = (app: string) => join(app, ".git/workrift-lock-holders")
  const now = () => Math.floor(Date.now() / 1000)

  test("red on round 3 (the verifier's C): a stale holder file whose pid is now deps' parent, the old lock held by an unrelated process: deps waits, then installs", async () => {
    const { w, stale, matches } = recording("stale-holder")
    stale()
    // The unrelated old-style holder: an flock on the old lock for 4 s (an old create mid-copy).
    const locker = spawnOwned([join(w.bin, "flock"), "-x", join(w.app, ".git/workrift.lock"), "sleep", "4"], { cwd: w.app, env: w.env })
    await until("the old lock held", () => Bun.spawnSync([join(w.bin, "flock"), "-n", join(w.app, ".git/workrift.lock"), "true"]).exitCode === 1)
    // deps' parent names itself in a holder file, as a killed old create left one with this pid.
    const script = `mkdir -p .git/workrift-lock-holders; echo "1 create old/dead" >.git/workrift-lock-holders/$$; workrift deps`
    const deps = startGroup(w.app, w.env, ["sh", "-c", script], join(w.dir, "deps.err"))
    const ran = await within(deps, 60_000)
    await locker.exited
    await endOwned([locker.pid, deps.pid])
    expect(ran?.code, deps.err()).toBe(0)
    expect(deps.err()).not.toContain("this hook runs under")
    expect(deps.err()).toContain("waiting for")
    expect(matches()).toMatchObject({ matches: true })
  }, 90_000)

  type Holder = "none" | "unrelated old" | "unrelated new" | "ancestor old" | "ancestor new"
  type Stale = "ancestor, long ago" | "ancestor, forged now" | "unrelated live pid" | "dead pid"
  const HOLDERS: ReadonlyArray<Holder> = ["none", "unrelated old", "unrelated new", "ancestor old", "ancestor new"]
  const STALES: ReadonlyArray<Stale> = ["ancestor, long ago", "ancestor, forged now", "unrelated live pid", "dead pid"]

  test("property: for generated stale holder files, holders and process trees, deps skips only under a true ancestor holder, never hangs, and the base ends installed for its lock file", async () => {
    // Cases drawn by a fixed stream; every holder at least twice, with a set of stale files and a tree each.
    let seed = 11
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const cases: Array<{ holder: Holder; stales: ReadonlyArray<Stale>; nested: boolean }> = []
    for (const holder of [...HOLDERS, ...HOLDERS])
      cases.push({ holder, stales: STALES.filter(() => next() < 0.6), nested: next() < 0.5 })
    const results: Array<Record<string, unknown>> = []
    for (const [i, c] of cases.entries()) {
      const { w, stale, matches } = recording(`prop-${i}`)
      const keeper = spawnOwned(["sleep", "60"])
      const dead = Bun.spawnSync(["true"]).pid
      // The stale files the wrapper writes: `$$` is the wrapper, an ancestor of deps in every tree below.
      const plant = c.stales
        .map((s) =>
          s === "ancestor, long ago"
            ? `echo "${now() - 3600} create old/killed" >'${holders(w.app)}'/$$`
            : s === "ancestor, forged now"
              ? `echo "$(date +%s) create old/forged" >'${holders(w.app)}'/$$`
              : s === "unrelated live pid"
                ? `echo "${now() - 60} create old/other" >'${holders(w.app)}/${keeper.pid}'`
                : `echo "${now() - 600} refresh" >'${holders(w.app)}/${dead}'`,
        )
        .join("; ")
      const deps = c.nested ? `sh -c 'sh -c "workrift deps"'` : "workrift deps"
      let run: string
      let locker: { readonly pid: number; readonly exited: Promise<number> } | undefined
      if (c.holder === "ancestor old" || c.holder === "ancestor new") {
        w.push("main", { "bun.lock": `main-2 ${i}\n` })
        sh(w.app, w.env, "git", "fetch", "-q", "origin")
        stale()
        // deps runs from the hooks of the holder's own git: the wrapper starts the holder.
        run = c.holder === "ancestor old" ? `'${OLD}' refresh` : `'${SCRIPT}' hold -- git merge -q --ff-only origin/main`
      } else {
        stale()
        if (c.holder === "unrelated old") {
          // An old create mid-copy: its flock on the old lock, its own true holder file.
          const l = spawnOwned([join(w.bin, "flock"), "-x", join(w.app, ".git/workrift.lock"), "sleep", "3"], { cwd: w.app, env: w.env })
          mkdirSync(holders(w.app), { recursive: true })
          writeFileSync(join(holders(w.app), String(l.pid)), `${now()} create old/copying\n`)
          locker = l
          await until("the old lock held", () => Bun.spawnSync([join(w.bin, "flock"), "-n", join(w.app, ".git/workrift.lock"), "true"]).exitCode === 1)
        }
        if (c.holder === "unrelated new") {
          const h = spawnOwned([SCRIPT, "hold", "--", "sleep", "3"], { cwd: w.app, env: w.env })
          locker = h
          await until("the hold in", () => readdirSync(join(stateOf(w.app), "base")).some((name) => name.endsWith(".in")))
        }
        run = deps
      }
      const wrapper = startGroup(w.app, w.env, ["sh", "-c", `mkdir -p '${holders(w.app)}'; ${plant}${plant ? "; " : ""}${run}`], join(w.dir, `case-${i}.err`))
      const ran = await within(wrapper, 60_000)
      await locker?.exited
      await endOwned([keeper.pid, wrapper.pid, ...(locker ? [locker.pid] : [])])
      const err = wrapper.err()
      results.push({
        case: c,
        code: ran === undefined ? "hung" : ran.code,
        skipped: err.includes("this hook runs under"),
        ...matches(),
      })
    }
    const wrong = results.filter((r) => {
      const c = r.case as (typeof cases)[number]
      return r.code !== 0 || r.skipped !== (c.holder === "ancestor old") || r.matches !== true
    })
    expect(wrong).toEqual([])
    // The stream covers a true ancestor with a stale file naming that same ancestor, and unrelated holders with one.
    expect(cases.some((c) => c.holder === "ancestor old" && c.stales.length > 0)).toBe(true)
    expect(cases.some((c) => c.holder.startsWith("unrelated") && c.stales.some((s) => s.startsWith("ancestor")))).toBe(true)
  }, 600_000)
})

/** The last test's cap: one ps a group owned, then one of the whole table (each well under a second, a few at load). */

describe("the end of the file", () => {
  test("no process a test of this file started survives it: every owned group is empty, and the run has no child left", () => {
    const left = [...ownedGroups].flatMap((pgid) => groupMembers(pgid).map((pid) => `${pid} (group ${pgid})`))
    expect(left).toEqual([])
    const table = lines(Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="]).stdout.toString()).map((line) => {
      const [pid, ppid, ...command] = line.trim().split(/\s+/)
      return { pid: Number(pid), ppid: Number(ppid), command: command.join(" ") }
    })
    // The run's descendants, but the ps that listed them.
    const descendants: Array<string> = []
    const parents = new Set([process.pid])
    for (let grew = true; grew; ) {
      grew = false
      for (const each of table)
        if (parents.has(each.ppid) && !parents.has(each.pid)) {
          parents.add(each.pid)
          grew = true
          if (!each.command.startsWith("ps -A -o ")) descendants.push(`${each.pid} ${each.command}`)
        }
    }
    expect(descendants).toEqual([])
  }, hangGuard("local-fixture"))
})
