import { env, spawnSync } from "bun"
import { Array as Arr, Option, Schema } from "effect"
import { buildName } from "../builds.ts"
import { oursOf, tuiOursOf } from "../filestore/configs.ts"
import { buildsLock, files, HANDOFF_SETTINGS, modeOf, type Settings, SettingsJson, shareDir, stepEnv } from "../settings.ts"
import { buildOfTree } from "../trees.ts"
import { type Program, programOf } from "./handoff.ts"
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
  mode: modeOf(host.host),
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
  config: settings.config,
  kept: files(settings).kept,
  server: Option.getOrElse(Arr.head(settings.config), () => `${home}/.config/opencode/opencode.json`),
  owned: oursOf(settings.checkout, shareDir(home)),
  tui: Option.getOrElse(Arr.findFirst(settings.config, (path) => lastPart(path) === "cli.json"), () => `${home}/.config/opencode/cli.json`),
  tuiOwned: tuiOursOf(settings.checkout, shareDir(home)),
})

/**
 * What daily says once it staged a build: what the handoff will do with it. A tree build's handoff
 * writes the record and restarts, and moves no checkout and writes no config (but the first tree
 * install's strip of our server entries); the old scheme's moves the checkout and writes the configs.
 */
export const stagedLine = (fromTree: boolean): string =>
  fromTree
    ? "staged: the update plugin's handoff installs it in the record and restarts the service onto it (after the Sabbath rest, in it); no checkout moves and no config is written, but for a host's first tree install, which takes our entries out of the server config"
    : "staged: the update plugin's handoff moves the checkout, writes the configs and restarts the service (after the Sabbath rest, in it)"

/** The last part of a path. */
const lastPart = (path: string): string => Option.getOrElse(Arr.last(path.split("/")), () => path)

/**
 * Where daily stages from (`--from-tree` or not), as plain data for daily, which runs on the root
 * package's Effect: the checkout, a build's tree (the build's name), or a stage refused with why.
 */
export type StageFrom = { readonly kind: "checkout" } | { readonly kind: "tree"; readonly build: string } | { readonly kind: "refused"; readonly message: string }

/**
 * A stage from a build's tree (daily's `--from-tree`): the build whose tree daily's `opencode/` (`root`)
 * is (`<share>/opencode-<version>.plugins/opencode`), with the dotfiles commit the update names
 * (`--dotfiles-target`, as a tree has no git to read one from). The checkout without the flag;
 * refused, so daily stages nothing, for a root that is no tree or a stage that names no dotfiles commit.
 */
export const treeStage = (root: string, flagged: boolean, dotfiles: ReadonlyArray<string>): StageFrom => {
  if (!flagged) return { kind: "checkout" }
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

/** The handoff program for daily by hand (`handoff.ts` `programOf`), over the record file as `read` reads it now (none when it throws). */
export const programForHand = (settings: Settings, read: (path: string) => string, exists: (path: string) => boolean): Program => programOf(settings, Option.liftThrowable(() => read(settings.record))(), exists)

/** The commit a checkout is on, in full. */
export const headOf = (directory: string): string => spawnSync(["git", "-C", directory, "rev-parse", "HEAD"]).stdout.toString().trim()

/**
 * Restarts the service through the update's handoff, as the plugin does, waiting for it: the health
 * check and its recovery run for an install by hand too. `program` is the next build's own handoff,
 * from its tree when it has one (`handoff.ts` `programOf`). Answers the handoff's exit code
 * (`model.ts` `EXIT_CODES`: 0 only for a proven build); its lines are in the update's log.
 */
export const restartThroughHandoff = (settings: Settings, reason: string, program: Program): number =>
  spawnSync([settings.bun, program.path, reason], {
    cwd: program.cwd,
    env: environment({ ...stepEnv(settings, Option.getOrElse(Option.fromNullishOr(env.PATH), () => "")), [HANDOFF_SETTINGS]: encodeSettings(settings) }),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode
