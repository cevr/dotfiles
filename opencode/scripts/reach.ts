// What a test file can reach in this workspace, and a key over it, for the
// gate's cache (scripts/gate.ts) and the affected acceptance tests
// (scripts/accept.ts).
//
// A file's reach is derived from the checkout, never listed by hand:
// - a file in a workspace package (mods/*, cmd/*, decider) reaches the whole
//   package but its tests, since a package loads its own files by path too
//   (the kernel's worker program, the wake backstop, the pool's ssh report)
//   and never its tests, and every package its package.json depends on: each
//   package's node_modules links only the workspace packages it declares, so an
//   undeclared import does not resolve;
// - any file reaches what it imports by a relative path or as @dotfiles/*;
// - a file outside the packages (tests/, scenarios/, testbeds/, scripts/), which
//   start plugins and programs by path, also reaches every `cmd/<name>` and
//   `mods/<name>` its code names, every `.ts`/`.tsx`/`.json` file a string of
//   it names (from its own folder or the workspace root), and every package of
//   `cmd/` or `mods/` when it names the folder itself (`"cmd"`), as a loader of
//   all plugins does; what its comments name it does not reach.
// Every key also covers the shared inputs: the root manifest, lock file,
// bunfig, tsconfig, the lint policy, these scripts, Bun's version and the OpenCode
// checkout in OPENCODE_DEV, whose modules the packages link.
// An acceptance file's key (`acceptKey`, the ledger of scripts/accept-ledger.ts)
// leaves out what no acceptance run loads: the packages' own unit tests,
// benches and Markdown, and the lint policy and the gate (`ACCEPT_SHARED`).
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { $ } from "bun"
import { Effect, Option } from "effect"
import { acceptKey, acceptSharedFrom } from "./accept-key.ts"
import { decodeGitPaths, nulFields } from "./git-paths.ts"
import { ALL_READS, readMatcher } from "./read-declarations.ts"
import { compilerInputs, projectReads, type CompilerInputs } from "./test-compiler-inputs.ts"
import { checkoutPaths, closeLinks, linkAliases, linkReads, linkTarget, predecessorLinks, type LinkInputs } from "./test-links.ts"
import { spellingReads, trackedSpellings, type TrackedSpellings } from "./test-path-spellings.ts"
import { emptyReadMap, loadReadMap, type RuntimeReads } from "./test-read-map.ts"
import { projectReadChecker } from "./test-read-project.ts"
import { isAcceptInput, packageOf } from "./test-population.ts"
export { matchingReads, readsOf } from "./read-declarations.ts"
export { ACCEPT_SHARED, acceptKey, acceptSharedFrom } from "./accept-key.ts"
export { acceptanceTests, checkedTests, isAcceptInput, mergeScriptTests, packageOf, unitTests, workboxTestFiles } from "./test-population.ts"

export const ROOT = path.resolve(import.meta.dir, "..")

/** Inputs every test shares; a change to one re-runs everything. */
export const SHARED = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  ".oxlintrc.json",
  ".oxlintrc.effect-debt.json",
  "lint/package.json",
  "effect-debt.json",
  "scripts/effect-debt.ts",
  "scripts/reach.ts",
  "scripts/read-declarations.ts",
  "scripts/test-read-map.ts",
  "scripts/test-links.ts",
  "scripts/test-path-spellings.ts",
  "scripts/test-compiler-inputs.ts",
  "scripts/test-read-project.ts",
  "scripts/test-reads.ts",
  "scripts/test-reads-ast.ts",
  "scripts/test-reads-modules.ts",
  "scripts/test-population.ts",
  "scripts/gate.ts",
  "scripts/link-fork.ts",
]

const SOURCE = /\.(ts|tsx|js|mjs)$/
const TEST = /\.test\.tsx?$/

export interface Workspace {
  /** Every file git tracks or would track, relative to ROOT. */
  readonly files: ReadonlyArray<string>
  /** Sibling inputs relative to opencode/, used only by explicit @reads. */
  readonly siblings?: ReadonlyArray<string>
  /** Git-object inputs can change even if all working files have the same contents. */
  readonly head?: string
  /** Package directory (`mods/prime`) of each package. */
  readonly packages: ReadonlyMap<string, Package>
  readonly compilerInputs?: CompilerInputs
  readonly runtimeReads?: RuntimeReads
  readonly links?: LinkInputs
  readonly spellings?: TrackedSpellings
}

