// `bun run daily`: makes the fork, with these mods loaded, the `opencode` a new terminal runs.
//
// 0. Fast-forwards the fork checkout's prime-look to origin/prime-look (`--fork-target <sha>`: to the
//    update's verified fork commit, mods/update) from another checkout; a branch with commits origin lacks, or uncommitted tracked changes, is left
//    as it is and said so (scripts/upstream.ts `syncFork`). Then, on the Mac, which owns the fork, merges upstream OpenCode into prime-look first, in a
//    worktree of its own, and lands it only when the merge is clean and its checks pass
//    (scripts/upstream.ts); a conflict or a red check leaves prime-look as it was, writes
//    `~/.local/state/opencode-daily/upstream-conflict.md` and the install goes on. `--no-upstream`
//    skips it; `--dry-run` fetches, says what it would merge and stops before anything else.
// 1. Builds the fork in `OPENCODE_DEV` (default: the prime-look workspace) as a release binary
//    (channel `latest`, version `<base>-prime.<fork commit>.<dotfiles commit>`, eight hex each), so it
//    shares the installed OpenCode's database and background service; a version change restarts that
//    service as ours, and a dotfiles-only update is a new version too. With
//    `--fork-target <sha>` it builds exactly that commit, in a detached worktree of the fork
//    pinned there (`~/.local/state/opencode-daily/fork-build`), never prime-look's HEAD, which
//    a land's post-land merge moves. A binary whose version names another pair of commits stops daily, and the
//    record names the commits built (mods/update/process/pin.ts). `--skip-build` reuses the last build,
//    which then must name the same pair.
// 2. Copies it to `~/.local/share/opencode-prime/`, stages it in the installed record and writes
//    `~/.local/bin/opencode`, a launcher that runs the build the record installs (the running one
//    until the handoff installs this one) without the caller's Anthropic routing and, after a
//    service start or restart, loads the resident location so the server plugins run with no
//    client (mods/update/filestore/launcher.ts, `residentDir`). `~/.local/bin` comes before
//    `~/.bun/bin` on PATH; `opencode2` stays the stock release.
// 3. Merges our entries into `~/.config/opencode/opencode.json` (server plugins, the role
//    agents' models, no auto-update) and `cli.json` (TUI plugins, the Prime theme), keeping
//    every other key and plugin. Paths are this checkout's, so nothing machine-specific is
//    committed.
//    Only `--configure` does this step, and nothing else: the update's handoff runs it from the
//    checkout once it moved onto the build's commit, right before the restart (mods/update). A
//    by-hand run gets it from the handoff too. The plugin lists are data (mods/update/trees.ts),
//    which `--tree <dir> --at <place> [--checkout <live checkout>] [--host <name>]` reads too: it writes a build's
//    plugin tree's server entries and overlay (`config/opencode.json`, `config/cli.json`) into the
//    tree in the making `dir`, every path naming `place`, and nothing else (mods/update/filestore/trees.ts).
// 4. Writes upstream/dev's lead for the TUI's corner (`upstreamReading`), then restarts the service
//    through the update's handoff (mods/update: checkout move, configs, health check, reinstall,
//    rollback). `--stage` (the update plugin's build ahead, from the checkout as it stands, which
//    does not move; `--dotfiles-target <sha>` names the commit the record gives the build) restarts
//    nothing and writes no config: the plugin's handoff does both, at once (outside the Sabbath rest).
//    The update stages with `--stage --from-tree`, run from the build's plugin tree
//    (`<share>/opencode-<version>.plugins/opencode`, mods/update/process/builder.ts): no fork link, no
//    install and no upstream merge (the tree is sealed; the post-land step merges upstream), and a
//    build whose version is not the tree's stages nothing (mods/update/process/install.ts `treeStage`).
//    By hand, the restart runs the next build's own handoff, from its tree when it has one.
import { $ } from "bun"
import { Effect, Option } from "effect"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join, resolve } from "node:path"
import { type Catalog, DEFAULT_FORK, loadCatalog, loginStoreDir, newestRelease } from "../testbeds/gamut/gamut.ts"
import { BUILTIN_AUTOMATION_OFF, BUILTIN_BTW_OFF, SERVER_OFF, SERVER_PLUGINS, serverEntry, serverEntryDir, TUI_OFF, tuiPluginsOf } from "../mods/update/trees.ts"
import type { Settings } from "../mods/update/settings.ts"
import { readyFork } from "./fork.ts"
import { upstreamFile } from "../mods/prime/update.ts"
import { hostLocks } from "../mods/work/process/landing.ts"
import { MergeDriverError, registerMergeDriver } from "./merge-driver.ts"
import { forkChecks, mergeUpstream, type SyncOutcome, syncFork, upstreamReading, withUpstreamLock } from "./upstream.ts"
import { builtForTree, flagValue, headOf, programForHand, refusals, restartThroughHandoff, settingsFor, stagedLine, treeStage, updateEntry } from "../mods/update/process/install.ts"
import { buildsLock, shareDir } from "../mods/update/settings.ts"
import { stageBuild } from "../mods/update/filestore/stage.ts"
import { RETIRED_PLUGINS } from "../mods/update/filestore/configs.ts"
import { releaseBuild, runDailyBuild } from "../mods/update/process/pin.ts"

