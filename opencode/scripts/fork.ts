// The one check every script that takes OPENCODE_DEV runs before it uses the
// fork (link-fork, and through it the gate and typecheck; accept; daily):
// the path is an OpenCode checkout on this machine with its TUI package
// installed, and every module that package installed resolves here. A path
// from another machine (a Mac path on the workbox), an unexpanded `~`, a folder
// that is not a checkout and an install copied from elsewhere all fail it, so
// nothing links to a module that is not there.
import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs"
import { hostname } from "node:os"
import path from "node:path"

/** The TUI package's modules, relative to the fork: what link-fork links into every package. */
export const FORK_MODULES = "packages/tui/node_modules"

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
export const checkFork = (dev: string | undefined): Fork => {
  if (dev === undefined || dev === "") return { problem: "OPENCODE_DEV is not set: point it at an OpenCode checkout, e.g. the prime-look Rift." }
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
