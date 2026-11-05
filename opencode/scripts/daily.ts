// `bun run daily`: makes the fork, with these mods loaded, the `opencode` a new terminal runs.
//
// 1. Builds the fork in `OPENCODE_DEV` (default: the prime-look Rift) as a release binary
//    (channel `latest`, version `<base>-prime.<commit>`), so it shares the installed OpenCode's
//    database and background service; a version change restarts that service as ours.
//    `--skip-build` reuses the last build.
// 2. Copies it to `~/.local/share/opencode-prime/` and writes `~/.local/bin/opencode`, a launcher
//    that runs it without the caller's Anthropic routing (`launcher`). `~/.local/bin` comes before
//    `~/.bun/bin` on PATH; `opencode2` stays the stock release.
// 3. Merges our entries into `~/.config/opencode/opencode.json` (server plugins, the role
//    agents' models, no auto-update) and `cli.json` (TUI plugins, the Prime theme), keeping
//    every other key and plugin. Paths are this checkout's, so nothing machine-specific is
//    committed.
// 4. Restarts the background service so it loads the server plugins.
import { $ } from "bun"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { anthropicAuthPlugin } from "../testbeds/anthropic-auth.ts"
import { type Catalog, DEFAULT_FORK, gentAuthDir, loadCatalog, newestRelease } from "../testbeds/gamut/gamut.ts"

const MODS = resolve(import.meta.dir, "../mods")
const CMD = resolve(import.meta.dir, "../cmd")

/** The directory OpenCode loads a plugin from: its `cmd/` package once it has one, else its mod. */
export const pluginDir = (name: string): string => (existsSync(join(CMD, name, "package.json")) ? join(CMD, name) : join(MODS, name))
const THEME = resolve(import.meta.dir, "../themes/prime.json")

type PluginEntry = string | { readonly package: string; readonly options?: Record<string, unknown> }
type Json = Record<string, unknown>

const packageOf = (entry: unknown): string | undefined =>
  typeof entry === "string" ? entry : typeof entry === "object" && entry !== null && "package" in entry ? String(entry.package) : undefined

/**
 * `~/.local/bin/opencode`: runs `binary` without the caller's Anthropic routing. The pool picks
 * the account for OpenCode's Claude requests, but the Anthropic auth plugin sends them to
 * `ANTHROPIC_BASE_URL` when it is set, and a Claude Code session on TeamClaude sets it to the
 * proxy. The background service inherits the environment of the client that starts it, so the
 * variables are dropped at every launch, not only when `daily` restarts the service.
 */