const NO_LINKS: LinkInputs = new Map()
const NO_SPELLINGS = trackedSpellings([], () => "")
const repoRoot = path.dirname(ROOT)
const workspaceFiles = (workspace: Workspace) => [...workspace.files, ...(workspace.siblings ?? [])]
export const selectionPaths = (workspace: Workspace, base: string, changed: ReadonlyArray<string>) =>
  predecessorLinks(repoRoot, base, changed).then((prior) =>
    closeLinks(workspace.links || NO_LINKS, prior, changed, workspaceFiles(workspace)),
  )

const lookupSpelling = () => {
  const physical = realpathSync.native(ROOT)
  const memo = new Map<string, string>()
  return (file: string) => {
    if (path.isAbsolute(file) || file.startsWith("../../") || file.split("/").some((part) => [".git", "node_modules", "opencode.db"].includes(part))) return ""
    const prior = memo.get(file)
    if (memo.has(file)) return prior || ""
    const found = Effect.runSync(Effect.option(Effect.try(() => path.relative(physical, realpathSync.native(path.join(ROOT, file))))))
    const actual = Option.getOrElse(found, () => "")
    memo.set(file, actual)
    return actual
  }
}

interface Package {
  readonly dir: string
  readonly files: ReadonlyArray<string>
  readonly deps: ReadonlyArray<string>
}

export const load = async (): Promise<Workspace> => {
  const cwd = path.dirname(ROOT)
  const { listed, head } = await $`git ls-files -co --exclude-standard -z`.cwd(cwd).quiet().arrayBuffer().then((listed) =>
    $`git rev-parse HEAD`.cwd(cwd).quiet().nothrow().text().then((head) => ({ listed, head })),
  )
  // A deleted file git still tracks is not an input.
  const known = nulFields(decodeGitPaths(listed)).map(fromRepository).filter((file) => existsSync(path.join(ROOT, file)))
  const files = known.filter((file) => !file.startsWith("../"))
  const siblings = known.filter((file) => file.startsWith("../"))
  const byDir = new Map<string, Array<string>>()
  for (const file of files) {
    const dir = packageOf(file)
    if (dir !== undefined) byDir.set(dir, [...(byDir.get(dir) ?? []), file])
  }
  const manifests = new Map<string, { name: string; deps: ReadonlyArray<string> }>()
  for (const dir of byDir.keys()) {
    const manifest = path.join(ROOT, dir, "package.json")
    if (!existsSync(manifest)) continue
    const json = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    manifests.set(dir, { name: json.name, deps: Object.keys({ ...json.dependencies, ...json.devDependencies }) })
  }
  const dirOfName = new Map([...manifests].map(([dir, { name }]) => [name, dir]))
  const packages = new Map<string, Package>()
  for (const [dir, list] of byDir) {
    const deps = (manifests.get(dir)?.deps ?? []).flatMap((name) => dirOfName.get(name) ?? [])
    packages.set(dir, { dir, files: list, deps })
  }
  return Effect.runPromise(Effect.all([Effect.promise(() => loadReadMap(ROOT)), Effect.promise(() => checkoutPaths(cwd))], { concurrency: "unbounded" })).then(([runtimeReads, { links, tracked }]) => {
    const spellings = trackedSpellings([...tracked, ...tracked.flatMap((file) => linkAliases(links, file))], lookupSpelling())
    return compilerInputs(ROOT, new Set(known), runtimeReads.compilerProjects).then((compilerInputs) =>
      ({ files, siblings, packages, head: head.trim(), compilerInputs, runtimeReads, links, spellings }),
    )
  })
}

/** A path from the repository's root expressed from opencode/. */
export const fromRepository = (file: string): string => path.posix.relative("opencode", file)

export const sourceText = (file: string) => {
  try {
    return readFileSync(path.join(ROOT, file), "utf8")
  } catch {
    return ""
  }
}

const TS = new Bun.Transpiler({ loader: "ts" })
const TSX = new Bun.Transpiler({ loader: "tsx" })

/**
 * A file's imports and its code without its comments, through Bun's transpiler: the code keeps every string and
 * template the source holds, and drops the comments (and the types). A file that is no source, or that the
 * transpiler cannot read, has no imports and is taken whole. A program's `#!` line goes first: `scanImports` reads
 * none (testbeds/gamut/gamut.ts has one).
 */