/** This checkout's `opencode/` directory, which daily runs from. */
const ROOT = resolve(import.meta.dir, "..")
const MODS = join(ROOT, "mods")
const CMD = join(ROOT, "cmd")

/**
 * The directory OpenCode loads a plugin from in the `opencode/` directory `root`: its `cmd/` package
 * once it has one, else its mod, named as it stands at `at` (a tree in the making names the place it is
 * renamed to).
 */
export const pluginDirIn = (name: string, root: string, at: string = root): string => {
  const where = existsSync(join(root, "cmd", name, "package.json")) ? "cmd" : "mods"
  return join(at, where, name)
}

/** The directory OpenCode loads a plugin from in this checkout (`pluginDirIn`). */
export const pluginDir = (name: string): string => pluginDirIn(name, ROOT)
const THEME = resolve(import.meta.dir, "../themes/prime.json")

/** Why the upstream merge is skipped, by where daily stages from: a stage from a build's tree has no link into the fork for the merge's checks. */
const SKIPPED_MERGE = {
  checkout: "a land's post-land step is merging upstream now",
  tree: "a stage from a build's tree; the post-land step merges upstream",
  refused: "a refused stage",
} as const

/** Stops daily, staging nothing, at the first of `problems` (it throws, as daily's other refusals do); nothing when there are none. */
const refuse = (problems: ReadonlyArray<string>): void => Effect.runSync(Effect.forEach(problems.slice(0, 1), (problem) => Effect.fail(`daily: ${problem}`), { discard: true }))

export type PluginEntry = string | { readonly package: string; readonly options?: Record<string, unknown> }
type Json = Record<string, unknown>

export { BUILTIN_AUTOMATION_OFF, BUILTIN_BTW_OFF }

const packageOf = (entry: unknown): string | undefined =>
  typeof entry === "string" ? entry : typeof entry === "object" && entry !== null && "package" in entry ? String(entry.package) : undefined

/**
 * The resident location: a directory of its own whose config keeps it loaded
 * (`location_idle_timeout: false`). OpenCode loads the server plugins per
 * location, on a location's first request, and unloads a location an hour
 * after its last session event, so a server no client uses runs none of them:
 * the mail listener among them, which a paired host needs. The launcher asks
 * for this location whenever it starts or restarts the service.
 */
export const residentDir = (home: string): string => join(home, ".local/state/opencode-prime/resident")

/**
 * OpenCode's record of the installed build, `<XDG state>/opencode/installed.json` (the fork's
 * `@opencode/util/installed-build`), written through the update's record (mods/update/record.ts).
 */
export const installedFile = (home: string, env: Record<string, string | undefined> = process.env): string =>
  join(env.XDG_STATE_HOME || join(home, ".local/state"), "opencode/installed.json")
export const residentConfig: Json = { experimental: { location_idle_timeout: false } }

/**
 * Each role's model: the newest Opus, the verifier too (the skill's Models rule). Codex is the
 * fallback the orchestrate mod moves a held start to; no role is bound to it. The planner goes
 * on the newest Fable first (`plannerModel`, the orchestrate entry's `planner`): its Opus here is
 * the second step of its chain, and what it runs on without the orchestrate mod.
 */
export const roleModels = (catalog: Catalog): Record<string, string> => {
  const newest = (provider: string, family: string) => {
    const model = newestRelease(catalog, provider, family)
    if (model === undefined) throw new Error(`no ${provider}/${family} release in the model catalog`)
    return `${provider}/${model}`
  }
  const claude = newest("anthropic", "claude-opus")
  return { planner: claude, implementor: claude, verifier: claude, worker: claude }
}

/** The prompt-cache lifetimes Anthropic offers, as `settings.cache.ttl` writes them, in ms. */
const ANTHROPIC_CACHE_TTLS = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const

/** The prompt-cache lifetime daily sets for Claude (`providers.anthropic.settings.cache.ttl`). */
export const CLAUDE_CACHE_TTL: keyof typeof ANTHROPIC_CACHE_TTLS = "1h"

/**
 * The same lifetime in ms, for the pool's `cacheLifeMs`: while a session's cache lives the pool
 * keeps it on the login the cache is on, so the two must agree.
 */
export const CLAUDE_CACHE_LIFE_MS: number = ANTHROPIC_CACHE_TTLS[CLAUDE_CACHE_TTL]

