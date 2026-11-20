import { file as fileAt, Glob, mmap, readableStreamToText, resolveSync, spawn, Transpiler } from "bun"
import { Array as Arr, Effect, Match, Option } from "effect"
import { buildName } from "../builds.ts"
import { removeMaking } from "./builds.ts"
import { UpdateFailed } from "../service.ts"
import { type Host, hostProvided, makingName, SEEDS, treeOf } from "../trees.ts"

/** Where trees are made, and what a make runs with. */
export interface Options {
  /** The share directory, where each build and its tree sit (`settings.ts` `shareDir`). */
  readonly share: string
  /** The git checkout whose object store holds the commits trees are made of; never checked out. */
  readonly checkout: string
  /** The bun that installs a tree and runs its own daily. */
  readonly bun: string
  /** The environment of a make's steps: PATH, HOME, and `OPENCODE_DEV` for the tree's own daily. */
  readonly env: Readonly<Record<string, string>>
  /** This process, which names its tree in the making (`trees.ts` `makingName`). */
  readonly pid: number
  /** More arguments for the tree's daily (`--tree`), such as `--checkout <live checkout>`. */
  readonly overlay: ReadonlyArray<string>
}

/** Where a make of `version` works, and where its tree then stands. */
export interface Place {
  readonly tree: string
  readonly making: string
}

/** The place of the tree of build `version` in `share`, made by process `pid`. */
export const placeOf = (share: string, version: string, pid: number): Place => {
  const tree = `${share}/${treeOf(buildName(version))}`
  return { tree, making: makingName(tree, pid) }
}

const failed = (step: string) => (cause: unknown) => new UpdateFailed({ step, message: String(cause) })

/** Runs `argv` in `cwd`; fails `step` with the end of what it printed when it exits other than 0. */
const run = (step: string, argv: ReadonlyArray<string>, cwd: string, env: Readonly<Record<string, string>>) =>
  Effect.try({ try: () => spawn([...argv], { cwd, env: { ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }), catch: failed(step) }).pipe(
    Effect.flatMap((child) =>
      Effect.all(
        {
          code: Effect.tryPromise({ try: () => child.exited, catch: failed(step) }),
          out: Effect.tryPromise({ try: () => readableStreamToText(child.stdout), catch: failed(step) }),
          err: Effect.tryPromise({ try: () => readableStreamToText(child.stderr), catch: failed(step) }),
        },
        { concurrency: "unbounded" },
      ),
    ),
    Effect.filterOrFail(
      (ran) => ran.code === 0,
      (ran) => new UpdateFailed({ step, message: `${argv.join(" ")} exited ${ran.code}: ${`${ran.out}\n${ran.err}`.trim().slice(-1500)}` }),
    ),
    Effect.asVoid,
  )

/** Node's built-in modules a source may name without `node:`. */
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "crypto",
  "dns",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
])

/** Whether every host serves `specifier` as a runtime built-in: Node's and Bun's own modules. */
const builtin = (specifier: string): boolean =>
  specifier.startsWith("node:") || specifier === "bun" || specifier.startsWith("bun:") || NODE_BUILTINS.has(specifier.split("/")[0] ?? specifier)

/** A workspace import: a relative path, or a workspace package by its `@dotfiles/` name. */
const workspaceImport = (specifier: string): boolean => specifier.startsWith(".") || specifier.startsWith("@dotfiles/")

const typescript = new Transpiler({ loader: "ts" })
/** TSX as the TUI's Solid transform sees it: its JSX runtime is OpenTUI's, which the TUI serves. */
const tsx = new Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "@opentui/solid" } } })

/** The transpiler of a source: TSX for `.tsx`, TypeScript for the rest. */
const transpilerOf = (file: string) =>
  Match.value(file.endsWith(".tsx")).pipe(
    Match.when(true, () => tsx),
    Match.orElse(() => typescript),
  )

/** The directory part of a path. */
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/"

