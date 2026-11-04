#!/usr/bin/env bun
/**
 * One-command live testbed for OpenCode with our plugins.
 *
 *   bun run gamut up <preset> [--prompt <file|text>] [--installed] [--no-build]
 *   bun run gamut send "<text>"
 *   bun run gamut keys <name…>
 *   bun run gamut interrupt
 *   bun run gamut read [--full]
 *   bun run gamut wait [seconds]
 *   bun run gamut status
 *   bun run gamut restart
 *   bun run gamut down
 *   bun run gamut list
 *   bun run gamut login anthropic
 *
 * `up` copies `fixture/` (the ledgerline app in its red state) to a fresh
 * scratch directory, writes the preset's models into its `opencode.json`
 * (with the Anthropic auth plugin and the account pool for a Claude preset),
 * loads the TUI plugins of `mods/` (Prime first) through the run's
 * `cli.json`, and launches
 * OpenCode on a pty that a detached terminal host keeps (`pty-host.ts`). It
 * runs the fork from source in `OPENCODE_DEV` (default: the prime-look Rift
 * beside this checkout), or the installed `opencode2` with `--installed`.
 * Every later subcommand reaches the TUI through the host's socket and reads
 * the run's own database. Run state stays in the scratch directory.
 *
 * A plain Bun script, a driver for a terminal program. Its pure parts are
 * covered by `tests/gamut.test.ts`.
 *
 * @module
 */

import { $ } from "bun"
import { Database } from "bun:sqlite"
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { GentSource } from "../../mods/pool/src/gent.ts"
import { anthropicAuthPlugin, poolPlugin } from "../anthropic-auth.ts"
import { type HostConfig, type HostScreen, hostCall, isKeyName, keys } from "./pty-host.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECKOUT = resolve(HERE, "../..")
const FIXTURE = join(HERE, "fixture")
const PLUGINS = join(CHECKOUT, "mods")
const THEME = join(CHECKOUT, "themes/prime.json")
/** The host's entry; `isHost` also finds a run's host by it in `ps`. */
const HOST_ENTRY = join(HERE, "pty-host.ts")
const SIM_ENTRY = join(HERE, "sim-model.ts")
/** The fork `up` runs when `OPENCODE_DEV` is unset: the prime-look Rift beside this checkout. */
export const DEFAULT_FORK = resolve(CHECKOUT, "../.rifts/opencode/prime-look")
/** The owner's OpenCode, where the logins live; `--installed` runs it too. */
const OWNER_OPENCODE = "opencode2"

// ── Presets ─────────────────────────────────────────────────────────────

export type Role = "orchestrator" | "worker" | "reviewer"

export const ROLES: ReadonlyArray<Role> = ["orchestrator", "worker", "reviewer"]

/**
 * One model choice. `model` is a family (`opencode-go/glm`, resolved to its
 * newest release) or a `provider/model` id; `effort` is the variant to run
 * it at, when the model has variants.
 */
export interface Slot {
  readonly model: string
  readonly effort?: string
}

/**
 * A preset pins the three roles. The orchestrator is OpenCode's `build` agent
 * (and `plan`, `compaction`), the worker the `general` and `explore`
 * subagents, the reviewer a `reviewer` subagent the run's config adds.
 */
export interface Preset {
  readonly about: string
  readonly roles: Readonly<Record<Role, Slot>>
  /**
   * Where the Claude logins come from: the owner's `opencode2`, copied into
   * the run (the default), or `gent`: the accounts gent holds, which the pool
   * reads and refreshes in place in gent's store (`gentAuthDir`), never
   * copied.
   */
  readonly claudeLogins?: "gent"
}

/**
 * The model families a preset may name instead of a release: the provider
 * and the catalog `family` of each. `up` and `list` resolve each to the
 * family's newest release, so a preset never pins a release a newer one
 * replaced.
 */
export const FAMILIES: Readonly<Record<string, { readonly provider: string; readonly family: string }>> = {
  "opencode-go/glm": { provider: "opencode-go", family: "glm" },
  "opencode-go/deepseek-flash": { provider: "opencode-go", family: "deepseek-flash" },
  "anthropic/claude-haiku": { provider: "anthropic", family: "claude-haiku" },
}

/** The provider gamut serves itself (`sim-model.ts`): no credential, no network. */
export const SIM_PROVIDER = "sim"
const SIM_MODEL = "sim/sim-model"

const every = (slot: Slot): Readonly<Record<Role, Slot>> => ({ orchestrator: slot, worker: slot, reviewer: slot })

export const PRESETS: Readonly<Record<string, Preset>> = {
  sim: {
    about: "the scripted local model in every role: no network, no credential",
    roles: every({ model: SIM_MODEL }),
  },
  deepseek: {
    about: "DeepSeek flash in every role on the OpenCode Go plan: the cheapest live run",
    roles: every({ model: "opencode-go/deepseek-flash", effort: "high" }),
  },
  "glm-deepseek": {
    about: "GLM orchestrates and reviews, DeepSeek flash implements, both on the OpenCode Go plan",
    roles: {
      orchestrator: { model: "opencode-go/glm", effort: "high" },
      worker: { model: "opencode-go/deepseek-flash", effort: "high" },
      reviewer: { model: "opencode-go/glm", effort: "high" },
    },
  },
  haiku: {
    about:
      "the newest Claude Haiku in every role on the Claude subscription, through the Anthropic auth plugin and the account pool",
    roles: every({ model: "anthropic/claude-haiku", effort: "high" }),
  },
  "haiku-gent": {
    about:
      "the newest Claude Haiku in every role on the Claude accounts gent holds, which the pool reads and refreshes in gent's own store",
    roles: every({ model: "anthropic/claude-haiku", effort: "high" }),
    claudeLogins: "gent",
  },
}

/** The provider whose subscription logins the account pool shares out. */
export const POOLED_PROVIDER = "anthropic"

/** A slot with its family resolved: the provider, the model id and the variant. */
export interface ResolvedSlot {
  readonly provider: string
  readonly model: string
  readonly variant?: string
}

export type ResolvedPreset = Readonly<Record<Role, ResolvedSlot>>

/** A catalog body: provider → its models, as models.dev and OpenCode's snapshot write them. */
export type Catalog = Readonly<
  Record<
    string,
    {
      readonly models: Readonly<
        Record<
          string,
          {
            readonly family?: string
            readonly release_date?: string
            readonly status?: string
            readonly capabilities?: { readonly reasoning?: { readonly effort?: ReadonlyArray<string> } }
          }
        >
      >
    }
  >
>

/** The newest release of `family` on `provider` that is not deprecated, by release date. */
export const newestRelease = (catalog: Catalog, provider: string, family: string): string | undefined =>
  Object.entries(catalog[provider]?.models ?? {})
    .filter(([, model]) => model.family === family && model.status !== "deprecated")
    .sort(([idA, a], [idB, b]) => (b.release_date ?? "").localeCompare(a.release_date ?? "") || idB.localeCompare(idA))
    .at(0)?.[0]

/**
 * The preset with each family resolved to its newest release. A family with
 * no release, or an effort the release does not offer, stops the run: a
 * guessed id would fail inside the TUI instead.
 */
