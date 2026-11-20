import { env, file, spawnSync } from "bun"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { buildName } from "../builds.ts"
import { oursOf } from "../filestore/configs.ts"
import { makeAndStage } from "../filestore/stage.ts"
import type { Options as TreeOptions } from "../filestore/trees.ts"
import { buildsLock, HANDOFF_SETTINGS, type Settings, SettingsJson, shareDir, stepEnv } from "../settings.ts"
import { goodOf, parseRecord, type Record } from "../record.ts"
import { buildOfTree, treeOf } from "../trees.ts"
import type { Program } from "./handoff.ts"
import { environment } from "./run.ts"

const encodeSettings = Schema.encodeSync(SettingsJson)

/** The value after `--name` in `argv`, as a list of none or one, for a caller with no Option. */
export const flagValue = (argv: ReadonlyArray<string>, name: string): ReadonlyArray<string> => {
  const at = argv.indexOf(name)
  return Option.toArray(Option.filter(Option.fromNullishOr(argv[at + 1]), (value) => at >= 0 && !value.startsWith("--")))
}

/** Where daily's install puts things on a host, for the update's settings. */
export interface Host {
  readonly host: string
  readonly home: string
  /** The XDG state directory: `XDG_STATE_HOME`, else `~/.local/state`. */
  readonly state: string
  readonly checkout: string
  readonly fork: string
  readonly bun: string
  readonly resident: string
  readonly launcher: string
}

/** The update's settings on a host, as daily writes them into the plugin's entry. */
export const settingsFor = (host: Host): Settings => ({
  host: host.host,
  checkout: host.checkout,
  fork: host.fork,
  bun: host.bun,
  launcher: host.launcher,
  resident: host.resident,
  record: `${host.state}/opencode/installed.json`,
  config: [`${host.home}/.config/opencode/opencode.json`, `${host.home}/.config/opencode/cli.json`],
  notice: `${host.state}/opencode-daily/upstream.json`,
  state: `${host.state}/opencode-update`,
})

/** The update plugin's entry in the server config. */
export const updateEntry = (directory: string, settings: Settings) => ({ package: directory, options: settings })

/**
 * How the update makes a build's tree on a host (`filestore/stage.ts` `treesLayer`): in the share
 * directory, out of the live checkout's object store, under the builds lock, each step with this
 * process's whole environment over `env` (a make passes on nothing else), and the tree's daily told
 * the live checkout and the host, so the update's and orchestrate's entries name the checkout and not
 * the tree.
 */
export const treeOptions = (settings: Settings, stepVariables: Readonly<globalThis.Record<string, string>>, home: string, pid: number) => ({
  share: shareDir(home),
  lock: buildsLock(home),
  checkout: settings.checkout,
  bun: settings.bun,
  env: environment(stepVariables),
  pid,
  overlay: ["--checkout", settings.checkout, "--host", settings.host],
})

/** The global configs as the update keeps, restores and strips them (`filestore/configs.ts`): the server config is the first, the TUI's the one named `cli.json`. */
export const configPaths = (settings: Settings, home: string) => ({
  server: Option.getOrElse(Arr.head(settings.config), () => `${home}/.config/opencode/opencode.json`),
  under: `${settings.checkout}/opencode`,
  owned: oursOf(settings.checkout, shareDir(home)),
})

/** What daily says once it staged a build: what a handoff will do with it. It writes the record and restarts, and moves no checkout and writes no config. */
export const STAGED_LINE =
  "staged: a handoff installs it in the record and restarts the service onto it (the update plugin's after the Sabbath rest, daily by hand's at once); no checkout moves and no config is written"

/** The last part of a path. */
const lastPart = (path: string): string => Option.getOrElse(Arr.last(path.split("/")), () => path)

/**
 * What daily was asked to do, as plain data for daily, which runs on the root package's Effect: install
 * the checkout's commit by hand, stage from a build's tree (the build's name), or nothing, refused with why.
 */
export type StageFrom = { readonly kind: "hand" } | { readonly kind: "tree"; readonly build: string } | { readonly kind: "refused"; readonly message: string }

/**
 * A stage from a build's tree (daily's `--stage --from-tree`): the build whose tree daily's `opencode/`
 * (`root`) is (`<share>/opencode-<version>.plugins/opencode`), with the dotfiles commit the update names
 * (`--dotfiles-target`, as a tree has no git to read one from). With neither flag, an install by hand;
 * refused, so daily stages nothing, for a stage that is not from a tree, a root that is no tree or a stage
 * that names no dotfiles commit.
 */
export const treeStage = (root: string, stage: boolean, flagged: boolean, dotfiles: ReadonlyArray<string>): StageFrom => {
  if (!stage && !flagged) return { kind: "hand" }
  if (!stage || !flagged) return { kind: "refused", message: "daily stages only from a build's tree (--stage --from-tree, as the update runs it); by hand it takes neither flag" }
  const build = Option.filter(buildOfTree(lastPart(root.slice(0, root.lastIndexOf("/")))), () => lastPart(root) === "opencode")
  if (Option.isNone(build)) return { kind: "refused", message: `daily --from-tree runs from a build's tree (<share>/opencode-<version>.plugins/opencode), not ${root}` }
  if (dotfiles.length === 0) return { kind: "refused", message: "daily --from-tree needs --dotfiles-target: a tree has no git to read the dotfiles commit from" }
  return { kind: "tree", build: build.value }
}