/**
 * The owner's hosts by host name (lower case, without `.local`), each with the others its pool
 * reads over SSH, by the destination that reaches them on the tailnet: the MacBook and the
 * workbox read each other.
 */
export const FLEET: Readonly<Record<string, ReadonlyArray<{ readonly name: string; readonly ssh: string }>>> = {
  "cristians-macbook-pro": [{ name: "workbox", ssh: "bite-workbox" }],
  "bite-cristian": [{ name: "macbook", ssh: "cvr@cristians-macbook-pro" }],
}

/** A host's peers in `FLEET`; a host not listed has none. */
export const peersOf = (host: string) => FLEET[host.toLowerCase().replace(/\.local$/, "")] ?? []

/**
 * The pool's plugin entry: Claude's cache lifetime, and the login store as a source of logins when
 * `store` (its directory) exists. On one of the owner's hosts (`fleet`) it also paces OpenAI's
 * agents on the ChatGPT account's own measure and reads the host's peers.
 */
export const poolEntry = (pool: string, store: string | undefined, fleet?: { readonly host: string }): PluginEntry => ({
  package: pool,
  options: {
    cacheLifeMs: CLAUDE_CACHE_LIFE_MS,
    ...(store === undefined ? {} : { sources: [{ kind: "store", dir: store }] }),
    ...(fleet === undefined ? {} : { paced: { openai: "openai" }, fleet: { host: fleet.host, peers: peersOf(fleet.host) } }),
  },
})

/**
 * The planner's first model: the newest Fable release (the owner's call, 2026-11-12: "Fable is
 * our planner"). Orchestrate starts every new planner on it at the planner's effort, and on the
 * role's own model (Opus), then Codex, when the pool holds it. None when the catalog has no
 * Fable release: the planner then runs on Opus like every role.
 */
export const plannerModel = (catalog: Catalog): string | undefined => {
  const fable = newestRelease(catalog, "anthropic", "claude-fable")
  return fable === undefined ? undefined : `anthropic/${fable}`
}

/**
 * Orchestrate's plugin entry: a Codex provider's new agents take the pool's pace first, which
 * paces OpenAI on the ChatGPT account (`poolEntry`'s `paced`); the admission script answers only
 * when the pool has no measure of it. With `planner`, the planner's first model. `fleet` names the
 * dotfiles and fork checkouts an accepted verdict records the verified target from (mods/update).
 */
export const orchestrateEntry = (orchestrate: string, fleet: { readonly dotfiles: string; readonly fork: string }, planner?: string): PluginEntry => ({
  package: orchestrate,
  options: { codex: { pool: true }, fleet, ...(planner === undefined ? {} : { planner: { model: planner } }) },
})

/**
 * Mail's plugin entry: on one of the owner's hosts (`FLEET`) whose Tailscale address is known,
 * its listener on that address only, so the hosts paired with `bun cmd/mail/pair.ts` reach it;
 * elsewhere the bare plugin, which listens nowhere.
 */
export const mailEntry = (mail: string, fleet: { readonly host: string; readonly tailscale: string | undefined }): PluginEntry =>
  peersOf(fleet.host).length === 0 || fleet.tailscale === undefined ? mail : { package: mail, options: { listen: { hostname: fleet.tailscale } } }

/** This machine's Tailscale IPv4 address, from the `tailscale` CLI (on PATH, or the Mac app's), or undefined. */
export const tailscaleAddress = async (): Promise<string | undefined> => {
  for (const cli of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    const ran = await $`${cli} ip -4`.nothrow().quiet().catch(() => undefined)
    const address = ran?.exitCode === 0 ? ran.stdout.toString().trim().split("\n")[0] : undefined
    if (address !== undefined && /^100\.\d+\.\d+\.\d+$/.test(address)) return address
  }
  return undefined
}

const record = (value: unknown): Json => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {})

/** `config` without the key `key`. */
const without = (config: Json, key: string): Json => Object.fromEntries(Object.entries(config).filter(([name]) => name !== key))

/**
 * The config's `experimental` settings, without the `background_compaction` flag daily wrote until upstream #64290
 * (fork 56711ea7) made background compaction default on and removed the flag. The fork ignores a key it no longer
 * defines, so an old config was harmless; daily removes what it wrote all the same, and the whole `experimental`
 * object once nothing else is in it.
 */
const retired = (existing: Json) => {
  const experimental = without(record(existing.experimental), "background_compaction")
  const rest = without(existing, "experimental")
  if (Object.keys(experimental).length === 0) return rest
  return { ...rest, experimental }
}

/**
 * The global server config with ours merged in: our plugins (any entry from `owned` dirs, or an
 * earlier copy of one that names no directory, such as `-opencode.tool.automation`, is replaced,
 * a `RETIRED_PLUGINS` entry dropped, every other entry kept, ours first so the auth plugin precedes the pool), each
 * role's model (its other fields kept), the retired `experimental.background_compaction` removed
 * (`retired`), and auto-update off so the stock release never replaces the fork.
 */