export const resolvePreset = (preset: Preset, catalog: Catalog): ResolvedPreset => {
  const resolveSlot = (slot: Slot): ResolvedSlot => {
    const family = FAMILIES[slot.model]
    if (family === undefined) {
      const [provider, ...rest] = slot.model.split("/")
      if (provider === undefined || rest.length === 0) throw new Error(`${slot.model} is not provider/model`)
      return { provider, model: rest.join("/"), ...(slot.effort === undefined ? {} : { variant: slot.effort }) }
    }
    const model = newestRelease(catalog, family.provider, family.family)
    if (model === undefined) throw new Error(`no ${slot.model} release in the model catalog`)
    const efforts = catalog[family.provider]?.models[model]?.capabilities?.reasoning?.effort ?? []
    if (slot.effort !== undefined && !efforts.includes(slot.effort)) {
      throw new Error(`${family.provider}/${model} has no ${slot.effort} effort (it has ${efforts.join(", ") || "none"})`)
    }
    return { provider: family.provider, model, ...(slot.effort === undefined ? {} : { variant: slot.effort }) }
  }
  return {
    orchestrator: resolveSlot(preset.roles.orchestrator),
    worker: resolveSlot(preset.roles.worker),
    reviewer: resolveSlot(preset.roles.reviewer),
  }
}

/** Whether resolving `preset` reads the catalog: it names a family. */
export const namesFamily = (preset: Preset): boolean => ROLES.some((role) => FAMILIES[preset.roles[role].model])

/** OpenCode's model selection for a slot: `provider/model#variant`. */
export const selection = (slot: ResolvedSlot, withVariant = true): string =>
  `${slot.provider}/${slot.model}${withVariant && slot.variant !== undefined ? `#${slot.variant}` : ""}`

/** The providers a run needs a login for, each once: every provider but gamut's own. */
export const providersNeeded = (preset: ResolvedPreset): ReadonlyArray<string> => [
  ...new Set(ROLES.map((role) => preset[role].provider).filter((provider) => provider !== SIM_PROVIDER)),
]

/** The providers whose logins `up` copies from the owner's `opencode2`: all but those another store keeps. */
export const loginsToCopy = (named: Preset, preset: ResolvedPreset): ReadonlyArray<string> =>
  providersNeeded(preset).filter((provider) => !(named.claudeLogins === "gent" && provider === POOLED_PROVIDER))

/** gent's credential store: `GAMUT_GENT_AUTH`, else `~/.gent/auth` of the caller's home (the run has its own). */
export const gentAuthDir = (env: Readonly<Record<string, string | undefined>> = process.env): string =>
  resolve(env.GAMUT_GENT_AUTH || join(homedir(), ".gent/auth"))

export const usesSim = (preset: ResolvedPreset): boolean =>
  ROLES.some((role) => preset[role].provider === SIM_PROVIDER)

const CATALOG_URL = "https://models.opencode.ai/experimental/v2.0/api.json?type=chat"

/**
 * The model catalog OpenCode itself reads. Offline, the snapshot the fork
 * ships (`packages/core/src/models-dev/snapshot.txt`), which has the same shape.
 */
const loadCatalog = async (fork: string | undefined): Promise<Catalog> => {
  try {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`${CATALOG_URL} answered ${response.status}`)
    return (await response.json()) as Catalog
  } catch (error) {
    const snapshot = fork === undefined ? undefined : join(fork, "packages/core/src/models-dev/snapshot.txt")
    if (snapshot === undefined || !existsSync(snapshot)) throw error
    console.log(`model catalog unreachable (${String(error)}); using ${snapshot}`)
    return (await Bun.file(snapshot).json()) as Catalog
  }
}

// ── Config writers ──────────────────────────────────────────────────────

/** A permission rule, as OpenCode's config writes it. */
interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

/** The reviewer reads and runs commands; it never edits or delegates. */
const REVIEWER_PERMISSIONS: ReadonlyArray<Rule> = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "shell", resource: "*", effect: "allow" },
  { action: "subagent", resource: "*", effect: "deny" },
]

const REVIEWER_SYSTEM =
  "You review a change for another agent. Read the diff and the files it touches, run the named test " +
  "command, and report what is wrong: correctness first, then scope. Do not edit files."

/** The sim provider's entry: an OpenAI-compatible endpoint on the run's own port. */
export const simProvider = (port: number) => ({
  name: "Sim",
  package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "sim-key" },
  models: {
    "sim-model": {
      name: "Sim",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 128000, output: 16000 },
    },
  },
})

/** Whether a run on `preset` signs in to the Claude subscription, so loads the auth plugin and the pool. */
export const usesPool = (preset: ResolvedPreset): boolean =>
  ROLES.some((role) => preset[role].provider === POOLED_PROVIDER)

/** A config `plugins` entry: a path, or a path with the plugin's options. */
export type PluginEntry = string | { readonly package: string; readonly options: Record<string, unknown> }

/**
 * The server plugins a run on the Claude subscription loads, in this order:
 * the Anthropic auth plugin (`authPlugin`, its loader directory), then the
 * pool, which chooses the login each request goes out on. With `gentStore`
 * the pool also takes the Claude accounts gent holds there.
 */
export const serverPlugins = (
  preset: ResolvedPreset,
  authPlugin: string,
  gentStore?: string,
): ReadonlyArray<PluginEntry> => {
  if (!usesPool(preset)) return []
  if (gentStore === undefined) return [authPlugin, poolPlugin]
  return [authPlugin, { package: poolPlugin, options: { sources: [{ kind: "gent", dir: gentStore }] } }]
}

/** The Claude accounts gent holds at `dir`, by label; fails when it holds none the pool can use. */
export const gentAccounts = (dir: string): ReadonlyArray<string> => {
  const listing = new GentSource({ dir }).list()
  if (listing.accounts.length === 0) {
    const skipped = listing.skipped.map((each) => `${each.label}: ${each.reason}`).join("; ")
    throw new Error(`gent holds no Claude account the pool can use at ${dir}${skipped === "" ? "" : ` (${skipped})`}; sign in to one in gent`)
  }
  return listing.accounts.map((id) => id.slice("gent:".length))
}

/**
 * The run's `opencode.json`: the orchestrator as the default model and as
 * `build`, `plan` and `compaction`; the worker as `general` and `explore`
 * (and, without its variant, the `title` and `summary` helpers); and a
 * `reviewer` subagent on the reviewer's model. Agent entries merge into
 * OpenCode's own, so the built-in prompts and permissions stay. Server
 * plugins load from here; the TUI plugins load from `cli.json`.
 */
export const projectConfig = (preset: ResolvedPreset, simPort?: number, plugins: ReadonlyArray<PluginEntry> = []) => {
  if (usesSim(preset) && simPort === undefined) throw new Error("a sim preset needs the sim model's port")
  const orchestrator = { model: selection(preset.orchestrator) }
  const worker = { model: selection(preset.worker) }
  const helper = { model: selection(preset.worker, false) }
  return {
    model: selection(preset.orchestrator),
    ...(plugins.length === 0 ? {} : { plugins }),
    ...(simPort === undefined ? {} : { providers: { [SIM_PROVIDER]: simProvider(simPort) } }),
    agents: {
      build: orchestrator,
      plan: orchestrator,
      compaction: orchestrator,
      general: worker,
      explore: worker,
      worker,
      implementor: worker,
      planner: orchestrator,
      verifier: { model: selection(preset.reviewer) },
      title: helper,
      summary: helper,
      reviewer: {
        model: selection(preset.reviewer),
        description: "Reviews a diff for correctness and scope. Reads and runs commands; never edits.",
        mode: "subagent",
        system: REVIEWER_SYSTEM,
        permissions: REVIEWER_PERMISSIONS,
      },
    },
  }
}

