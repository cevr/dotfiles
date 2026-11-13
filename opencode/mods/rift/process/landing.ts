// Landing over Git and the shell, run as child processes. The repository's
// commands come from its warm source's Git config (`rift.gate`,
// `rift.accept`, `rift.generated`, `rift.regenerate`, `rift.push`,
// `rift.pushBranches`, `rift.postLand`, the default branch from
// `workrift.main` else origin's HEAD) and run through `sh -c`, their output
// kept in a log under `logs`; the gate and the acceptance run always run
// heavy, through the guard's launcher (`checkArgv`). A lock file is installed again with its package
// manager (frozen first, then free, as a merged lock file may need) and
// committed when the install rewrote it. `rift.regenerate` runs after every
// batch's merges, and what it rewrote is committed.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { availableParallelism, loadavg } from "node:os"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { basename, dirname, join } from "node:path"
import { DEFAULT_LIMITS, heavyArgv, type Host, ioniceAvailable, SCOPE_PROBE } from "@dotfiles/opencode-guard/launcher"
import { Effect, Layer, Option } from "effect"
import { type HostLoad, type LandConfig, type Merged, type PostLanded, type Ran, type Started, type Unit } from "../land.ts"
import { Landing, RiftFailed } from "../service.ts"
import { commands, lines } from "./command.ts"
import { exclusively, exclusivelySync, holding, type LockMode, oneGate } from "./flock.ts"

export interface Options {
  /** Where each check's log is written, `<rift name>.<gate|accept>.log`. */
  readonly logs: string
  /** Variables added to every command's environment (a test's scratch HOME). */
  readonly env?: Readonly<Record<string, string>>
  /** The machine's platform; a test names another. */
  readonly platform?: string
  /** The systemd scope probe (the guard's `SCOPE_PROBE`); a test names a stand-in. */
  readonly probe?: ReadonlyArray<string>
}

/**
 * The argv a gate or acceptance run runs as: always heavy, through the
 * guard's launcher (`nice`, `ionice -c3` where the host has it, and on a
 * systemd host a user scope under its memory cap), both streams into `log`
 * in the order they were written.
 */
export const checkArgv = (command: string, log: string, host: Host): ReadonlyArray<string> =>
  heavyArgv(["sh", "-c", 'sh -c "$1" >"$2" 2>&1', "rift-land", command, log], DEFAULT_LIMITS, host)

/**
 * The lock files a land's checks hold, under `logs`, one set per host. `checks`: every gate and accept check
 * holds it shared, so a post-land step that changes what they read (the dotfiles' fork checkout) holds it
 * exclusively for that short change alone, and a full gate run by hand holds it exclusively for its whole run
 * (flock.ts's `gateTurn`). `accept`: each accept check holds it exclusively, and so does a
 * post-land step's own heavy test run, so the two never run at once. `wanted`: every gate and accept check
 * holds it shared from before it waits for `checks` until it ends, so a full gate waiting for its turn lets
 * a land's check go first.
 */
export const lockFiles = (logs: string) => ({ checks: join(logs, "locks", "checks.lock"), accept: join(logs, "locks", "accept.lock"), wanted: join(logs, "locks", "checks.wanted.lock") })

type LockFiles = ReturnType<typeof lockFiles>

/**
 * This host's land logs and their lock files, `${XDG_CACHE_HOME:-~/.cache}/rift-land` read from `env`: the one
 * place the rift tool (cmd/rift) and a script that takes its locks (scripts/daily.ts) find them.
 */
export const landLogs = (env: NodeJS.ProcessEnv): string => join(env["XDG_CACHE_HOME"] || join(TuiDirs.dirs().home, ".cache"), "rift-land")

/**
 * This host's land locks for a script that changes what a land's checks read outside any land (`bun run
 * daily`): `move` runs a change to the fork checkout (a fast-forward, an install) holding the checks lock,
 * `moveSync` the same for a synchronous one, and `tests` runs the fork's tests holding the accept lock.
 * `gate` runs a full gate (`bun run gate`) in its turn, one at a time per host and after any land's check
 * that came while it waited; as is when `env` says a land runs it as its gate check (RIFT_LAND_CHECK=gate).
 */
