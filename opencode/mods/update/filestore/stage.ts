import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { exclusivelySync, holding } from "@dotfiles/opencode-work/process/flock"
import { publishReviewInput, siblingReviewInputLock } from "@dotfiles/opencode-work/process/landing"
import { Effect, Layer, Predicate } from "effect"
import { buildName, stagingName } from "../builds.ts"
import { parseRecord, type Record, recordText, stagedRecord } from "../record.ts"
import { stageInTree, Tree, Trees, UpdateFailed } from "../service.ts"
import { TREE_SUFFIX, treeOf } from "../trees.ts"
import { removeMaking } from "./builds.ts"
import { launcher } from "./launcher.ts"
import { check, make, type Options as TreeOptions } from "./trees.ts"

/**
 * The Trees over the share directory (`filestore/trees.ts`), each make under the builds lock `lock`,
 * which daily's stage takes for its copy and record and a prune for its read and deletes: two stages
 * at once (daily by hand during the updater's) never make one tree twice, and a prune never meets a
 * tree half placed. Under that same lock, and before the make, it reads whether the tree stands: a
 * make answers `Stood` for a tree that was there, `Made` for one it placed, and nothing places a tree
 * in between. `has` reads whether a build's overlay stands beside it.
 */
export const treesLayer = (options: TreeOptions & { readonly lock: string }) =>
  Layer.succeed(
    Trees,
    Trees.of({
      make: (version, commit) =>
        holding(
          [[options.lock, "exclusive"]],
          Effect.gen(function* () {
            const stood = existsSync(join(options.share, treeOf(buildName(version))))
            const path = yield* make(options, version, commit)
            if (stood) return Tree.Stood({ path })
            return Tree.Made({ path, version })
          }),
        ).pipe(
          Effect.catchTag("RiftFailed", (failed) => Effect.fail(new UpdateFailed({ step: "take the builds lock", message: failed.message }))),
        ),
      check,
      has: (version) => Effect.sync(() => existsSync(join(options.share, treeOf(buildName(version)), "config", "opencode.json"))),
      remove: (made) => holding([[options.lock, "exclusive"]], removeMaking(made.path)).pipe(Effect.ignore),
    }),
  )

/**
 * daily by hand's tree build, the updater's own (`service.ts` `stageInTree`), for daily, which runs on
 * the root package's Effect: the tree of build `version` made from dotfiles commit `commit` under the
 * builds lock (`treesLayer`), then `stage` run on it (the tree's own daily); a stage that fails takes
 * the tree with it only when this make made it. A from-scratch host has no share directory yet: it is
 * made first. Answers the tree's path; rejects with the failed step.
 */
export const makeAndStage = (options: TreeOptions & { readonly lock: string }, version: string, commit: string, stage: (tree: string) => Promise<void>): Promise<string> =>
  Effect.runPromise(
    Effect.sync(() => mkdirSync(options.share, { recursive: true })).pipe(
      Effect.andThen(
        Trees.use((trees) =>
          stageInTree(trees, version, commit, (tree) => Effect.tryPromise({ try: () => stage(tree), catch: (cause) => new UpdateFailed({ step: "stage the build", message: String(cause) }) })),
        ),
      ),
      Effect.provide(treesLayer(options)),
    ),
  )

/** One build daily stages: the file it built, where it goes, and what the record says of it. */
export interface Stage {
  /** The release binary daily built. */
  readonly built: string
  /** The share directory (`settings.ts` `shareDir`). */
  readonly share: string
  readonly version: string
  /** The installed record (`installed.json`). */
  readonly record: string
  /** The launcher, `~/.local/bin/opencode` (`launcher.ts`). */
  readonly launcher: string
  /** The resident location the launcher loads after a service start (`settings.ts` `resident`). */
  readonly resident: string
  /** The builds lock (`settings.ts` `buildsLock`). */
  readonly lock: string
  readonly dotfiles: string
  readonly fork: string
  /** Daily's own process, which names its copy in flight. */
  readonly pid: number
}

