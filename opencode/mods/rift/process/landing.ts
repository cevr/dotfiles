// Landing over Git and the shell, run as child processes. The repository's
// commands come from its warm source's Git config (`rift.gate`,
// `rift.accept`, `rift.generated`, `rift.regenerate`, `rift.push`,
// `rift.pushBranches`, `rift.postLand`, `rift.mergeCheck`, `rift.focus`, the default branch from
// `workrift.main` else origin's HEAD) and run through `sh -c`, their output
// kept in a log under `logs`; the gate and the acceptance run always run
// heavy, through the guard's launcher (`checkArgv`). A lock file is installed again with its package
// manager (frozen first, then free, as a merged lock file may need) and
// committed when the install rewrote it. `rift.regenerate` runs after every
// batch's merges, and what it rewrote is committed. Receipts (`receipts`) are read and written here: a
// checkout's in its Git dir, every one in the host's receipts folder beside the logs; `scriptReceipt` and
// `scriptReceipts` give them to scripts outside Effect (scripts/gate.ts, post-land.ts, receipt.ts).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism, loadavg } from "node:os"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { basename, dirname, join } from "node:path"
import { DEFAULT_LIMITS, heavyArgv, type Host, ioniceAvailable, SCOPE_PROBE } from "@dotfiles/opencode-guard/launcher"
import { Clock, Console, DateTime, Effect, Layer, Match, Option, Predicate, Result, Schema } from "effect"
import { type HostLoad, type LandConfig, type Merged, type PostLanded, type Ran, type Started, type Unit } from "../land.ts"
import { type LandRecord, LandRecordJson, type Receipt, ReceiptJson, type Snapshot, standing as standingOf } from "../receipt.ts"
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
 * a land's check go first. `fork`: a fork move holds it exclusively with `checks`, for that short change, and a
 * land's own checks by receipts (a Rift's focused gate, the merge check) hold it shared, so they wait for a
 * fork move alone; they hold `land` exclusively, one at a time per host, and no other check or step takes it,
 * so a full gate, an accept check or a post-land step (its deep run) never holds up a land.
 */
export const lockFiles = (logs: string) => ({
  checks: join(logs, "locks", "checks.lock"),
  accept: join(logs, "locks", "accept.lock"),
  wanted: join(logs, "locks", "checks.wanted.lock"),
  fork: join(logs, "locks", "fork.lock"),
  land: join(logs, "locks", "land.lock"),
})

/** The host's receipts folder (receipt.ts), beside the land logs: every receipt by head and kind, and each land's record. */
export const receiptsDir = (logs: string): string => join(logs, "receipts")

type LockFiles = ReturnType<typeof lockFiles>

/**
 * This host's land logs and their lock files, `${XDG_CACHE_HOME:-~/.cache}/rift-land` read from `env`: the one
 * place the rift tool (cmd/rift) and a script that takes its locks (scripts/daily.ts) find them.
 */
export const landLogs = (env: NodeJS.ProcessEnv): string => join(env["XDG_CACHE_HOME"] || join(TuiDirs.dirs().home, ".cache"), "rift-land")

/**
 * This host's land locks for a script that changes what a land's checks read outside any land (`bun run
 * daily`): `move` runs a change to the fork checkout (a fast-forward, an install) holding the checks lock and
 * the fork lock, `moveSync` the same for a synchronous one, and `tests` runs the fork's tests holding the accept lock.
 * `gate` runs a full gate (`bun run gate`) in its turn, one at a time per host and after any land's check
 * that came while it waited; as is when `env` says a land runs it as its gate check (RIFT_LAND_CHECK=gate).
 */
export const hostLocks = (env: NodeJS.ProcessEnv) => {
  const files = lockFiles(landLogs(env))
  const checks = exclusively(files.checks)
  const fork = exclusively(files.fork)
  const checksSync = exclusivelySync(files.checks)
  const forkSync = exclusivelySync(files.fork)
  return {
    files,
    move: <A>(step: () => Promise<A>) => checks(() => fork(step)),
    moveSync: <A>(step: () => A) => checksSync(() => forkSync(step)),
    tests: exclusively(files.accept),
    gate: (root: string) => oneGate(files, root, Option.fromUndefinedOr(env["RIFT_LAND_CHECK"])),
  }
}