/** Whether the package in `dir` has a TUI entry: its `package.json` exports `./tui`. */
const exportsTui = (dir: string): boolean => {
  const manifest = join(dir, "package.json")
  if (!existsSync(manifest)) return false
  try {
    const { exports } = JSON.parse(readFileSync(manifest, "utf8")) as { exports?: unknown }
    return typeof exports === "object" && exports !== null && "./tui" in exports
  } catch {
    return false
  }
}

/**
 * Our TUI plugins, by absolute path, Prime first: each directory of
 * `mods/` whose `package.json` exports `./tui`. A server-only plugin (the
 * pool) is left out; `serverPlugins` adds it to the project config instead.
 */
export const pluginPaths = (pluginsDir: string): ReadonlyArray<string> =>
  readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && exportsTui(join(pluginsDir, entry.name)))
    .map((entry) => entry.name)
    .sort((a, b) => Number(b === "prime") - Number(a === "prime") || a.localeCompare(b))
    .map((name) => join(pluginsDir, name))

/**
 * The run's `cli.json` in `OPENCODE_CONFIG_DIR`: the TUI plugins and the
 * Prime theme. OpenCode loads TUI plugins from this file, not from the
 * project's `opencode.json` (measured: a project `plugins` entry left the
 * stock look).
 */
export const cliConfig = (plugins: ReadonlyArray<string>) => ({
  plugins,
  theme: { name: "prime", mode: "dark" },
})

const ROSTER_START = "<!-- roster -->"
const ROSTER_END = "<!-- /roster -->"

/** The roster block for a resolved preset, markers included. */
export const rosterBlock = (preset: ResolvedPreset): string =>
  [
    ROSTER_START,
    `- Orchestrator: the \`build\` agent, on \`${selection(preset.orchestrator)}\`.`,
    `- Worker (fix or feature): \`agent: "general"\`, pinned in \`opencode.json\` to \`${selection(preset.worker)}\`.`,
    `- Reviewer (second opinion on a diff): \`agent: "reviewer"\`, pinned to \`${selection(preset.reviewer)}\`.`,
    ROSTER_END,
  ].join("\n")

/**
 * Replace the roster block in an `AGENTS.md` body. The markers are the
 * contract: the text outside them survives every preset.
 */
export const rewriteRoster = (agentsMd: string, preset: ResolvedPreset): string => {
  const start = agentsMd.indexOf(ROSTER_START)
  const end = agentsMd.indexOf(ROSTER_END)
  if (start < 0 || end < 0) throw new Error("AGENTS.md has no roster block")
  return agentsMd.slice(0, start) + rosterBlock(preset) + agentsMd.slice(end + ROSTER_END.length)
}

// ── Launch and environment ──────────────────────────────────────────────

/** How to start OpenCode: the command before its own flags, and what it adds to the environment. */
export interface Launch {
  readonly kind: "fork" | "installed"
  readonly base: readonly [string, ...string[]]
  readonly env: Readonly<Record<string, string>>
  /** The fork's checkout, for the offline catalog. */
  readonly fork?: string
}

/**
 * The fork, from source: Bun runs its CLI entry with the TUI's JSX preload,
 * so a source edit shows on the next `up` and there is nothing to build.
 */
export const forkLaunch = (fork: string, bun: string): Launch => ({
  kind: "fork",
  base: [bun, join(fork, "packages/cli/src/index.ts")],
  env: {
    BUN_OPTIONS: `--conditions=browser --preload=${join(fork, "packages/tui/node_modules/@opentui/solid/scripts/preload.js")}`,
  },
  fork,
})

const resolveLaunch = (installed: boolean, callerEnv: Readonly<Record<string, string | undefined>>): Launch => {
  if (installed) {
    const bin = Bun.which(OWNER_OPENCODE)
    if (bin === null) throw new Error(`no ${OWNER_OPENCODE} on PATH for --installed`)
    return { kind: "installed", base: [bin], env: {} }
  }
  const fork = resolve(callerEnv.OPENCODE_DEV || DEFAULT_FORK)
  const launch = forkLaunch(fork, process.execPath)
  if (!existsSync(launch.base[1] ?? "")) {
    throw new Error(`no OpenCode checkout at ${fork}: set OPENCODE_DEV to one, or pass --installed`)
  }
  const preload = join(fork, "packages/tui/node_modules/@opentui/solid/scripts/preload.js")
  if (!existsSync(preload)) throw new Error(`${fork} has no TUI preload (${preload}): run bun install there`)
  return launch
}

/** The caller's terminal basics: the only caller variables OpenCode sees besides the proxy ones. */
export const TERMINAL_VARIABLES = ["PATH", "SHELL", "USER", "LOGNAME", "TMPDIR", "LANG"] as const

/**
 * Network proxy settings. `ANTHROPIC_BASE_URL` is not one of them: the
 * owner's points at a local proxy that pools Claude accounts itself, and a
 * run's Claude traffic goes straight to Anthropic so the pool's choice of
 * login is the one that counts.
 */
export const PROXY_VARIABLES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
] as const

/** Where a run keeps its parts, under its scratch root. */
export interface RunPaths {
  readonly root: string
  readonly work: string
  readonly home: string
  readonly config: string
  readonly data: string
  readonly db: string
  readonly socket: string
}

export const runPaths = (root: string): RunPaths => ({
  root,
  work: join(root, "work"),
  home: join(root, "home"),
  config: join(root, "config"),
  data: join(root, "data"),
  db: join(root, "data/opencode.db"),
  socket: join(root, "host.sock"),
})

/**
 * OpenCode's whole environment: the caller's terminal basics and proxy
 * variables (an empty one reads as unset), a home of the run's own, its
 * database and config directory, and the launch's own additions. No other
 * caller variable reaches it, so no API key in the caller's shell does.
 */
export const runEnv = (
  caller: Readonly<Record<string, string | undefined>>,
  paths: RunPaths,
  launch: Launch,
  offline: boolean,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const name of [...TERMINAL_VARIABLES, ...PROXY_VARIABLES]) {
    const value = caller[name]
    if (value !== undefined && value !== "") env[name] = value
  }
  return {
    ...env,
    COLORTERM: "truecolor",
    HOME: paths.home,
    XDG_CONFIG_HOME: join(paths.home, ".config"),
    XDG_DATA_HOME: join(paths.home, ".local/share"),
    XDG_STATE_HOME: join(paths.home, ".local/state"),
    XDG_CACHE_HOME: join(paths.home, ".cache"),
    OPENCODE_DB: paths.db,
    OPENCODE_CONFIG_DIR: paths.config,
    ...(offline ? { OPENCODE_DISABLE_MODELS_FETCH: "1" } : {}),
    ...launch.env,
  }
}

// ── State file ──────────────────────────────────────────────────────────

/** What `up` records so every later subcommand can find the run. */
export interface GamutState {
  readonly checkout: string
  readonly root: string
  readonly hostPid: number
  readonly simPid?: number
  readonly base: readonly [string, ...string[]]
  readonly preset: string
  /**
   * `Date.now()` when the last message was typed. `wait` counts only a turn
   * after it, so the turn the previous prompt finished cannot pass for the
   * one just sent.
   */
  readonly sendMark: number
  /** Whether the last thing typed starts a turn; a slash command may start none. */
  readonly awaitsTurn: boolean
}

/**
 * The state file names the checkout, so two checkouts with other names run at
 * once; `readState` checks the canonical path too. `GAMUT_STATE` overrides it
 * (the e2e test runs beside a live run).
 */
export const stateFileFor = (checkoutRoot: string, override?: string): string =>
  override || join(tmpdir(), `opencode-gamut-${basename(checkoutRoot)}.json`)

const STATE_FILE = stateFileFor(CHECKOUT, process.env.GAMUT_STATE)

