// `bun run daily`: makes the fork, with these mods loaded, the `opencode` a new terminal runs.
//
// 0. Fast-forwards the fork checkout's prime-look to origin/prime-look (`--fork-target <sha>`: to the
//    update's verified fork commit, mods/update) from another checkout; a branch with commits origin lacks, or uncommitted tracked changes, is left
//    as it is and said so (scripts/upstream.ts `syncFork`). Then, on the Mac, which owns the fork, merges upstream OpenCode into prime-look first, in a
//    worktree of its own, and lands it only when the merge is clean and its checks pass
//    (scripts/upstream.ts); a conflict or a red check leaves prime-look as it was, writes
//    `~/.local/state/opencode-daily/upstream-conflict.md` and the install goes on. `--no-upstream`
//    skips it; `--dry-run` fetches, says what it would merge and stops before anything else.
// 1. By hand (no `--stage`), installs this checkout's HEAD as the update installs a target
//    (mods/update/process/install.ts `installByHand`): the build's plugin tree made from the commit, out of
//    the checkout's object store (`<share>/opencode-<version>.plugins`), then that tree's own daily run with
//    `--stage --from-tree` (step 2), then the host's settings (step 3), then the tree's handoff (step 4).
//    The files as they stand are never installed: an edit not committed runs in the dev launcher alone
//    (`bun run verify:launch`), and daily says so.
// 2. `--stage --from-tree` (the update's stage, run from the build's plugin tree, mods/update/process/builder.ts):
//    builds the fork commit `--fork-target <sha>` as a release binary (channel `latest`, version
//    `<base>-prime.<fork commit>.<dotfiles commit>.tree`, eight hex each), in a detached worktree of the
//    fork pinned there (`~/.local/state/opencode-daily/fork-build`), never prime-look's HEAD, which a land's
//    post-land merge moves; so it shares the installed OpenCode's database and background service, and
//    each update is a new version. A binary whose version names another pair of commits stops daily, and
//    the record names the commits built (mods/update/process/pin.ts); `--skip-build` reuses the last build,
//    which then must name the same pair, and a build whose version is not the tree's stages nothing
//    (install.ts `treeStage`). It copies the build to `~/.local/share/opencode-prime/`, stages it in the
//    installed record and writes `~/.local/bin/opencode`, a launcher that runs the build the record installs
//    (the running one until the handoff installs this one) without the caller's Anthropic routing and,
//    after a service start or restart, loads the resident location so the server plugins run with no
//    client (mods/update/filestore/launcher.ts, `residentDir`). `~/.local/bin` comes before `~/.bun/bin` on
//    PATH; `opencode2` stays the stock release. It restarts nothing and writes no config, and runs no fork
//    link, install or upstream merge (the tree is sealed; the post-land step merges upstream).
// 3. By hand only, what no build's tree carries, the same for every build: no auto-update in
//    `~/.config/opencode/opencode.json`, the Prime theme and the window tab scope in `cli.json` only where it
//    has none (the owner picks both in the TUI), the Prime theme's file and the resident location's config,
//    every other key and every plugin entry kept as it is, each file written only when its text changes
//    (`writeSettings`). The rest follows each update in the build's own tree: its plugins, and the role
//    agents' models and Claude's cache lifetime (`treeSettings`), which win over the same keys in the global
//    config. The plugin lists are data (mods/update/trees.ts), which
//    `--tree <dir> --at <place> [--checkout <live checkout>] [--host <name>]` reads: it writes a build's
//    plugin tree's server entries and overlay (`config/opencode.json`, `config/cli.json`) into the tree in
//    the making `dir`, every path naming `place`, and nothing else (mods/update/filestore/trees.ts).
// 4. By hand, restarts the service through the build's own handoff (mods/update: the record, the restart,
//    the health check, the rollback), at once; the update plugin's handoff does it after the Sabbath rest.
//    The staged stage writes upstream/dev's lead for the TUI's corner first (`upstreamReading`).
import { $ } from "bun"
import { Effect, Option, Schema } from "effect"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join, resolve } from "node:path"
import { type Catalog, loadCatalog, loginStoreDir, newestRelease } from "../testbeds/gamut/gamut.ts"
import { BUILTIN_AUTOMATION_OFF, BUILTIN_BTW_OFF, SERVER_OFF, SERVER_PLUGINS, serverEntry, serverEntryDir, TUI_OFF, tuiPluginsOf } from "../mods/update/trees.ts"
import type { Settings } from "../mods/update/settings.ts"
import type { TailnetRead, TailnetWrite } from "../mods/digest/policy.ts"
import { readyFork } from "./fork.ts"
import { upstreamFile } from "../mods/prime/update.ts"
import { hostLocks } from "../mods/work/process/landing.ts"
import { MergeDriverError, registerMergeDriver } from "./merge-driver.ts"
import { forkChecks, mergeUpstream, type Outcome as UpstreamOutcome, ownsFork, type SyncOutcome, syncFork, upstreamReading, withUpstreamLock } from "./upstream.ts"
import { builtForTree, flagValue, headOf, installByHand, refusals, restartThroughHandoff, settingsFor, STAGED_LINE, treeOptions, treeStage, updateEntry } from "../mods/update/process/install.ts"
import { buildsLock, shareDir, stepEnv } from "../mods/update/settings.ts"
import { stageBuild } from "../mods/update/filestore/stage.ts"
import { treeStageCommand } from "../mods/update/process/builder.ts"
import { treeProgram } from "../mods/update/process/handoff.ts"
import { environment } from "../mods/update/process/run.ts"
import { releaseBuild, runDailyBuild, versionOf } from "../mods/update/process/pin.ts"

