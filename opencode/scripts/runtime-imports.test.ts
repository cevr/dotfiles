/**
 * What code that runs outside the lint gate may import. The plugins (mods/*, cmd/*), the scenarios
 * opencode-drive compiles into one script, and `bun run daily` (which the update plugin runs as
 * `daily --stage`) never reach the lint tool: scripts/effect-debt.ts, its merge module, or oxlint.
 * The scenarios and daily never reach oxc-parser either: a compiled scenario cannot load its native
 * binding (`Cannot find module './parser.darwin-universal.node'`). The walk follows each file's
 * runtime imports, type-only ones left out, through the workspace and stops at node_modules.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { Match } from "effect"

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

/** Every module `seed` reaches at runtime, each with the file that first imports it. */
const reachOf = (seed: string) => {
  const reached = new Map<string, string>()
  const pending = [path.join(ROOT, seed)]
  for (const file of pending) {
    for (const target of importsOf(file)) {
      if (reached.has(target)) continue
      reached.set(target, path.relative(ROOT, file))
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

/** Whether `target`, reached from the checkout at `root`, is one of `forbidden`. */
const forbiddenAt = (root: string, target: string, forbidden: ReadonlyArray<RegExp>) => {
  let name = target
  if (path.isAbsolute(target)) name = path.relative(root, target)
  return forbidden.some((pattern) => pattern.test(name))
}

/** Each module of `forbidden` that `seed` reaches, named with its importer. */
const breaches = (seed: string, forbidden: ReadonlyArray<RegExp>) =>
  reachOf(seed)
    .entries()
    .filter(([target]) => forbiddenAt(ROOT, target, forbidden))
    .map(([target, importer]) => `${seed} reaches ${path.relative(ROOT, target)} through ${importer}`)
    .toArray()

const sources = (pattern: string) => [...new Bun.Glob(pattern).scanSync({ cwd: ROOT })].filter((file) => !file.includes("node_modules/") && !/\.(test|bench)\.tsx?$/.test(file)).sort()

const SCENARIOS = sources("scenarios/*.ts")
const PLUGINS = [...sources("mods/**/*.{ts,tsx}"), ...sources("cmd/**/*.{ts,tsx}")]

describe("runtime imports", () => {
  test("a checkout in a directory named oxlint-* is not the lint tool", () => {
    const root = "/Users/x/Developer/personal/.rifts/dotfiles/oxlint-x/opencode"
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
  })

  test("no scenario, and not bun run daily, reaches the lint tool or oxc-parser", () => {
    expect(SCENARIOS.length).toBeGreaterThan(0)
    expect([...SCENARIOS, "scripts/daily.ts"].flatMap((seed) => breaches(seed, [...LINT_TOOL, ...NATIVE_PARSER]))).toEqual([])
  })

  test("no plugin source reaches the lint tool", () => {
    expect(PLUGINS.length).toBeGreaterThan(0)
    expect(PLUGINS.flatMap((seed) => breaches(seed, LINT_TOOL))).toEqual([])
  })
})