export const hostLocks = (env: NodeJS.ProcessEnv) => {
  const files = lockFiles(landLogs(env))
  return { files, move: exclusively(files.checks), moveSync: exclusivelySync(files.checks), tests: exclusively(files.accept), gate: (root: string) => oneGate(files, root, Option.fromUndefinedOr(env["RIFT_LAND_CHECK"])) }
}

/** The locks each check holds while it runs; a post-land step takes its own, by the paths it is given. */
const CHECK_LOCKS: Readonly<Record<"gate" | "accept" | "post-land", (files: LockFiles) => ReadonlyArray<readonly [string, LockMode]>>> = {
  gate: (files) => [
    [files.wanted, "shared"],
    [files.checks, "shared"],
  ],
  accept: (files) => [
    [files.wanted, "shared"],
    [files.checks, "shared"],
    [files.accept, "exclusive"],
  ],
  "post-land": () => [],
}

/** Each lock file, by name, to its installs: the frozen one, then the one that may rewrite it. */
export const INSTALLS: Readonly<Record<string, readonly [string, string]>> = {
  "bun.lock": ["bun install --frozen-lockfile", "bun install"],
  "bun.lockb": ["bun install --frozen-lockfile", "bun install"],
  "pnpm-lock.yaml": ["pnpm install --frozen-lockfile", "pnpm install"],
  "yarn.lock": ["yarn install --immutable", "yarn install"],
  "package-lock.json": ["npm ci", "npm install"],
}

const isLock = (file: string): boolean => Object.hasOwn(INSTALLS, basename(file))

/** The entries of `git status --porcelain=v1 -z`: `XY path`, a rename's old path dropped. */
export const statusEntries = (output: string): ReadonlyArray<{ readonly line: string; readonly file: string }> => {
  const fields = output.split("\0").filter((field) => field !== "")
  const entries: Array<{ line: string; file: string }> = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    const file = field.slice(3)
    entries.push({ line: field, file })
    if (field[0] === "R" || field[0] === "C") index++
  }
  return entries
}

/** Whether `file` reads the same under both roots: missing in both, or the same bytes. */
const same = (left: string, right: string): boolean => {
  const [a, b] = [existsSync(left), existsSync(right)]
  if (!a || !b) return a === b
  try {
    return readFileSync(left).equals(readFileSync(right))
  } catch {
    return false
  }
}