const writeState = (state: GamutState) => Bun.write(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)

const readState = async (): Promise<GamutState> => {
  const file = Bun.file(STATE_FILE)
  if (!(await file.exists())) {
    throw new Error(`no gamut run is up (${STATE_FILE} is missing). Run: bun run gamut up <preset>`)
  }
  const state = (await file.json()) as GamutState
  if (state.checkout !== realpathSync(CHECKOUT)) {
    throw new Error(`the gamut run belongs to another checkout (${state.checkout}); refusing ${STATE_FILE}`)
  }
  return state
}

// ── Arguments ───────────────────────────────────────────────────────────

export interface UpArgs {
  readonly preset: string
  readonly prompt: string | undefined
  readonly installed: boolean
  readonly build: boolean
}

/** The flags of `up` that take the next argument. Each is given at most once. */
const UP_VALUE_FLAGS = { "--prompt": "a file path or the prompt text" } as const
const UP_SWITCHES = ["--installed", "--no-build"] as const

export const parseUpArgs = (rest: ReadonlyArray<string>): UpArgs => {
  const values = new Map<string, string>()
  const taken = new Set<number>()
  for (const [flag, what] of Object.entries(UP_VALUE_FLAGS)) {
    const index = rest.indexOf(flag)
    if (index < 0) continue
    if (rest.lastIndexOf(flag) !== index) throw new Error(`${flag} is given more than once`)
    const value = rest[index + 1]
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value: ${what}`)
    values.set(flag, value)
    taken.add(index + 1)
  }
  const unknown = rest.filter(
    (arg, index) =>
      arg.startsWith("--") && !taken.has(index) && !(arg in UP_VALUE_FLAGS) && !UP_SWITCHES.some((s) => s === arg),
  )
  if (unknown.length > 0) throw new Error(`unknown flag ${unknown[0]}`)
  const positional = rest.filter((arg, index) => !arg.startsWith("--") && !taken.has(index))
  if (positional.length > 1) throw new Error(`up takes one preset, got ${positional.join(" ")}`)
  const preset = positional[0]
  if (preset === undefined) throw new Error(`up needs a preset: ${Object.keys(PRESETS).join(", ")}`)
  return {
    preset,
    prompt: values.get("--prompt"),
    installed: rest.includes("--installed"),
    build: !rest.includes("--no-build"),
  }
}

/** A positive whole count (seconds) from the command line; anything else is refused. */
export const parseCount = (name: string, value: string): number => {
  const count = Number(value)
  if (!/^\d+$/.test(value) || count <= 0) {
    throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(value)}`)
  }
  return count
}

/** Every key name is known before any is pressed. */
export const checkKeyNames = (names: ReadonlyArray<string>): void => {
  if (names.length === 0) throw new Error("keys needs at least one key name")
  const unknown = names.find((name) => !isKeyName(name))
  if (unknown !== undefined) throw new Error(`no key named ${unknown}; keys: ${Object.keys(keys).join(", ")}`)
}

/**
 * Written the way a person asks, not as a checklist: the run is meant to
 * exercise how the orchestrator plans and splits work on its own.
 */
export const DEFAULT_PROMPT =
  "Can you work through the open tasks in the README? AGENTS.md says how to " +
  "split them up. Run the tests and typecheck when you're done and tell me " +
  "how each one went."

/** `--prompt` takes a file path or the prompt text itself. */
const resolvePrompt = async (value: string): Promise<string> => {
  const file = Bun.file(value)
  if (await file.exists()) return (await file.text()).trim()
  return value
}

// ── Processes ───────────────────────────────────────────────────────────

/** The size the TUI draws at: wide enough that the status line keeps every item. */
const HOST_SIZE = { cols: 120, rows: 40 }

/** The one line to show for a failed command: its last non-empty stderr line, then stdout's. */
export const failureText = (stdout: string, stderr: string): string => {
  const lastLine = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1)
  return lastLine(stderr) ?? lastLine(stdout) ?? "no output"
}

/** Whether `pid` still runs `entry` with an argument under `root`: not a process that reused the id. */
const runsUnder = async (pid: number, entry: string, root: string): Promise<boolean> => {
  const ps = await $`ps -o command= -p ${pid}`.quiet().nothrow()
  const command = ps.stdout.toString()
  return ps.exitCode === 0 && command.includes(entry) && command.includes(root)
}

const isHost = (pid: number, root: string) => runsUnder(pid, HOST_ENTRY, join(root, "host.json"))
const isSim = (pid: number, root: string) => runsUnder(pid, SIM_ENTRY, join(root, "sim.port"))

const TIMED_OUT: unique symbol = Symbol("timed out")

/** `promise`, or `TIMED_OUT` once `ms` have passed. */
const within = async <A>(promise: Promise<A>, ms: number): Promise<A | typeof TIMED_OUT> => {
  // A cleared timer, so a call that answered leaves nothing to keep the process up.
  let timer: Timer | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms)))
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Call the run's host, for at most `ms`. A host that has stopped is named as
 * such, with the log that says why; any other failure keeps its own message.
 */
const callHost = async <A>(state: GamutState, call: (socket: string) => Promise<A>, ms = 30_000): Promise<A> => {
  const paths = runPaths(state.root)
  const log = join(state.root, "host.log")
  let failure: unknown
  const result = await within(
    call(paths.socket).catch((error: unknown) => {
      failure = error
      return TIMED_OUT
    }),
    ms,
  )
  if (result !== TIMED_OUT) return result as A
  if (!(await isHost(state.hostPid, state.root))) {
    throw new Error(`the run's terminal host has stopped (see ${log}); run: bun run gamut down`)
  }
  if (failure === undefined) throw new Error(`the run's terminal host did not answer within ${ms / 1000}s (see ${log})`)
  throw failure instanceof Error ? failure : new Error(String(failure))
}

/**
 * Start a detached Bun process that outlives this command, logging to
 * `log`, and wait until `ready` holds.
 */