/** Why daily refuses to stage from where it was asked to (none or one line). */
export const refusals = (from: StageFrom): ReadonlyArray<string> =>
  [from]
    .values()
    .filter((each): each is Extract<StageFrom, { kind: "refused" }> => each.kind === "refused")
    .map((each) => each.message)
    .toArray()

/** Why daily, having built `version`, stages nothing (none or one line): it runs from the tree of another build (`treeStage`). */
export const builtForTree = (from: StageFrom, version: string): ReadonlyArray<string> =>
  [from]
    .values()
    .filter((each): each is Extract<StageFrom, { kind: "tree" }> => each.kind === "tree" && each.build !== buildName(version))
    .map((each) => `daily built ${version}, but runs from the tree of ${each.build}: nothing staged`)
    .toArray()

/** The commit a checkout is on, in full. */
export const headOf = (directory: string): string => spawnSync(["git", "-C", directory, "rev-parse", "HEAD"]).stdout.toString().trim()

/** How many files under the checkout's `opencode/` differ from its commit, git's way (`status --porcelain`). */
const uncommitted = (checkout: string): number =>
  spawnSync(["git", "-C", checkout, "status", "--porcelain", "--", "opencode"])
    .stdout.toString()
    .split("\n")
    .filter((line) => line !== "").length

/**
 * What daily by hand says before it installs: the commit, never the files as they stand. An edit not
 * committed is in no tree; the dev launcher runs the checkout as it stands.
 */
export const notInstalledLine = (commit: string, dirty: number): string =>
  [
    `daily: installing commit ${commit.slice(0, 10)}; uncommitted edits in this checkout are not installed (to run them: bun run verify:launch)`,
    ...[dirty].flatMap((count) => [`; ${count} files under opencode/ differ from it`].filter(() => count > 0)),
  ].join("")

/**
 * Whether build `version` is what the host runs, proven, with its tree: the record installs it and names
 * it good, and its tree stands (`treeStands`). daily by hand then has nothing to build or restart.
 */
export const alreadyInstalled = (record: Option.Option<Record>, version: string, treeStands: boolean): boolean =>
  treeStands && Option.exists(record, (each) => each.version === version && Option.exists(goodOf(each), (good) => good.version === version))

/** What daily by hand says when the commit is installed and proven already (`alreadyInstalled`). */
export const alreadyLine = (version: string): string =>
  `daily: ${version} is installed and proven, with its tree; nothing built, staged or restarted (commit a change to install it)`

/** daily by hand's install of the checkout's commit, each step daily's own (`installByHand`). */
export interface ByHand {
  /** The live dotfiles checkout, whose object store the tree is made from. */
  readonly checkout: string
  /** Its HEAD, the dotfiles commit installed. */
  readonly commit: string
  /** The build's version, a tree build's (`pin.ts` `versionOf`). */
  readonly version: string
  /** Where and how the tree is made (`treeOptions`). */
  readonly trees: TreeOptions & { readonly lock: string }
  /** The installed record (`installed.json`), read for whether `version` is installed and proven already. */
  readonly record: string
  /** The tree's own daily, staging the build (`builder.ts` `treeStageCommand`); rejects when it fails. */
  readonly stage: (tree: string) => Promise<void>
  /** The host's settings in the global configs: never a plugin entry. */
  readonly settings: () => void
  /** The restart through the tree's handoff; answers its exit code. */
  readonly handoff: (tree: string) => Promise<number>
  readonly log: (line: string) => void
}

/**
 * daily by hand: the checkout's HEAD installed the way the updater installs a target. When the record
 * installs that build already, proven, with its tree, only the host's settings are written, and daily
 * says so: a rebuild would restart the service onto the build it runs. Else the tree is made and the
 * build staged from it (`stage.ts` `makeAndStage`: a failed stage takes the tree only when its make
 * made it), then the host's settings are written, then the tree's handoff restarts onto the build.
 * Answers the handoff's exit code (0 for the no-op); rejects, restarting nothing, when the tree or the
 * stage fails.
 */
export const installByHand = (steps: ByHand): Promise<number> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.sync(() => steps.log(notInstalledLine(steps.commit, uncommitted(steps.checkout))))
      const record = yield* Effect.promise(() => file(steps.record).text().catch(() => "")).pipe(Effect.map(parseRecord))
      const treeStands = yield* Effect.promise(() => file(`${steps.trees.share}/${treeOf(buildName(steps.version))}/config/opencode.json`).exists())
      if (alreadyInstalled(record, steps.version, treeStands)) {
        yield* Effect.sync(steps.settings)
        yield* Effect.sync(() => steps.log(alreadyLine(steps.version)))
        return 0
      }
      const tree = yield* Effect.promise(() => makeAndStage(steps.trees, steps.version, steps.commit, steps.stage))
      yield* Effect.sync(steps.settings)
      return yield* Effect.promise(() => steps.handoff(tree))
    }),
  )

/**
 * Restarts the service through the update's handoff, as the plugin does, waiting for it: the health
 * check and its recovery run for an install by hand too. `program` is the build's own handoff, from its
 * tree (`handoff.ts` `treeProgram`). Answers the handoff's exit code (`model.ts` `EXIT_CODES`: 0 only
 * for a proven build); its lines are in the update's log.
 */
export const restartThroughHandoff = (settings: Settings, reason: string, program: Program): number =>
  spawnSync([settings.bun, program.path, reason], {
    cwd: program.cwd,
    env: environment({ ...stepEnv(settings, Option.getOrElse(Option.fromNullishOr(env.PATH), () => "")), [HANDOFF_SETTINGS]: encodeSettings(settings) }),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode
