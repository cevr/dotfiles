// Links the host's modules (Effect, the plugin API, OpenTUI, Solid) from the
// OpenCode checkout in OPENCODE_DEV into every workspace package's
// node_modules (mods/*, cmd/*, decider), so the plugins and the kit they share
// typecheck and test against one copy of them. At runtime OpenCode provides
// these modules itself; the links are for tooling.
//
// Each package's node_modules is a real directory that Bun owns: it holds the
// workspace links (`@dotfiles/*`) and vendor packages Bun installs. This script
// adds one link per entry of the fork's node_modules that Bun did not put
// there. Run it before `bun install` (an older checkout linked the whole
// directory to the fork, and an install through that link would write into
// the fork) and again after it: an install that changes a package's
// node_modules drops the links it did not make. The TUI plugins resolve
// `solid-js` through these links when OpenCode loads them.
//
// It checks the fork first (scripts/fork.ts) and touches nothing when the
// check fails: a path from another machine, or a fork whose own install points
// nowhere, would leave every TUI plugin without `solid-js`. A link of ours that
// points nowhere, left by a run against a fork that is gone, is removed.
//
// The links go through an anchor outside the checkout: one link per checkout
// in ~/.local/state/opencode-fork (OPENCODE_FORK_ANCHORS), named by the
// checkout's path under the home folder, to this machine's fork modules. Each
// package link is relative to that anchor, so its text is the same on every
// machine that holds the checkout at the same place under its home. Syncthing
// syncs the dotfiles, links included: absolute links from the Mac reached the
// workbox and pointed nowhere there, and every TUI plugin started then failed
// on `solid-js` (2026-11-11). With the anchor, a synced link resolves through
// the anchor of the machine reading it, and pointing a checkout at another
// fork rewrites one anchor and no synced file.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { checkFork, FORK_MODULES } from "./fork.ts"

const checked = checkFork(process.env.OPENCODE_DEV)
if ("problem" in checked) {
  console.error(`link-fork: ${checked.problem}`)
  process.exit(1)
}

const forkModules = path.normalize(FORK_MODULES) + path.sep
const root = path.resolve(import.meta.dir, "..")

const ANCHORS = "opencode-fork"
const anchors = process.env.OPENCODE_FORK_ANCHORS || path.join(homedir(), ".local/state", ANCHORS)
const underHome = path.relative(homedir(), root)
const anchor = path.join(anchors, underHome.startsWith("..") || path.isAbsolute(underHome) ? root.replace(/^[/\\]+/, "") : underHome, "modules")
const anchored = readAnchor()
if (anchored !== checked.modules) {
  if (anchored !== undefined) rmSync(anchor)
  mkdirSync(path.dirname(anchor), { recursive: true })
  symlinkSync(checked.modules, anchor)
}
const target = anchor

function readAnchor() {
  try {
    if (!lstatSync(anchor).isSymbolicLink()) {
      console.error(`link-fork: ${anchor} is not a link: move it away so the links can go through it.`)
      process.exit(1)
    }
    return readlinkSync(anchor)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
const children = (dir: string) => (existsSync(dir) ? readdirSync(dir).map((name) => path.join(dir, name)) : [])
const packages = [...children(path.join(root, "mods")), ...children(path.join(root, "cmd")), path.join(root, "decider"), path.join(root, "sim")].filter(
  (dir) => existsSync(path.join(dir, "package.json")),
)

const linkOf = (file: string) => {
  try {
    const stat = lstatSync(file)
    return stat.isSymbolicLink() ? readlinkSync(file) : "real"
  } catch {
    return undefined
  }
}

/** A link through an anchor, or (from an older run) straight into a fork's packages/tui/node_modules: ours to repoint or remove. */
const ours = (link: string | undefined): link is string =>
  link !== undefined && link !== "real" && (link.includes(path.sep + ANCHORS + path.sep) || link.includes(forkModules))

/** Removes the links of ours in `dir` (one level into scopes) that point nowhere. */
const prune = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const entry = path.join(dir, name)
    const current = linkOf(entry)
    if (ours(current) && !existsSync(entry)) rmSync(entry)
    else if (current === "real" && name.startsWith("@") && lstatSync(entry).isDirectory()) prune(entry)
  }
}

/** Links each entry of `from` missing in `into`; a scope both have is merged one level down. */
const merge = (from: string, into: string) => {
  for (const name of readdirSync(from)) {
    if (name === ".cache") continue
    const source = path.join(from, name)
    const link = path.join(into, name)
    const text = path.relative(into, source)
    const current = linkOf(link)
    if (current === undefined) symlinkSync(text, link)
    else if (current === "real" && name.startsWith("@") && lstatSync(link).isDirectory()) merge(source, link)
    else if (ours(current) && current !== text) {
      rmSync(link)
      symlinkSync(text, link)
    }
  }
}

for (const dir of packages) {
  const modules = path.join(dir, "node_modules")
  // An older checkout linked the whole directory to a fork: replace the link with a directory.
  if (linkOf(modules) !== undefined && linkOf(modules) !== "real") rmSync(modules)
  mkdirSync(modules, { recursive: true })
  prune(modules)
  merge(target, modules)
}