export const mergeServer = (
  existing: Json,
  plugins: ReadonlyArray<PluginEntry>,
  models: Record<string, string>,
  owned: ReadonlyArray<string>,
): Json => {
  const ours = plugins.map(packageOf)
  const others = (Array.isArray(existing.plugins) ? existing.plugins : []).filter((entry) => {
    const path = packageOf(entry)
    return path === undefined || (!ours.includes(path) && !RETIRED_PLUGINS.includes(path) && !owned.some((dir) => path === dir || path.startsWith(`${dir}/`)))
  })
  const agents = (typeof existing.agents === "object" && existing.agents !== null ? existing.agents : {}) as Record<string, Json>
  const providers = record(existing.providers)
  const anthropic = record(providers.anthropic)
  const settings = record(anthropic.settings)
  return {
    ...retired(existing),
    autoupdate: false,
    // Claude's prompt cache lives an hour instead of Anthropic's 5-minute default, so a pause for a
    // review or a long tool call doesn't rewrite the whole context; a 1h write costs 2x input, not 1.25x.
    providers: { ...providers, anthropic: { ...anthropic, settings: { ...settings, cache: { ...record(settings.cache), ttl: CLAUDE_CACHE_TTL } } } },
    plugins: [...plugins, ...others],
    agents: {
      ...agents,
      ...Object.fromEntries(Object.entries(models).map(([role, model]) => [role, { ...agents[role], model }])),
    },
  }
}

/** The object at `key` of a config, or an empty one when the key holds none. */
const objectAt = (config: Json, key: string): object => {
  const value = config[key]
  return typeof value === "object" && value !== null ? value : {}
}

/**
 * The TUI config with ours merged in: our plugins first (Prime before the rest), the Prime theme,
 * and the fork's `window` tab scope: a window's tabs are the sessions opened in it, never those
 * of the other TUIs on the machine, since herdr gives each session its own space (owner, q61).
 * An entry of ours that names no directory (`-opencode.btw` turns a built-in off) replaces its
 * earlier copy.
 */
export const mergeCli = (existing: Json, plugins: ReadonlyArray<string>, owned: ReadonlyArray<string>): Json => {
  const others = (Array.isArray(existing.plugins) ? existing.plugins : []).filter((entry) => {
    const path = packageOf(entry)
    return path === undefined || (!plugins.includes(path) && !owned.some((dir) => path === dir || path.startsWith(`${dir}/`)))
  })
  const theme = objectAt(existing, "theme")
  const tabs = objectAt(existing, "tabs")
  return { ...existing, theme: { ...theme, name: "prime" }, tabs: { ...tabs, scope: "window" }, plugins: [...plugins, ...others] }
}

const readJson = (path: string): Json => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Json) : {})
/** A config's text, as daily writes every JSON file. */
export const jsonText = (value: Json): string => `${JSON.stringify(value, null, 2)}\n`
const writeJson = (path: string, value: Json) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, jsonText(value), { mode: 0o600 })
}

/**
 * The plugin directories daily owns in a host's configs: this checkout's `mods/` and `cmd/`, and the
 * loader directory earlier runs loaded the auth plugin through. Any entry under one that the current
 * lists leave out (a deleted plugin, such as the web plugin) is dropped.
 */
export const ownedDirs = (share: string): ReadonlyArray<string> => [MODS, CMD, join(share, "anthropic-auth")]

/**
 * Merges ours into the host's server and TUI configs in `config`. Only `--configure` writes them,
 * which the update's handoff runs from the checkout once it moved onto the build's commit, so the
 * service it restarts reads only plugins that checkout has; a stage writes none.
 */
export const writeConfigs = (to: {
  readonly config: string
  readonly server: ReadonlyArray<PluginEntry>
  readonly cli: ReadonlyArray<string>
  readonly models: Record<string, string>
  readonly owned: ReadonlyArray<string>
}) => {
  writeJson(join(to.config, "opencode.json"), mergeServer(readJson(join(to.config, "opencode.json")), to.server, to.models, to.owned))
  writeJson(join(to.config, "cli.json"), mergeCli(readJson(join(to.config, "cli.json")), to.cli, to.owned))
}

/**
 * Moves prime-look to origin (`sync`) and, when it moved and is checked out there (`head`), installs what
 * the move changed (`install`: the build skips its own install), all in one hold of the land's checks lock
 * (`move`), since a land's gate and accept read the checkout. A failed install is logged, lets go of the
 * lock and then fails with its own error: daily stops, as a build on a half-installed fork must not run.
 */