const scan = (file: string, source: string) => {
  const whole = { imports: new Array<string>(), code: source }
  if (!SOURCE.test(file)) return whole
  const transpiler = (file.endsWith(".tsx") && TSX) || TS
  const body = source.replace(/^#!.*/, "")
  try {
    return { imports: transpiler.scanImports(body).map((each) => each.path), code: transpiler.transformSync(body) }
  } catch {
    return whole
  }
}

export const codeOf = (file: string, source: string): string => scan(file, source).code

/** The import specifiers a source holds (`import`, `export … from`, `import()`), through Bun's transpiler. */
export const importsOf = (file: string, source: string): ReadonlyArray<string> => scan(file, source).imports

const analyzers = new WeakMap<Workspace, ReturnType<typeof readAnalyzer>>()
const readAnalyzer = (workspace: Workspace) => {
  const links = workspace.links || NO_LINKS
  const files = workspaceFiles(workspace).filter((file) => !Option.exists(Option.fromUndefinedOr(links.get(file)), ({ target }) => Option.isNone(target)))
  const check = projectReadChecker(ROOT, [...files, ...files.flatMap((file) => linkAliases(links, file))], (file) => sourceText(linkTarget(links, file)))
  const result = new Map<string, ReturnType<typeof check>>()
  return (file: string) => {
    const existing = result.get(file)
    if (existing) return existing
    const read = check(file, sourceText(file))
    result.set(file, read)
    return read
  }
}

export const inspectReads = (workspace: Workspace, file: string) => {
  const analyze = analyzers.get(workspace) ?? readAnalyzer(workspace)
  analyzers.set(workspace, analyze)
  return analyze(file)
}

const authorities = new WeakMap<Workspace, Map<string, ReturnType<typeof authorityOf>>>()
const workspacePaths = new WeakMap<Workspace, ReadonlySet<string>>()

const pathsOf = (workspace: Workspace) => {
  const existing = workspacePaths.get(workspace)
  if (existing) return existing
  const paths = new Set(workspace.files)
  workspacePaths.set(workspace, paths)
  return paths
}

/** Top-level script tests deliberately walk imports only inside scripts/; direct outer modules are still inputs. */
const externalScriptImports = (workspace: Workspace, test: string): ReadonlyArray<string> => {
  if (!/^scripts\/[^/]+\.test\.tsx?$/.test(test)) return []
  const known = pathsOf(workspace)
  return importsOf(test, sourceText(test)).filter((specifier) => specifier.startsWith("../")).map((specifier) => {
    const resolved = resolveLocal(known, test, specifier, workspace.links)
    if (resolved) return resolved
    return path.posix.join(path.posix.dirname(test), specifier)
  })
}

const authorityOf = (workspace: Workspace, test: string) => {
  const read = inspectReads(workspace, test)
  const runtimeReads = workspace.runtimeReads || emptyReadMap
  const configs = runtimeReads.compilerProjects[test] || []
  const compiler = projectReads(configs, workspace.compilerInputs)
  const compilerReason = (read.opensCompiler || configs.length > 0) && (configs.length === 0 || !compiler.ready) &&
    "TypeScript project: no complete native project inventory"
  const paths = runtimeReads.paths[test] ?? []
  const imports = externalScriptImports(workspace, test)
  const patterns = read.patterns.filter((pattern) => pattern !== ALL_READS)
  const spelling = spellingReads(workspace.spellings || NO_SPELLINGS, patterns, paths, read.literalPaths)
  const directPaths = spelling.paths
  const directories = directPaths.filter((file) => file.endsWith("/"))
  const exact = new Set([...directPaths.filter((file) => !file.endsWith("/")), ...spelling.literalPaths, ...imports, ...compiler.exact])
  const matches = readMatcher(spelling.patterns)
  const direct = (file: string) => exact.has(file) || matches(file) || directories.some((prefix) => file.startsWith(prefix))
  const links = workspace.links || NO_LINKS
  const linked = linkReads(links, direct, exact, [...spelling.patterns, ...directories])
  const linkReason = linked.unsafe && `tracked symlink is dangling or resolves outside checkout: ${linked.unsafe}`
  const spellingReason = spelling.ambiguous && "tracked read spelling is ambiguous or cannot be resolved"
  const reason = runtimeReads.untracedSubprocesses[test] || compilerReason || linkReason || spellingReason
  const subprocessReason = Option.getOrUndefined(Option.liftPredicate(reason, Boolean))
  const unknown = read.classification === "unknown" || Boolean(subprocessReason)
  const observationsFor = (file: string) => {
    const spellings = [file, ...linkAliases(links, file)]
    return [...directPaths.filter((entry) => spellings.some((name) => entry === name || (entry.endsWith("/") && name.startsWith(entry)))), ...configs.filter((config) => workspace.compilerInputs?.get(config)?.has(file))]
  }
  return { unknown, subprocessReason, spellingIssues: spelling.rejected, exact: new Set([...exact, ...linked.canonical]), imports, positive: linked.has, observationsFor, linkKey: linked.fingerprint, has: (file: string) => unknown || linked.has(file) }
}

/** Runtime reads have one authority for selection, cache inputs and the coverage audit.
 * Unknown scope always selects, but is not evidence that any one observed path has a positive witness.
 */
export const testReadInputs = (workspace: Workspace, test: string) => {
  const cached = authorities.get(workspace) ?? new Map<string, ReturnType<typeof authorityOf>>()
  authorities.set(workspace, cached)
  const prior = cached.get(test)
  if (prior) return prior
  const authority = authorityOf(workspace, test)
  cached.set(test, authority)
  return authority
}

/** Runtime inputs, even if they are docs or a suite: proved static, explicitly bounded, or conservative. */
export const declaredInputs = (workspace: Workspace, file: string): ReadonlyArray<string> => {
  const inputs = testReadInputs(workspace, file)
  return [...new Set([...inputs.exact, ...[...workspace.files, ...(workspace.siblings ?? [])].filter(inputs.has)])]
}

/** Only unknown-input tests also follow Git's object identity (relevant to archives and history). */
export const readState = (workspace: Workspace, file: string): string =>
  (testReadInputs(workspace, file).unknown && workspace.head) || ""

export const readKeyState = (workspace: Workspace, file: string) =>
  [readState(workspace, file), testReadInputs(workspace, file).linkKey].filter(Boolean).join("\n")

/** The workspace file a specifier from `from` names, if any. */
const resolveLocal = (known: ReadonlySet<string>, from: string, specifier: string, links: LinkInputs = NO_LINKS): string | undefined => {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (known.has(candidate)) return candidate
    const target = linkTarget(links, candidate)
    if (known.has(target)) return target
  }
  return undefined
}

