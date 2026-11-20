// The one check every script that takes OPENCODE_DEV runs before it uses the
// fork (link-fork, and through it the gate and typecheck; accept; daily):
// the path is an OpenCode checkout on this machine with its TUI package
// installed, every module that package installed resolves here, and the install
// is the checkout's own (no exact pin linked at another version). A path
// from another machine (a Mac path on the workbox), an unexpanded `~`, a folder
// that is not a checkout and an install copied from elsewhere all fail it, so
// nothing links to a module that is not there.
//
// Every caller takes the fork through `readyFork`, which first removes the one
// stray link-fork itself ever wrote into a fork (below), so an older checkout's
// run does not leave a fork that every caller then refuses.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs"
import { hostname } from "node:os"
import path from "node:path"

/** The TUI package's modules, relative to the fork: what link-fork links into every package. */
export const FORK_MODULES = "packages/tui/node_modules"

/** The folder under ~/.local/state that holds link-fork's anchors, one per checkout. */
export const ANCHORS = "opencode-fork"

/** sim-tui's extra links: the fork TUI's test folder (its fixture and preload) and the protocol package, by where they sit from the anchor. */
export const SIM_TUI: ReadonlyArray<readonly [string, string]> = [
  ["@opencode-tui/test", "../test"],
  ["@opencode/protocol", "../../protocol"],
]

/**
 * Removes link-fork's own stray from the fork's modules. A link-fork before 2026-11-13 linked sim-tui's scope folders
 * whole to the fork's, so sim-tui's extra links went through them into the fork's own modules, as text relative to
 * a checkout that points nowhere from there; the check refuses such a fork. Such a link is ours: it names the
 * anchors folder. A link of the fork's own is never touched.
 */
const removeStray = (modules: string) => {
  for (const [name] of SIM_TUI) {
    const scope = path.join(modules, path.dirname(name))
    if (!existsSync(scope)) continue
    for (const entry of readdirSync(scope, { withFileTypes: true }).filter((each) => each.name === path.basename(name) && each.isSymbolicLink()))
      if (readlinkSync(path.join(scope, entry.name)).includes(path.sep + ANCHORS + path.sep)) rmSync(path.join(scope, entry.name))
  }
}

/**
 * The fork in OPENCODE_DEV (`dev`), ready for a script to use: link-fork's own stray removed from it, then checked
 * (`checkFork`). link-fork, accept, daily and post-land all take the fork through it.
 */
export const readyFork = (dev: string | undefined): Fork => {
  if (dev === undefined || dev === "") return { problem: "OPENCODE_DEV is not set: point it at an OpenCode checkout, e.g. the prime-look Rift." }
  removeStray(path.join(path.resolve(dev), FORK_MODULES))
  return checkFork(dev)
}

export type Fork = { readonly fork: string; readonly modules: string } | { readonly problem: string }

/** The entries of `modules` (one level into scopes) that are links resolving to nothing. */
const broken = (modules: string): ReadonlyArray<string> =>
  readdirSync(modules).flatMap((name) => {
    if (name === ".cache") return []
    const entry = path.join(modules, name)
    const stat = lstatSync(entry)
    if (stat.isSymbolicLink()) return existsSync(entry) ? [] : [`${name} -> ${readlinkSync(entry)}`]
    return name.startsWith("@") && stat.isDirectory() ? broken(entry).map((each) => `${name}/${each}`) : []
  })