export const layer = (options: Options) => {
  const { spawn, run } = commands(options.env)
  /** Whether a systemd scope is available: on Linux, the probe exits 0; asked once, at the first check. */
  let scoped: boolean | undefined
  const scope = Effect.suspend(() =>
    scoped !== undefined || (options.platform ?? process.platform) !== "linux"
      ? Effect.succeed(scoped ?? false)
      : spawn(options.probe ?? SCOPE_PROBE, options.logs).pipe(
          Effect.map((ran) => ran.code === 0),
          Effect.orElseSucceed(() => false),
          Effect.tap((available) => Effect.sync(() => void (scoped = available))),
        ),
  )
  const git = (path: string, ...args: ReadonlyArray<string>) => run(["git", "-C", path, ...args], path)
  const trimmed = (path: string, ...args: ReadonlyArray<string>) => git(path, ...args).pipe(Effect.map((out) => out.trim()))
  /** A Git config value, or undefined when unset. */
  const setting = (path: string, key: string) =>
    spawn(["git", "-C", path, "config", "--get", key], path).pipe(Effect.map((ran) => (ran.code === 0 && ran.stdout.trim() !== "" ? ran.stdout.trim() : undefined)))
  /** A Git config boolean as Git reads it (`yes`, `on`, `1` …), or undefined when unset; a value Git cannot read as one fails. */
  const flag = (path: string, key: string) =>
    spawn(["git", "-C", path, "config", "--type=bool", "--get", key], path).pipe(
      Effect.flatMap((ran) =>
        ran.code === 0
          ? Effect.succeed(ran.stdout.trim() === "true")
          : ran.code === 1
            ? Effect.succeed(undefined)
            : Effect.fail(new RiftFailed({ operation: "git config", message: ran.stderr.trim() || `${key} is not a boolean` })),
      ),
    )

  const config = Effect.fn("Landing.config")(function* (source: string) {
    const named = yield* setting(source, "workrift.main")
    const head = yield* spawn(["git", "-C", source, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], source)
    const main = named ?? (head.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : "main")
    const generated = yield* spawn(["git", "-C", source, "config", "--get-all", "rift.generated"], source)
    return {
      main,
      gate: yield* setting(source, "rift.gate"),
      accept: yield* setting(source, "rift.accept"),
      generated: generated.code === 0 ? lines(generated.stdout) : [],
      regenerate: yield* setting(source, "rift.regenerate"),
      push: (yield* flag(source, "rift.push")) ?? true,
      pushBranches: (yield* flag(source, "rift.pushBranches")) ?? false,
      postLand: yield* setting(source, "rift.postLand"),
    } satisfies LandConfig
  })

  const ownChanges = Effect.fn("Landing.ownChanges")(function* (path: string, source: string) {
    const status = yield* git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":(exclude).rift")
    return statusEntries(status)
      .filter((entry) => !same(join(path, entry.file), join(source, entry.file)))
      .map((entry) => entry.line)
  })

  const start = Effect.fn("Landing.start")(function* (integration: string, main: string) {
    // A copy-on-write copy can carry a multi-pack index its packs no longer match; Git then fails to read objects.
    const midx = join(integration, (yield* trimmed(integration, "rev-parse", "--git-path", "objects/pack/multi-pack-index")))
    if (existsSync(midx) && (yield* spawn(["git", "-C", integration, "multi-pack-index", "verify"], integration)).code !== 0) {
      rmSync(midx, { force: true })
      yield* spawn(["git", "-C", integration, "multi-pack-index", "write"], integration)
    }
    const previous = yield* trimmed(integration, "rev-parse", "HEAD")
    yield* spawn(["git", "-C", integration, "merge", "--abort"], integration)
    yield* git(integration, "fetch", "-q", "origin")
    // The integration Rift holds no one's work: a gate that rewrote files (a lint fix) leaves nothing behind; its branch is named for it.
    yield* git(integration, "checkout", "-q", "-f", "-B", basename(integration), `origin/${main}`)
    return { base: yield* trimmed(integration, "rev-parse", "HEAD"), previous } satisfies Started
  })

  const merge = Effect.fn("Landing.merge")(function* (integration: string, from: Unit, settings: LandConfig) {
    yield* git(integration, "fetch", "-q", from.path, from.branch)
    const merged = yield* spawn(["git", "-C", integration, "merge", "--no-edit", "-m", `Merge ${from.branch}`, "FETCH_HEAD"], integration)
    if (merged.code === 0) return { _tag: "Merged" as const, regenerated: [] } satisfies Merged
    const files = lines(yield* git(integration, "diff", "--name-only", "--diff-filter=U"))
    if (files.length === 0) {
      yield* spawn(["git", "-C", integration, "merge", "--abort"], integration)
      return yield* new RiftFailed({ operation: "git merge", message: (merged.stderr.trim() || merged.stdout.trim()).split("\n").slice(-20).join("\n") })
    }
    if (!files.every((file) => isLock(file) || settings.generated.includes(file))) {
      yield* git(integration, "merge", "--abort")
      return { _tag: "Conflict" as const, files } satisfies Merged
    }
    // Only written files conflict: take the Rift's side and write them again for the merged sources.
    yield* git(integration, "checkout", "-q", "--theirs", "--", ...files)
    for (const lock of files.filter(isLock)) yield* run(["sh", "-c", INSTALLS[basename(lock)]![1]], join(integration, dirname(lock)))
    if (settings.regenerate !== undefined) yield* run(["sh", "-c", settings.regenerate], integration)
    yield* git(integration, "add", "--", ...files)
    yield* git(integration, "commit", "-q", "--no-edit")
    return { _tag: "Merged" as const, regenerated: files } satisfies Merged
  })

  const install = Effect.fn("Landing.install")(function* (integration: string, previous: string) {
    const changed = lines(yield* git(integration, "diff", "--name-only", previous, "HEAD")).filter(isLock)
    const committed: Array<string> = []
    for (const lock of changed) {
      const [frozen, free] = INSTALLS[basename(lock)]!
      const where = join(integration, dirname(lock))
      if ((yield* spawn(["sh", "-c", frozen], where)).code !== 0) yield* run(["sh", "-c", free], where)
      if ((yield* git(integration, "status", "--porcelain", "--", lock)).trim() !== "") {
        yield* git(integration, "add", "--", lock)
        yield* git(integration, "commit", "-q", "-m", `chore: ${lock} after landing`, "--", lock)
        committed.push(lock)
      }
    }
    return committed
  })

  const regenerate = Effect.fn("Landing.regenerate")(function* (integration: string, settings: LandConfig) {
    if (settings.regenerate === undefined) return []
    yield* run(["sh", "-c", settings.regenerate], integration)
    const status = yield* git(integration, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    const files = statusEntries(status)
      .map((entry) => entry.file)
      .filter((file) => settings.generated.includes(file) || isLock(file))
    if (files.length === 0) return []
    yield* git(integration, "add", "--", ...files)
    yield* git(integration, "commit", "-q", "-m", "chore: regenerate generated files after landing", "--", ...files)
    return files
  })

  const locks = lockFiles(options.logs)
  const check = Effect.fn("Landing.check")(function* (path: string, label: "gate" | "accept" | "post-land", command: string, env: Readonly<Record<string, string>>) {
    mkdirSync(options.logs, { recursive: true })
    const log = join(options.logs, `${basename(path)}.${label}.log`)
    const started = Date.now()
    const argv = checkArgv(command, log, { scope: yield* scope, ionice: ioniceAvailable(options.platform ?? process.platform) })
    // RIFT_LAND_CHECK tells the command which check it runs: a full gate run as the land's gate check runs under these locks, not in a turn of its own.
    const ran = yield* holding(CHECK_LOCKS[label](locks), spawn(argv, path, { ...env, RIFT_LAND_CHECK: label }))
    const output = existsSync(log) ? readFileSync(log, "utf8") : ran.stderr
    return { code: ran.code, seconds: Math.round((Date.now() - started) / 1000), log, output } satisfies Ran
  })

  const postLand = Effect.fn("Landing.postLand")(function* (path: string, command: string, env: Readonly<Record<string, string>>) {
    mkdirSync(options.logs, { recursive: true })
    const report = join(options.logs, `${basename(path)}.post-land.report.md`)
    rmSync(report, { force: true })
    const ran = yield* check(path, "post-land", command, { ...env, RIFT_POST_LAND_REPORT: report, RIFT_LAND_CHECKS_LOCK: locks.checks, RIFT_LAND_ACCEPT_LOCK: locks.accept })
    return { ...ran, report: existsSync(report) ? readFileSync(report, "utf8") : undefined } satisfies PostLanded
  })

  const hostLoad = Effect.sync((): HostLoad => ({ load: loadavg()[0] ?? 0, cores: availableParallelism() }))

  const push = Effect.fn("Landing.push")(function* (path: string, main: string) {
    yield* git(path, "fetch", "-q", "origin")
    const holds = yield* spawn(["git", "-C", path, "merge-base", "--is-ancestor", `origin/${main}`, "HEAD"], path)
    if (holds.code !== 0)
      return yield* new RiftFailed({ operation: "git push", message: `origin/${main} moved while the gate ran; land the batch again to merge it first.` })
    yield* git(path, "push", "-q", "origin", `HEAD:${main}`)
    return yield* trimmed(path, "log", "-1", "--format=%h %s")
  })

  const pushBranch = Effect.fn("Landing.pushBranch")(function* (unit: Unit) {
    yield* git(unit.path, "push", "-q", "origin", `HEAD:refs/heads/${unit.branch}`)
    return yield* trimmed(unit.path, "log", "-1", "--format=%h %s")
  })

  const sync = Effect.fn("Landing.sync")(function* (path: string) {
    yield* git(path, "fetch", "-q", "origin")
  })

  return Layer.succeed(Landing, Landing.of({ config, ownChanges, start, merge, install, regenerate, check, postLand, hostLoad, push, pushBranch, sync }))
}
