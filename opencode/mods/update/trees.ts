import { Array as Arr, Option, Schema } from "effect"

/**
 * A build's plugin tree: `opencode-<version>.plugins/` beside its binary `opencode-<version>` in the
 * share directory, made once by the stage and never written after it (`filestore/trees.ts`). The fork
 * binds a compiled build to the tree beside its own executable (`<executable>.plugins/config/`,
 * the fork's `packages/cli/src/adjacent-config.ts`), so every process of a build loads the plugins,
 * the plugin entries and the options of the dotfiles commit it was built with, for its whole life.
 *
 * - `opencode/`: the dotfiles commit's `opencode/` directory (`git archive`), with its dependencies
 *   installed (`bun install --frozen-lockfile`) and no link into the fork: the binary serves the
 *   fork's modules a plugin imports itself (`HOST_PROVIDED`).
 * - `entries/server/<name>/`: one generated package per server plugin, exporting only `./server` (and
 *   `./rpc` where the plugin has one), which re-exports the plugin's own `server.ts`. The server lists
 *   these, so no plugin it lists has a TUI part: a TUI of another build never imports this build's.
 * - `config/opencode.json` (the server's plugin entries) and `config/cli.json` (the TUI's).
 */
export const TREE_SUFFIX = ".plugins"

/** The tree of the build file named `build` (`builds.ts` `buildName`): `<build>.plugins`. */
export const treeOf = (build: string): string => `${build}${TREE_SUFFIX}`

/**
 * The build file a share directory entry is the tree of; none for anything else. Whether that names a
 * build is the build grammar's to say (`builds.ts` `buildVersion`).
 */
export const buildOfTree = (name: string): Option.Option<string> =>
  Option.liftPredicate(name, (each) => each.endsWith(TREE_SUFFIX) && each.length > TREE_SUFFIX.length).pipe(Option.map((each) => each.slice(0, -TREE_SUFFIX.length)))

/**
 * The name a tree is made under before its one rename into place: `<tree>.make-<pid>`. It never reads as
 * a tree (`buildOfTree`), so nothing loads a tree half made, and a prune under the builds lock takes it
 * for a make that was stopped.
 */
export const makingName = (tree: string, pid: number): string => `${tree}.make-${pid}`

/** Whether a share directory entry is a tree in the making (`makingName`), as a stopped make leaves it. */
export const makingTree = (name: string): Option.Option<string> => Option.fromNullishOr(/^(.+\.plugins)\.make-\d+$/.exec(name)?.[1])

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Whether a running process's command line names the tree `tree` (a share directory entry): a path
 * through it, such as a wake job's `bun <share>/<tree>/opencode/cmd/wake/job.ts`. Such a tree stays,
 * whatever the record says, as long as the process runs.
 */
export const namedBy = (tree: string, command: string): boolean => new RegExp(`(^|/)${escaped(tree)}(/|\\s|$)`).test(command)

/**
 * The modules a host process serves a plugin itself, never from the plugin's own install: the server
 * (`effect` and `@opencode/plugin`, each with its subpaths: the fork's `packages/plugin/src/runtime-modules.ts`),
 * the TUI (those, and Solid and OpenTUI: its `packages/tui/src/plugin/runtime-plugin-support.bun.ts`
 * `HOST_MODULES`), and plain `bun` (none).
 */
export type Host = "server" | "tui" | "bun"

const SERVER_PROVIDED = [/^effect(\/|$)/, /^@opencode\/plugin(\/|$)/]
const TUI_PROVIDED = ["solid-js", "solid-js/store", "@opentui/core", "@opentui/solid", "@opentui/solid/components", "@opentui/solid/jsx-runtime", "@opentui/solid/jsx-dev-runtime"]

/** Whether `host` serves the bare import `specifier` itself. */
export const hostProvided = (host: Host, specifier: string): boolean => {
  if (host === "bun") return false
  if (SERVER_PROVIDED.some((pattern) => pattern.test(specifier))) return true
  return host === "tui" && TUI_PROVIDED.includes(specifier)
}