export const launcher = (binary: string): string =>
  [
    "#!/bin/sh",
    "# Written by `bun run daily` (dotfiles/opencode/scripts/daily.ts).",
    "unset ANTHROPIC_BASE_URL ANTHROPIC_INSECURE",
    `exec '${binary.replaceAll("'", `'\\''`)}' "$@"`,
    "",
  ].join("\n")

/** Each role's model: Claude plans and implements; the verifier is the other family (the skill's Families rule). */
export const roleModels = (catalog: Catalog): Record<string, string> => {
  const newest = (provider: string, family: string) => {
    const model = newestRelease(catalog, provider, family)
    if (model === undefined) throw new Error(`no ${provider}/${family} release in the model catalog`)
    return `${provider}/${model}`
  }
  const claude = newest("anthropic", "claude-opus")
  return { planner: claude, implementor: claude, verifier: newest("openai", "gpt-sol") }
}

/**
 * The global server config with ours merged in: our plugins (any entry from `owned` dirs is
 * replaced, every other entry kept, ours first so the auth plugin precedes the pool), each
 * role's model (its other fields kept), and auto-update off so the stock release never
 * replaces the fork.
 */
export const mergeServer = (
  existing: Json,
  plugins: ReadonlyArray<PluginEntry>,
  models: Record<string, string>,
  owned: ReadonlyArray<string>,
): Json => {
  const others = (Array.isArray(existing.plugins) ? existing.plugins : []).filter((entry) => {
    const path = packageOf(entry)
    return path === undefined || !owned.some((dir) => path === dir || path.startsWith(`${dir}/`))
  })
  const agents = (typeof existing.agents === "object" && existing.agents !== null ? existing.agents : {}) as Record<string, Json>
  return {
    ...existing,
    autoupdate: false,
    plugins: [...plugins, ...others],
    agents: {
      ...agents,
      ...Object.fromEntries(Object.entries(models).map(([role, model]) => [role, { ...agents[role], model }])),
    },
  }
}

/** The TUI config with ours merged in: our plugins first (Prime before the rest), the Prime theme. */
export const mergeCli = (existing: Json, plugins: ReadonlyArray<string>, owned: ReadonlyArray<string>): Json => {
  const others = (Array.isArray(existing.plugins) ? existing.plugins : []).filter((entry) => {
    const path = packageOf(entry)
    return path === undefined || !owned.some((dir) => path === dir || path.startsWith(`${dir}/`))
  })
  const theme = typeof existing.theme === "object" && existing.theme !== null ? existing.theme : {}
  return { ...existing, theme: { ...theme, name: "prime" }, plugins: [...plugins, ...others] }
}

const readJson = (path: string): Json => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Json) : {})
const writeJson = (path: string, value: Json) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

if (import.meta.main) {
  const home = homedir()
  const fork = resolve(process.env.OPENCODE_DEV || DEFAULT_FORK)
  const cli = join(fork, "packages/cli")
  if (!existsSync(join(cli, "script/build.ts"))) throw new Error(`no OpenCode checkout at ${fork}: set OPENCODE_DEV`)
  const base = (JSON.parse(readFileSync(join(cli, "package.json"), "utf8")) as { version: string }).version
  const commit = (await $`git -C ${fork} rev-parse --short=8 HEAD`.text()).trim()
  const version = `${base}-prime.${commit}`
  const target = `cli-${process.platform}-${process.arch}`
  const built = join(cli, "dist", target, "bin/opencode")

  // The workspace links and vendor packages the plugins import: OpenCode loads plugins in place and
  // installs nothing. The fork's modules are linked before the install, so it never writes through an
  // older checkout's whole-directory link into the fork, and again after it, because an install that
  // changes a package's node_modules drops links it did not make. The TUI plugins resolve `solid-js`
  // through those links at load time (scripts/link-fork.ts).
  const linkFork = () => $`bun ${join(import.meta.dir, "link-fork.ts")}`.env({ ...process.env, OPENCODE_DEV: fork }).quiet()
  await linkFork()
  await $`bun install --frozen-lockfile`.cwd(resolve(import.meta.dir, "..")).quiet()
  await linkFork()

  if (!process.argv.includes("--skip-build")) {
    console.log(`building ${version} from ${fork}`)
    await $`bun run script/build.ts --single --skip-install --skip-web-ui`
      .cwd(cli)
      .env({ ...process.env, OPENCODE_CHANNEL: "latest", OPENCODE_VERSION: version })
      .quiet()
  }
  const reported = (await $`${built} --version`.text()).trim()
  if (!reported.includes(version)) throw new Error(`${built} reports ${reported}, not ${version}: build it (drop --skip-build)`)

  const share = join(home, ".local/share/opencode-prime")
  mkdirSync(share, { recursive: true })
  const binary = join(share, `opencode-${version}`)
  // Copy beside it, then rename over it: Linux refuses to write a binary the running service executes
  // (ETXTBSY), and a rename leaves that process on the old file.
  const staged = `${binary}.${process.pid}`
  copyFileSync(built, staged)
  chmodSync(staged, 0o755)
  renameSync(staged, binary)
  const link = join(home, ".local/bin/opencode")
  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { force: true })
  writeFileSync(link, launcher(binary), { mode: 0o755 })

  const auth = anthropicAuthPlugin
  const gent = gentAuthDir()
  const pool = pluginDir("pool")
  const server: PluginEntry[] = [
    auth,
    existsSync(gent) ? { package: pool, options: { sources: [{ kind: "gent", dir: gent }] } } : pool,
    pluginDir("orchestrate"),
    pluginDir("guard"),
    pluginDir("kernel"),
    pluginDir("status"),
    pluginDir("queue"),
    pluginDir("git"),
    pluginDir("idle-compact"),
  ]
  // Earlier runs loaded the auth plugin through a loader directory here; its entry is replaced too.
  const loader = join(share, "anthropic-auth")
  rmSync(loader, { recursive: true, force: true })
  const owned = [MODS, CMD, loader]
  const config = join(home, ".config/opencode")
  const models = roleModels(await loadCatalog(fork))
  writeJson(join(config, "opencode.json"), mergeServer(readJson(join(config, "opencode.json")), server, models, owned))
  writeJson(join(config, "cli.json"), mergeCli(readJson(join(config, "cli.json")), [pluginDir("prime"), pluginDir("status"), pluginDir("queue"), pluginDir("herdr"), pluginDir("git"), pluginDir("cache")], owned))
  mkdirSync(join(config, "themes"), { recursive: true })
  copyFileSync(THEME, join(config, "themes/prime.json"))

  const restart = await $`${link} service restart`.nothrow().quiet()
  console.log(`opencode -> ${binary} (${reported})`)
  console.log(`server plugins: ${server.map(packageOf).join(", ")}`)
  console.log(`roles: ${Object.entries(models).map(([role, model]) => `${role} ${model}`).join(", ")}`)
  console.log(restart.exitCode === 0 ? "background service restarted" : `service restart exited ${restart.exitCode}: ${restart.stderr.toString().trim()}`)
}
