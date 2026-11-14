// `bun run daily`: makes the fork, with these mods loaded, the `opencode` a new terminal runs.
//
// 0. Fast-forwards the fork checkout's prime-look to origin/prime-look (`--fork-target <sha>`: to the
//    update's verified fork commit, mods/update) from another checkout; a branch with commits origin lacks, or uncommitted tracked changes, is left
//    as it is and said so (scripts/upstream.ts `syncFork`). Then, on the Mac, which owns the fork, merges upstream OpenCode into prime-look first, in a
//    worktree of its own, and lands it only when the merge is clean and its checks pass
//    (scripts/upstream.ts); a conflict or a red check leaves prime-look as it was, writes
//    `~/.local/state/opencode-daily/upstream-conflict.md` and the install goes on. `--no-upstream`
//    skips it; `--dry-run` fetches, says what it would merge and stops before anything else.
// 1. Builds the fork in `OPENCODE_DEV` (default: the prime-look Rift) as a release binary
//    (channel `latest`, version `<base>-prime.<commit>`), so it shares the installed OpenCode's
//    database and background service; a version change restarts that service as ours. With
//    `--fork-target <sha>` it builds exactly that commit, in a detached worktree of the fork
//    pinned there (`~/.local/state/opencode-daily/fork-build`), never prime-look's HEAD, which
//    a land's post-land merge moves. A binary whose version names another commit stops daily, and the
//    record names the commit built (mods/update/process/pin.ts). `--skip-build` reuses the last build.
// 2. Copies it to `~/.local/share/opencode-prime/` and writes `~/.local/bin/opencode`, a launcher
//    that runs it without the caller's Anthropic routing and, after a service start or restart,
//    loads the resident location so the server plugins run with no client (`launcher`,
//    `residentDir`). `~/.local/bin` comes before `~/.bun/bin` on PATH; `opencode2` stays the
//    stock release.
// 3. Merges our entries into `~/.config/opencode/opencode.json` (server plugins, the role
//    agents' models, no auto-update) and `cli.json` (TUI plugins, the Prime theme), keeping
//    every other key and plugin. Paths are this checkout's, so nothing machine-specific is
//    committed.
// 4. Writes upstream/dev's lead for the TUI's corner (`upstreamReading`), then restarts the service
//    through the update's handoff (mods/update: health check, reinstall, rollback). `--stage` (the
//    update plugin's build ahead) restarts nothing: the plugin does, once every root session is idle.
import { $ } from "bun"
import { Effect } from "effect"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join, resolve } from "node:path"
import { anthropicAuthPlugin } from "../testbeds/anthropic-auth.ts"
import { type Catalog, DEFAULT_FORK, loadCatalog, loginStoreDir, newestRelease } from "../testbeds/gamut/gamut.ts"
import { readyFork } from "./fork.ts"
import { upstreamFile } from "../mods/prime/update.ts"
import { hostLocks } from "../mods/rift/process/landing.ts"
import { MergeDriverError, registerMergeDriver } from "./merge-driver.ts"
import { forkChecks, mergeUpstream, type SyncOutcome, syncFork, upstreamReading, withUpstreamLock } from "./upstream.ts"
import { flagValue, headOf, restartThroughHandoff, settingsFor, updateEntry } from "../mods/update/process/install.ts"
import { buildsLock, shareDir } from "../mods/update/settings.ts"
import { stageBuild } from "../mods/update/filestore/stage.ts"
import { releaseBuild, runDailyBuild } from "../mods/update/process/pin.ts"

const MODS = resolve(import.meta.dir, "../mods")
const CMD = resolve(import.meta.dir, "../cmd")

/** The directory OpenCode loads a plugin from: its `cmd/` package once it has one, else its mod. */
export const pluginDir = (name: string): string => (existsSync(join(CMD, name, "package.json")) ? join(CMD, name) : join(MODS, name))
const THEME = resolve(import.meta.dir, "../themes/prime.json")

type PluginEntry = string | { readonly package: string; readonly options?: Record<string, unknown> }
type Json = Record<string, unknown>

/** Turns off the fork's built-in /btw (`opencode.btw`), so /btw is the btw mod's (cmd/btw). */
export const BUILTIN_BTW_OFF = "-opencode.btw"

/**
 * Turns off the fork's built-in schedule plugin (`opencode.tool.schedule`): its schedule tools and
 * its `/schedule` command, which tells the model to call them. The wake plugin's tools replace
 * them (the README's OpenCode's schedules are off); a plugin can take a tool out of the registry
 * but not a command, so the plugin goes whole. Stored schedules and their API are the host's own.
 */
export const BUILTIN_SCHEDULE_OFF = "-opencode.tool.schedule"

