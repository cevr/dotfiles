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
import { Option, Schema } from "effect"

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
    return { problem: `${fork}'s install is not its checkout's (moved without an install?): ${stale.join("; ")}. Run bun install --frozen-lockfile in ${fork}.` }
  return { fork, modules }
}

/** A version a package.json pins exactly (no range, alias or protocol). */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/** The version in a link into Bun's isolated store: `…/.bun/<name, / as +>@<version>[+<hash>]/node_modules/<name>`. */
const STORE = /\/\.bun\/[^/]+?@([^/@+]+)(?:\+[^/]*)?\/node_modules\//

const Pins = Schema.Record(Schema.String, Schema.String)
const Globs = Schema.Array(Schema.String)
/** The fields of a workspace package's package.json the check reads. */
const Manifest = Schema.Struct({
  dependencies: Schema.optionalKey(Pins),
  devDependencies: Schema.optionalKey(Pins),
  optionalDependencies: Schema.optionalKey(Pins),
})
/** The fields of the fork's root package.json the check reads: `workspaces` as globs, or as `{ packages, catalog }`. */
const Root = Schema.Struct({
  workspaces: Schema.optionalKey(Schema.Union([Globs, Schema.Struct({ packages: Schema.optionalKey(Globs), catalog: Schema.optionalKey(Pins) })])),
  catalog: Schema.optionalKey(Pins),
})
type RootPackage = typeof Root.Type
const decodeRoot = Schema.decodeUnknownOption(Schema.fromJsonString(Root))
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))
const isGlobs = Schema.is(Globs)

/** A file's text, none when it is not there. */
const textOf = (file: string) => Option.map(Option.liftPredicate(file, existsSync), (there) => readFileSync(there, "utf8"))
/** A package.json's pins as pairs, none for an absent field. */
const pairs = (pins: Option.Option<typeof Pins.Type>) => Object.entries(Option.getOrElse(pins, () => ({})))

/** The root's `workspaces` globs. */
const globsOf = (root: RootPackage): ReadonlyArray<string> =>
  Option.match(Option.fromUndefinedOr(root.workspaces), {
    onNone: () => [],
    onSome: (workspaces) => {
      if (isGlobs(workspaces)) return workspaces
      return Option.getOrElse(Option.fromUndefinedOr(workspaces.packages), () => [])
    },
  })

/** The root's catalog, under `workspaces` or beside it. */
const catalogOf = (root: RootPackage): ReadonlyMap<string, string> => {
  const nested = Option.flatMap(Option.fromUndefinedOr(root.workspaces), (workspaces) => {
    if (isGlobs(workspaces)) return Option.none<typeof Pins.Type>()
    return Option.fromUndefinedOr(workspaces.catalog)
  })
  return new Map([...pairs(Option.fromUndefinedOr(root.catalog)), ...pairs(nested)])
}

/** The fork's workspace package folders: each glob `dir` or `dir/*` with a package.json. */
const workspaceDirs = (fork: string, globs: ReadonlyArray<string>): ReadonlyArray<string> =>
  globs
    .flatMap((glob) => {
      if (!glob.endsWith("/*")) return [path.join(fork, glob)]
      const parent = path.join(fork, glob.slice(0, -2))
      if (!existsSync(parent)) return []
      return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(parent, entry.name))
    })
    .filter((dir) => existsSync(path.join(dir, "package.json")))

/** The version a pin wants: the catalog's for `catalog:`, else the pin itself; none when it is not one exact version. */
const wantedOf = (catalog: ReadonlyMap<string, string>, name: string, spec: string) => {
  const wanted = Option.liftPredicate(spec, (each) => each !== "catalog:").pipe(Option.orElse(() => Option.fromUndefinedOr(catalog.get(name))))
  return Option.filter(wanted, (version) => EXACT.test(version))
}

/** The store version the symlink `link` points into, none for no link or one outside Bun's store. */
const installedAt = (link: string) =>
  Option.fromUndefinedOr(lstatSync(link, { throwIfNoEntry: false })).pipe(
    Option.filter((stat) => stat.isSymbolicLink()),
    Option.flatMap(() => Option.fromNullishOr(STORE.exec(readlinkSync(link).split(path.sep).join("/")))),
    Option.flatMap((match) => Option.fromUndefinedOr(match[1])),
  )

/**
 * The exact pins of the fork's workspace packages (`catalog:` read from the root's catalog) that its
 * install links at another version, each `<package folder>: <name> <installed>, pinned <wanted>`. A
 * checkout moved to a commit whose lockfile differs, with no install after (2026-11-20: prime-look
 * reset from a merge that installed psychoscript 0.2.1 back to a commit pinning 0.1.2), runs the
 * old packages against the new source: Code Mode's `execute` hung and tests/image.test.ts went red
 * with nothing of ours changed. Only links into Bun's store are read; a pin with no link is skipped.
 */
export const staleInstall = (fork: string): ReadonlyArray<string> =>
  Option.match(Option.flatMap(textOf(path.join(fork, "package.json")), decodeRoot), {
    onNone: () => [],
    onSome: (root) => {
      const catalog = catalogOf(root)
      return workspaceDirs(fork, globsOf(root)).flatMap((dir) => {
        const manifest = Option.flatMap(textOf(path.join(dir, "package.json")), decodeManifest)
        const pins = Option.match(manifest, {
          onNone: () => [],
          onSome: (each) => [each.dependencies, each.devDependencies, each.optionalDependencies].flatMap((field) => pairs(Option.fromUndefinedOr(field))),
        })
        return pins.flatMap(([name, spec]) =>
          Option.toArray(
            Option.flatMap(wantedOf(catalog, name, spec), (wanted) =>
              Option.map(
                Option.filter(installedAt(path.join(dir, "node_modules", name)), (installed) => installed !== wanted),
                (installed) => `${path.relative(fork, dir)}: ${name} ${installed}, pinned ${wanted}`,
              ),
            ),
          ),
        )
      })
    },
  })