/**
 * The entry points a process runs from a tree, each with its host: every server plugin's `server.ts`,
 * every TUI plugin's `tui.tsx` (or `tui.ts`), and the scripts a process runs by path with bun (the
 * handoff, daily, a wake's backstop and job, an image job, the kernel's worker). Paths from `opencode/`.
 */
export const SEEDS: ReadonlyArray<{ readonly glob: string; readonly host: Host }> = [
  { glob: "cmd/*/server.ts", host: "server" },
  { glob: "cmd/*/tui.{ts,tsx}", host: "tui" },
  { glob: "cmd/update/handoff.ts", host: "bun" },
  { glob: "scripts/daily.ts", host: "bun" },
  { glob: "cmd/wake/backstop.ts", host: "bun" },
  { glob: "cmd/wake/job.ts", host: "bun" },
  { glob: "cmd/image/run.ts", host: "bun" },
  { glob: "mods/kernel/worker/program.ts", host: "bun" },
]

/**
 * The plugin lists, as data: the plugins by their directory's name (`cmd/<name>`, else `mods/<name>`),
 * in load order, and the built-ins each config turns off. `scripts/daily.ts` reads them for both its
 * writers, the global configs (`--configure`) and a tree's (`--tree`), and gives a plugin its options.
 */
export const SERVER_PLUGINS: ReadonlyArray<string> = [
  "anthropic-auth",
  "pool",
  "orchestrate",
  "guard",
  "kernel",
  "status",
  "queue",
  "git",
  "idle-compact",
  "model-next",
  "auto-title",
  "mail",
  "questions",
  "wake",
  "image",
  "skills",
  "work",
  "tool-names",
  "cache",
  // Prime's reply style (cmd/prime/server.ts) goes before memory, whose digest stays last in the system prompt.
  "prime",
  "memory",
  "stall",
  "rex",
  "escape",
  "update",
]

/**
 * Turns off the fork's built-in automation plugin (`opencode.tool.automation`): its automation tools and
 * its `/automation` command, which tells the model to call them. The wake plugin's tools replace
 * them (the README's OpenCode's automations are off); a plugin can take a tool out of the registry
 * but not a command, so the plugin goes whole. Stored automations and their API are the host's own.
 */
export const BUILTIN_AUTOMATION_OFF = "-opencode.tool.automation"

/** The server's built-ins turned off, after its plugins. */
export const SERVER_OFF: ReadonlyArray<string> = [BUILTIN_AUTOMATION_OFF]

/** A plugin package's TUI part, as its `package.json` exports it. */
const TuiManifest = Schema.Struct({ exports: Schema.Struct({ "./tui": Schema.optionalKey(Schema.String) }) })
const decodeTuiManifest = Schema.decodeUnknownOption(Schema.fromJsonString(TuiManifest))

/** Whether the plugin package whose `package.json` is `manifest` has a TUI part (it exports `./tui`). */
export const hasTuiPart = (manifest: string): boolean => Option.exists(decodeTuiManifest(manifest), (plugin) => Option.isSome(Option.fromUndefinedOr(plugin.exports["./tui"])))

/** The TUI plugin that loads first: Prime, whose look the others draw into. */
export const TUI_FIRST = "prime"

/**
 * The order the TUI loads its plugins in, which is the order their sidebar sections and slots draw in
 * (a slot is appended in load order): Prime first, then the old scheme's list as it stood, so the
 * sidebar keeps its layout (the pool's section, `status`, second; the Queue section, which came through
 * the server's listing, after them). Order only: which plugins load is derived (`tuiPluginsOf`).
 */
export const TUI_ORDER: ReadonlyArray<string> = [TUI_FIRST, "status", "herdr", "rex", "git", "cache", "questions", "model-next", "btw", "skills", "recover", "orchestrate", "escape"]

