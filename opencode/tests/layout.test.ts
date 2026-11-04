/**
 * The layout fence (ARCHITECTURE.md §Layout): for every mod whose
 * package.json names its `"domain"` folder, imports point one way
 * (`cmd/*` → implementation and UI folders → the domain → `lib/` → `effect`),
 * the domain imports nothing from outside, another mod is reached only through
 * a file its `exports` lists, and files are named by concept, not by kind.
 *
 * Mods not yet migrated have no `"domain"` field and are listed as pending.
 *
 * @module
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { parseSync } from "oxc-parser"

const ROOT = resolve(import.meta.dir, "..")
const MODS = join(ROOT, "mods")
const LIB = join(ROOT, "lib")

interface Manifest {
  readonly domain?: string
  readonly exports?: Record<string, string>
}

const manifest = (mod: string): Manifest => JSON.parse(readFileSync(join(MODS, mod, "package.json"), "utf8")) as Manifest

const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : []
  })

const specifiers = (file: string): ReadonlyArray<string> => {
  const text = readFileSync(file, "utf8")
  const { module } = parseSync(file, text)
  return [
    ...module.staticImports.map((item) => item.moduleRequest.value),
    ...module.staticExports.flatMap((item) => item.entries.flatMap((entry) => (entry.moduleRequest ? [entry.moduleRequest.value] : []))),
    ...module.dynamicImports.flatMap((item) => {
      const literal = text.slice(item.moduleRequest.start, item.moduleRequest.end)
      return /^["'`][^"'`$]*["'`]$/.test(literal) ? [literal.slice(1, -1)] : []
    }),
  ]
}

/** The mod folder a path is in (`cmd`, the domain, an implementation), or undefined at the mod root. */
const folderOf = (modDir: string, path: string) => {
  const parts = relative(modDir, path).split(sep)
  return parts.length > 1 ? parts[0] : undefined
}

const within = (dir: string, path: string) => path === dir || path.startsWith(dir + sep)

const KIND_SUFFIX = /\.(aggregate|command|view|policy|saga|projection|external|rejection|id|model|plugin|story|tui)\.tsx?$/
const KIND_FOLDERS = new Set(["host", "src", "test", "commands", "services", "domain"])

/** Every violation in one migrated mod, as `<file>: <reason>`. */
export const violations = (mod: string): ReadonlyArray<string> => {
  const modDir = join(MODS, mod)
  const domain = manifest(mod).domain
  if (domain === undefined) return []
  const found: string[] = []
  if (!existsSync(join(modDir, domain))) found.push(`${mod}: the domain folder ${domain}/ is missing`)
  for (const file of sources(modDir)) {
    const name = relative(modDir, file)
    const folder = folderOf(modDir, file)
    if (folder === undefined) {
      found.push(`${name}: source files live in a folder, not at the mod root`)
      continue
    }
    if (KIND_FOLDERS.has(folder)) found.push(`${name}: folder ${folder}/ is named by kind`)
    if (KIND_SUFFIX.test(file)) found.push(`${name}: named by kind, not by concept`)
    const inDomain = folder === domain
    const testSupport = /\.test\.tsx?$/.test(file) || (inDomain && name === join(domain, "laws.ts"))
    for (const spec of specifiers(file)) {
      if (!spec.startsWith(".")) {
        if (!inDomain) continue
        if (spec === "effect" || spec.startsWith("effect/")) continue
        if (testSupport && spec === "bun:test") continue
        found.push(`${name}: the domain imports ${spec}`)
        continue
      }
      const target = resolve(dirname(file), spec)
      if (within(LIB, target)) continue
      if (within(modDir, target)) {
        const into = folderOf(modDir, target)
        if (into === "cmd" && folder !== "cmd") found.push(`${name}: imports cmd/ (${spec})`)
        else if (inDomain && into !== domain) found.push(`${name}: the domain imports ${into ?? "the mod root"}/ (${spec})`)
        continue
      }
      if (within(MODS, target)) {
        const other = relative(MODS, target).split(sep)[0] ?? ""
        const listed = Object.values(manifest(other).exports ?? {}).map((path) => resolve(MODS, other, path))
        if (!listed.includes(target)) found.push(`${name}: reaches into mod ${other} past its exports (${spec})`)
        else if (inDomain) found.push(`${name}: the domain imports another mod (${spec})`)
        continue
      }
      found.push(`${name}: imports outside the mods and lib (${spec})`)
    }
  }
  return found
}

const mods = readdirSync(MODS).filter((name) => existsSync(join(MODS, name, "package.json")))
const migrated = mods.filter((mod) => manifest(mod).domain !== undefined)

describe("mod layout", () => {
  for (const mod of migrated) test(`${mod} keeps the layout`, () => expect(violations(mod)).toEqual([]))
  for (const mod of mods.filter((name) => !migrated.includes(name))) test.todo(`${mod} is not on the layout yet`, () => {})
})
