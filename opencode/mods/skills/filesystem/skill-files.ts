// SkillFiles over the filesystem, by OpenCode's own rules
// (packages/core/src/config/discovery.ts, config/plugin/skill-scan.ts and
// skill-file.ts in the fork):
//
// - Local folders: `.opencode/skills`, `.opencode/skill`, `.claude/skills` and
//   `.agents/skills` in the working directory and each parent up to the root,
//   nearest first, less any folder inside a global root.
// - Global folders: `skills` and `skill` in OpenCode's config directory, then
//   `.claude/skills` and `.agents/skills` in the home directory.
// - In each folder: a directory holding SKILL.md is one skill, named by the
//   directory, and is not searched further; a `.md` file at the top is one
//   skill named by its file; hidden and ignored directories are skipped; the
//   search goes 6 levels deep. Files without valid frontmatter are skipped.
import { Effect, Layer } from "effect"
import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { SkillFiles } from "../service.ts"
import type { Found, Tier } from "../tier.ts"

export interface Roots {
  /** The working directory. */
  readonly directory: string
  /** The home directory (OpenCode's `Global.home`). */
  readonly home: string
  /** OpenCode's config directory (`Global.config`, `~/.config/opencode`). */
  readonly config: string
}

const MAX_DEPTH = 6
// FSUtil.ignoredDirectories (packages/util/src/fs-util.ts).
const IGNORED = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__"])

const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const entries = (directory: string): ReadonlyArray<Dirent> => {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

const kind = (entry: Dirent, path: string): "file" | "directory" | "other" => {
  if (entry.isFile()) return "file"
  if (entry.isDirectory()) return "directory"
  if (!entry.isSymbolicLink()) return "other"
  try {
    const info = statSync(path)
    return info.isDirectory() ? "directory" : info.isFile() ? "file" : "other"
  } catch {
    return "other"
  }
}

/** The skill files in one folder, sorted, as SkillScan.scan lists them. */
const scanFolder = (root: string): ReadonlyArray<string> => {
  const files: Array<string> = []
  const queue = [{ directory: root, depth: 0 }]
  for (const item of queue) {
    const children = entries(item.directory)
      .filter((entry) => !entry.name.startsWith(".") && !IGNORED.has(entry.name))
      .map((entry) => {
        const path = join(item.directory, entry.name)
        return { name: entry.name, path, type: kind(entry, path) }
      })
    const skill = children.find((child) => child.type === "file" && child.name === "SKILL.md")
    if (skill) {
      files.push(skill.path)
      continue
    }
    if (item.depth === 0) files.push(...children.filter((child) => child.type === "file" && child.name.endsWith(".md")).map((child) => child.path))
    if (item.depth < MAX_DEPTH) queue.push(...children.filter((child) => child.type === "directory").map((child) => ({ directory: child.path, depth: item.depth + 1 })))
  }
  return files.toSorted()
}

/** A frontmatter value as a string, or undefined. */
const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/** One file parsed as SkillFile.parse does, or undefined when it is not a skill. */
const parse = (folder: string, path: string, tier: Tier): Found | undefined => {
  let contents: string
  try {
    contents = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  if (!contents) return undefined
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(contents)
  let data: unknown = {}
  if (match) {
    try {
      data = Bun.YAML.parse(match[1] ?? "") ?? {}
    } catch {
      return undefined
    }
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined
  const fields: Record<string, unknown> = { ...data }
  if (fields.name !== undefined && typeof fields.name !== "string") return undefined
  if (fields.description !== undefined && typeof fields.description !== "string") return undefined
  const id = dirname(path) === folder && basename(path) !== "SKILL.md" ? basename(path, ".md") : basename(dirname(path))
  const description = text(fields.description)
  return {
    id,
    name: text(fields.name) ?? id,
    ...(description === undefined ? {} : { description }),
    path,
    content: match ? contents.slice(match[0].length) : contents,
    tier,
  }
}

/** Every directory from `start` up to the filesystem root, nearest first. */
const ancestors = (start: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  for (let current = resolve(start); ; current = dirname(current)) {
    found.push(current)
    if (dirname(current) === current) return found
  }
}

/** The folders each tier reads, in order. */
export const folders = (roots: Roots): { readonly local: ReadonlyArray<string>; readonly global: ReadonlyArray<string> } => {
  const global = [join(roots.config, "skills"), join(roots.config, "skill"), join(roots.home, ".claude", "skills"), join(roots.home, ".agents", "skills")]
  const globalRoots = [roots.config, join(roots.home, ".claude"), join(roots.home, ".agents")].map(real)
  const insideGlobal = (folder: string) => {
    const path = real(folder)
    return globalRoots.some((root) => path === root || path.startsWith(root + sep))
  }
  const local = ancestors(roots.directory)
    .flatMap((directory) => [".opencode/skills", ".opencode/skill", ".claude/skills", ".agents/skills"].map((folder) => join(directory, folder)))
    .filter((folder) => !insideGlobal(folder))
  return { local, global }
}

/** Reads the folders of both tiers afresh on every scan. */
export const layer = (roots: Roots): Layer.Layer<SkillFiles> =>
  Layer.succeed(
    SkillFiles,
    SkillFiles.of({
      scan: Effect.sync(() => {
        const tiers = folders(roots)
        const read = (tier: Tier) => (folder: string) => scanFolder(folder).flatMap((path) => parse(folder, path, tier) ?? [])
        return [...tiers.local.flatMap(read("local")), ...tiers.global.flatMap(read("global"))]
      }).pipe(Effect.withSpan("SkillFiles.scan")),
    }),
  )
