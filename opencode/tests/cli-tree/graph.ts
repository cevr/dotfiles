/**
 * The import graph of a checkout or an installed tree, read from its sources: what a seed reaches at runtime
 * (type-only imports left out), the packages a bare import loads from, the copies of `effect` a command's graph
 * reaches, and the Effect pins and copies an install's manifest and lock hold. `scripts/runtime-imports.test.ts`
 * reads the checkout with it, `tests/cli-tree-installed.test.ts` the installed tree `TREE_OPENCODE` names.
 *
 * Synchronous, so a plain `bun:test` case runs it. The caller hands it how to read a file (`graphOf(read)`): a read
 * that fails throws, so a file the walk cannot read (a sealed tree's sources refuse Bun's `mmap`, which opens them
 * for writing) fails the check instead of reading as empty.
 */
import { JSONC, resolveSync, Transpiler } from "bun"
import { Array as Arr, Match, Option, Order, Schema } from "effect"
import { builtin } from "../../mods/update/filestore/trees.ts"

const typescript = new Transpiler({ loader: "ts" })
const tsx = new Transpiler({ loader: "tsx" })
/** The transpiler of a source: TSX for `.tsx`, TypeScript for the rest. */
const transpilerOf = (file: string) =>
  Match.value(file.endsWith(".tsx")).pipe(
    Match.when(true, () => tsx),
    Match.orElse(() => typescript),
  )

/** The directory part of a path. */
const dirOf = (file: string): string => file.slice(0, file.lastIndexOf("/")) || "/"

/** Whether `file` is `root` or under it. */
export const within = (root: string, file: string) => file === root || file.startsWith(`${root}/`)

/** `file` from `root`, when it is under it; else `file` itself. */
const relativeTo = (root: string, file: string) =>
  Match.value(within(root, file) && file !== root).pipe(
    Match.when(true, () => file.slice(root.length + 1)),
    Match.orElse(() => file),
  )

/** A workspace import: a relative path, or a workspace package by its `@dotfiles/` name. */
const workspaceImport = (specifier: string) => specifier.startsWith(".") || specifier.startsWith("@dotfiles/")

/** A workspace source the walk descends into: ours, not a dependency's, and code. */
const ours = (file: string) => file.startsWith("/") && !file.includes("/node_modules/") && /\.(ts|tsx|js|mjs)$/.test(file)

/** Whether Bun or Node serves `specifier` itself (the tree check's own list, `filestore/trees.ts` `builtin`). */
export const builtinModule = builtin

/** Whether `specifier` resolves, exactly, from the file `importer`. */
export const resolvesFrom = (specifier: string, importer: string) => Option.isSome(Option.liftThrowable(() => resolveSync(specifier, dirOf(importer)))())

/** A target as the repo names it: a workspace file by its path from `root`, a package by its specifier. */
export const nameAt = (root: string, target: string) =>
  Match.value(target.startsWith("/")).pipe(
    Match.when(true, () => relativeTo(root, target)),
    Match.orElse(() => target),
  )

/** Whether `target`, reached from the checkout at `root`, is one of `forbidden`. */
export const forbiddenAt = (root: string, target: string, forbidden: ReadonlyArray<RegExp>) => forbidden.some((pattern) => pattern.test(nameAt(root, target)))

/**
 * A platform implementation: a server plugin takes `FileSystem`, `Path` and `ChildProcessSpawner` from its
 * host (since the fork's platform floor, mods/update/process/pin.ts `PLATFORM_FLOOR`) and imports only their
 * tags from `effect`, never an implementation, even one plain Bun could resolve from the tree's install.
 */
export const PLATFORM_IMPL = [/^@effect\/platform-(node|bun)(\/|$)/]

/** The package a bare import names: its first part, or its first two for a scoped package. */
export const packageOf = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, 1 + Number(specifier.startsWith("@")))
    .join("/")

/** A manifest's runtime pin of `name`, or "(unpinned)". */
export const pinIn = (manifest: { readonly dependencies?: Readonly<Record<string, string>> }, name: string) =>
  Option.getOrElse(Option.fromNullishOr(manifest.dependencies?.[name]), () => "(unpinned)")

/** `pinsAt` of an install on one Effect release, `pinned`: one copy of each, all at it. */
export const expectedPins = (pinned: string) => ({
  effect: pinned,
  platform: pinned,
  copies: [
    ["@effect/platform-bun", `@effect/platform-bun@${pinned}`] as const,
    ["@effect/platform-node", `@effect/platform-node@${pinned}`] as const,
    ["@effect/platform-node-shared", `@effect/platform-node-shared@${pinned}`] as const,
    ["effect", `effect@${pinned}`] as const,
  ],
})

/** What these checks read of a package's `package.json`. */
const Manifest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))

/** What these checks read of `bun.lock`: its packages table, each entry's first element the resolution `<name>@<version>`. */
const decodeLock = Schema.decodeUnknownSync(Schema.Struct({ packages: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)) }))

