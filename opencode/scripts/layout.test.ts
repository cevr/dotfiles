/**
 * The layout checks that are not imports (ARCHITECTURE.md §Layout; oxlint
 * fences the imports): every mod that has its `cmd/<mod>` package names its
 * files and folders by concept, never by kind, and keeps no source at a
 * kind-named path.
 *
 * Mods without a `cmd/` package are not on the layout yet and are listed as
 * pending.
 *
 * @module
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

const ROOT = join(import.meta.dir, "..")
const MODS = join(ROOT, "mods")
const CMD = join(ROOT, "cmd")

const KIND_SUFFIX = /\.(aggregate|command|view|policy|saga|projection|external|rejection|id|model|plugin|story|tui)\.tsx?$/
const KIND_FOLDERS = new Set(["host", "src", "test", "tests", "commands", "services", "domain", "adapters", "lib"])

const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : []
  })

/** Every file in `dir` named by kind, or under a folder named by kind. */
export const kindNamed = (dir: string): ReadonlyArray<string> =>
  sources(dir).flatMap((file) => {
    const name = relative(dir, file)
    const folders = name.split(sep).slice(0, -1).filter((folder) => KIND_FOLDERS.has(folder))
    return [
      ...folders.map((folder) => `${name}: folder ${folder}/ is named by kind`),
      ...(KIND_SUFFIX.test(name) ? [`${name}: named by kind, not by concept`] : []),
    ]
  })

const mods = readdirSync(MODS).filter((name) => existsSync(join(MODS, name, "package.json")))
const onLayout = (mod: string) => existsSync(join(CMD, mod, "package.json"))

describe("mod layout", () => {
  for (const mod of mods.filter(onLayout)) {
    test(`${mod} names its files by concept`, () => expect(kindNamed(join(MODS, mod))).toEqual([]))
    test(`cmd/${mod} names its files by concept`, () => expect(kindNamed(join(CMD, mod))).toEqual([]))
  }
  for (const mod of mods.filter((name) => !onLayout(name))) test.todo(`${mod} is not on the layout yet`, () => {})
})