/** The locks each check holds while it runs; a post-land step takes its own, by the paths it is given. */
const CHECK_LOCKS: Readonly<Record<"gate" | "accept" | "post-land" | "focus" | "merge", (files: LockFiles) => ReadonlyArray<readonly [string, LockMode]>>> = {
  focus: (files) => [
    [files.fork, "shared"],
    [files.land, "exclusive"],
  ],
  merge: (files) => [
    [files.fork, "shared"],
    [files.land, "exclusive"],
  ],
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

/** The receipt file a kind of run writes for `head` in the host's receipts folder. */
const hostReceipt = (logs: string, receipt: Receipt): string => join(receiptsDir(logs), `${receipt.head}.${receipt.kind}.json`)

/**
 * Receipts on disk (receipt.ts), for the land and for a script that writes one (scripts/gate.ts,
 * scripts/post-land.ts): `snapshot` reads a checkout's head and the tree of its tracked files as they are on
 * disk (through a scratch copy of its index, so its own index is untouched); `write` keeps a receipt in the
 * host's receipts folder under `logs` by head and kind, and a `round` one in its checkout too (its Git dir's
 * `rift-receipt.json`), where `newest` reads it back.
 */
export const receipts = (logs: string, env: Readonly<Record<string, string>> = {}) => {
  const { run } = commands(env)
  const trimmed = (path: string, ...args: ReadonlyArray<string>) => run(["git", "-C", path, ...args], path).pipe(Effect.map((out) => out.trim()))
  const gitPath = (path: string, name: string) => trimmed(path, "rev-parse", "--path-format=absolute", "--git-path", name)
  const io = <A>(operation: string, step: () => A) => Effect.try({ try: step, catch: (cause) => new RiftFailed({ operation, message: String(cause) }) })
  const encode = (receipt: Receipt) => Schema.encodeEffect(ReceiptJson)(receipt).pipe(Effect.mapError((error) => new RiftFailed({ operation: "receipt", message: error.message })))

  const snapshot = Effect.fn("Receipts.snapshot")(function* (path: string) {
    const head = yield* trimmed(path, "rev-parse", "HEAD")
    const index = yield* gitPath(path, "index")
    const scratch = `${index}.rift-receipt`
    const tree = yield* Effect.acquireUseRelease(
      io("copy index", () => copyFileSync(index, scratch)),
      () =>
        run(["git", "-C", path, "add", "-u"], path, { GIT_INDEX_FILE: scratch }).pipe(
          Effect.andThen(run(["git", "-C", path, "write-tree"], path, { GIT_INDEX_FILE: scratch })),
          Effect.map((out) => out.trim()),
        ),
      () => Effect.sync(() => rmSync(scratch, { force: true })),
    )
    return { head, tree } satisfies Snapshot
  })

  const write = Effect.fn("Receipts.write")(function* (receipt: Receipt) {
    const text = yield* encode(receipt)
    const file = hostReceipt(logs, receipt)
    yield* io("write receipt", () => {
      mkdirSync(receiptsDir(logs), { recursive: true })
      writeFileSync(file, `${text}\n`)
    })
    if (receipt.kind !== "round") return file
    const kept = yield* gitPath(receipt.repo, "rift-receipt.json")
    yield* io("write receipt", () => writeFileSync(kept, `${text}\n`))
    return file
  })

  const newest = Effect.fn("Receipts.newest")(function* (path: string) {
    const kept = yield* gitPath(path, "rift-receipt.json")
    const text = yield* io("read receipt", () => Option.liftPredicate(kept, existsSync).pipe(Option.map((file) => readFileSync(file, "utf8"))))
    return Option.flatMap(text, Schema.decodeUnknownOption(ReceiptJson))
  })

  /** A receipt of `kind` for `path` at `at`, its checks as they ran, ended now. */
  const made = (path: string, at: Snapshot, kind: Receipt["kind"], checks: Receipt["checks"]) =>
    Effect.map(DateTime.now, (now): Receipt => ({ repo: path, head: at.head, tree: at.tree, kind, checks, at: DateTime.formatIso(now) }))

  return { snapshot, write, newest, made }
}

/** A check run for a receipt: its command line as the receipt names it, its run, and the exit its answer means. */
export interface ReceiptStep<A, E, R> {
  readonly command: string
  readonly run: Effect.Effect<A, E, R>
  readonly code: (answer: A) => number
}

/**
 * Runs `steps` in turn for the checkout at `path` and writes their one receipt of `kind`, from where the
 * checkout stood before the first (its head and tracked files) and with each step's exit and seconds; answers
 * the steps' answers and the receipt's file in the host's receipts folder.
 */
export const receiptedSteps = <A, E, R>(logs: string, path: string, kind: Receipt["kind"], steps: ReadonlyArray<ReceiptStep<A, E, R>>) =>
  Effect.gen(function* () {
    const kit = receipts(logs)
    const at = yield* kit.snapshot(path)
    const ran = yield* Effect.forEach(steps, timed)
    const file = yield* Effect.flatMap(kit.made(path, at, kind, ran.map((each) => each.check)), kit.write)
    return { answers: ran.map((each) => each.answer), checks: ran.map((each) => each.check), file }
  })

/** A step run, its answer and its check as a receipt names it. */
const timed = <A, E, R>(step: ReceiptStep<A, E, R>) =>
  Effect.gen(function* () {
    const from = yield* Clock.currentTimeMillis
    const answer = yield* step.run
    const to = yield* Clock.currentTimeMillis
    return { answer, check: { command: step.command, code: step.code(answer), seconds: Math.round((to - from) / 1000) } }
  })

/**
 * A script's receipt of `kind` for the checkout at `path`, outside Effect (scripts/receipt.ts): each step's
 * `exit` is its run to an exit code, run in turn, or the exit of a proof already made, not run here; answers
 * the checks as written and the receipt's file in the host's receipts folder.
 */
export const scriptReceipts = (
  logs: string,
  path: string,
  kind: Receipt["kind"],
  steps: ReadonlyArray<{ readonly command: string; readonly exit: number | (() => Promise<number>) }>,
): Promise<{ readonly checks: Receipt["checks"]; readonly file: string }> =>
  Effect.runPromise(
    receiptedSteps(
      logs,
      path,
      kind,
      steps.map((step) => ({
        command: step.command,
        run: Match.value(step.exit).pipe(
          Match.when(Predicate.isNumber, (code) => Effect.succeed(code)),
          Match.orElse((run) => Effect.promise(run)),
        ),
        code: (answer: number) => answer,
      })),
    ),
  )

/**
 * One check a script outside Effect runs for its receipt (scripts/gate.ts's full gate, scripts/post-land.ts's
 * deep run): `step` run as `command` from where the checkout at `path` stands now, its receipt of `kind`
 * written from there with the exit `code` reads off its answer. The step runs even when the receipt cannot be
 * read or written, which is said on stderr; its answer stands.
 */
export const scriptReceipt = <A>(logs: string, path: string, kind: Receipt["kind"], command: string, step: () => Promise<A>, code: (answer: A) => number): Promise<A> => {
  const kit = receipts(logs)
  const unwritten = (failure: RiftFailed) => Console.error(`${command}: its receipt was not written: ${failure.message}`)
  return Effect.runPromise(
    Effect.gen(function* () {
      const at = yield* Effect.result(kit.snapshot(path))
      const ran = yield* timed({ command, run: Effect.promise(step), code })
      yield* Result.match(at, {
        onFailure: unwritten,
        onSuccess: (from) => Effect.flatMap(kit.made(path, from, kind, [ran.check]), kit.write).pipe(Effect.asVoid, Effect.catch(unwritten)),
      })
      return ran.answer
    }),
  )
}

export const layer = (options: Options) => {
  const { spawn, run } = commands(options.env)
  const kept = receipts(options.logs, options.env)
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
      mergeCheck: Option.fromUndefinedOr(yield* setting(source, "rift.mergeCheck")),
      focus: Option.fromUndefinedOr(yield* setting(source, "rift.focus")),
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
  const check = Effect.fn("Landing.check")(function* (path: string, label: keyof typeof CHECK_LOCKS, command: string, env: Readonly<Record<string, string>>) {
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
    const ran = yield* check(path, "post-land", command, {
      ...env,
      RIFT_POST_LAND_REPORT: report,
      RIFT_LAND_CHECKS_LOCK: locks.checks,
      RIFT_LAND_ACCEPT_LOCK: locks.accept,
      RIFT_LAND_FORK_LOCK: locks.fork,
      RIFT_LAND_LOGS: options.logs,
    })
    return { ...ran, report: existsSync(report) ? readFileSync(report, "utf8") : undefined } satisfies PostLanded
  })

  /** The check label (log name and locks) each kind of receipted run runs as. */
  const LABEL = { round: "focus", merge: "merge", accept: "accept" } as const

  const receipted = Effect.fn("Landing.receipted")(function* (path: string, kind: "round" | "merge" | "accept", command: string, env: Readonly<Record<string, string>>) {
    const at = yield* kept.snapshot(path)
    const ran = yield* check(path, LABEL[kind], command, env)
    const receipt = yield* kept.made(path, at, kind, [{ command, code: ran.code, seconds: ran.seconds }])
    yield* kept.write(receipt)
    return { ran, receipt }
  })

  const standing = Effect.fn("Landing.standing")(function* (path: string) {
    return standingOf(yield* kept.newest(path), yield* kept.snapshot(path))
  })

  const changed = Effect.fn("Landing.changed")(function* (path: string, main: string) {
    const from = yield* trimmed(path, "merge-base", "HEAD", `origin/${main}`)
    return lines(yield* git(path, "diff", "--name-only", "--no-renames", "--diff-filter=d", from, "HEAD")).map((file) => join(path, file))
  })

  const headOf = (path: string) => trimmed(path, "rev-parse", "HEAD")

  const record = Effect.fn("Landing.record")(function* (landed: LandRecord) {
    const text = yield* Schema.encodeEffect(LandRecordJson)(landed).pipe(Effect.mapError((error) => new RiftFailed({ operation: "land record", message: error.message })))
    const file = join(receiptsDir(options.logs), `${landed.head}.land.json`)
    yield* Effect.try({
      try: () => {
        mkdirSync(receiptsDir(options.logs), { recursive: true })
        writeFileSync(file, `${text}\n`)
      },
      catch: (cause) => new RiftFailed({ operation: "land record", message: String(cause) }),
    })
    return file
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

  return Layer.succeed(
    Landing,
    Landing.of({ config, ownChanges, start, merge, install, regenerate, check, postLand, hostLoad, push, pushBranch, sync, standing, changed, headOf, receipted, record }),
  )
}