/** This checkout's `opencode/` directory, which daily runs from. */
const ROOT = resolve(import.meta.dir, "..")
const MODS = join(ROOT, "mods")

/** The fork's CLI package at a commit, of which daily by hand reads the version its build names. */
const decodeCliPackage = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))

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

/** Stops daily, staging nothing, at the first of `problems` (it throws, as daily's other refusals do); nothing when there are none. */
const refuse = (problems: ReadonlyArray<string>): void => Effect.runSync(Effect.forEach(problems.slice(0, 1), (problem) => Effect.fail(`daily: ${problem}`), { discard: true }))

export type PluginEntry = string | { readonly package: string; readonly options?: Record<string, unknown> }
type Json = Record<string, unknown>

export { BUILTIN_AUTOMATION_OFF, BUILTIN_BTW_OFF }

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

/** A host name as `FLEET` keys it: lower case, without `.local`. It is also the host's Tailscale host name. */
export const fleetKey = (host: string): string => host.toLowerCase().replace(/\.local$/, "")

/** A host's peers in `FLEET`; a host not listed has none. */
export const peersOf = (host: string) => FLEET[fleetKey(host)] ?? []

/** How the digest's page names each of the owner's hosts (`digest.name`, and its peers' `name`). */
export const DIGEST_NAMES: ReadonlyMap<string, string> = new Map([
  ["cristians-macbook-pro", "macbook"],
  ["bite-cristian", "workbox"],
])

/** A `FLEET` host's name on the digest's page; its host name when `DIGEST_NAMES` has none. */
export const digestName = (host: string): string => Option.getOrElse(Option.fromUndefinedOr(DIGEST_NAMES.get(host)), () => host)

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

/** The owner's zone: the morning a digest message set aside for Later returns in, on each of his hosts (the workbox runs on UTC). */
export const OWNER_TIMEZONE = "America/Montreal"

/**
 * The digest's plugin entry. On one of the owner's hosts (`FLEET`):
 * - `digest.timezone` is his;
 * - `digest.tailnetRead` is `"member"`: his own devices (this host's Tailscale user's; never another user's on his
 *   shared tailnet) read the page unpaired (owner, 2026-11-22: "Tailnet can read");
 * - `digest.tailnetWrite` is `"member-except-hosts"`: those devices also mark and answer unpaired, except the agent
 *   machines, this host and the other fleet hosts (where agents run), which pair as before (owner, 2026-11-22:
 *   "the tailnet is the authentication");
 * - `digest.agentHosts` names the other fleet hosts by their MagicDNS first label (`fleetOthersOf`) and his other
 *   agent machines (`OWNER_AGENT_DEVICES`); `digest.excludedDevices` names his devices that get nothing unpaired,
 *   reads included (`OWNER_EXCLUDED_DEVICES`). Names only: the installer never looks a device up. Each host's device
 *   store keys them by stable node ID, once, by hand (`bun cmd/digest/devices.ts agent|exclude <name>`); until it
 *   does, an unkeyed exclusion closes the tailnet to "paired" and an unkeyed agent host closes its writes.
 * - `digest.name` is the host's `DIGEST_NAMES` name, and `digest.peers` the other fleet hosts (`fleetOthersOf`, so
 *   every peer is also an agent host, keyed by the same store entry), each by its page name and its MagicDNS first
 *   label: the page shows their projects beside its own and writes to each directly (owner, 2026-11-22: "the digest
 *   is available over all environments").
 * Set `tailnetWrite` to `"paired"` here to make marks and answers need pairing again, or `"member"` to let the agent
 * machines write too.
 *
 * Elsewhere the bare plugin: the host's zone, and the plugin's defaults, `"paired"` for both.
 */