/** Whether `path` is `root` or inside it. */
const within = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`)

/** A source the walk descends into: ours (inside `root`, outside every `node_modules`), and code. */
const ours = (root: string, file: string): boolean => within(root, file) && !file.includes("/node_modules/") && /\.(ts|tsx|js|mjs)$/.test(file)

/** Whether anything, a file or a directory, is at `path` (a link is followed). */
const exists = (path: string) =>
  Effect.tryPromise(() => fileAt(path).stat()).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

/** Where Bun loads `specifier` from when `file` imports it, every link resolved: none when it does not resolve. */
const resolved = (specifier: string, file: string): Option.Option<string> => Option.liftThrowable(() => resolveSync(specifier, dirOf(file)))()

/** A source's text, its `#!` line blanked; empty when it does not read. Synchronous, so the check runs anywhere, a plain test too. */
const sourceOf = (file: string): string =>
  Option.getOrElse(Option.liftThrowable(() => new TextDecoder().decode(mmap(file)))(), () => "").replace(/^#!.*\n/, "\n")

/** The package a bare import names: its first part, or its first two for a scoped package. */
const packageOf = (specifier: string): string =>
  specifier
    .split("/")
    .slice(0, Match.value(specifier.startsWith("@")).pipe(Match.when(true, () => 2), Match.orElse(() => 1)))
    .join("/")

/**
 * Whether a `node_modules` from `file`'s directory up to `root` holds the package `specifier` names as
 * an install put it there, inside `root`, with the links that leave `root` passed over: in a dev
 * checkout those are the fork's, made for typecheck and tests, which shadow the install's own copy a tree loads.
 */
const installedUp = (root: string, file: string, specifier: string): boolean =>
  Arr.unfold(dirOf(file), (dir) => Option.liftPredicate([dir, dirOf(dir)] as const, () => within(root, dir))).some((dir) =>
    Option.isSome(Option.filter(resolved(`./node_modules/${packageOf(specifier)}/package.json`, `${dir}/file`), (at) => within(root, at))),
  )

/** What one import lacks, if anything, and the source of ours it leads the walk on to, if any. */
interface Found {
  readonly problem: Option.Option<string>
  readonly next: Option.Option<string>
}

/** What one bare or workspace import of `file` lacks in `root` for `host`, if anything; and the source it leads the walk on to. */
const importOf = (root: string, host: Host, file: string, specifier: string): Found => {
  const target = Option.filter(resolved(specifier, file), (path) => within(root, path))
  const importer = file.slice(root.length + 1)
  const next = Option.filter(target, (path) => ours(root, path))
  if (builtin(specifier) || (!workspaceImport(specifier) && hostProvided(host, specifier))) return { problem: Option.none(), next: Option.none() }
  if (workspaceImport(specifier)) return { problem: Option.map(Option.filter(Option.some(specifier), () => Option.isNone(target)), () => `${importer} imports ${specifier}, which does not resolve inside the tree`), next }
  const lacking = Option.isNone(target) && !installedUp(root, file, specifier)
  return { problem: Option.map(Option.filter(Option.some(specifier), () => lacking), () => `${importer} imports ${specifier}, which the ${host} host does not serve and no install of the tree holds`), next }
}

/** The problems of one seed's walk: every source it reaches, each runtime import once per directory. */
const walk = (root: string, seed: string, host: Host): ReadonlyArray<string> => {
  const reached = new Set<string>()
  const pending = [`${root}/${seed}`]
  const problems: Array<string> = []
  for (const file of pending) {
    const source = sourceOf(file)
    // The imports the source names: the TSX transform adds React's runtime, which the TUI's own Solid transform does not.
    const scanned = Option.getOrElse(Option.liftThrowable(() => transpilerOf(file).scanImports(source))(), () => [])
    for (const { path: specifier } of scanned.filter((each) => source.includes(`"${each.path}"`) || source.includes(`'${each.path}'`))) {
      const key = `${dirOf(file)}\u0000${specifier}`
      if (reached.has(key)) continue
      reached.add(key)
      const found = importOf(root, host, file, specifier)
      problems.push(...Option.toArray(found.problem).map((problem) => `${seed} (${host}): ${problem}`))
      pending.push(...Option.toArray(Option.filter(found.next, (next) => !pending.includes(next))))
    }
  }
  return problems
}

/**
 * The runtime imports of every process a tree runs (`trees.ts` `SEEDS`), read from the sources under
 * `root` (a tree's `opencode/`, or a checkout's), that would not load in an install with no link
 * into the fork: each named with its seed and importer. A bare import counts as loading when its host
 * serves it (`trees.ts` `hostProvided`), when it is a runtime built-in, or when Bun loads it from inside
 * `root`, links resolved, or else an install's own copy is there under the fork's link (`installedUp`).
 * A workspace import must resolve inside `root`. Synchronous: the check's step and the gate's
 * `scripts/runtime-imports.test.ts` both run it.
 */
export const unresolvedImports = (root: string): ReadonlyArray<string> => {
  // The root as Bun resolves into it, every link (macOS's /var → /private/var too) resolved.
  const real = Option.getOrElse(Option.map(resolved("./package.json", `${root}/package.json`), dirOf), () => root)
  return SEEDS.flatMap(({ glob, host }) =>
    [...new Glob(glob).scanSync({ cwd: real })]
      .filter((file) => !/\.(test|bench)\.tsx?$/.test(file))
      .sort()
      .flatMap((seed) => walk(real, seed, host)),
  )
}

/**
 * Takes away every write permission under `dir`, but in each `node_modules`: on Linux Bun hardlinks a
 * package's files from its cache, so a mode change there would change the cache's own files. A link
 * is never followed. A file's mode changes without its directory's write bit, so the order is free.
 */
const seal = (dir: string, env: Readonly<Record<string, string>>) =>
  run("seal the tree", ["find", dir, "-name", "node_modules", "-prune", "-o", "!", "-type", "l", "-exec", "chmod", "a-w", "{}", "+"], dir, env)

/**
 * The steps of a make, in order, each on the tree in the making (`Place.making`), which nothing takes
 * for a tree: the commit's `opencode/` from the checkout's object store, its install, the tree's own
 * daily writing its entries and overlay (`scripts/daily.ts --tree`), the check, the seal, and last the
 * one rename into place. Exported so a test can stop between any two.
 */
export const steps = (options: Options, place: Place, commit: string) => {
  const opencode = `${place.making}/opencode`
  const archive = `${place.making}/opencode.tar`
  return [
    {
      name: "archive",
      run: Effect.gen(function* () {
        yield* run("make the tree's directory", ["mkdir", "-p", place.making], options.share, options.env)
        yield* run("archive the commit", ["git", "-C", options.checkout, "archive", "--format=tar", `--output=${archive}`, commit, "opencode"], place.making, options.env)
        yield* run("unpack the commit", ["tar", "-xf", archive, "-C", place.making], place.making, options.env)
        yield* Effect.tryPromise({ try: () => fileAt(archive).delete(), catch: failed("unpack the commit") })
      }),
    },
    { name: "install", run: run("install the tree", [options.bun, "install", "--frozen-lockfile"], opencode, options.env) },
    {
      name: "overlay",
      run: run("write the tree's entries and overlay", [options.bun, `${opencode}/scripts/daily.ts`, "--tree", place.making, "--at", place.tree, ...options.overlay], opencode, options.env),
    },
    { name: "check", run: check(place.making) },
    { name: "seal", run: seal(place.making, options.env) },
    {
      // A plain rename, never into a tree there: `mv` moves into a directory it finds at the target.
      name: "place",
      run: exists(place.tree).pipe(
        Effect.filterOrFail(
          (there) => !there,
          () => new UpdateFailed({ step: "place the tree", message: `${place.tree} appeared while it was made` }),
        ),
        Effect.andThen(run("place the tree", ["mv", place.making, place.tree], options.share, options.env)),
      ),
    },
  ] as const
}

/**
 * Checks a tree (made or in the making): both overlay files are there, and every runtime import of
 * every process it runs loads in it (`unresolvedImports`).
 */
export const check = (tree: string) =>
  Effect.gen(function* () {
    for (const file of ["config/opencode.json", "config/cli.json"]) {
      if (!(yield* exists(`${tree}/${file}`))) return yield* new UpdateFailed({ step: "check the tree", message: `${tree} has no ${file}` })
    }
    const problems = unresolvedImports(`${tree}/opencode`)
    if (problems.length > 0) return yield* new UpdateFailed({ step: "check the tree", message: problems.join("\n") })
  })

/**
 * Makes the tree of build `version` from dotfiles commit `commit`, answering its path; a tree already
 * there is answered as it is. A failed step removes the tree in the making. The caller holds the
 * builds lock (`settings.ts` `buildsLock`) from the make through the staged record, as the stage does.
 */
export const make = Effect.fn("Trees.make")(function* (options: Options, version: string, commit: string) {
  const place = placeOf(options.share, version, options.pid)
  if (yield* exists(place.tree)) return place.tree
  const clear = removeMaking(place.making)
  yield* clear
  yield* Effect.forEach(steps(options, place, commit), (step) => step.run, { discard: true }).pipe(Effect.tapError(() => clear))
  return place.tree
})

// The Trees layer is `filestore/stage.ts` `treesLayer`: these, each make under the builds lock.