export const moveFork = <I>(
  move: <A>(step: () => Promise<A>) => Promise<A>,
  sync: () => SyncOutcome,
  head: Effect.Effect<string>,
  install: Effect.Effect<I>,
  log: (line: string) => void,
): Promise<SyncOutcome> =>
  move(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const synced = sync()
        if (synced.kind === "fast-forwarded" && (yield* head).trim() === synced.to)
          yield* install.pipe(Effect.tapDefect(() => Effect.sync(() => log(`daily: the fork's install after its move to ${synced.to} failed; daily stops before the build`))))
        return synced
      }),
    ),
  )

/** The land locks daily's fork steps take: `move` (the checks lock) to change prime-look, `tests` (the accept lock) to test it. */
export interface ForkLocks {
  readonly move: <A>(step: () => Promise<A>) => Promise<A>
  readonly tests: <A>(step: () => Promise<A>) => Promise<A>
}

/** What daily does to prime-look, each step unlocked; `forkSteps` puts each inside its lock. */
export interface ForkWork<I, C> {
  readonly sync: () => SyncOutcome
  readonly head: Effect.Effect<string>
  readonly install: Effect.Effect<I>
  readonly checks: (dir: string) => Effect.Effect<C>
  readonly log: (line: string) => void
}

/**
 * daily's steps that change or test prime-look, each run whole inside its land lock, since a land's gate
 * and accept read the checkout: the move to origin and its install (`move`), the upstream merge's fork
 * tests (`checks`, under the accept lock), and the install after a merge (`reinstall`).
 */
export const forkSteps = <I, C>(locks: ForkLocks, work: ForkWork<I, C>) => ({
  move: () => moveFork(locks.move, work.sync, work.head, work.install, work.log),
  checks: (dir: string) => locks.tests(() => Effect.runPromise(work.checks(dir))),
  reinstall: () => locks.move(() => Effect.runPromise(work.install)),
})

/** The dotfiles checkout daily runs from: its git config gets the merge driver, its workspace the install. */
export const DOTFILES = resolve(MODS, "../..")

/**
 * Registers the merge driver in `checkout`, daily's own dotfiles checkout, then runs `install`. A checkout
 * whose .gitattributes routes no file to the driver is not the dotfiles root: daily fails there, before the
 * install, rather than leave the policy to git's line merge without a word.
 */
export const installDotfiles = <I>(checkout: string, install: Effect.Effect<I>): Promise<I> =>
  Effect.runPromise(
    registerMergeDriver(checkout).pipe(
      Effect.filterOrFail(
        (registered) => registered !== "unrouted",
        () => new MergeDriverError({ message: `${checkout}'s .gitattributes routes no file to the merge driver effect-debt; daily registers it in its own dotfiles checkout` }),
      ),
      Effect.andThen(install),
    ),
  )

/** Which host a run configures: its live dotfiles checkout and its name. */
interface Where {
  readonly checkout: string
  readonly host: string
}

/** This checkout on this host. */
const HERE: Where = { checkout: DOTFILES, host: hostname() }

/** The update's settings for the dotfiles checkout and host `where`, as the plugin's entry and the handoff get them. */
const hostSettings = (home: string, fork: string, where: Where = HERE) =>
  settingsFor({ host: where.host, home, state: dirname(dirname(installedFile(home))), checkout: where.checkout, fork, bun: process.execPath, resident: residentDir(home), launcher: join(home, ".local/bin/opencode") })

/** What a host's plugin entries are made of beyond the plugins' directories, read once per run (`hostFacts`). */
export interface HostFacts {
  /** The host's name (`FLEET`). */
  readonly host: string
  readonly tailscale: Option.Option<string>
  /** The fork checkout, and the dotfiles checkout an accepted verdict records the verified target from. */
  readonly fleet: { readonly dotfiles: string; readonly fork: string }
  readonly catalog: Catalog
  /** The pool's login store, when it exists. */
  readonly store: Option.Option<string>
  /** The update plugin's options. */
  readonly settings: Settings
}

/** The facts of the host `where` (this checkout on this host, by default). */
const hostFacts = (home: string, fork: string, where: Where = HERE) =>
  Effect.gen(function* () {
    return {
      host: where.host,
      tailscale: Option.fromNullishOr(yield* Effect.promise(tailscaleAddress)),
      fleet: { dotfiles: where.checkout, fork },
      catalog: yield* Effect.promise(() => loadCatalog(fork)),
      store: Option.liftPredicate(loginStoreDir(home), existsSync),
      settings: hostSettings(home, fork, where),
    } satisfies HostFacts
  })

/** The entries of the plugins daily gives options, by name, from the plugin's directory and the host's facts. */
const OPTIONED = new Map<string, (dir: string, facts: HostFacts) => PluginEntry>([
  ["pool", (dir, facts) => poolEntry(dir, Option.getOrUndefined(facts.store), { host: facts.host })],
  ["orchestrate", (dir, facts) => orchestrateEntry(dir, facts.fleet, plannerModel(facts.catalog))],
  ["mail", (dir, facts) => mailEntry(dir, { host: facts.host, tailscale: Option.getOrUndefined(facts.tailscale) })],
  ["update", (dir, facts) => updateEntry(dir, facts.settings)],
])

