/**
 * What code that runs outside the lint gate may import. The plugins (mods/*, cmd/*), the scenarios
 * opencode-drive compiles into one script, and `bun run daily` (which the update plugin runs as
 * `daily --stage`) never reach the lint tool: scripts/effect-debt.ts, its merge module, or oxlint.
 * The scenarios and daily never reach oxc-parser either: a compiled scenario cannot load its native
 * binding (`Cannot find module './parser.darwin-universal.node'`). The walk follows each file's
 * runtime imports, type-only ones left out, through the workspace and stops at node_modules.
 *
 * It finds its seeds by glob, not import, so it declares them for the gate's selection (scripts/reach.ts `readsOf`):
 * @reads cmd/** mods/** scenarios/*.ts scripts/daily.ts
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { isBuiltin } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { env } from "bun"
import { Match, Option } from "effect"
import { unresolvedImports } from "../mods/update/filestore/trees.ts"
import { type Host, hostProvided, SEEDS } from "../mods/update/trees.ts"

const ROOT = process.cwd()
const typescript = new Bun.Transpiler({ loader: "ts" })
const tsx = new Bun.Transpiler({ loader: "tsx" })
/** The transpiler of a source: TSX for `.tsx`, TypeScript for the rest. */
const transpilerOf = (file: string) =>
  Match.value(path.extname(file)).pipe(
    Match.when(".tsx", () => tsx),
    Match.orElse(() => typescript),
  )

/** A workspace import: a relative path, or a workspace package by its `@dotfiles/` name. */
const workspaceImport = (specifier: string) => specifier.startsWith(".") || specifier.startsWith("@dotfiles/")

/**
 * One file's runtime imports: a workspace one as the real path it resolves to, any other as its
 * package specifier (a dependency, or the JSX runtime the TSX transform adds).
 */