const startDetached = async (
  what: string,
  argv: ReadonlyArray<string>,
  log: string,
  ready: () => boolean,
): Promise<number> => {
  const fd = openSync(log, "a")
  const child = Bun.spawn([process.execPath, ...argv], { stdio: ["ignore", fd, fd], detached: true })
  closeSync(fd)
  child.unref()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the ${what} exited ${child.exitCode}: ${failureText("", await Bun.file(log).text())}`)
    }
    if (ready()) return child.pid
    await Bun.sleep(100)
  }
  child.kill("SIGKILL")
  throw new Error(`the ${what} was not ready within 10s; see ${log}`)
}

/**
 * Start the terminal host and wait for its socket. The config holds
 * OpenCode's whole environment, proxy values included, so it is written
 * owner-only and the host removes it once read; none of it reaches a
 * process argument.
 */
const startHost = (root: string, config: HostConfig): Promise<number> => {
  const file = join(root, "host.json")
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
  return startDetached("terminal host", [HOST_ENTRY, file], join(root, "host.log"), () => existsSync(config.socket))
}

const startSim = async (root: string): Promise<{ pid: number; port: number }> => {
  const portFile = join(root, "sim.port")
  const pid = await startDetached("sim model", [SIM_ENTRY, portFile], join(root, "sim.log"), () =>
    existsSync(portFile),
  )
  return { pid, port: parseCount("sim port", (await Bun.file(portFile).text()).trim()) }
}

// ── Credentials ─────────────────────────────────────────────────────────

/** Which of `providers` have no stored login in the owner's OpenCode. */
const missingLogins = async (providers: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  if (providers.length === 0) return []
  const listed = await $`${OWNER_OPENCODE} auth list --format json`.quiet().nothrow()
  if (listed.exitCode !== 0) {
    throw new Error(`${OWNER_OPENCODE} auth list failed: ${failureText(listed.stdout.toString(), listed.stderr.toString())}`)
  }
  const integrations = JSON.parse(listed.stdout.toString()) as ReadonlyArray<{
    readonly id: string
    readonly connections?: ReadonlyArray<unknown>
  }>
  return providers.filter(
    (provider) => !integrations.some((each) => each.id === provider && (each.connections?.length ?? 0) > 0),
  )
}

/**
 * The exact step that stores a missing login. A Claude subscription login
 * needs the Anthropic auth plugin loaded, which the owner's own config does
 * not do: `gamut login` signs in with it.
 */
export const loginStep = (provider: string): string =>
  provider === POOLED_PROVIDER ? `bun run gamut login ${provider}` : `${OWNER_OPENCODE} auth login ${provider}`

/** `text` with every secret value replaced, for an error line that might echo one. */
export const redact = (text: string, secrets: ReadonlyArray<string>): string =>
  secrets.filter((secret) => secret.length >= 4).reduce((out, secret) => out.split(secret).join("<redacted>"), text)

/**
 * Copy the owner's login for each provider into the run's own database: the
 * owner's `auth export` piped into the run binary's `auth import` in the run's
 * environment. The credential passes through memory and stdin only, never an
 * argument, a file or a log line.
 */
const importCredentials = (
  providers: ReadonlyArray<string>,
  launch: Launch,
  env: Readonly<Record<string, string>>,
  cwd: string,
): void => {
  for (const provider of providers) {
    const exported = Bun.spawnSync([OWNER_OPENCODE, "auth", "export", provider, "--standalone"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (exported.exitCode !== 0) {
      throw new Error(`${OWNER_OPENCODE} auth export ${provider} exited ${exported.exitCode}`)
    }
    let credentials: ReadonlyArray<{ readonly value?: unknown }>
    try {
      credentials = JSON.parse(exported.stdout.toString()) as typeof credentials
    } catch {
      // A parse error quotes the text it choked on: say nothing of it.
      throw new Error(`${OWNER_OPENCODE} auth export ${provider} printed something other than JSON`)
    }
    if (credentials.length === 0) throw new Error(`no ${provider} login stored; run: ${loginStep(provider)}`)
    const secrets = credentials.flatMap((each) =>
      Object.values((each.value ?? {}) as Record<string, unknown>).filter(
        (value): value is string => typeof value === "string",
      ),
    )
    const imported = Bun.spawnSync([...launch.base, "auth", "import", "--standalone"], {
      stdin: exported.stdout,
      stdout: "pipe",
      stderr: "pipe",
      env,
      cwd,
    })
    if (imported.exitCode !== 0) {
      const said = redact(failureText(imported.stdout.toString(), imported.stderr.toString()), secrets)
      throw new Error(`importing the ${provider} login into the run failed (exit ${imported.exitCode}): ${said}`)
    }
    console.log(`login ${provider}: copied into the run (${credentials.length} credential)`)
  }
}

// ── up ──────────────────────────────────────────────────────────────────

const up = async (args: UpArgs) => {
  const named = PRESETS[args.preset]
  if (named === undefined) {
    throw new Error(`unknown preset: ${args.preset}. Presets: ${Object.keys(PRESETS).join(", ")}`)
  }
  if (existsSync(STATE_FILE)) throw new Error(`a gamut run is already up (${STATE_FILE}). Run: bun run gamut down`)
  const launch = resolveLaunch(args.installed, process.env)
  const preset = resolvePreset(named, namesFamily(named) ? await loadCatalog(launch.fork) : {})
  const missing = await missingLogins(loginsToCopy(named, preset))
  if (missing.length > 0) {
    throw new Error(`no stored login for ${missing.join(", ")}; run: ${missing.map(loginStep).join(" && ")}`)
  }
  const gentStore = named.claudeLogins === "gent" ? gentAuthDir() : undefined
  if (gentStore !== undefined) gentAccounts(gentStore)

  const root = join(tmpdir(), `opencode-gamut-${Date.now()}`)
  // Until the state file names `root`, `down` cannot find it: a failed `up`
  // stops what it started and removes it here instead.
  const started: { simPid?: number } = {}
  try {
    await prepareAndLaunch(args, launch, named, preset, root, started, gentStore)
  } catch (error) {
    if (!existsSync(STATE_FILE)) {
      if (started.simPid !== undefined && (await isSim(started.simPid, root))) process.kill(started.simPid, "SIGKILL")
      rmSync(root, { recursive: true, force: true })
    }
    throw error
  }
}

const prepareAndLaunch = async (
  args: UpArgs,
  launch: Launch,
  named: Preset,
  preset: ResolvedPreset,
  root: string,
  started: { simPid?: number },
  gentStore: string | undefined,
) => {
  const paths = runPaths(root)
  for (const dir of [paths.work, paths.home, paths.config, paths.data]) mkdirSync(dir, { recursive: true })

  // The fixture ships its ignore file under a neutral name so this repo's git
  // does not apply it to the checked-in copy.
  cpSync(FIXTURE, paths.work, { recursive: true })
  renameSync(join(paths.work, ".gitignore.fixture"), join(paths.work, ".gitignore"))

  let simPort: number | undefined
  if (usesSim(preset)) {
    const sim = await startSim(root)
    started.simPid = sim.pid
    simPort = sim.port
  }

  const plugins: ReadonlyArray<PluginEntry> = [
    join(PLUGINS, "orchestrate"),
    join(PLUGINS, "codex"),
    { package: join(PLUGINS, "status"), options: { log: join(paths.home, ".cache/orchestrate/opencode-agents.jsonl"), statusScript: join(homedir(), ".claude/skills/orchestrate/scripts/status.ts") } },
    ...(usesPool(preset) ? serverPlugins(preset, anthropicAuthPlugin(paths.root), gentStore) : [poolPlugin]),
  ]
  await Bun.write(
    join(paths.work, "opencode.json"),
    `${JSON.stringify(projectConfig(preset, simPort, plugins), null, 2)}\n`,
  )
  await Bun.write(join(paths.config, "cli.json"), `${JSON.stringify(cliConfig(pluginPaths(PLUGINS)), null, 2)}\n`)
  cpSync(THEME, join(paths.work, ".opencode/themes/prime.json"))
  const agentsPath = join(paths.work, "AGENTS.md")
  await Bun.write(agentsPath, rewriteRoster(await Bun.file(agentsPath).text(), preset))
  // The run's home has no owner git config; the agent's commits need a name.
  await Bun.write(join(paths.home, ".gitconfig"), "[user]\n\tname = gamut\n\temail = gamut@local\n")

  console.log(`work   ${paths.work}`)
  console.log(`run    ${launch.kind === "fork" ? `fork ${launch.fork}` : launch.base[0]}`)
  console.log(
    `preset ${args.preset}  ${ROLES.map((role) => `${role} ${selection(preset[role])}`).join("  ")}`,
  )
  if (gentStore !== undefined) {
    console.log(`gent   ${gentStore}: the pool reads these accounts in place: ${gentAccounts(gentStore).join(", ")}`)
  }
  if (!args.build) console.log("--no-build: nothing to build either way; the fork runs from source")

  await $`bun install --silent`.cwd(paths.work).quiet()
  // A git repo so the agent can diff, and so a subagent's edits are recoverable.
  await $`git init -q`.cwd(paths.work).quiet()
  await $`git add -A`.cwd(paths.work).quiet()
  await $`git -c user.name=gamut -c user.email=gamut@local commit -q -m ${"ledgerline: red suite with six open tasks"}`
    .cwd(paths.work)
    .quiet()

  const env = runEnv(process.env, paths, launch, simPort !== undefined)
  importCredentials(loginsToCopy(named, preset), launch, env, paths.work)

  const prompt = args.prompt === undefined ? DEFAULT_PROMPT : await resolvePrompt(args.prompt)
  const sendMark = Date.now()
  const hostPid = await startHost(root, {
    socket: paths.socket,
    cwd: paths.work,
    command: [...launch.base, "--standalone", "--auto", "--prompt", prompt],
    env,
    ...HOST_SIZE,
  })

  const state: GamutState = {
    checkout: realpathSync(CHECKOUT),
    root,
    hostPid,
    ...(started.simPid === undefined ? {} : { simPid: started.simPid }),
    base: launch.base,
    preset: args.preset,
    sendMark,
    awaitsTurn: true,
  }
  try {
    await writeState(state)
  } catch (error) {
    // Without the state file no `down` can find the host, so stop it here.
    if (await isHost(hostPid, root)) process.kill(hostPid, "SIGKILL")
    throw error
  }
  console.log(`host   ${hostPid} on ${paths.socket}`)
  console.log(`state  ${STATE_FILE}`)
}

// ── The run's database ──────────────────────────────────────────────────

const hasTable = (db: Database, name: string): boolean =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null

const hasColumn = (db: Database, table: string, column: string): boolean =>
  (db.query(`PRAGMA table_info(${table})`).all() as ReadonlyArray<{ name: string }>).some(
    (row) => row.name === column,
  )

/**
 * The sessions with a turn open: one whose last start (`time_busy`, or its
 * last user message) is after its last `time_idle`, or with a message still
 * waiting for admission (`session_inbox`, the release's `session_pending`).
 * OpenCode sets `time_idle` when a turn ends, a failed or cancelled one too.
 */
export const openTurnSessions = (db: Database): ReadonlyArray<string> => {
  if (!hasTable(db, "session_v2")) return []
  const busy = hasColumn(db, "session_v2", "time_busy") ? "COALESCE(s.time_busy, 0)" : "0"
  const queues = ["session_inbox", "session_pending"].filter((table) => hasTable(db, table))
  const sql = [
    `SELECT s.id FROM session_v2 s WHERE MAX(${busy},
       COALESCE((SELECT MAX(m.time_created) FROM session_message m WHERE m.session_id = s.id AND m.type = 'user'), 0))
       > COALESCE(s.time_idle, 0)`,
    ...queues.map((table) => `SELECT session_id FROM ${table}`),
  ].join(" UNION ")
  return (db.query(sql).all() as ReadonlyArray<{ id: string }>).map((row) => Object.values(row)[0] as string)
}

/**
 * What the run's own database says since `sendMark`: whether a turn started,
 * which turns are open, and whether anything was stored at all (the trace a
 * handled slash command leaves).
 */
export interface RunRecord {
  readonly started: boolean
  readonly open: ReadonlyArray<string>
  readonly stored: boolean
}

export const NO_RECORD: RunRecord = { started: false, open: [], stored: false }

export const runRecord = (db: Database, sendMark: number): RunRecord => {
  if (!hasTable(db, "session_v2")) return NO_RECORD
  const busy = hasColumn(db, "session_v2", "time_busy") ? "COALESCE(time_busy, 0) > ?1 OR " : ""
  const started =
    db.query(`SELECT 1 FROM session_v2 WHERE ${busy}time_created > ?1 LIMIT 1`).get(sendMark) !== null ||
    db.query(`SELECT 1 FROM session_message WHERE type = 'user' AND time_created > ?1 LIMIT 1`).get(sendMark) !== null
  const stored =
    started ||
    db.query(`SELECT 1 FROM session_message WHERE time_created > ?1 LIMIT 1`).get(sendMark) !== null ||
    db.query(`SELECT 1 FROM session_v2 WHERE time_updated > ?1 LIMIT 1`).get(sendMark) !== null
  return { started, open: openTurnSessions(db), stored }
}

/** Open the run's database read-only for `read`; `absent` when OpenCode has not made it yet. */
const readRunDb = <A>(dbPath: string, absent: A, read: (db: Database) => A): A => {
  if (!existsSync(dbPath)) return absent
  const db = new Database(dbPath, { readonly: true })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

/** One session as `status` reports it. */
export interface SessionReport {
  readonly id: string
  readonly parent: string | null
  readonly title: string
  readonly agent: string
  readonly turns: number
  readonly cost: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly tools: Readonly<Record<string, number>>
  readonly errors: ReadonlyArray<string>
}

export interface RunReport {
  readonly sessions: ReadonlyArray<SessionReport>
  /** `provider/model#variant` → assistant replies on it. */
  readonly models: Readonly<Record<string, number>>
  readonly open: ReadonlyArray<string>
}