export const digestEntry = (digest: string, fleet: { readonly host: string }): PluginEntry => {
  if (peersOf(fleet.host).length === 0) return digest
  return {
    package: digest,
    options: {
      timezone: OWNER_TIMEZONE,
      tailnetRead: "member" satisfies TailnetRead,
      tailnetWrite: "member-except-hosts" satisfies TailnetWrite,
      agentHosts: [...fleetOthersOf(fleet.host), ...OWNER_AGENT_DEVICES],
      excludedDevices: OWNER_EXCLUDED_DEVICES,
      name: digestName(fleetKey(fleet.host)),
      peers: fleetOthersOf(fleet.host).map((host) => ({ name: digestName(host), host })),
    },
  }
}

/** His devices beyond the fleet that run agents (owner, 2026-11-22): they read on the tailnet, and pair to write. */
export const OWNER_AGENT_DEVICES: ReadonlyArray<string> = ["cristians-macbook-pro-rex"]

/** His devices that get nothing unpaired on the tailnet, as if another user's (owner, 2026-11-22: "remove the lenovo-rescue"). */
export const OWNER_EXCLUDED_DEVICES: ReadonlyArray<string> = ["lenovo-rescue"]

/** The fleet's other hosts by their Tailscale names (each host's `FLEET` name is its MagicDNS first label); none off the fleet. */
export const fleetOthersOf = (host: string): ReadonlyArray<string> => Object.keys(FLEET).filter((name) => peersOf(host).length > 0 && name !== host.toLowerCase().replace(/\.local$/, ""))

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
 * The settings each build carries in its tree's server overlay (`writeTree`), derived at the tree's make from
 * the catalog it reads then, so a new model release reaches the roles with the next update and nothing writes
 * the owner's files. The fork loads the tree's `config/opencode.json` after the global config and before a
 * project's, folding each agent field by field and provider settings key by key (core `config.ts` `load`,
 * `config/plugin/agent.ts`, `Provider.mergeOverlay`). So these keys, and only these, are the build's over the
 * owner's global config: each role's model and Claude's cache lifetime, which nothing but a build sets (no TUI
 * or command writes either). Every other key, and every other field of those objects, stays the owner's, and a
 * project's config wins over both. The theme and the tab scope are the owner's, picked in the TUI, so the
 * tree's `cli.json` lists only plugins (`hostCli`).
 */
export const treeSettings = (catalog: Catalog) => ({
  agents: Object.fromEntries(Object.entries(roleModels(catalog)).map(([role, model]) => [role, { model }])),
  // Claude's prompt cache lives an hour instead of Anthropic's 5-minute default, so a pause for a
  // review or a long tool call doesn't rewrite the whole context; a 1h write costs 2x input, not 1.25x.
  providers: { anthropic: { settings: { cache: { ttl: CLAUDE_CACHE_TTL } } } },
})

/**
 * The owner's TUI config with the host's defaults in what it lacks: the Prime theme, and the fork's `window`
 * tab scope (a window's tabs are the sessions opened in it, never those of the other TUIs on the machine, since
 * herdr gives each session its own space; owner, q61). A value already there stays, whoever wrote it: the
 * owner picks both in the TUI (`/themes`, `/settings`), which writes them here, and a pick must last.
 */
export const hostCli = (existing: Json) => ({
  ...existing,
  theme: { name: "prime", ...record(existing.theme) },
  tabs: { scope: "window", ...record(existing.tabs) },
})

/**
 * The global server config with what no tree can carry in it: auto-update off, so the stock release never
 * replaces the fork (the fork's CLI reads that policy from the global config directory alone, cli
 * `services/updater.ts` `readPolicy`), and the retired `experimental.background_compaction` removed
 * (`retired`). Every other key stays, the role models and `plugins` untouched: the build's tree carries both.
 */