/** Checks OPENCODE_DEV (`dev`) names an installed OpenCode checkout here; `problem` says what is wrong and how to fix it. */
const checkFork = (dev: string): Fork => {
  const fork = path.resolve(dev)
  const modules = path.join(fork, FORK_MODULES)
  const expected = `an OpenCode checkout with its packages installed (${FORK_MODULES})`
  if (dev.startsWith("~")) return { problem: `OPENCODE_DEV is '${dev}': the ~ reached the script unexpanded. Write the path with $HOME (OPENCODE_DEV=$HOME/${dev.slice(2)}).` }
  if (!existsSync(fork)) return { problem: `OPENCODE_DEV is '${dev}', which does not exist on this machine (${hostname()}): expected ${expected} there. A path from another machine needs this machine's checkout instead.` }
  if (!existsSync(path.join(fork, "packages/tui/package.json")))
    return { problem: `OPENCODE_DEV is '${dev}', which is not an OpenCode checkout: expected packages/tui/package.json in it.` }
  for (const name of ["@opencode/plugin", "solid-js"])
    if (!existsSync(path.join(modules, name))) return { problem: `${modules} has no ${name}: run bun install in ${fork} first.` }
  const bad = broken(modules)
  if (bad.length > 0)
    return { problem: `${modules} has ${bad.length} modules that point nowhere on this machine (${bad.slice(0, 3).join(", ")}${bad.length > 3 ? ", …" : ""}): run bun install in ${fork}.` }
  const stale = staleInstall(fork)
  if (stale.length > 0)
    return {
      problem: `${fork}'s install is not its checkout's (moved without an install?): ${stale.slice(0, 3).join("; ")}${stale.length > 3 ? "; …" : ""}. Run bun install --frozen-lockfile in ${fork}.`,
    }
  return { fork, modules }
}

/** A version a package.json pins exactly (no range, alias or protocol). */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/** The version in a link into Bun's isolated store: `…/.bun/<name, / as +>@<version>[+<hash>]/node_modules/<name>`. */
const STORE = /\/\.bun\/[^/]+?@([^/@+]+)(?:\+[^/]*)?\/node_modules\//

const readJson = (file: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** The fork's workspace package folders: its root package.json's `workspaces` globs, each `dir` or `dir/*`. */
const workspaceDirs = (fork: string, workspaces: unknown): ReadonlyArray<string> => {
  const globs = Array.isArray(workspaces) ? workspaces : record(workspaces)["packages"]
  if (!Array.isArray(globs)) return []
  return globs
    .filter((glob): glob is string => typeof glob === "string")
    .flatMap((glob) => {
      if (!glob.endsWith("/*")) return [path.join(fork, glob)]
      const parent = path.join(fork, glob.slice(0, -2))
      if (!existsSync(parent)) return []
      return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(parent, entry.name))
    })
    .filter((dir) => existsSync(path.join(dir, "package.json")))
}

/**
 * The exact pins of the fork's workspace packages (`catalog:` read from the root's catalog) that its
 * install links at another version, each `<package folder>: <name> <installed>, pinned <wanted>`. A
 * checkout moved to a commit whose lockfile differs, with no install after (2026-11-20: prime-look
 * reset from a merge that installed psychoscript 0.2.1 back to a commit pinning 0.1.2), runs the
 * old packages against the new source: Code Mode's `execute` hung and tests/image.test.ts went red
 * with nothing of ours changed. Only links into Bun's store are read; a pin with no link is skipped.
 */
export const staleInstall = (fork: string): ReadonlyArray<string> => {
  const root = readJson(path.join(fork, "package.json"))
  const workspaces = root["workspaces"]
  const catalog = record(record(workspaces)["catalog"] ?? root["catalog"])
  return workspaceDirs(fork, workspaces).flatMap((dir) => {
    const manifest = readJson(path.join(dir, "package.json"))
    const pins = ["dependencies", "devDependencies", "optionalDependencies"].flatMap((field) => Object.entries(record(manifest[field])))
    return pins.flatMap(([name, spec]) => {
      const wanted = spec === "catalog:" ? catalog[name] : spec
      if (typeof wanted !== "string" || !EXACT.test(wanted)) return []
      const link = path.join(dir, "node_modules", name)
      let target: string
      try {
        if (!lstatSync(link).isSymbolicLink()) return []
        target = readlinkSync(link)
      } catch {
        return []
      }
      const installed = STORE.exec(target.split(path.sep).join("/"))?.[1]
      if (installed === undefined || installed === wanted) return []
      return [`${path.relative(fork, dir)}: ${name} ${installed}, pinned ${wanted}`]
    })
  })
}