/**
 * The server's plugin entries, as `trees.ts` `SERVER_PLUGINS` lists them and then the built-ins it
 * turns off, each plugin at the directory `dirOf` names, with its options from `facts`.
 */
export const serverEntries = (facts: HostFacts, dirOf: (name: string) => string): ReadonlyArray<PluginEntry> => [
  ...SERVER_PLUGINS.map((name) => Option.match(Option.fromNullishOr(OPTIONED.get(name)), { onNone: () => dirOf(name), onSome: (entry) => entry(dirOf(name), facts) })),
  ...SERVER_OFF,
]

/** The plugin packages of the `opencode/` directory `root`, each `cmd/<name>` by its name and `package.json`, for `trees.ts` `tuiPluginsOf`. */
export const pluginPackages = (root: string): ReadonlyArray<{ readonly name: string; readonly manifest: string }> =>
  readdirSync(join(root, "cmd")).flatMap((name) => {
    const manifest = join(root, "cmd", name, "package.json")
    return Option.toArray(Option.liftPredicate(manifest, existsSync)).map((path) => ({ name, manifest: readFileSync(path, "utf8") }))
  })

/**
 * The TUI's plugin entries: every plugin of the `opencode/` directory `root` with a TUI part, as `trees.ts`
 * `tuiPluginsOf` derives them, then the built-ins it turns off, each at the directory `dirOf` names.
 */
export const tuiEntries = (root: string, dirOf: (name: string) => string): ReadonlyArray<string> => [...tuiPluginsOf(pluginPackages(root)).map(dirOf), ...TUI_OFF]

/** Both global configs as `--configure` writes them over `existing`: the server's and the TUI's. */
export const configured = (existing: { readonly server: Json; readonly cli: Json }, facts: HostFacts, share: string) => ({
  server: mergeServer(existing.server, serverEntries(facts, (name) => pluginDir(name)), roleModels(facts.catalog), ownedDirs(share)),
  cli: mergeCli(existing.cli, tuiEntries(ROOT, (name) => pluginDir(name)), ownedDirs(share)),
})

/**
 * Step 3, `--configure`: merges this checkout's plugins, the role models and the theme into the
 * host's configs. The update's handoff runs it once it moved the checkout onto the build's commit,
 * right before the restart, so no config names a plugin directory the checkout lacks.
 */
const configureHost = (home: string, fork: string) =>
  Effect.gen(function* () {
    const share = shareDir(home)
    writeJson(join(residentDir(home), "opencode.json"), residentConfig)
    const facts = yield* hostFacts(home, fork)
    // Earlier runs loaded the auth plugin through a loader directory here; its entry is replaced too.
    const loader = join(share, "anthropic-auth")
    rmSync(loader, { recursive: true, force: true })
    const config = join(home, ".config/opencode")
    const written = configured({ server: readJson(join(config, "opencode.json")), cli: readJson(join(config, "cli.json")) }, facts, share)
    writeJson(join(config, "opencode.json"), written.server)
    writeJson(join(config, "cli.json"), written.cli)
    mkdirSync(join(config, "themes"), { recursive: true })
    copyFileSync(THEME, join(config, "themes/prime.json"))
    const planner = plannerModel(facts.catalog)
    console.log(`server plugins: ${serverEntries(facts, (name) => pluginDir(name)).map(packageOf).join(", ")}`)
    console.log(`roles: ${Object.entries(roleModels(facts.catalog)).map(([role, model]) => `${role} ${model}`).join(", ")}`)
    console.log(planner === undefined ? "planner first: none (no Fable in the catalog), so Opus" : `planner first: ${planner}, then Opus, then Codex when the pool holds it`)
  })

/**
 * `--tree <dir> --at <place>`: writes a tree's server entries and its overlay (`trees.ts`) into `dir`,
 * the tree in the making, whose `opencode/` holds the plugins; every path names `place`, where the tree
 * stands once renamed. The server lists each plugin's generated entry (`entries/server/<name>`, no TUI
 * part), the TUI each plugin's own directory. Only the plugin entries: the global configs keep the role
 * models, the theme and every other key. `where` names the live dotfiles checkout, which the update
 * plugin fetches into and orchestrate records the verified target from, and the host whose fleet the
 * pool and mail join (a host outside `FLEET`, such as a test's, joins none).
 */