interface AssistantData {
  readonly model?: { readonly id?: string; readonly providerID?: string; readonly variant?: string }
  readonly content?: ReadonlyArray<{
    readonly type?: string
    readonly name?: string
    readonly state?: { readonly status?: string; readonly error?: unknown }
  }>
  readonly error?: { readonly type?: string; readonly message?: string }
}

const errorText = (error: unknown): string =>
  typeof error === "string"
    ? error
    : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : JSON.stringify(error)

const oneLine = (text: string, max = 160) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * What the run did, from its own database: each session (its parent, agent,
 * turns, cost and tokens), the tool calls and errors in it, and the models
 * that answered.
 */
export const runReport = (db: Database): RunReport => {
  if (!hasTable(db, "session_v2")) return { sessions: [], models: {}, open: [] }
  const rows = db
    .query(
      `SELECT id, parent_id, title, agent, cost, tokens_input, tokens_output FROM session_v2 ORDER BY time_created`,
    )
    .all() as ReadonlyArray<{
    id: string
    parent_id: string | null
    title: string | null
    agent: string | null
    cost: number
    tokens_input: number
    tokens_output: number
  }>
  const messages = db
    .query(`SELECT session_id, type, data FROM session_message ORDER BY session_id, seq`)
    .all() as ReadonlyArray<{ session_id: string; type: string; data: string }>
  const models: Record<string, number> = {}
  const turns = new Map<string, number>()
  const tools = new Map<string, Record<string, number>>()
  const errors = new Map<string, string[]>()
  const push = (session: string, error: string) => errors.set(session, [...(errors.get(session) ?? []), error])
  for (const message of messages) {
    if (message.type === "user") turns.set(message.session_id, (turns.get(message.session_id) ?? 0) + 1)
    if (message.type === "idle") {
      const outcome = (JSON.parse(message.data) as { outcome?: string }).outcome
      if (outcome !== undefined && outcome !== "succeeded") push(message.session_id, `turn ended ${outcome}`)
    }
    if (message.type !== "assistant") continue
    const data = JSON.parse(message.data) as AssistantData
    if (data.model?.id !== undefined) {
      const name = `${data.model.providerID ?? "?"}/${data.model.id}${data.model.variant ? `#${data.model.variant}` : ""}`
      models[name] = (models[name] ?? 0) + 1
    }
    for (const part of data.content ?? []) {
      if (part.type !== "tool" || part.name === undefined) continue
      const counts = tools.get(message.session_id) ?? {}
      counts[part.name] = (counts[part.name] ?? 0) + 1
      tools.set(message.session_id, counts)
      if (part.state?.status === "error") {
        push(message.session_id, `${part.name}: ${oneLine(errorText(part.state.error ?? "failed"))}`)
      }
    }
    if (data.error !== undefined) push(message.session_id, oneLine(errorText(data.error)))
  }
  return {
    sessions: rows.map((row) => ({
      id: row.id,
      parent: row.parent_id,
      title: row.title ?? "",
      agent: row.agent ?? "",
      turns: turns.get(row.id) ?? 0,
      cost: row.cost,
      tokensIn: row.tokens_input,
      tokensOut: row.tokens_output,
      tools: tools.get(row.id) ?? {},
      errors: errors.get(row.id) ?? [],
    })),
    models,
    open: openTurnSessions(db),
  }
}