export const hostServer = (existing: Json): Json => ({ ...retired(existing), autoupdate: false })

const readJson = (path: string): Json => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Json) : {})
/** A config's text, as daily writes every JSON file. */
export const jsonText = (value: Json): string => `${JSON.stringify(value, null, 2)}\n`
const writeJson = (path: string, value: Json) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, jsonText(value), { mode: 0o600 })
}

/** Writes `text` at `path` only when the file does not hold it already: a TUI and the service watch these files. */
const writeChanged = (path: string, text: string) => {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, { mode: 0o600 })
}

/** Whether the TUI config lacks a default `hostCli` adds: only then is it written, so a file that has both is never rewritten, nor its text reformatted. */
export const lacksCliDefault = (existing: Json): boolean => !Object.hasOwn(record(existing.theme), "name") || !Object.hasOwn(record(existing.tabs), "scope")

/**
 * Step 3, by hand only: what the build's tree does not carry, each the same for every build: auto-update off in
 * the global server config (`hostServer`), the Prime theme and the window tab scope in `cli.json` where it has
 * none (`hostCli`), the Prime theme's file in the global config directory (the TUI finds theme files there and
 * in a project's `.opencode/`, never in a tree, tui `theme/discovery.ts`), and the resident location's config
 * (a location's own file). Each file is written only when its text changes, `cli.json` only when a default is
 * added. Both configs are read before anything is written, so one that does not read stops daily with nothing
 * changed. The role models and every plugin entry are left as they are: the build's tree carries them.
 */
