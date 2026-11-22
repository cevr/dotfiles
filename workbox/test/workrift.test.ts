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
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

const repo = join(import.meta.dir, "..", "..")
// WORKRIFT_SCRIPT runs the suite against another script (an older one, for a test's red run).
const SCRIPT = process.env.WORKRIFT_SCRIPT ?? join(repo, "workbox/bin/workrift")
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
      // refresh and create now say once when the source has no warm step and never warmed (Bite base re-created
      // cold, 2026-11-19): that line, and the two reads it makes (the warm step, the marker's path), are theirs.
      const note = "workrift: <S>/root/app has no warm step (git config workrift.warm) and was never warmed; its workspaces start cold\n"
      const marker = "git [-C] [<S>/root/app] [rev-parse] [--path-format=absolute] [--git-path] [workrift-warmed-tree]"
      const withoutNote = (step: (typeof after)[number]) => {
        if (step.argv !== "refresh" && !step.argv.startsWith("create ")) return step
        expect(step.err.split(note).length - 1, step.argv).toBe(1)
        const at = step.calls.indexOf(marker)
        expect(step.calls[at - 1], step.argv).toBe("git [-C] [<S>/root/app] [config] [--get] [workrift.warm]")
        return { ...step, err: step.err.replace(note, ""), calls: step.calls.filter((_, i) => i !== at && i !== at - 1) }
      }
      // create now checks what the base lacks under the lock (its marker, its advance stamp, its hooks) and says
      // its phases (a create waited 1059 s, 2026-11-20); the Rift backend is on its way out, so create's steps
      // keep only their rift calls, exit, output and remaining stderr to compare. Every other verb stays exact.
      // refresh too, since it takes the advance lock and warms with the base's lock free (seven creates queued behind
      // a base's warm, 2026-11-21): its git calls are not compared; its rift calls, exit, output and stderr are.
      const createRift = (step: (typeof after)[number]) =>
        step.argv.startsWith("create ") || step.argv === "refresh"
          ? {
              ...step,
              calls: step.calls.filter((call) => call.startsWith("rift ")),
              err: step.err
                .split("\n")
                .filter((line) => !line.startsWith(`workrift: ${step.argv}: `))
                .join("\n"),
            }
          : step
      // check now also reads the warm step, its last call, to warn when the base's build output lags its tree (an
      // advance no longer warms, 2026-11-22); with none set it warns of nothing.
      const check = after.find((step) => step.argv === "check")
      expect(check?.calls.at(-1)).toBe("git [-C] [<S>/root/app] [config] [--get] [workrift.warm]")
      const lastDropped = (step: (typeof after)[number]) => ({ ...step, calls: step.calls.slice(0, -1) })
      expect(after.map((step) => createRift(step === deps || step === check ? lastDropped(step) : withoutNote(step)))).toEqual(before.map(createRift))
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
    60_000,
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
    60_000,
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
    60_000,
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
    120_000,
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
    120_000,
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
            const start = sh(p.w.app, h.env, "ps", "-o", "lstart=", "-p", String(process.pid)).trim()
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
      "if ($t =~ /^\\d+$/ && !@ARGV) { open($fh, '>>&=', $t) or exit 64 } else { open($fh, '>>', $t) or exit 64 }",
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
const slowCopy = (bin: string, delay: number) => {
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
    sh(w.app, w.env, "git", "config", "workrift.warm", `sleep 0.2; ${heldTest(w.app)}; printf '%s %s\\n' "$(pwd -P)" "$s" >>'${warmed}'`)
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
    "seven creates at once after main's lock changed: each is in within seconds; one advance moves and installs the base after the copies, in the background, and warms nothing; every workspace ends installed for its own lock",
    async () => {
      const { w, head } = loaded("seven")
      const installs = join(w.dir, "installs")
      const baseWarms = join(w.dir, "base-warms")
      sh(w.app, w.env, "git", "config", "workrift.install", `sleep 1; cat bun.lock >"$(git rev-parse --absolute-git-dir)/installed-lock"; pwd -P >>'${installs}'`)
      sh(w.app, w.env, "git", "config", "workrift.warm", `sleep 3; pwd -P >>'${baseWarms}'`)
      const read = (file: string) => lines(existsSync(file) ? readFileSync(file, "utf8") : "")
      w.push("main", { "bun.lock": "main-1\n" })
      expect(w.wr(w.app, "refresh").code).toBe(0)
      const warmedTree = readFileSync(join(w.app, ".git/workrift-warmed-tree"), "utf8").trim()
      const landed = w.push("main", { "bun.lock": "main-2\n" })
      // The last advance is older than the window: the next create advances the base.
      stampAdvance(w.app, `${Math.floor(Date.now() / 1000) - 601}\n`)
      const branches = Array.from({ length: 7 }, (_, i) => `feat/p${i}`)
      const ran = await spawnAll(w.app, w.env, branches.map((branch) => [SCRIPT, "create", branch]))
      const paths = ran.map((each) => lines(each.out).at(-1) ?? "")
      for (const [i, each] of ran.entries()) {
        expect(each.code, each.err).toBe(0)
        expect(lines(each.out)).toEqual([paths[i]])
        // The wait for the base's lock (its 'lock' line to its 'locked' line) is at most an advance's move (its
        // install: sleep 1), never a warm (sleep 3) nor a queue of copies.
        const asked = Number(each.err.match(/: lock \/\S+ \((\d+)s\)/)?.[1])
        const locked = Number(each.err.match(/: locked \((\d+)s\)/)?.[1])
        expect({ branch: branches[i], waited: locked - asked <= 2 }, each.err).toEqual({ branch: branches[i], waited: true })
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
    90_000,
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
      // A hold of the base's lock for two seconds, in line before the create.
      const holder = Bun.spawn([SCRIPT, "hold", "--", "sleep", "2"], { cwd: w.app, env: w.env, stdout: "ignore", stderr: "ignore" })
      while (!readdirSync(join(stateOf(w.app), "base")).some((name) => name.endsWith(".w"))) await Bun.sleep(20)
      const [ran] = await spawnAll(w.app, w.env, [[SCRIPT, "create", "feat/p"]])
      expect(await holder.exited).toBe(0)
      expect(ran?.code, ran?.err).toBe(0)
      const path = join(w.root, ".work/app/feat-p")
      expect(ran?.out).toBe(`${path}\n`)
      const said = lines(ran?.err ?? "")
      expect(said.filter((line) => line.startsWith("workrift: waiting"))).toEqual([
        expect.stringMatching(new RegExp(`^workrift: waiting for the lock of ${w.app}: behind 1; the first pid ${holder.pid} \\(hold sleep 2\\), holding since \\d\\d:\\d\\d:\\d\\dZ$`)),
      ])
      const steps = said.filter((line) => line.startsWith("workrift: create feat/p: ")).map((line) => line.replace(/ \(\d+s\)$/, ""))
      expect(steps).toEqual([
        "workrift: create feat/p: look up feat/p and main on origin",
        `workrift: create feat/p: lock ${w.app}`,
        "workrift: create feat/p: locked",
        "workrift: create feat/p: clone feat-p",
        "workrift: create feat/p: fetch feat/p and main into the workspace",
        "workrift: create feat/p: workspace: install if its lock file changed",
        "workrift: create feat/p: workspace: warm step if its tree changed",
        `workrift: create feat/p: done: ${path}`,
      ])
      for (const line of said.filter((line) => line.startsWith("workrift: create feat/p: "))) expect(line).toMatch(/ \(\d+s\)$/)
      // The lock waited about as long as the holder held it, and no ticket is left.
      expect(Number(said.find((line) => line.includes(": locked"))?.match(/\((\d+)s\)$/)?.[1])).toBeGreaterThanOrEqual(1)
      expect(readdirSync(join(stateOf(w.app), "base"))).toEqual([])
    },
    60_000,
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
      // install fingerprint, the warm marker and the warm's log.
      expect(readdirSync(join(w.app, ".git")).filter((name) => name.startsWith("workrift")).sort()).toEqual(
        ["workrift-installed-locks", "workrift-warm.log", "workrift-warmed-tree"].filter((name) => existsSync(join(w.app, ".git", name))),
      )
    },
    600_000,
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
    "red on main: twelve refreshes against a slow one are served in the order they came",
    async () => {
      const { w } = loaded("fifo")
      const order = join(w.dir, "order")
      sh(w.app, w.env, "git", "config", "workrift.warm", "true")
      sh(w.app, w.env, "git", "config", "workrift.install", `if [ "$LABEL" = first ]; then sleep 6; else sleep 0.2; fi; printf '%s\\n' "$LABEL" >>'${order}'`)
      expect(w.wr(w.app, "refresh").code).toBe(0)
      writeFileSync(order, "")
      const spawned: Array<ReturnType<typeof Bun.spawn>> = []
      const labels = ["first", ...Array.from({ length: 12 }, (_, i) => `r${i}`)]
      for (const label of labels) {
        spawned.push(Bun.spawn([SCRIPT, "refresh"], { cwd: w.app, env: { ...w.env, LABEL: label }, stdout: "ignore", stderr: "ignore" }))
        await Bun.sleep(400)
      }
      for (const child of spawned) expect(await child.exited).toBe(0)
      expect(lines(readFileSync(order, "utf8"))).toEqual(labels)
    },
    120_000,
  )

  test(
    "creates and exclusive holds in one line: the creates between two holds copy together, after the first and before the second",
    async () => {
      const { w } = loaded("batches")
      const copies = slowCopy(w.bin, 0.2)
      const holds = join(w.dir, "holds")
      expect(w.wr(w.app, "refresh").code).toBe(0)
      const hold = (label: string, seconds: number) =>
        Bun.spawn([SCRIPT, "hold", "--", "sh", "-c", `printf '${label} start %s\\n' "$(${nowLine})" >>'${holds}'; sleep ${seconds}; printf '${label} end %s\\n' "$(${nowLine})" >>'${holds}'`], {
          cwd: w.app,
          env: w.env,
          stdout: "ignore",
          stderr: "ignore",
        })
      const creates: Array<Promise<Spawned>> = []
      const create = (branch: string) => {
        creates.push(spawnAll(w.app, w.env, [[SCRIPT, "create", branch]]).then((ran) => ran[0]!))
      }
      const h0 = hold("h0", 6)
      await Bun.sleep(500)
      for (const i of [0, 1, 2, 3]) {
        create(`feat/a${i}`)
        await Bun.sleep(300)
      }
      await Bun.sleep(1000)
      const h1 = hold("h1", 1)
      await Bun.sleep(1000)
      for (const i of [0, 1, 2, 3]) {
        create(`feat/b${i}`)
        await Bun.sleep(300)
      }
      expect(await h0.exited).toBe(0)
      expect(await h1.exited).toBe(0)
      for (const ran of await Promise.all(creates)) expect(ran.code, ran.err).toBe(0)
      const at = (what: string) => Number(lines(readFileSync(holds, "utf8")).find((line) => line.startsWith(`${what} `))?.split(" ")[2])
      const copy = copies()
      const of = (prefix: string) => copy.filter((each) => each.to.includes(`/feat-${prefix}`))
      expect(of("a")).toHaveLength(4)
      expect(of("b")).toHaveLength(4)
      for (const each of of("a")) expect({ to: each.to, afterH0: each.start >= at("h0 end"), beforeH1: each.end <= at("h1 start") }).toEqual({ to: each.to, afterH0: true, beforeH1: true })
      for (const each of of("b")) expect({ to: each.to, afterH1: each.start >= at("h1 end") }).toEqual({ to: each.to, afterH1: true })
      // The creates between the holds went in together: every copy began before any ended.
      expect(Math.max(...of("a").map((each) => each.start))).toBeLessThan(Math.min(...of("a").map((each) => each.end)))
    },
    120_000,
  )

  test(
    "kill -9 of a create waiting in line, and of a hold holding the lock: the line goes on within seconds and no ticket is left",
    async () => {
      const { w } = loaded("killed")
      expect(w.wr(w.app, "refresh").code).toBe(0)
      const queue = join(stateOf(w.app), "base")
      const tickets = () => (existsSync(queue) ? readdirSync(queue) : [])
      const pidFile = join(w.dir, "sleeper")
      // A hold whose command we can find: it records its pid, then sleeps.
      const holder = Bun.spawn([SCRIPT, "hold", "--", "sh", "-c", `echo $$ >'${pidFile}'; exec sleep 30`], { cwd: w.app, env: w.env, stdout: "ignore", stderr: "ignore" })
      while (!existsSync(pidFile)) await Bun.sleep(20)
      // A create waits behind it; it is killed while it waits.
      const waiter = Bun.spawn([SCRIPT, "create", "feat/killed"], { cwd: w.app, env: w.env, stdout: "ignore", stderr: "ignore" })
      while (tickets().length < 2) await Bun.sleep(20)
      waiter.kill("SIGKILL")
      await waiter.exited
      // The holder is killed while it holds: its command lives on, but holds no ticket of its.
      holder.kill("SIGKILL")
      await holder.exited
      const started = Date.now()
      const ran = w.wr(w.app, "create", "feat/after")
      expect(ran.code, ran.err).toBe(0)
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(tickets()).toEqual([])
      expect(w.active(w.app).map((each) => each.name)).toEqual(["feat-after"])
      process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL")
    },
    60_000,
  )

  test(
    "a work new that dies mid-copy leaves a Creating record: the create hands it to work gc -id and fails, leaving no record and no folder",
    () => {
      const { w } = loaded("died")
      slowCopy(w.bin, 1)
      expect(w.wr(w.app, "refresh").code).toBe(0)
      // A work that is killed once its clone has begun (as a host's OOM killer would).
      const dying = join(w.bin, "dying-work")
      exe(
        dying,
        `#!/bin/sh\ncase " $* " in\n  *" new "*) ;;\n  *) exec '${work}' "$@" ;;\nesac\n'${work}' "$@" &\nchild=$!\nuntil grep -q feat-died '${join(w.bin, "..", "copies.begun")}' 2>/dev/null; do sleep 0.05; done\nsleep 0.2\npkill -9 -P "$child"\nkill -9 "$child"\nwait "$child"\nexit 137\n`,
      )
      const ran = run(w.app, { ...w.env, WORK: dying }, [SCRIPT, "create", "feat/died"])
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