const writeTree = (home: string, fork: string, tree: { readonly dir: string; readonly at: string; readonly where: Where }) =>
  Effect.gen(function* () {
    const facts = yield* hostFacts(home, fork, tree.where)
    const opencode = join(tree.dir, "opencode")
    // Each entry reaches its plugin from `entries/server/<name>/`, three levels below the tree.
    const entries = SERVER_PLUGINS.flatMap((name) =>
      serverEntry(name, readFileSync(join(pluginDirIn(name, opencode), "package.json"), "utf8"), pluginDirIn(name, opencode, "../../../opencode")).map((entry) => ({ name, entry })),
    )
    const listed = new Set(entries.map(({ name }) => name))
    const missing = SERVER_PLUGINS.filter((name) => !listed.has(name))
    if (missing.length > 0) return yield* Effect.die(`no server part to list in ${tree.dir}: ${missing.join(", ")}`)
    for (const { name, entry } of entries) {
      const dir = serverEntryDir(tree.dir, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "package.json"), entry.manifest)
      for (const file of entry.files) writeFileSync(join(dir, file.name), file.text)
    }
    writeJson(join(tree.dir, "config/opencode.json"), { plugins: serverEntries(facts, (name) => serverEntryDir(tree.at, name)) })
    writeJson(join(tree.dir, "config/cli.json"), { plugins: tuiEntries(opencode, (name) => pluginDirIn(name, opencode, join(tree.at, "opencode"))) })
  })

/** The fork checkout daily builds and configures from: `OPENCODE_DEV`, else the default, checked. */
const forkOf = (env: NodeJS.ProcessEnv): string => {
  const checked = readyFork(env.OPENCODE_DEV || DEFAULT_FORK)
  if ("problem" in checked) throw new Error(checked.problem)
  if (!existsSync(join(checked.fork, "packages/cli/script/build.ts"))) throw new Error(`no OpenCode checkout at ${checked.fork}: expected packages/cli/script/build.ts; set OPENCODE_DEV`)
  return checked.fork
}

/** `--tree`'s run: the tree in the making, where it will stand, and the live checkout, from daily's arguments. */
const treeRun = (argv: ReadonlyArray<string>, home: string, fork: string) =>
  Option.map(Option.fromIterable(flagValue(argv, "--tree")), (dir) =>
    writeTree(home, fork, {
      dir,
      at: Option.getOrElse(Option.fromIterable(flagValue(argv, "--at")), () => dir),
      where: { checkout: Option.getOrElse(Option.fromIterable(flagValue(argv, "--checkout")), () => HERE.checkout), host: Option.getOrElse(Option.fromIterable(flagValue(argv, "--host")), () => HERE.host) },
    }),
  )

