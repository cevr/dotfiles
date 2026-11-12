import { file } from "bun"
import { Effect, Option, Schema } from "effect"
import { UpdateFailed } from "../service.ts"
import { run, spawned, type Place } from "./run.ts"

/**
 * Where a stage builds the verified target's fork commit: `tree`, a detached worktree of the fork
 * checkout `fork`, so the build never reads the shared checkout, which a land's post-land step
 * moves (2026-11-12: the Mac built prime-look's HEAD 2ff62080, 6 commits past the target 93a88642,
 * and recorded the target's hash). The shared checkout's branch and files are never touched.
 */
export interface Pin {
  /** The fork checkout (prime-look), whose object store the tree shares. */
  readonly fork: string
  /** The build tree, a worktree this module owns: made on first use, moved to each target after. */
  readonly tree: string
  /** The fork commit the verified target names. */
  readonly commit: string
  /** The bun that installs, by its full path. */
  readonly bun: string
  /** Variables every command gets. */
  readonly env: Readonly<globalThis.Record<string, string>>
}

/** What builds the fork in a tree: the real one runs the fork's release build; a test's fakes it. */
export interface ForkBuild {
  /** Builds `tree` as release `version`; answers the binary's path. */
  readonly build: (tree: string, version: string) => Effect.Effect<string, UpdateFailed>
  /** What `binary --version` says. */
  readonly report: (binary: string) => Effect.Effect<string, UpdateFailed>
}

/** A staged build of the fork: the commit it was built from, and what its binary says. */
export interface Pinned {
  readonly commit: string
  readonly version: string
  readonly binary: string
  readonly reported: string
}

/** The fork's release version for `commit`: `<base>-prime.<first 8 of the commit>`. */
export const versionOf = (base: string, commit: string): string => `${base}-prime.${commit.slice(0, 8)}`

/** The commit a fork binary's version names (`…-prime.<hash>`), when it names one. */
export const suffixOf = (reported: string): Option.Option<string> => Option.fromNullishOr(/-prime\.([0-9a-f]+)/.exec(reported)?.[1])

const CliPackage = Schema.Struct({ version: Schema.String })
const decodeCli = Schema.decodeUnknownEffect(Schema.fromJsonString(CliPackage))

/**
 * Puts `pin.tree` at exactly `pin.commit`, its tracked files as the commit has them, and installs its
 * dependencies as the lockfile pins them. Answers the commit in full. Fails when the fork checkout
 * lacks the commit or the tree ends anywhere else.
 */
export const pinTree = (pin: Pin): Effect.Effect<string, UpdateFailed> =>
  Effect.gen(function* () {
    const at: Place = { cwd: pin.fork, env: pin.env }
    const git = (step: string, ...args: ReadonlyArray<string>) => run(step, ["git", ...args], at).pipe(Effect.map((out) => out.trim()))
    const commit = yield* git(`find the target's fork commit ${pin.commit.slice(0, 10)} in ${pin.fork}`, "rev-parse", "--verify", "--quiet", `${pin.commit}^{commit}`)
    yield* git("prune the fork's stale worktrees", "worktree", "prune")
    const known = yield* spawned("read the build tree", ["git", "-C", pin.tree, "rev-parse", "--is-inside-work-tree"], at)
    if (known.code === 0) yield* git("move the build tree to the target", "-C", pin.tree, "checkout", "--quiet", "--detach", "--force", commit)
    else yield* git("make the build tree", "worktree", "add", "--quiet", "--detach", "--force", pin.tree, commit)
    const head = yield* git("read the build tree's commit", "-C", pin.tree, "rev-parse", "HEAD")
    const changed = yield* git("read the build tree's changes", "-C", pin.tree, "status", "--porcelain", "--untracked-files=no")
    if (head !== commit) return yield* new UpdateFailed({ step: "pin the build tree", message: `${pin.tree} is at ${head.slice(0, 10)}, not the target's fork ${commit.slice(0, 10)}` })
    if (changed !== "") return yield* new UpdateFailed({ step: "pin the build tree", message: `${pin.tree} has changes the target's fork ${commit.slice(0, 10)} lacks:\n${changed}` })
    yield* run("install the build tree's dependencies", [pin.bun, "install", "--frozen-lockfile"], { cwd: pin.tree, env: pin.env })
    return commit
  })

