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
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import path from "node:path"

const dev = process.env.OPENCODE_DEV
if (!dev) {
  console.error("OPENCODE_DEV is not set: point it at an OpenCode checkout, e.g. the prime-look Rift.")
  process.exit(1)
}
const target = path.resolve(dev, "packages/tui/node_modules")
if (!existsSync(path.join(target, "@opencode/plugin"))) {
  console.error(`${target} has no @opencode/plugin: run bun install in ${dev} first.`)
  process.exit(1)
}

const forkModules = path.join("packages", "tui", "node_modules") + path.sep
const root = path.resolve(import.meta.dir, "..")
const children = (dir: string) => (existsSync(dir) ? readdirSync(dir).map((name) => path.join(dir, name)) : [])
const packages = [...children(path.join(root, "mods")), ...children(path.join(root, "cmd")), path.join(root, "decider")].filter(
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

/** Links each entry of `from` missing in `into`; a scope both have is merged one level down. */
const merge = (from: string, into: string) => {
  for (const name of readdirSync(from)) {
    if (name === ".cache") continue
    const source = path.join(from, name)
    const link = path.join(into, name)
    const current = linkOf(link)
    if (current === undefined) symlinkSync(source, link)
    else if (current === "real" && name.startsWith("@") && lstatSync(link).isDirectory()) merge(source, link)
    // A link into this fork, or into another checkout's packages/tui/node_modules, is ours to repoint.
    else if (current !== "real" && current !== source && current.includes(forkModules)) {
      rmSync(link)
      symlinkSync(source, link)
    }
  }
}

for (const dir of packages) {
  const modules = path.join(dir, "node_modules")
  // An older checkout linked the whole directory to a fork: replace the link with a directory.
  if (linkOf(modules) !== undefined && linkOf(modules) !== "real") rmSync(modules)
  mkdirSync(modules, { recursive: true })
  merge(target, modules)
}