/** The graph helpers over files `read` reads (it throws when a file does not read). */
export const graphOf = (read: (file: string) => string) => {
  /**
   * One file's runtime imports: a workspace one as the real path it resolves to (Bun resolves every link), any other
   * as its package specifier (a dependency, or the JSX runtime the TSX transform adds).
   */
  const importsOf = (file: string) =>
    transpilerOf(file)
      .scanImports(read(file).replace(/^#!.*\n/, "\n"))
      .map((each) =>
        Match.value(workspaceImport(each.path)).pipe(
          Match.when(true, () => resolveSync(each.path, dirOf(file))),
          Match.orElse(() => each.path),
        ),
      )

  /** Every module `seed` (a path from `root`) reaches at runtime, each with the file (from `root`) that first imports it. */
  const reachOf = (seed: string, root: string) => {
    const reached = new Map<string, string>()
    const pending = [`${root}/${seed}`]
    for (const file of pending)
      for (const target of importsOf(file)) {
        if (reached.has(target)) continue
        reached.set(target, relativeTo(root, file))
        if (ours(target)) pending.push(target)
      }
    return reached
  }

  /** Each module of `forbidden` that `seed` reaches from `root`, named with its importer. */
  const breaches = (seed: string, forbidden: ReadonlyArray<RegExp>, root: string) =>
    reachOf(seed, root)
      .entries()
      .filter(([target]) => forbiddenAt(root, target, forbidden))
      .map(([target, importer]) => `${seed} reaches ${nameAt(root, target)} through ${importer}`)
      .toArray()

  /** Each bare import `seed`'s graph reaches from `root` that is no built-in, with its importer. */
  const bareOf = (seed: string, root: string) =>
    reachOf(seed, root)
      .entries()
      .filter(([target]) => !target.startsWith("/") && !builtinModule(target))
      .toArray()

  /** The `package.json` in `dir`. */
  const manifestAt = (dir: string) => decodeManifest(read(`${dir}/package.json`))

  /** The real directory of the package `name` as Bun resolves it from `dir`: the nearest `package.json` named `name` above what it resolves to. */
  const packageDirFrom = (name: string, dir: string): Option.Option<string> =>
    Option.liftThrowable(() => resolveSync(name, dir))().pipe(
      Option.flatMap((file) =>
        Arr.findFirst(
          Arr.unfold(dirOf(file), (at) => Option.liftPredicate([at, dirOf(at)] as const, () => at !== dirOf(at))),
          (at) => Option.exists(Option.liftThrowable(() => manifestAt(at))(), (each) => each.name === name),
        ),
      ),
    )

  /**
   * Every copy of `effect` `seed`'s graph loads from `root`: each one its graph imports, and each one a package
   * it imports reaches through its own dependencies and peers (a platform layer and its shared node half),
   * keyed by who reaches it and valued by its version. On a tree with no links each key's real directory is one.
   */
  const effectsOf = (seed: string, root: string) => {
    const found = new Map<string, string>()
    const visited = new Set<string>()
    const versionAt = (dir: string) => manifestAt(dir).version ?? "(none)"
    const descend = (dir: string, via: string) => {
      if (visited.has(dir)) return
      visited.add(dir)
      const manifest = manifestAt(dir)
      for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }))
        for (const at of Option.toArray(packageDirFrom(name, dir))) {
          if (name === "effect") found.set(`${via} -> ${at}`, versionAt(at))
          else descend(at, `${via}/${name}`)
        }
    }
    for (const [target, importer] of bareOf(seed, root))
      for (const at of Option.toArray(packageDirFrom(packageOf(target), dirOf(`${root}/${importer}`)))) {
        if (packageOf(target) === "effect") found.set(`${importer} -> ${at}`, versionAt(at))
        else descend(at, packageOf(target))
      }
    return found
  }

  /**
   * The install's Effect at `root`: the runtime pins of `effect` and `@effect/platform-bun` in its `package.json`,
   * and every copy of `effect` and of an `@effect/platform-*` package its `bun.lock` (parsed) resolves. An install that
   * nests a second copy anywhere (a key `<dependent>/effect`) or moves one off the pin differs (package.json `overrides`).
   */
  const pinsAt = (root: string) => {
    const lock = decodeLock(JSONC.parse(read(`${root}/bun.lock`)))
    const copies = Arr.sort(
      Object.entries(lock.packages)
        .filter(([key]) => /(^|\/)(effect|@effect\/platform-[a-z-]+)$/.test(key))
        .map(([key, entry]) => [key, String(entry[0])] as const),
      Order.mapInput(Order.String, ([key]: readonly [string, string]) => key),
    )
    const manifest = manifestAt(root)
    return { effect: pinIn(manifest, "effect"), platform: pinIn(manifest, "@effect/platform-bun"), copies }
  }

  return { reachOf, breaches, bareOf, manifestAt, packageDirFrom, effectsOf, pinsAt }
}