/** A plugin's place: its index in `TUI_ORDER`, and after every listed one for a plugin it does not list. */
const placeOf = (name: string): number => Option.getOrElse(Arr.findFirstIndex(TUI_ORDER, (listed) => listed === name), () => TUI_ORDER.length)

/**
 * The TUI's plugins, derived from the packages themselves (`packages`: each plugin directory's name and
 * its `package.json`): every one that exports `./tui`, in `TUI_ORDER`, and those it does not list after,
 * by name. Derived, never kept by hand: a TUI part reached the TUI under the old scheme also through the
 * server's listing (gap 5), which a tree's server entries no longer carry, so a plugin missing here
 * would drop out of every TUI (2026-11-20: the Queue sidebar section, `cmd/queue`).
 */
export const tuiPluginsOf = (packages: ReadonlyArray<{ readonly name: string; readonly manifest: string }>): ReadonlyArray<string> =>
  packages
    .flatMap((each) => [each.name].filter(() => hasTuiPart(each.manifest)))
    .toSorted((left, right) => placeOf(left) - placeOf(right) || Number(left > right) - Number(left < right))

/** Turns off the fork's built-in /btw (`opencode.btw`), so /btw is the btw mod's (cmd/btw). */
export const BUILTIN_BTW_OFF = "-opencode.btw"

/** The TUI's built-ins turned off, after its plugins. */
export const TUI_OFF: ReadonlyArray<string> = [BUILTIN_BTW_OFF]

/** A tree's server entry package for the plugin `name`, under `entries/server/`. */
export const serverEntryDir = (tree: string, name: string): string => `${tree}/entries/server/${name}`

/** The parts of a plugin package a server entry carries, as its `package.json` exports them. */
const PluginManifest = Schema.Struct({ exports: Schema.Struct({ "./server": Schema.optionalKey(Schema.String), "./rpc": Schema.optionalKey(Schema.String) }) })
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(PluginManifest))
const EntryManifest = Schema.Struct({ name: Schema.String, private: Schema.Boolean, type: Schema.String, exports: Schema.Record(Schema.String, Schema.String) })
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(EntryManifest))

/** A generated server entry: its `package.json`, and its files, each a one-line re-export. */
export interface ServerEntry {
  readonly manifest: string
  readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>
}

/**
 * The generated server entry of plugin `name`, whose own `package.json` is `manifest`: a package
 * exporting `./server` (and `./rpc` when the plugin has one), each a one-line re-export of the plugin's
 * own file. None when the plugin has no server part: a list of none or one, for daily, whose `effect`
 * is another copy than this module's in a checkout (`scripts/link-fork.ts`). `from` is the entry's way
 * to the plugin's directory (`../../../opencode/cmd/<name>`). The host runs a server part's default
 * export (`Plugin.define`); an RPC part is read by its named exports.
 */
export const serverEntry = (name: string, manifest: string, from: string): ReadonlyArray<ServerEntry> =>
  decodeManifest(manifest).pipe(
    Option.flatMap((plugin) =>
      Option.map(Option.fromUndefinedOr(plugin.exports["./server"]), (server) => [
        { part: "server", file: server, line: "export { default } from" },
        ...Option.toArray(Option.map(Option.fromUndefinedOr(plugin.exports["./rpc"]), (rpc) => ({ part: "rpc", file: rpc, line: "export * from" }))),
      ]),
    ),
    Option.map((parts) => ({
      manifest: `${encodeManifest({ name: `@dotfiles/opencode-entry-${name}`, private: true, type: "module", exports: Object.fromEntries(parts.map(({ part }) => [`./${part}`, `./${part}.ts`])) })}\n`,
      files: parts.map(({ part, file, line }) => ({ name: `${part}.ts`, text: `${line} "${from}/${file.replace(/^\.\//, "")}"\n` })),
    })),
    Option.toArray,
  )