const count = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

/** `status`'s text for a report: the session tree, models, tool calls, errors and open turns. */
export const formatReport = (report: RunReport): string => {
  const lines: string[] = [`sessions (${report.sessions.length})`]
  const children = (parent: string | null) => report.sessions.filter((session) => session.parent === parent)
  const known = new Set(report.sessions.map((session) => session.id))
  const walk = (session: SessionReport, depth: number) => {
    lines.push(
      `${"  ".repeat(depth + 1)}${session.id}  ${session.agent || "?"}  ${JSON.stringify(session.title)}  turns ${session.turns}  $${session.cost.toFixed(4)}  in ${count(session.tokensIn)} out ${count(session.tokensOut)}`,
    )
    for (const child of children(session.id)) walk(child, depth + 1)
  }
  // A child whose parent is not stored still shows, as a root.
  for (const root of report.sessions.filter((s) => s.parent === null || !known.has(s.parent))) walk(root, 0)
  lines.push("models")
  const models = Object.entries(report.models)
  if (models.length === 0) lines.push("  none")
  for (const [name, replies] of models) lines.push(`  ${name}  ${replies} replies`)
  lines.push("tool calls")
  const withTools = report.sessions.filter((session) => Object.keys(session.tools).length > 0)
  if (withTools.length === 0) lines.push("  none")
  for (const session of withTools) {
    const calls = Object.entries(session.tools)
      .sort(([, a], [, b]) => b - a)
      .map(([name, n]) => `${name} ${n}`)
    lines.push(`  ${session.id}  ${calls.join(", ")}`)
  }
  lines.push("errors")
  const errors = report.sessions.flatMap((session) => session.errors.map((error) => `  ${session.id}  ${error}`))
  lines.push(...(errors.length === 0 ? ["  none"] : errors))
  lines.push(`open turns  ${report.open.join(", ") || "none"}`)
  return lines.join("\n")
}

/**
 * `17 pass, 0 fail` from a `bun test` run. Bun colours its summary even when
 * piped, so the colour is stripped before reading.
 */
export const testSummary = (output: string): string => {
  const plain = Bun.stripANSI(output)
  const pass = /^\s*(\d+) pass/m.exec(plain)?.[1] ?? "?"
  const fail = /^\s*(\d+) fail/m.exec(plain)?.[1] ?? "?"
  return `${pass} pass, ${fail} fail`
}

const status = async () => {
  const state = await readState()
  const paths = runPaths(state.root)
  console.log(`preset ${state.preset}  work ${paths.work}`)
  console.log(readRunDb(paths.db, "no database yet: OpenCode has stored nothing", (db) => formatReport(runReport(db))))
  // The red app is the measure of whether the run did the work.
  const tests = await $`bun test`.cwd(paths.work).quiet().nothrow()
  console.log(`bun test  ${testSummary(`${tests.stdout}\n${tests.stderr}`)}`)
}

// ── send, keys, read, wait ──────────────────────────────────────────────

/** A prompt starts a turn; a slash command runs in the client and may start none. */
export const sendAwaitsTurn = (text: string): boolean => !text.trimStart().startsWith("/")

const send = async (text: string) => {
  if (text.trim() === "") throw new Error("send needs the text to type")
  const state = await readState()
  // Mark before typing: the message is stored after this time.
  await writeState({ ...state, sendMark: Date.now(), awaitsTurn: sendAwaitsTurn(text) })
  await callHost(state, async (socket) => {
    await hostCall(socket, { op: "type", text })
    await hostCall(socket, { op: "keys", names: ["enter"] })
  })
}

const pressKeys = async (names: ReadonlyArray<string>) => {
  checkKeyNames(names)
  const state = await readState()
  await callHost(state, (socket) => hostCall(socket, { op: "keys", names }))
}

/**
 * What `read` prints: the rows added since the last read (`(no change)` when
 * none), or the whole screen with `--full`, then how many rows of the last
 * read are gone and, once it has exited, OpenCode's exit code.
 */
export const screenText = (screen: HostScreen, full: boolean): string => {
  const lines = [...screen.rows]
  if (!full && lines.length === 0) lines.push("(no change)")
  if (screen.gone > 0) lines.push(`(${screen.gone} rows of the last read are gone)`)
  if (screen.exited !== undefined) lines.push(`(opencode exited ${screen.exited})`)
  return lines.join("\n")
}

const read = async (full: boolean) => {
  const state = await readState()
  const screen = await callHost(state, (socket) => hostCall(socket, { op: "read", scope: full ? "full" : "changes" }))
  console.log(screenText(screen, full))
}

/** Where a wait stands: settled reads in a row, quiet reads in a row, and the last screen. */
export interface WaitProgress {
  readonly settledReads: number
  readonly quietReads: number
  readonly lastScreen?: string
}

export const WAIT_START: WaitProgress = { settledReads: 0, quietReads: 0 }

/** Seconds between `wait`'s reads. */
export const WAIT_EVERY_MS = 3000

/** Idle reads in a row after which a slash command that stored nothing is taken as handled. */
export const QUIET_READS = 5

/**
 * Fold one read into the wait. A read is idle when no turn is open in the
 * database and the screen is the same as the last read's. An idle read counts
 * only with proof the send was handled: a turn started after it for a prompt,
 * anything stored after it for a slash command. Two such reads in a row
 * settle: a background subagent's result starts a new turn by itself. A slash
 * command that leaves no trace settles after `QUIET_READS` idle reads. A busy
 * read starts the count again.
 */
export const waitStep = (
  progress: WaitProgress,
  screen: string,
  record: RunRecord,
  awaitsTurn: boolean,
): WaitProgress => {
  const idle = record.open.length === 0 && screen === progress.lastScreen
  if (!idle) return { ...WAIT_START, lastScreen: screen }
  const handled = awaitsTurn ? record.started : record.stored
  if (handled) return { settledReads: progress.settledReads + 1, quietReads: 0, lastScreen: screen }
  if (awaitsTurn) return { ...WAIT_START, lastScreen: screen }
  return { settledReads: 0, quietReads: progress.quietReads + 1, lastScreen: screen }
}

export const isSettled = (progress: WaitProgress): boolean =>
  progress.settledReads >= 2 || progress.quietReads >= QUIET_READS

const wait = async (timeoutSeconds: number) => {
  const state = await readState()
  const paths = runPaths(state.root)
  const deadline = Date.now() + timeoutSeconds * 1000
  let progress = WAIT_START
  let record = NO_RECORD
  while (Date.now() < deadline) {
    // A host that stops answering ends the wait with the budget, not after it.
    const screen = await callHost(
      state,
      (socket) => hostCall(socket, { op: "read", scope: "screen" }),
      Math.max(deadline - Date.now(), 1000),
    )
    if (screen.exited !== undefined) throw new Error(`opencode exited ${screen.exited}; read --full shows its last screen`)
    record = readRunDb(paths.db, NO_RECORD, (db) => runRecord(db, state.sendMark))
    progress = waitStep(progress, screen.rows.join("\n"), record, state.awaitsTurn)
    if (isSettled(progress)) {
      console.log("idle")
      return
    }
    await Bun.sleep(WAIT_EVERY_MS)
  }
  const turns = record.started ? `open turns: ${record.open.join(", ") || "none"}` : "no turn started"
  console.error(`not settled after ${timeoutSeconds}s; ${turns}`)
  process.exitCode = 1
}