const importsOf = (file: string) => {
  const source = readFileSync(file, "utf8").replace(/^#!.*\n/, "\n")
  const transpiler = transpilerOf(file)
  return transpiler.scanImports(source).map((each) => {
    if (!workspaceImport(each.path)) return each.path
    return realpathSync(Bun.resolveSync(each.path, path.dirname(file)))
  })
}

/** A workspace source the walk descends into: ours, not a dependency's, and code. */
const ours = (file: string) => path.isAbsolute(file) && !file.includes("/node_modules/") && /\.(ts|tsx|js|mjs)$/.test(file)

/** Every module `seed` (a path from `root`) reaches at runtime, each with the file that first imports it. */
const reachOf = (seed: string, root = ROOT) => {
  const reached = new Map<string, string>()
  const pending = [path.join(root, seed)]
  for (const file of pending) {
    for (const target of importsOf(file)) {
      if (reached.has(target)) continue
      reached.set(target, path.relative(root, file))
      if (ours(target)) pending.push(target)
    }
  }
  return reached
}

/**
 * The patterns match a target as the repo names it: a workspace file by its path from the root, a
 * package by its specifier. The checkout's own directory (a Rift named `oxlint-x`) never counts.
 */
const LINT_TOOL = [/^scripts\/effect-debt(-merge)?\.ts$/, /^(@[^/]+\/)?oxlint/]
const NATIVE_PARSER = [/^(@[^/]+\/)?oxc-parser([@/]|$)/]
/**
 * The fork's packages OpenCode does not hand a server plugin: it provides `effect` and
 * `@opencode/plugin` only, and any other `@opencode/*` resolves through the checkout's fork links
 * (scripts/link-fork.ts), which a copy of the checkout lacks, so one value import stops the whole
 * plugin from loading ("Cannot find package '@opencode/schema'"). Import those for types only.
 */
const FORK_ONLY = [/^@opencode\/(?!plugin(\/|$))/]

/** Whether `target`, reached from the checkout at `root`, is one of `forbidden`. */
const forbiddenAt = (root: string, target: string, forbidden: ReadonlyArray<RegExp>) => forbidden.some((pattern) => pattern.test(nameAt(root, target)))

/** A target as the repo names it: a workspace file by its path from `root`, a package by its specifier. */
const nameAt = (root: string, target: string) =>
  Match.value(path.isAbsolute(target)).pipe(
    Match.when(true, () => path.relative(root, target)),
    Match.orElse(() => target),
  )

/**
 * A platform implementation: a server plugin takes `FileSystem`, `Path` and `ChildProcessSpawner` from its
 * host (since the fork's platform floor, mods/update/process/pin.ts `PLATFORM_FLOOR`) and imports only their
 * tags from `effect`, never an implementation, even one plain Bun could resolve from the tree's install.
 */
const PLATFORM_IMPL = [/^@effect\/platform-(node|bun)(\/|$)/]

/** Each module of `forbidden` that `seed` reaches from `root`, named with its importer. */
const breaches = (seed: string, forbidden: ReadonlyArray<RegExp>, root = ROOT) =>
  reachOf(seed, root)
    .entries()
    .filter(([target]) => forbiddenAt(root, target, forbidden))
    .map(([target, importer]) => `${seed} reaches ${nameAt(root, target)} through ${importer}`)
    .toArray()

const sources = (pattern: string) => [...new Bun.Glob(pattern).scanSync({ cwd: ROOT })].filter((file) => !file.includes("node_modules/") && !/\.(test|bench)\.tsx?$/.test(file)).sort()

const SCENARIOS = sources("scenarios/*.ts")
const PLUGINS = [...sources("mods/**/*.{ts,tsx}"), ...sources("cmd/**/*.{ts,tsx}")]
/** The server plugin entries OpenCode loads: each `cmd/` package's `server.ts`. */
const SERVERS = sources("cmd/*/server.ts")

describe("runtime imports", () => {
  test("a checkout in a directory named oxlint-* is not the lint tool", () => {
    const root = "/Users/x/Developer/personal/.work/dotfiles/oxlint-x/opencode"
    const lintTool = (target: string) => forbiddenAt(root, target, LINT_TOOL)
    expect(lintTool(`${root}/mods/skills/catalog.ts`)).toBe(false)
    expect(lintTool(`${root}/scripts/daily.ts`)).toBe(false)
    expect(lintTool(`${root}/scripts/effect-debt.ts`)).toBe(true)
    expect(lintTool(`${root}/scripts/effect-debt-merge.ts`)).toBe(true)
    expect(lintTool("oxlint")).toBe(true)
    expect(lintTool("oxlint-plugin-effect/rules")).toBe(true)
    expect(lintTool("effect")).toBe(false)
    expect(forbiddenAt(root, "oxc-parser", NATIVE_PARSER)).toBe(true)
    expect(forbiddenAt(root, `${root}/mods/oxc-parser-notes.ts`, NATIVE_PARSER)).toBe(false)
    expect(forbiddenAt(root, "@opencode/schema/session-id", FORK_ONLY)).toBe(true)
    expect(forbiddenAt(root, "@opencode/client", FORK_ONLY)).toBe(true)
    expect(forbiddenAt(root, "@opencode/plugin/effect", FORK_ONLY)).toBe(false)
    expect(forbiddenAt(root, "@opencode/plugin", FORK_ONLY)).toBe(false)
    expect(forbiddenAt(root, "@opencode/plugins", FORK_ONLY)).toBe(true)
  })

  test("no scenario, and not bun run daily, reaches the lint tool or oxc-parser", () => {
    expect(SCENARIOS.length).toBeGreaterThan(0)
    expect([...SCENARIOS, "scripts/daily.ts"].flatMap((seed) => breaches(seed, [...LINT_TOOL, ...NATIVE_PARSER]))).toEqual([])
  })

  test("no plugin source reaches the lint tool", () => {
    expect(PLUGINS.length).toBeGreaterThan(0)
    expect(PLUGINS.flatMap((seed) => breaches(seed, LINT_TOOL))).toEqual([])
  })

  test("no server plugin reaches a fork package OpenCode does not provide", () => {
    expect(SERVERS.length).toBeGreaterThan(0)
    expect(SERVERS.flatMap((seed) => breaches(seed, FORK_ONLY))).toEqual([])
  })

  // A build's plugin tree (mods/update/filestore/trees.ts) holds its own install and no link into the
  // fork: what a process of it imports, its host serves, or that install holds. The same check gates
  // each tree's make; here it gates the change, over this checkout, the fork's links passed over.
  test("every process a plugin tree runs imports only what its host serves or an install with no fork links holds", () => {
    const seeds = SEEDS.flatMap(({ glob }) => sources(glob))
    expect(SEEDS.every(({ glob }) => sources(glob).length > 0)).toBe(true)
    expect(seeds).toContain("cmd/update/handoff.ts")
    expect(unresolvedImports(ROOT)).toEqual([])
  })

  test("no server plugin, the orchestrate server first, reaches a platform implementation", () => {
    expect(SERVERS).toContain("cmd/orchestrate/server.ts")
    expect(breaches("cmd/orchestrate/server.ts", PLATFORM_IMPL)).toEqual([])
    expect(SERVERS.flatMap((seed) => breaches(seed, PLATFORM_IMPL))).toEqual([])
  })
})

/**
 * What each host serves, restated here as the oracle the generated cases compare `hostProvided` to: the
 * server `effect` and `@opencode/plugin` with any subpath, the TUI those and its exact Solid and OpenTUI
 * modules, plain Bun nothing. Broadening the server's list to a platform package fails these cases.
 */
const TUI_EXACT = ["solid-js", "solid-js/store", "@opentui/core", "@opentui/solid", "@opentui/solid/components", "@opentui/solid/jsx-runtime", "@opentui/solid/jsx-dev-runtime"]
const servedBy = (host: Host, specifier: string): boolean => {
  const server = ["effect", "@opencode/plugin"].some((name) => specifier === name || specifier.startsWith(`${name}/`))
  if (host === "server") return server
  if (host === "tui") return server || TUI_EXACT.includes(specifier)
  return false
}
const HOSTS: ReadonlyArray<Host> = ["server", "tui", "bun"]
/** The packages, each a host's own or a near miss of one: a platform implementation, a longer name, a sibling scope. */
const PACKAGES = [
  "effect",
  "@opencode/plugin",
  "solid-js",
  "@opentui/core",
  "@opentui/solid",
  "@effect/platform-node",
  "@effect/platform-bun",
  "@effect/platform",
  "@effect/platform-node-shared",
  "@opencode/schema",
  "@opencode/plugins",
  "@opencode/plugin-x",
  "effects",
  "effect-bun-test",
  "opencode",
]
const SUBPATHS = ["", "/FileSystem", "/effect", "/store", "/a/b", "/NodeServices"]
const SPECIFIERS = [...new Set([...PACKAGES.flatMap((name) => SUBPATHS.map((sub) => `${name}${sub}`)), ...TUI_EXACT])]

describe("what each host serves, generated over host × package × subpath", () => {
  test("hostProvided matches the oracle on every case, near misses included", () => {
    const cases = HOSTS.flatMap((host) => SPECIFIERS.map((specifier) => ({ host, specifier })))
    expect(cases.length).toBeGreaterThan(250)
    expect(cases.filter(({ host, specifier }) => hostProvided(host, specifier) !== servedBy(host, specifier))).toEqual([])
    // The two fixed points: no host serves a platform implementation, and plain Bun serves nothing.
    expect(cases.filter(({ host, specifier }) => hostProvided(host, specifier) && (specifier.startsWith("@effect/platform") || host === "bun"))).toEqual([])
  })

  test("in a tree with no fork links, a loader-only import fails a plain-Bun process, an install's own copy loads, and a platform implementation the install holds is still no server's", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "runtime-imports-")))
    // The install holds a platform implementation (Bun resolves it) and nothing else.
    const installed = "@effect/platform-node/NodeServices"
    writeTree(root, [
      ["package.json", `{ "name": "fixture", "private": true }`],
      ["node_modules/@effect/platform-node/package.json", `{ "name": "@effect/platform-node", "exports": { "./NodeServices": "./NodeServices.js" } }`],
      ["node_modules/@effect/platform-node/NodeServices.js", "export const layer = 1\n"],
    ])
    const specifiers = [...SPECIFIERS.filter((specifier) => specifier.split("/").length <= 3), installed, "node:fs", "bun"]
    const seeds: ReadonlyArray<readonly [Host, string]> = [
      ["server", "cmd/fixture/server.ts"],
      ["tui", "cmd/fixture/tui.tsx"],
      ["bun", "cmd/update/handoff.ts"],
    ]
    const body = specifiers.map((specifier) => `import "${specifier}"`).join("\n")
    writeTree(
      root,
      seeds.map(([, seed]) => [seed, `${body}\n`]),
    )
    // The tree's check counts any subpath of an installed package as loading (`installedUp`, a dev approximation
    // for the fork's links that shadow an install): `@effect/platform-node/FileSystem` passes it though no such
    // export resolves. Exact resolution is the real no-links tree's test below (TREE_OPENCODE).
    const loads = (host: Host, specifier: string) => specifier === "node:fs" || specifier === "bun" || specifier === "@effect/platform-node" || specifier.startsWith("@effect/platform-node/") || servedBy(host, specifier)
    const expected = seeds.flatMap(([host, seed]) =>
      specifiers.flatMap((specifier) => [`${seed} (${host}): ${seed} imports ${specifier}, which the ${host} host does not serve and no install of the tree holds`].filter(() => !loads(host, specifier))),
    )
    expect([...unresolvedImports(root)].sort()).toEqual(expected.toSorted())
    // A plain-Bun process that leans on what only a loader serves fails the tree's check.
    expect(expected).toContain("cmd/update/handoff.ts (bun): cmd/update/handoff.ts imports effect, which the bun host does not serve and no install of the tree holds")
    expect(expected).toContain("cmd/update/handoff.ts (bun): cmd/update/handoff.ts imports @opencode/plugin/effect, which the bun host does not serve and no install of the tree holds")
    // The install's copy loads for the tree's check, so the server boundary is its own assertion.
    expect(breaches("cmd/fixture/server.ts", PLATFORM_IMPL, root)).toContain(`cmd/fixture/server.ts reaches ${installed} through cmd/fixture/server.ts`)
    rmSync(root, { recursive: true, force: true })
  })

  // The tree a build actually loads: `TREE_OPENCODE=<share>/opencode-<version>.plugins/opencode` (a copy, never the live share dir's own files written).
  const tree = Option.fromNullishOr(env.TREE_OPENCODE)
  test.skipIf(Option.isNone(tree))("the real no-links tree named by TREE_OPENCODE resolves every process's imports exactly, and its servers reach no platform implementation", () => {
    const at = realpathSync(Option.getOrElse(tree, () => "/nonexistent/loop-probe-x"))
    expect(unresolvedImports(at)).toEqual([])
    // Exactly: every bare import a process reaches, that its host does not serve, resolves from its importer in this tree, subpath and all
    // (React's JSX runtime is this walk's TSX transform's, not the TUI's: its Solid transform imports OpenTUI's, which it serves).
    const unresolved = SEEDS.flatMap(({ glob, host }) =>
      [...new Bun.Glob(glob).scanSync({ cwd: at })]
        .filter((seed) => !/\.(test|bench)\.tsx?$/.test(seed))
        .flatMap((seed) =>
          reachOf(seed, at)
            .entries()
            .filter(([target]) => !path.isAbsolute(target) && !builtinModule(target) && !hostProvided(host, target) && !/^react(\/|$)/.test(target))
            .filter(([target, importer]) => !resolvesFrom(target, path.join(at, importer)))
            .map(([target, importer]) => `${seed} (${host}): ${importer} imports ${target}, which does not resolve in the tree`)
            .toArray(),
        ),
    )
    expect(unresolved).toEqual([])
    const servers = [...new Bun.Glob("cmd/*/server.ts").scanSync({ cwd: at })].sort()
    expect(servers).toContain("cmd/orchestrate/server.ts")
    expect(servers.flatMap((seed) => breaches(seed, PLATFORM_IMPL, at))).toEqual([])
  })
})

/** Whether Bun or Node serves `specifier` itself. */
const builtinModule = (specifier: string) => specifier === "bun" || specifier.startsWith("bun:") || specifier.startsWith("node:") || isBuiltin(specifier)

/** Whether `specifier` resolves, exactly, from the file `importer`. */
const resolvesFrom = (specifier: string, importer: string) => Option.isSome(Option.liftThrowable(() => Bun.resolveSync(specifier, path.dirname(importer)))())

/** Writes each `[path, text]` under `root`, its directories made. */
const writeTree = (root: string, entries: ReadonlyArray<readonly [string, string]>) => {
  for (const [file, text] of entries) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
}