/**
 * Builds the fork checked out in `dir` at `commit` as `<base>-prime.<commit>` and reads its binary's
 * version back. A binary whose version names another commit fails, so nothing is staged from it.
 */
const buildAt = (dir: string, commit: string, fork: ForkBuild): Effect.Effect<Pinned, UpdateFailed> =>
  Effect.gen(function* () {
    const read = Effect.tryPromise({ try: () => file(`${dir}/packages/cli/package.json`).text(), catch: (cause) => new UpdateFailed({ step: "read the fork's version", message: String(cause) }) })
    const cli = yield* read.pipe(Effect.flatMap((text) => decodeCli(text).pipe(Effect.mapError((cause) => new UpdateFailed({ step: "read the fork's version", message: String(cause) })))))
    const version = versionOf(cli.version, commit)
    const binary = yield* fork.build(dir, version)
    const reported = (yield* fork.report(binary)).trim()
    if (!Option.exists(suffixOf(reported), (suffix) => suffix === commit.slice(0, 8)))
      return yield* new UpdateFailed({ step: "check the build's version", message: `${binary} reports ${reported}, not the fork commit ${commit.slice(0, 8)} it was built from: nothing staged` })
    return { commit, version, binary, reported }
  })

/**
 * The stage's fork build: the tree pinned to the target's commit, then built and its version checked
 * (`buildAt`). A binary that names another commit fails the stage, so the update never installs it
 * nor marks the target good.
 */
export const stageFork = (pin: Pin, fork: ForkBuild): Effect.Effect<Pinned, UpdateFailed> => pinTree(pin).pipe(Effect.flatMap((commit) => buildAt(pin.tree, commit, fork)))

/** What daily builds: with a target's fork commit (`--fork-target`, a stage), that commit in the tree; with none, the fork checkout as it stands. */
export interface DailyBuild {
  readonly fork: string
  readonly tree: string
  /** The target's fork commit, none or one. */
  readonly commit: ReadonlyArray<string>
  readonly bun: string
  readonly build: ForkBuild
  readonly log: (line: string) => void
}

/** daily's fork build (`DailyBuild`); a failure names its step. */
export const dailyBuild = (options: DailyBuild): Effect.Effect<Pinned, UpdateFailed> => {
  const named = (failed: UpdateFailed) => new UpdateFailed({ step: failed.step, message: `${failed.step}: ${failed.message}` })
  const env = {}
  const built = Option.match(Option.fromIterable(options.commit), {
    onNone: () =>
      Effect.sync(() => options.log(`building ${options.fork} as it stands`)).pipe(
        Effect.andThen(run("read the fork's commit", ["git", "rev-parse", "HEAD"], { cwd: options.fork, env })),
        Effect.flatMap((head) => buildAt(options.fork, head.trim(), options.build)),
      ),
    onSome: (commit) =>
      Effect.sync(() => options.log(`building the target's fork ${commit.slice(0, 10)} in ${options.tree}, pinned there`)).pipe(
        Effect.andThen(stageFork({ fork: options.fork, tree: options.tree, commit, bun: options.bun, env }, options.build)),
      ),
  })
  return built.pipe(Effect.mapError(named))
}

/** `dailyBuild` for daily, a script with no Effect runtime of this package's: it rejects with the named failure. */
export const runDailyBuild = (options: DailyBuild): Promise<Pinned> => Effect.runPromise(dailyBuild(options))

/** The fork's release build in a tree (`packages/cli/script/build.ts`), for the platform `target` (`cli-<os>-<arch>`). */
export const releaseBuild = (bun: string, target: string, env: Readonly<globalThis.Record<string, string>>, skip = false): ForkBuild => ({
  build: (tree, version) => {
    const cli = `${tree}/packages/cli`
    const binary = `${cli}/dist/${target}/bin/opencode`
    if (skip) return Effect.succeed(binary)
    return run("build the fork", [bun, "run", "script/build.ts", "--single", "--skip-install", "--skip-web-ui"], { cwd: cli, env: { ...env, OPENCODE_CHANNEL: "latest", OPENCODE_VERSION: version } }).pipe(Effect.as(binary))
  },
  report: (binary) => run("read the build's version", [binary, "--version"], { cwd: "/", env }),
})