/**
 * Stages a build, holding the builds lock from its copy into the share directory through the staged
 * record's write: a handoff's prune takes the same lock to read the record and list the directory, so
 * it never sees a build the record does not name yet (`filestore/builds.ts`). It copies the build
 * beside its name, then renames it over that name: Linux refuses to write a binary the running service
 * executes (ETXTBSY), and a rename leaves that process on the old file. The launcher stays on the build
 * the record installs, the running one, until the handoff installs the staged one (`launcher.ts`).
 * Answers the build's path. `flock` is libc's, but for a test.
 */
export const stageBuild = (stage: Stage, flock?: (descriptor: number, operation: number) => number): string => {
  const binary = join(stage.share, buildName(stage.version))
  exclusivelySync(stage.lock, flock)(() => {
    mkdirSync(stage.share, { recursive: true })
    const copy = join(stage.share, stagingName(stage.version, stage.pid))
    copyFileSync(stage.built, copy)
    chmodSync(copy, 0o755)
    renameSync(copy, binary)
    // Staged, not installed: the handoff installs it as it restarts, and the health check proves it (mods/update).
    const last = Effect.runSync(
      Effect.try({ try: () => readFileSync(stage.record, "utf8"), catch: (error) => error }).pipe(
        Effect.catchIf((error) => Predicate.hasProperty(error, "code") && error.code === "ENOENT", () => Effect.succeed("")),
      ),
    )
    const record = stagedRecord(parseRecord(last), { version: stage.version, command: [binary], dotfiles: stage.dotfiles, fork: stage.fork }, readdirSync(stage.share))
    Effect.runSync(publishReviewInput("stage the installed record", stage.record, siblingReviewInputLock(stage.record), { preserve: { whenAbsent: 0o600, ceiling: 0o640 } }, recordText(record)))
    writeLauncher(stage.launcher, stage.resident, record, stage.pid)
  })
  return binary
}

/**
 * Points the launcher at the build `record` installs, never at a staged one. A client of a build the
 * record does not know (neither installed nor superseded) starts the service on its own build and
 * replaces the running one (the fork's `ServiceConfig.serviceBuild` and `service.ensure`): a launcher
 * on a staged build made every new TUI stop the shared service until the handoff ran (workbox,
 * 2026-11-18). So the launcher moves only with the record: daily's stage, and the handoff's install
 * and rollback (`records.ts`). Written beside its path and renamed over it, since a terminal may run
 * it at any moment; `pid`, the writing process, names its copy in flight.
 */
export const writeLauncher = (path: string, resident: string, record: Record, pid: number): void => {
  const next = `${path}.${pid}`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(next, launcher(record.command[0], resident))
  chmodSync(next, 0o755)
  renameSync(next, path)
  writeCurrentTree(record.command[0], pid)
}

/** The link beside the builds that names the installed build's tree (`currentTree`). */
export const CURRENT_TREE = "current.plugins"

/**
 * Points `<share>/current.plugins` at the tree of `binary`, the build the record installs, written with
 * the launcher at each record write: a path that outlives a process (a pending wake's job, a command
 * link) goes through it rather than into one build's tree, which a prune deletes with its build. A
 * relative link, made beside its path and renamed over it; a build with no tree (an older build's)
 * leaves no link, as nothing of it is in a tree.
 */
export const writeCurrentTree = (binary: string, pid: number): void => {
  const tree = `${binary}${TREE_SUFFIX}`
  const link = join(dirname(binary), CURRENT_TREE)
  if (!existsSync(join(tree, "config"))) {
    rmSync(link, { force: true })
    return
  }
  rmSync(`${link}.${pid}`, { force: true })
  symlinkSync(basename(tree), `${link}.${pid}`)
  renameSync(`${link}.${pid}`, link)
}