const packageOf = (entry: unknown): string | undefined =>
  typeof entry === "string" ? entry : typeof entry === "object" && entry !== null && "package" in entry ? String(entry.package) : undefined

/**
 * `~/.local/bin/opencode`: runs `binary` without the caller's Anthropic routing. The pool picks
 * the account for OpenCode's Claude requests, but the Anthropic auth plugin sends them to
 * `ANTHROPIC_BASE_URL` when it is set, and a Claude Code session on TeamClaude sets it to the
 * proxy. The background service inherits the environment of the client that starts it, so the
 * variables are dropped at every launch, not only when `daily` restarts the service.
 */
export const launcher = (binary: string, resident: string): string => {
  const quoted = `'${binary.replaceAll("'", `'\\''`)}'`
  const header = `'x-opencode-directory:${encodeURIComponent(resident).replaceAll("'", "%27")}'`
  return [
    "#!/bin/sh",
    "# Written by `bun run daily` (dotfiles/opencode/scripts/daily.ts).",
    "unset ANTHROPIC_BASE_URL ANTHROPIC_INSECURE",
    "# A started service loads the server plugins in its resident location (`residentConfig`).",
    'case "$1 $2" in',
    '"service start" | "service restart")',
    `  ${quoted} "$@" || exit`,
    `  ${quoted} api GET /api/location -H ${header} >/dev/null || echo "opencode: the service did not load its resident location; its plugins wait for a client" >&2`,
    "  exit 0",
    "  ;;",
    "esac",
    `exec ${quoted} "$@"`,
    "",
  ].join("\n")
}

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

/**
 * The global server config with ours merged in: our plugins (any entry from `owned` dirs, or an
 * earlier copy of one that names no directory, such as `-opencode.tool.schedule`, is replaced,
 * every other entry kept, ours first so the auth plugin precedes the pool), each
 * role's model (its other fields kept), background compaction on (the other `experimental`
 * settings kept), and auto-update off so the stock release never replaces the fork.
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
    return path === undefined || (!ours.includes(path) && !owned.some((dir) => path === dir || path.startsWith(`${dir}/`)))
  })
  const agents = (typeof existing.agents === "object" && existing.agents !== null ? existing.agents : {}) as Record<string, Json>
  const providers = record(existing.providers)
  const anthropic = record(providers.anthropic)
  const settings = record(anthropic.settings)
  return {
    ...existing,
    autoupdate: false,
    // Claude's prompt cache lives an hour instead of Anthropic's 5-minute default, so a pause for a
    // review or a long tool call doesn't rewrite the whole context; a 1h write costs 2x input, not 1.25x.
    providers: { ...providers, anthropic: { ...anthropic, settings: { ...settings, cache: { ...record(settings.cache), ttl: CLAUDE_CACHE_TTL } } } },
    // Background compaction (the fork's `background_compaction` flag, off in a released build): as a session nears
    // its compaction ceiling, the summary is written from the warm cache in the background and held, so the
    // automatic or idle compaction that follows swaps it in at once instead of waiting on a summary request.
    experimental: { ...record(existing.experimental), background_compaction: true },
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
const writeJson = (path: string, value: Json) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/**
 * The plugin directories daily owns in a host's configs: this checkout's `mods/` and `cmd/`, and the
 * loader directory earlier runs loaded the auth plugin through. Any entry under one that the current
 * lists leave out (a deleted plugin, such as the web plugin) is dropped.
 */
export const ownedDirs = (share: string): ReadonlyArray<string> => [MODS, CMD, join(share, "anthropic-auth")]