// `--tree`: a build's tree's entries and overlay alone. `--configure`: step 3 alone. Every other run:
// steps 0 to 2 and 4, the fork merged and built, the build staged, then (by hand) the restart through
// the handoff, which moves the checkout if it must and runs `--configure`.
if (import.meta.main) {
  const home = homedir()
  const argv = process.argv
  const args = new Set(argv)
  const env = process.env
  const fork = forkOf(env)
  const only = Option.orElse(treeRun(argv, home, fork), () => Option.some(configureHost(home, fork)).pipe(Option.filter(() => args.has("--configure"))))
  if (Option.isSome(only)) await Effect.runPromise(only.value)
  else {
    // From the update plugin (mods/update): the verified target's fork commit, built instead of
    // origin's prime-look, and its dotfiles commit, which the record names (the checkout moves onto
    // it only in the handoff).
    const forkTarget = flagValue([...args], "--fork-target")
    const dotfilesTarget = flagValue([...args], "--dotfiles-target")
    // `--from-tree`: the update's stage, run from the build's own plugin tree (mods/update/process/builder.ts).
    const fromTree = treeStage(ROOT, args.has("--from-tree"), dotfilesTarget)
    refuse(refusals(fromTree))
    // Step 0 (the Mac only): merge upstream OpenCode into prime-look (scripts/upstream.ts).
    const state = join(home, ".local/state/opencode-daily")
    const locks = hostLocks(env)
    const steps = forkSteps(locks, {
      sync: () => syncFork({ fork, dryRun: args.has("--dry-run"), to: forkTarget[0], log: console.log }),
      head: Effect.promise(() => $`git -C ${fork} rev-parse HEAD`.text()),
      install: Effect.promise(() => $`bun install --frozen-lockfile`.cwd(fork).quiet()),
      checks: (dir) => Effect.promise(() => forkChecks(resolve(MODS, ".."), fork)(dir)),
      log: console.log,
    })
    const upstream = (dryRun: boolean) =>
      mergeUpstream({
        fork,
        host: hostname(),
        skip: args.has("--no-upstream"),
        dryRun,
        landing: locks.moveSync,
        checks: steps.checks,
        worktree: join(state, "upstream-merge"),
        report: join(state, "upstream-conflict.md"),
        log: console.log,
      })
    // Before the merge and the build, so neither starts from a prime-look origin has moved past.
    await steps.move()
    if (args.has("--dry-run")) {
      const outcome = await upstream(true)
      if (outcome.kind === "skipped") console.log(`upstream: skipped (${outcome.reason})`)
      console.log("dry run: nothing merged, built or installed")
      process.exit(0)
    }

    // The workspace links and vendor packages the plugins import: OpenCode loads plugins in place and
    // installs nothing. The fork's modules are linked before the install, so it never writes through an
    // older checkout's whole-directory link into the fork, and again after it, because an install that
    // changes a package's node_modules drops links it did not make. The TUI plugins resolve `solid-js`
    // through those links at load time (scripts/link-fork.ts).
    // A stage from a build's tree does none of it: the tree was installed at its make with no link into
    // the fork and is sealed, and on Linux its node_modules are hardlinks of Bun's cache, so neither an
    // install nor a link may write there; nothing runs plugins from the live checkout any more.
    const linkFork = () => $`bun ${join(import.meta.dir, "link-fork.ts")}`.env({ ...env, OPENCODE_DEV: fork }).quiet()
    if (fromTree.kind === "checkout") {
      await linkFork()
      await installDotfiles(DOTFILES, Effect.promise(() => $`bun install --frozen-lockfile`.cwd(resolve(MODS, "..")).quiet()))
      await linkFork()
    }

    // After the links, since the merge's acceptance tests load the mods through them.
    // Under the lock a land's post-land step (scripts/post-land.ts) merges under too. A stage from a
    // tree skips it: the merge's checks link the fork into the tests' checkout, and the tree takes no
    // link; the post-land step still merges upstream.
    const merged = fromTree.kind === "checkout" && (await withUpstreamLock(state, () => upstream(false)))
    const outcome = merged || { kind: "skipped" as const, reason: SKIPPED_MERGE[fromTree.kind] }
    if (outcome.kind === "skipped") console.log(`upstream: skipped (${outcome.reason})`)
    if (outcome.kind === "merged") {
      if ((await $`git -C ${fork} rev-parse HEAD`.text()).trim() === outcome.merge) {
        // The build skips its install; the merge may have changed the fork's dependencies.
        await steps.reinstall()
        await linkFork()
      } else console.log(`upstream: ${fork} does not have prime-look checked out, so this build leaves the merge out`)
    }

    // A stage (`--fork-target`) builds exactly the verified target's fork commit, in a worktree of its
    // own pinned there, never prime-look's HEAD, which a land's post-land merge moves; by hand, the
    // checkout as it stands. Either binary must name the commit it was built from (mods/update/process/pin.ts).
    // The version names the dotfiles commit too (pin.ts `versionOf`), so a dotfiles-only update is a new
    // version that every open TUI moves onto. `--skip-build` reuses the last binary only when it names the same pair.
    const settings = hostSettings(home, fork)
    const dotfiles = dotfilesTarget[0] ?? headOf(settings.checkout)
    const build = releaseBuild(process.execPath, `cli-${process.platform}-${process.arch}`, {}, args.has("--skip-build"))
    const { commit: builtCommit, version, binary: built, reported } = await runDailyBuild({ fork, tree: join(state, "fork-build"), commit: forkTarget, dotfiles, withTree: fromTree.kind === "tree", bun: process.execPath, build, log: console.log })

    // The tree was made under the version the update read for this target: a build of another stops here, staging nothing.
    refuse(builtForTree(fromTree, version))

    // Under the builds lock, from the copy through the staged record (mods/update/filestore/stage.ts).
    // The launcher stays on the build the record installs; the handoff moves it onto this one (stage.ts `writeLauncher`).
    const binary = stageBuild({
      built,
      share: shareDir(home),
      version,
      record: settings.record,
      launcher: settings.launcher,
      resident: settings.resident,
      lock: buildsLock(home),
      dotfiles,
      fork: builtCommit,
      pid: process.pid,
    })
    // Upstream against this build, for the TUI's corner (mods/prime/update.ts), written before the
    // restart that makes every open TUI reconnect and read it again.
    const reading = upstreamReading(fork, join(state, "upstream-conflict.md"), outcome.kind === "skipped" && !args.has("--no-upstream"))
    if (reading === undefined) rmSync(upstreamFile(home, env.XDG_STATE_HOME), { force: true })
    else writeJson(upstreamFile(home, env.XDG_STATE_HOME), reading)
    console.log(reading === undefined ? "upstream: no upstream/dev to count against" : `upstream: ${reading.commits} commits past this build${reading.blocked ? ", merge blocked" : ""}`)

    console.log(`opencode -> ${binary} (${reported})`)
    if (args.has("--stage")) console.log(stagedLine(fromTree.kind === "tree"))
    else {
      const code = restartThroughHandoff(settings, "daily by hand", programForHand(settings, (path) => readFileSync(path, "utf8"), existsSync))
      console.log(`restart: the update's handoff exited ${code} (0 only for a proven build); its lines are in ${settings.state}/update.log`)
      process.exitCode = code
    }
  }
}