// ── restart, down, list ─────────────────────────────────────────────────

/** The newest top-level session, the one `restart` resumes. */
const rootSession = (dbPath: string): string | undefined =>
  readRunDb(dbPath, undefined, (db) =>
    hasTable(db, "session_v2")
      ? (
          db
            .query(`SELECT id FROM session_v2 WHERE parent_id IS NULL ORDER BY time_created DESC LIMIT 1`)
            .get() as { id: string } | null
        )?.id
      : undefined,
  )

const restart = async () => {
  const state = await readState()
  const session = rootSession(runPaths(state.root).db)
  const command: [string, ...string[]] = [
    ...state.base,
    "--standalone",
    "--auto",
    ...(session === undefined ? [] : ["--session", session]),
  ]
  await writeState({ ...state, sendMark: Date.now(), awaitsTurn: false })
  await callHost(state, (socket) => hostCall(socket, { op: "restart", command }), 30_000)
  console.log(session === undefined ? "relaunched: no session to resume" : `relaunched: resumed ${session}`)
}

/**
 * Stop OpenCode, its host and the sim model, then remove the run. A host that
 * has stopped already, or does not answer, is killed by its recorded process
 * id once `ps` shows it is still the host. The scratch tree holds the run's
 * copy of a login, so it is deleted outright, not trashed.
 */
const down = async () => {
  const state = await readState()
  const stopped = await within(
    hostCall(runPaths(state.root).socket, { op: "down" }).catch(() => undefined),
    25_000,
  )
  if (stopped !== TIMED_OUT && stopped?.killed === true) console.log("opencode did not quit on ctrl+c within 15s; killed it")
  const deadline = Date.now() + 2000
  while ((await isHost(state.hostPid, state.root)) && Date.now() < deadline) await Bun.sleep(100)
  if (await isHost(state.hostPid, state.root)) process.kill(state.hostPid, "SIGKILL")
  if (state.simPid !== undefined && (await isSim(state.simPid, state.root))) process.kill(state.simPid, "SIGTERM")
  rmSync(state.root, { recursive: true, force: true })
  rmSync(STATE_FILE, { force: true })
  console.log(`stopped the host, removed ${state.root}`)
}

/**
 * Add one Claude subscription login to the owner's OpenCode. The owner's
 * config does not load the Anthropic auth plugin, which is what offers the
 * Claude Pro/Max sign-in, so the login runs on a private server in a scratch
 * directory whose project config loads it. The login lands in the owner's
 * own database, where `up` copies it from. Each call adds one account: sign
 * in to a different Claude account in the browser each time.
 */
const login = async (provider: string | undefined) => {
  if (provider !== POOLED_PROVIDER) {
    throw new Error(`gamut login signs in to ${POOLED_PROVIDER}; for another provider run: ${OWNER_OPENCODE} auth login <provider>`)
  }
  const dir = mkdtempSync(join(tmpdir(), "opencode-gamut-login-"))
  try {
    writeFileSync(join(dir, "opencode.json"), `${JSON.stringify({ plugins: [anthropicAuthPlugin(dir)] })}\n`)
    // The sign-in talks to Anthropic itself, not to a proxy the caller's shell names.
    const env = { ...process.env }
    delete env.ANTHROPIC_BASE_URL
    const child = Bun.spawn([OWNER_OPENCODE, "auth", "login", provider, "--method", "claude-max", "--standalone"], {
      cwd: dir,
      env,
      stdio: ["inherit", "inherit", "inherit"],
    })
    const code = await child.exited
    if (code !== 0) throw new Error(`${OWNER_OPENCODE} auth login ${provider} exited ${code}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** gent's accounts at `dir` for `list`, or why there are none. */
const gentListing = (dir: string): string => {
  try {
    return `${gentAccounts(dir).length} accounts`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The presets as `up` would run them today, and the login each needs. */
const list = async () => {
  const fork = resolve(process.env.OPENCODE_DEV || DEFAULT_FORK)
  const catalog = Object.values(PRESETS).some(namesFamily) ? await loadCatalog(fork) : {}
  for (const [name, preset] of Object.entries(PRESETS)) {
    const resolved = resolvePreset(preset, catalog)
    const needed = loginsToCopy(preset, resolved)
    const missing = await missingLogins(needed)
    const needs =
      preset.claudeLogins === "gent"
        ? `takes the Claude accounts gent holds at ${gentAuthDir()} (${gentListing(gentAuthDir())})`
        : needed.length === 0
          ? "needs nothing"
          : `needs the ${needed.join(", ")} login (${missing.length === 0 ? "stored" : `missing: ${missing.map(loginStep).join(" && ")}`})`
    console.log(`${name}  ${preset.about}; ${needs}`)
    for (const role of ROLES) {
      const slot = preset.roles[role]
      const family = FAMILIES[slot.model] === undefined ? "" : ` (${slot.model})`
      console.log(`  ${role.padEnd(12)} ${selection(resolved[role])}${family}`)
    }
  }
}

// ── entry ───────────────────────────────────────────────────────────────

const USAGE = `usage: bun run gamut <command>
  up <preset> [--prompt <file|text>] [--installed] [--no-build]
                        fresh scratch run on its own terminal host; the fork from
                        OPENCODE_DEV (default ${DEFAULT_FORK}),
                        or opencode2 with --installed
  send <text>           type text + Enter into the TUI
  keys <name…>          press named keys (ctrl+c, esc, down, tab, …)
  interrupt             press ctrl+c once
  read [--full]         print the rows added since the last read, or the screen
  wait [seconds]        block until no turn is open and the screen is still (default 600)
  status                sessions, turns, models, tool calls, errors, bun test
  restart               quit OpenCode and resume the session
  down                  quit, stop the host, remove the scratch dir
  list                  presets, their models and the login each needs
  login anthropic       add one Claude subscription login to opencode2, through
                        the Anthropic auth plugin (once per account)`

const main = async (argv: ReadonlyArray<string>): Promise<void> => {
  const [command, ...rest] = argv
  switch (command) {
    case "up":
      return up(parseUpArgs(rest))
    case "send":
      return send(rest.join(" "))
    case "keys":
      return pressKeys(rest)
    case "interrupt":
      return pressKeys(["ctrl+c"])
    case "read":
      return read(rest.includes("--full"))
    case "wait":
      return wait(parseCount("wait seconds", rest[0] ?? "600"))
    case "status":
      return status()
    case "restart":
      return restart()
    case "down":
      return down()
    case "list":
      return list()
    case "login":
      return login(rest[0])
    default:
      console.log(USAGE)
      if (command !== undefined && command !== "help" && command !== "--help") process.exitCode = 2
  }
}

/** One line per failure: a failed git or bun call's exit code and what it said, not its stack. */
const failureLine = (error: unknown): string => {
  if (error instanceof $.ShellError) {
    return `gamut: a command failed (exit ${error.exitCode}): ${failureText(error.stdout.toString(), error.stderr.toString())}`
  }
  return `gamut: ${error instanceof Error ? error.message : String(error)}`
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(failureLine(error))
    process.exitCode = 1
  })
}