export const writeSettings = (home: string) => {
  const config = join(home, ".config/opencode")
  const server = hostServer(readJson(join(config, "opencode.json")))
  const cli = readJson(join(config, "cli.json"))
  writeChanged(join(residentDir(home), "opencode.json"), jsonText(residentConfig))
  writeChanged(join(config, "opencode.json"), jsonText(server))
  if (lacksCliDefault(cli)) writeJson(join(config, "cli.json"), hostCli(cli))
  writeChanged(join(config, "themes/prime.json"), readFileSync(THEME, "utf8"))
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
  ["digest", (dir, facts) => digestEntry(dir, { host: facts.host })],
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

/** Step 3 by hand: the host's settings the tree cannot carry (`writeSettings`). */
const settingsByHand = (home: string) => writeSettings(home)

const RoleOverlay = Schema.Struct({ agents: Schema.Record(Schema.String, Schema.Struct({ model: Schema.String })), plugins: Schema.Array(Schema.Unknown) })
const decodeRoleOverlay = Schema.decodeUnknownOption(Schema.fromJsonString(RoleOverlay))
const decodePlanner = Schema.decodeUnknownOption(Schema.Struct({ options: Schema.Struct({ planner: Schema.Struct({ model: Schema.String }) }) }))

/**
 * The stage's lines (the update's stage log) naming the role models the build's tree carries and the
 * planner's first model, read from its overlay (`<tree>/config/opencode.json`): the one place an update
 * says that a role model set by hand in the global config loses to the build's.
 */
export const roleLines = (overlay: string): ReadonlyArray<string> =>
  Option.match(decodeRoleOverlay(overlay), {
    onNone: () => ["roles: the tree's overlay names none"],
    onSome: (config) => {
      const planner = Option.firstSomeOf(config.plugins.map((entry) => Option.map(decodePlanner(entry), (each) => each.options.planner.model)))
      return [
        `roles (this build's, over a role model set by hand in ~/.config/opencode/opencode.json): ${Object.entries(config.agents).map(([role, agent]) => `${role} ${agent.model}`).join(", ")}`,
        Option.match(planner, { onNone: () => "planner first: none (no Fable in the catalog), so Opus", onSome: (model) => `planner first: ${model}, then Opus, then Codex when the pool holds it` }),
      ]
    },
  })

/**
 * `--tree <dir> --at <place>`: writes a tree's server entries and its overlay (`trees.ts`) into `dir`,
 * the tree in the making, whose `opencode/` holds the plugins; every path names `place`, where the tree
 * stands once renamed. The server lists each plugin's generated entry (`entries/server/<name>`, no TUI
 * part), the TUI each plugin's own directory. Beside the entries, the settings the build carries
 * (`treeSettings`), from the catalog read now; the global configs keep every other key. `where` names
 * the live dotfiles checkout, which the update plugin fetches into and orchestrate records the verified target from, and the host whose fleet the
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
    writeJson(join(tree.dir, "config/opencode.json"), { ...treeSettings(facts.catalog), plugins: serverEntries(facts, (name) => serverEntryDir(tree.at, name)) })
    writeJson(join(tree.dir, "config/cli.json"), { plugins: tuiEntries(opencode, (name) => pluginDirIn(name, opencode, join(tree.at, "opencode"))) })
  })

/** The fork checkout daily builds and configures from: `OPENCODE_DEV`, checked (`readyFork`); unset, it throws `NO_FORK`, with no guessed default. */
export const forkOf = (env: NodeJS.ProcessEnv): string => {
  const checked = readyFork(env.OPENCODE_DEV)
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

// `--tree`: a build's tree's entries and overlay alone. `--stage --from-tree`: step 0's fork sync and
// step 2, from a build's tree. By hand: step 0 with the upstream merge, then steps 1, 3 and 4.
if (import.meta.main) {
  const home = homedir()
  const argv = process.argv
  const args = new Set(argv)
  const env = process.env
  const log = (line: string) => console.log(line)
  const fork = forkOf(env)
  const only = treeRun(argv, home, fork)
  if (Option.isSome(only)) await Effect.runPromise(only.value)
  else {
    // From the update (mods/update): the target's fork commit, built instead of origin's prime-look,
    // and its dotfiles commit, which the record names.
    const forkTarget = flagValue([...args], "--fork-target")
    const dotfilesTarget = flagValue([...args], "--dotfiles-target")
    // `--stage --from-tree`: the update's stage, run from the build's own plugin tree (mods/update/process/builder.ts).
    const from = treeStage(ROOT, args.has("--stage"), args.has("--from-tree"), dotfilesTarget)
    refuse(refusals(from))
    // Step 0 (the Mac only): merge upstream OpenCode into prime-look (scripts/upstream.ts).
    const state = join(home, ".local/state/opencode-daily")
    const locks = hostLocks(env)
    const steps = forkSteps(locks, {
      sync: () => syncFork({ fork, dryRun: args.has("--dry-run"), to: forkTarget[0], log }),
      head: Effect.promise(() => $`git -C ${fork} rev-parse HEAD`.text()),
      install: Effect.promise(() => $`bun install --frozen-lockfile`.cwd(fork).quiet()),
      checks: (dir) => Effect.promise(() => forkChecks(resolve(MODS, ".."), fork)(dir)),
      log,
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
        log,
      })
    // Before the merge and the build, so neither starts from a prime-look origin has moved past.
    await steps.move()
    if (args.has("--dry-run")) {
      const outcome = await upstream(true)
      if (outcome.kind === "skipped") log(`upstream: skipped (${outcome.reason})`)
      log("dry run: nothing merged, built or installed")
      process.exit(0)
    }

    const settings = hostSettings(home, fork)
    if (from.kind !== "tree") {
      // Step 0's upstream merge, on the host that owns the fork: its checks are tests of this checkout,
      // which load the mods through the fork's links (scripts/link-fork.ts), so the merge installs and
      // links the checkout first; nothing else in daily links or installs it, and nothing running loads it.
      // The links go before the install, so it never writes through an older whole-directory link into the
      // fork, and again after it, because an install that changes a package's node_modules drops links it did
      // not make. Under the lock a land's post-land step (scripts/post-land.ts) merges under too.
      const merging = !args.has("--no-upstream") && ownsFork(hostname())
      const linkForkForMerge = Effect.promise(() => $`bun ${join(import.meta.dir, "link-fork.ts")}`.env({ ...env, OPENCODE_DEV: fork }).quiet())
      const forkHead = Effect.promise(() => $`git -C ${fork} rev-parse HEAD`.text()).pipe(Effect.map((text) => text.trim()))
      const say = (line: string) => Effect.sync(() => log(line))
      const code = await Effect.runPromise(
        Effect.gen(function* () {
          if (merging) {
            yield* linkForkForMerge
            yield* Effect.promise(() => installDotfiles(DOTFILES, Effect.promise(() => $`bun install --frozen-lockfile`.cwd(resolve(MODS, "..")).quiet())))
            yield* linkForkForMerge
          }
          const locked = yield* Effect.promise(() => withUpstreamLock(state, () => upstream(false)))
          const outcome = Option.getOrElse(Option.fromNullishOr(locked), (): UpstreamOutcome => ({ kind: "skipped", reason: "a land's post-land step is merging upstream now" }))
          if (outcome.kind === "skipped") yield* say(`upstream: skipped (${outcome.reason})`)
          if (outcome.kind === "merged") {
            if ((yield* forkHead) === outcome.merge) {
              // The merge may have changed the fork's dependencies: the fork and the merge's links again.
              yield* Effect.promise(steps.reinstall)
              yield* linkForkForMerge
            } else yield* say(`upstream: ${fork} does not have prime-look checked out, so this build leaves the merge out`)
          }

          // Steps 1, 3 and 4: this checkout's HEAD, never its files as they stand, built as the update builds a
          // target (mods/update/process/install.ts `installByHand`), on the fork's HEAD as step 0 left it.
          const head = headOf(settings.checkout)
          const forkCommit = yield* forkHead
          const cli = decodeCliPackage(yield* Effect.promise(() => $`git -C ${fork} show ${forkCommit}:packages/cli/package.json`.text()))
          const variables = stepEnv(settings, Option.getOrElse(Option.fromNullishOr(env.PATH), () => ""))
          const passed = ["--skip-build", "--no-upstream"].filter((flag) => args.has(flag))
          return yield* Effect.promise(() =>
            installByHand({
              checkout: settings.checkout,
              commit: head,
              version: versionOf(cli.version, forkCommit, head),
              trees: treeOptions(settings, variables, home, process.pid),
              record: settings.record,
              stage: (tree) =>
                $`${[...treeStageCommand(settings, tree, forkCommit, head), ...passed]}`
                  .cwd(join(tree, "opencode"))
                  .env(environment(variables))
                  .then(() => undefined),
              settings: () => settingsByHand(home),
              // The restart's line is said where it runs: the no-op (the build installed and proven) restarts nothing.
              handoff: (tree) =>
                Effect.runPromise(
                  Effect.sync(() => restartThroughHandoff(settings, "daily by hand", treeProgram(tree))).pipe(
                    Effect.tap((code) => Effect.sync(() => log(`restart: the update's handoff exited ${code} (0 only for a proven build); its lines are in ${settings.state}/update.log`))),
                  ),
                ),
              log: log,
            }),
          )
        }),
      )
      process.exit(code)
    }

    // Step 2, from the build's tree: no fork link, no install and no upstream merge (the post-land step merges upstream).
    log("upstream: skipped (a stage from a build's tree; the post-land step merges upstream)")
    // The target's fork commit, in a worktree of its own pinned there, never prime-look's HEAD, which a land's
    // post-land merge moves. The binary must name the commits it was built from (mods/update/process/pin.ts):
    // the version names the dotfiles commit too (pin.ts `versionOf`), so each update is a new version that
    // every open TUI moves onto. `--skip-build` reuses the last binary only when it names the same pair.
    const dotfiles = dotfilesTarget[0] ?? headOf(settings.checkout)
    const build = releaseBuild(process.execPath, `cli-${process.platform}-${process.arch}`, {}, args.has("--skip-build"))
    const { commit: builtCommit, version, binary: built, reported } = await runDailyBuild({ fork, tree: join(state, "fork-build"), commit: forkTarget, dotfiles, bun: process.execPath, build, log })

    // The tree was made under the version the update read for this target: a build of another stops here, staging nothing.
    refuse(builtForTree(from, version))

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
    const reading = upstreamReading(fork, join(state, "upstream-conflict.md"), !args.has("--no-upstream"))
    if (reading === undefined) rmSync(upstreamFile(home, env.XDG_STATE_HOME), { force: true })
    else writeJson(upstreamFile(home, env.XDG_STATE_HOME), reading)
    log(reading === undefined ? "upstream: no upstream/dev to count against" : `upstream: ${reading.commits} commits past this build${reading.blocked ? ", merge blocked" : ""}`)

    log(`opencode -> ${binary} (${reported})`)
    // The settings this build carries, from its tree's overlay beside this `opencode/` (`treeSettings`).
    const overlay = join(ROOT, "../config/opencode.json")
    for (const line of roleLines(existsSync(overlay) ? readFileSync(overlay, "utf8") : "")) log(line)
    log(STAGED_LINE)
  }
}