const NAMED_PACKAGE = /(?<![\w.-])(cmd|mods)\/([a-z0-9][a-z0-9-]*)/g
const NAMED_FILE = /["'`/]([\w.-]+(?:\/[\w.-]+)*\.(?:tsx?|json))["'`]/g
const NAMED_GROUP = /["'`](cmd|mods)["'`]/g

/** Every workspace file `seeds` can reach. */
export const reach = (
  workspace: Workspace, seeds: ReadonlyArray<string>, memo = new Map<string, ReadonlyArray<string>>(), known: ReadonlySet<string> = new Set(workspace.files),
): ReadonlySet<string> => {
  const seen = new Set<string>()
  const expanded = new Set<string>()
  const queue: Array<string> = []
  const add = (file: string) => {
    if (!seen.has(file) && known.has(file)) {
      seen.add(file)
      queue.push(file)
    }
  }
  const addPackage = (dir: string) => {
    const pkg = workspace.packages.get(dir)
    if (pkg === undefined || expanded.has(dir)) return
    expanded.add(dir)
    // Its tests are no part of what the package loads: a suite reaches a package's tests only by importing them.
    for (const file of pkg.files) if (!TEST.test(file)) add(file)
    for (const dep of pkg.deps) addPackage(dep)
  }
  for (const seed of seeds) add(seed)
  while (queue.length > 0) {
    const file = queue.pop()!
    const dir = packageOf(file)
    if (dir !== undefined) addPackage(dir)
    if (!SOURCE.test(file)) continue
    let edges = memo.get(file)
    if (edges === undefined) {
      edges = edgesOf(workspace, known, file)
      memo.set(file, edges)
    }
    for (const edge of edges) {
      if (workspace.packages.has(edge)) addPackage(edge)
      else add(edge)
    }
  }
  return seen
}

/** A file's edges: workspace files, or package directories. */
const edgesOf = (workspace: Workspace, known: ReadonlySet<string>, file: string): ReadonlyArray<string> => {
  const { imports, code } = scan(file, sourceText(file))
  const edges: Array<string> = []
  for (const specifier of imports) {
    if (specifier.startsWith(".")) {
      const local = resolveLocal(known, file, specifier, workspace.links)
      if (local !== undefined) edges.push(local)
    } else if (specifier.startsWith("@dotfiles/")) {
      const name = specifier.split("/").slice(0, 2).join("/")
      for (const [dir] of workspace.packages) if (packageName(dir) === name) edges.push(dir)
    }
  }
  if (packageOf(file) === undefined) {
    // What the code names, never what a comment does: a comment that mentions a script (sim/verify-model.ts names
    // scripts/verify.ts) would make every suite that loads the file reach all that script loads.
    for (const match of code.matchAll(NAMED_PACKAGE)) edges.push(`${match[1]}/${match[2]}`)
    for (const match of code.matchAll(NAMED_GROUP)) for (const dir of workspace.packages.keys()) if (dir.startsWith(`${match[1]}/`)) edges.push(dir)
    for (const match of code.matchAll(NAMED_FILE)) {
      const named = match[1]!
      const local = resolveLocal(known, file, named.startsWith(".") ? named : `./${named}`) ?? (known.has(named) ? named : undefined)
      if (local !== undefined) edges.push(local)
    }
  }
  return edges
}

const names = new Map<string, string>()
const packageName = (dir: string) => {
  let name = names.get(dir)
  if (name === undefined) {
    name = (JSON.parse(sourceText(`${dir}/package.json`) || "{}") as { name?: string }).name ?? dir
    names.set(dir, name)
  }
  return name
}

const contentHashes = new Map<string, string>()
const hashOf = (file: string) => {
  let hash = contentHashes.get(file)
  if (hash === undefined) {
    try {
      // resolve, not join: an acceptance stand-in (ACCEPT_FILES) may be an absolute path; a relative one hashes as before.
      hash = Bun.hash(readFileSync(path.resolve(ROOT, file))).toString(36)
    } catch {
      hash = "missing"
    }
    contentHashes.set(file, hash)
  }
  return hash
}

/** The OpenCode checkout in OPENCODE_DEV as a key line: its path, head, uncommitted diff and installed lock file. */
const forkLine = async () => {
  const fork = process.env.OPENCODE_DEV
  if (fork !== undefined && existsSync(fork)) {
    const head = await $`git rev-parse HEAD`.cwd(fork).quiet().nothrow().text()
    const diff = await $`git diff HEAD`.cwd(fork).quiet().nothrow().arrayBuffer()
    const lock = path.join(fork, "bun.lock")
    const installed = existsSync(lock) ? Bun.hash(readFileSync(lock)) : 0
    return `fork:${path.resolve(fork)}:${head.trim()}:${Bun.hash(diff)}:${installed}`
  }
  return "fork:none"
}

/** What every key shares: the shared files, Bun, and the OpenCode checkout the packages link. */
export const sharedKey = (extra: ReadonlyArray<string> = []) =>
  forkLine().then((fork) => {
    const hash = createHash("sha256")
    for (const file of SHARED) hash.update(`${file}:${hashOf(file)}\n`)
    hash.update(`bun:${Bun.version}:${Bun.revision}\n`)
    hash.update(`${fork}\n`)
    for (const each of extra) hash.update(`${each}\n`)
    return hash.digest("hex")
  })

/** What an acceptance file reaches as an input: the file itself and its reach (`reach`), less what `isAcceptInput` leaves out. */
export const acceptReach = (workspace: Workspace, file: string, memo = new Map<string, ReadonlyArray<string>>()): ReadonlySet<string> =>
  new Set([file, ...[...reach(workspace, [file], memo)].filter(isAcceptInput), ...declaredInputs(workspace, file)])

/** The acceptance shared key of this checkout, Bun and the fork in OPENCODE_DEV; `extra` adds the ledger's version and the run's flags. */
export const acceptSharedKey = (extra: ReadonlyArray<string>) => forkLine().then((fork) => acceptSharedFrom(hashOf, fork, extra))

export const acceptReadKey = (workspace: Workspace, test: string, shared: string, reached: Iterable<string>) =>
  acceptKey(shared, reached, hashOf, readKeyState(workspace, test))

/** A key over `files`' contents and the shared key. */
export const keyOf = (shared: string, files: Iterable<string>) => {
  const hash = createHash("sha256")
  hash.update(shared)
  for (const file of [...files].sort()) hash.update(`${file}:${hashOf(file)}\n`)
  return hash.digest("hex")
}