/**
 * Merges ours into the host's server and TUI configs in `config`. Every run writes them, a stage
 * (`--stage`, the update's build ahead) too, so the service the handoff restarts reads only plugins
 * the advanced checkout has.
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

if (import.meta.main) {
  const home = homedir()
  const args = new Set(process.argv)
  // From the update plugin (mods/update): the verified target's fork commit, built instead of origin's prime-look.
  const forkTarget = flagValue([...args], "--fork-target")
  const env = process.env
  const checked = readyFork(env.OPENCODE_DEV || DEFAULT_FORK)
  if ("problem" in checked) throw new Error(checked.problem)
  const fork = checked.fork
  const cli = join(fork, "packages/cli")
  if (!existsSync(join(cli, "script/build.ts"))) throw new Error(`no OpenCode checkout at ${fork}: expected packages/cli/script/build.ts; set OPENCODE_DEV`)
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
  const linkFork = () => $`bun ${join(import.meta.dir, "link-fork.ts")}`.env({ ...env, OPENCODE_DEV: fork }).quiet()
  await linkFork()
  await installDotfiles(DOTFILES, Effect.promise(() => $`bun install --frozen-lockfile`.cwd(resolve(MODS, "..")).quiet()))
  await linkFork()

  // After the links, since the merge's acceptance tests load the mods through them.
  // Under the lock a land's post-land step (scripts/post-land.ts) merges under too.
  const outcome = (await withUpstreamLock(state, () => upstream(false))) ?? { kind: "skipped" as const, reason: "a land's post-land step is merging upstream now" }
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
  const build = releaseBuild(process.execPath, `cli-${process.platform}-${process.arch}`, {}, args.has("--skip-build"))
  const { commit: builtCommit, version, binary: built, reported } = await runDailyBuild({ fork, tree: join(state, "fork-build"), commit: forkTarget, bun: process.execPath, build, log: console.log })

  const share = shareDir(home)
  const record = installedFile(home)
  const checkout = dirname(dirname(MODS))
  // Under the builds lock, from the copy through the staged record (mods/update/filestore/stage.ts).
  const binary = stageBuild({ built, share, version, record, lock: buildsLock(home), dotfiles: headOf(checkout), fork: builtCommit, pid: process.pid })
  const link = join(home, ".local/bin/opencode")
  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { force: true })
  writeJson(join(residentDir(home), "opencode.json"), residentConfig)
  writeFileSync(link, launcher(binary, residentDir(home)), { mode: 0o755 })

  const settings = settingsFor({ host: hostname(), home, state: dirname(dirname(record)), checkout, fork, bun: process.execPath, resident: residentDir(home), launcher: link })
  const auth = anthropicAuthPlugin
  const store = loginStoreDir(home)
  const pool = pluginDir("pool")
  const catalog = await loadCatalog(fork)
  const planner = plannerModel(catalog)
  const server: PluginEntry[] = [
    auth,
    poolEntry(pool, existsSync(store) ? store : undefined, { host: hostname() }),
    orchestrateEntry(pluginDir("orchestrate"), { dotfiles: checkout, fork }, planner),
    pluginDir("guard"),
    pluginDir("kernel"),
    pluginDir("status"),
    pluginDir("queue"),
    pluginDir("git"),
    pluginDir("idle-compact"),
    mailEntry(pluginDir("mail"), { host: hostname(), tailscale: await tailscaleAddress() }),
    pluginDir("questions"),
    pluginDir("wake"),
    pluginDir("skills"),
    pluginDir("rift"),
    pluginDir("tool-names"),
    pluginDir("cache"),
    pluginDir("memory"),
    pluginDir("stall"),
    pluginDir("escape"),
    updateEntry(pluginDir("update"), settings),
    BUILTIN_SCHEDULE_OFF,
  ]
  // Earlier runs loaded the auth plugin through a loader directory here; its entry is replaced too.
  const loader = join(share, "anthropic-auth")
  rmSync(loader, { recursive: true, force: true })
  const config = join(home, ".config/opencode")
  const models = roleModels(catalog)
  const tui = [pluginDir("prime"), pluginDir("status"), pluginDir("herdr"), pluginDir("git"), pluginDir("cache"), pluginDir("questions"), pluginDir("btw"), pluginDir("skills"), pluginDir("recover"), pluginDir("orchestrate"), pluginDir("escape"), BUILTIN_BTW_OFF]
  writeConfigs({ config, server, cli: tui, models, owned: ownedDirs(share) })
  mkdirSync(join(config, "themes"), { recursive: true })
  copyFileSync(THEME, join(config, "themes/prime.json"))

  // Upstream against this build, for the TUI's corner (mods/prime/update.ts), written before the
  // restart that makes every open TUI reconnect and read it again.
  const reading = upstreamReading(fork, join(state, "upstream-conflict.md"), outcome.kind === "skipped" && !args.has("--no-upstream"))
  if (reading === undefined) rmSync(upstreamFile(home, env.XDG_STATE_HOME), { force: true })
  else writeJson(upstreamFile(home, env.XDG_STATE_HOME), reading)
  console.log(reading === undefined ? "upstream: no upstream/dev to count against" : `upstream: ${reading.commits} commits past this build${reading.blocked ? ", merge blocked" : ""}`)

  console.log(`opencode -> ${binary} (${reported})`)
  console.log(`server plugins: ${server.map(packageOf).join(", ")}`)
  console.log(`roles: ${Object.entries(models).map(([role, model]) => `${role} ${model}`).join(", ")}`)
  console.log(planner === undefined ? "planner first: none (no Fable in the catalog), so Opus" : `planner first: ${planner}, then Opus, then Codex when the pool holds it`)
  if (args.has("--stage")) console.log("staged: the update plugin restarts the service once every root session is idle")
  else {
    const code = restartThroughHandoff(settings, "daily by hand")
    console.log(`restart: the update's handoff exited ${code} (0 only for a proven build); its lines are in ${settings.state}/update.log`)
    process.exitCode = code
  }
}
