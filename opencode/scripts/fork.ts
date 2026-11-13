// The one check every script that takes OPENCODE_DEV runs before it uses the
// fork (link-fork, and through it the gate and typecheck; accept; daily):
// the path is an OpenCode checkout on this machine with its TUI package
// installed, and every module that package installed resolves here. A path
// from another machine (a Mac path on the workbox), an unexpanded `~`, a folder
// that is not a checkout and an install copied from elsewhere all fail it, so
// nothing links to a module that is not there.
//
// Every caller takes the fork through `readyFork`, which first removes the one
// stray link-fork itself ever wrote into a fork (below), so an older checkout's
// run does not leave a fork that every caller then refuses.
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync } from "node:fs"
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
  return { fork, modules }
}
