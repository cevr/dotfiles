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
import { tmpdir } from "node:os"
import path from "node:path"
import { Option } from "effect"
import { unresolvedImports } from "../mods/update/filestore/trees.ts"
import { COMMANDS, type Host, hostProvided, SEEDS } from "../mods/update/trees.ts"
import * as Graph from "../tests/cli-tree/graph.ts"

const ROOT = realpathSync(process.cwd())
/** The import graph helpers on this checkout (`tests/cli-tree/graph.ts`, which the installed-tree check shares). */
const graph = Graph.graphOf((file) => readFileSync(file, "utf8"))
const breaches = (seed: string, forbidden: ReadonlyArray<RegExp>, root = ROOT) => graph.breaches(seed, forbidden, root)
const bareOf = (seed: string) => graph.bareOf(seed, ROOT)
const { effectsOf, manifestAt, packageDirFrom, pinsAt } = graph
const { expectedPins, forbiddenAt, packageOf, pinIn, PLATFORM_IMPL, within } = Graph
/** The root `package.json`'s exact version of `name`. */
const rootPin = (name: string) => pinIn(manifestAt(ROOT), name)
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

/** A plain-Bun entry by its own mark: a source of `cmd/` that runs as a script (`import.meta.main`, or a `#!` line). */
const ENTRIES = sources("cmd/**/*.{ts,tsx}").filter((file) => !/\.sim\.tsx?$/.test(file) && /^#!|import\.meta\.main/m.test(readFileSync(file, "utf8")))

describe("the plain-Bun commands a tree runs (mods/update/trees.ts COMMANDS)", () => {
  test("every production entry of cmd/ is a declared command, and every declared command is there, with a probe", () => {
    expect(ENTRIES).toContain("cmd/digest/devices.ts")
    const declared = COMMANDS.map(({ path: file }) => file)
    expect(ENTRIES.filter((file) => !declared.includes(file))).toEqual([])
    expect(declared.filter((file) => sources(file).length !== 1)).toEqual([])
    expect(new Set(declared).size).toBe(declared.length)
    expect(COMMANDS.filter(({ probes }) => probes.length === 0)).toEqual([])
  })

  test("the tree's plain-Bun seeds are exactly the probed commands: no seed without a probe, no probe without a seed", () => {
    // Each Bun seed resolved to its files (a glob there would hide an unprobed entry), compared as sets both ways.
    const seeded = new Set(SEEDS.filter(({ host }) => host === "bun").flatMap(({ glob }) => sources(glob)))
    const probed = new Set(COMMANDS.filter(({ probes }) => probes.length > 0).map(({ path: file }) => file))
    expect({ seedWithoutProbe: [...seeded.difference(probed)].sort(), probeWithoutSeed: [...probed.difference(seeded)].sort() }).toEqual({
      seedWithoutProbe: [],
      probeWithoutSeed: [],
    })
    // And no other host's seed reaches a command's file as its own entry: a command is a bun process, nothing else.
    const elsewhere = SEEDS.filter(({ host }) => host !== "bun").flatMap(({ glob }) => sources(glob)).filter((file) => probed.has(file))
    expect(elsewhere).toEqual([])
  })

  test("each command's graph imports only the packages it declares, each one the root install holds, and never a module only a loader serves", () => {
    const outside = COMMANDS.flatMap(({ path: seed, packages }) =>
      bareOf(seed)
        .filter(([target]) => !packages.includes(packageOf(target)))
        .map(([target, importer]) => `${seed} reaches ${target} through ${importer}, not in its packages ${JSON.stringify(packages)}`),
    )
    expect(outside).toEqual([])
    // The install holds each one: it resolves from its importer inside the checkout, or, where a fork link shadows
    // the install there (scripts/link-fork.ts), from the root's own install (the exact form is the tree's test below).
    const held = (name: string, importer: string) => [path.dirname(path.join(ROOT, importer)), ROOT].some((dir) => Option.exists(packageDirFrom(name, dir), (at) => within(ROOT, at)))
    const unheld = COMMANDS.flatMap(({ path: seed }) =>
      bareOf(seed)
        .filter(([target, importer]) => !held(packageOf(target), importer))
        .map(([target, importer]) => `${seed}: ${importer} imports ${target}, which no install of the checkout holds`),
    )
    expect(unheld).toEqual([])
    // The loader-only modules: `@opencode/*` (the server's and the fork's), the TUI's Solid and OpenTUI.
    expect(COMMANDS.flatMap(({ packages }) => packages.filter((name) => hostProvided("tui", name) && name !== "effect"))).toEqual([])
  })

  test("each command's graph is on one effect release, the root's pin, through every package it reaches (its platform layer's too)", () => {
    const pinned = rootPin("effect")
    expect(pinsAt(ROOT)).toEqual(expectedPins(pinned))
    const mixed = COMMANDS.flatMap(({ path: seed }) => {
      const versions = [...new Set(effectsOf(seed, ROOT).values())]
      return [`${seed}: effect ${versions.join(", ")}`].filter(() => versions.length !== 1 || versions[0] !== pinned)
    })
    expect(mixed).toEqual([])
    // daily's graph holds the platform layer: the walk reaches effect through it, not just beside it.
    expect([...effectsOf("scripts/daily.ts", ROOT).keys()].some((each) => each.startsWith("@effect/platform-bun"))).toBe(true)
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
    // export resolves. Exact resolution is the real no-links tree's, in tests/cli-tree-installed.test.ts (TREE_OPENCODE).
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

})

/** Writes each `[path, text]` under `root`, its directories made. */
const writeTree = (root: string, entries: ReadonlyArray<readonly [string, string]>) => {
  for (const [file, text] of entries) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
}
