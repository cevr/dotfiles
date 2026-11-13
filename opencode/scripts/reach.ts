// What a test file can reach in this workspace, and a key over it, for the
// gate's cache (scripts/gate.ts) and the affected acceptance tests
// (scripts/accept.ts).
//
// A file's reach is derived from the checkout, never listed by hand:
// - a file in a workspace package (mods/*, cmd/*, decider) reaches the whole
//   package, since a package loads its own files by path too (the kernel's
//   worker program, the wake backstop, the pool's ssh report), and every
//   package its package.json depends on: each package's node_modules links
//   only the workspace packages it declares, so an undeclared import does not
//   resolve;
// - any file reaches what it imports by a relative path or as @dotfiles/*;
// - a file outside the packages (tests/, scenarios/, testbeds/, scripts/), which
//   start plugins and programs by path, also reaches every `cmd/<name>` and
//   `mods/<name>` it names, every `.ts`/`.tsx`/`.json` file a string of it
//   names (from its own folder or the workspace root), and every package of
//   `cmd/` or `mods/` when it names the folder itself (`"cmd"`), as a loader of
//   all plugins does.
// Every key also covers the shared inputs: the root manifest, lock file,
// bunfig, tsconfig, the lint policy, these scripts, Bun's version and the OpenCode
// checkout in OPENCODE_DEV, whose modules the packages link.
import { existsSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { $ } from "bun"

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
  "scripts/gate.ts",
  "scripts/link-fork.ts",
]

const SOURCE = /\.(ts|tsx|js|mjs)$/
const TEST = /\.test\.tsx?$/

export interface Workspace {
  /** Every file git tracks or would track, relative to ROOT. */
  readonly files: ReadonlyArray<string>
  /** Package directory (`mods/prime`) of each package. */
  readonly packages: ReadonlyMap<string, Package>
}

interface Package {
  readonly dir: string
  readonly files: ReadonlyArray<string>
  readonly deps: ReadonlyArray<string>
}

const groups = ["mods", "cmd"] as const

/** The package directory a file belongs to, if any. */
export const packageOf = (file: string): string | undefined => {
  const [first, second] = file.split("/")
  if (first === "decider") return "decider"
  if ((first === "mods" || first === "cmd") && second !== undefined && file.split("/").length > 2) return `${first}/${second}`
  return undefined
}

export const load = async (): Promise<Workspace> => {
  const listed = await $`git ls-files -co --exclude-standard -z`.cwd(ROOT).quiet().text()
  // A deleted file git still tracks is not an input.
  const files = listed.split("\0").filter((file) => file !== "" && existsSync(path.join(ROOT, file)))
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
  return { files, packages }
}

const read = (file: string) => {
  try {
    return readFileSync(path.join(ROOT, file), "utf8")
  } catch {
    return ""
  }
}

const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) }

const imports = (file: string, source: string): ReadonlyArray<string> => {
  try {
    return transpilers[file.endsWith(".tsx") ? "tsx" : "ts"].scanImports(source).map((each) => each.path)
  } catch {
    return []
  }
}

/** The workspace file a specifier from `from` names, if any. */
const resolveLocal = (known: ReadonlySet<string>, from: string, specifier: string): string | undefined => {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (known.has(candidate)) return candidate
  return undefined
}

const NAMED_PACKAGE = /(?<![\w.-])(cmd|mods)\/([a-z0-9][a-z0-9-]*)/g
const NAMED_FILE = /["'`/]([\w.-]+(?:\/[\w.-]+)*\.(?:tsx?|json))["'`]/g
const NAMED_GROUP = /["'`](cmd|mods)["'`]/g

/** Every workspace file `seeds` can reach. */
export const reach = (workspace: Workspace, seeds: ReadonlyArray<string>, memo = new Map<string, ReadonlyArray<string>>()): ReadonlySet<string> => {
  const known = new Set(workspace.files)
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
    for (const file of pkg.files) add(file)
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
  const source = read(file)
  const edges: Array<string> = []
  for (const specifier of imports(file, source)) {
    if (specifier.startsWith(".")) {
      const local = resolveLocal(known, file, specifier)
      if (local !== undefined) edges.push(local)
    } else if (specifier.startsWith("@dotfiles/")) {
      const name = specifier.split("/").slice(0, 2).join("/")
      for (const [dir] of workspace.packages) if (packageName(dir) === name) edges.push(dir)
    }
  }
  if (packageOf(file) === undefined) {
    for (const match of source.matchAll(NAMED_PACKAGE)) edges.push(`${match[1]}/${match[2]}`)
    for (const match of source.matchAll(NAMED_GROUP)) for (const dir of workspace.packages.keys()) if (dir.startsWith(`${match[1]}/`)) edges.push(dir)
    for (const match of source.matchAll(NAMED_FILE)) {
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
    name = (JSON.parse(read(`${dir}/package.json`) || "{}") as { name?: string }).name ?? dir
    names.set(dir, name)
  }
  return name
}

/** The test files outside tests/ and the gamut fixture: the gate's unit tests. */
export const unitTests = (workspace: Workspace) =>
  workspace.files.filter((file) => TEST.test(file) && !file.startsWith("tests/") && !file.startsWith("testbeds/gamut/fixture/"))

/** tests/*.test.ts: the acceptance tests, most of which run real OpenCode. */
export const acceptanceTests = (workspace: Workspace) => workspace.files.filter((file) => /^tests\/[^/]+\.test\.tsx?$/.test(file))

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

/**
 * What every acceptance key shares (scripts/accept.ts, scripts/accept-ledger.ts): the inputs a
 * real-OpenCode run loads whatever the file, and the runner itself. Unlike SHARED it leaves out
 * what only the lint and the gate read (`.oxlintrc.json`, `.oxlintrc.effect-debt.json`,
 * `lint/package.json`, `effect-debt.json`, `scripts/effect-debt.ts`, `scripts/gate.ts`): a change to
 * those reruns no acceptance file.
 */
export const ACCEPT_SHARED = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "scripts/reach.ts",
  "scripts/link-fork.ts",
  "scripts/accept.ts",
  "scripts/accept-plan.ts",
  "scripts/accept-ledger.ts",
  "scripts/leaks.ts",
  "scripts/fork.ts",
]

/** What no acceptance run loads although a package holds it: its own unit tests, benches and Markdown. */
const PACKAGE_ONLY = /(\.test\.tsx?|\.bench\.ts|\.md)$/

/** Whether a reached file is an input of an acceptance run: anything but a package's unit test, bench or Markdown. */
export const isAcceptInput = (file: string) => !packageOf(file) || !PACKAGE_ONLY.test(file)

/** What an acceptance file reaches as an input: the file itself and its reach (`reach`), less what `isAcceptInput` leaves out. */
export const acceptReach = (workspace: Workspace, file: string, memo = new Map<string, ReadonlyArray<string>>()): ReadonlySet<string> =>
  new Set([file, ...[...reach(workspace, [file], memo)].filter(isAcceptInput)])

/** The acceptance shared key from a hash of each file and the fork's line (pure: the model test hands both in). */
export const acceptSharedFrom = (hashFile: (file: string) => string, fork: string, extra: ReadonlyArray<string>) => {
  const hash = createHash("sha256")
  for (const file of ACCEPT_SHARED) hash.update(`${file}:${hashFile(file)}\n`)
  hash.update(`bun:${Bun.version}:${Bun.revision}\n`)
  hash.update(`${fork}\n`)
  for (const each of extra) hash.update(`${each}\n`)
  return hash.digest("hex")
}

/** The acceptance shared key of this checkout, Bun and the fork in OPENCODE_DEV; `extra` adds the ledger's version and the run's flags. */
export const acceptSharedKey = (extra: ReadonlyArray<string>) => forkLine().then((fork) => acceptSharedFrom(hashOf, fork, extra))

/** An acceptance file's key: the shared key and the contents of the inputs it reaches (`isAcceptInput` applied again, so a caller's set cannot widen it). */
export const acceptKey = (shared: string, reached: Iterable<string>, hashFile: (file: string) => string = hashOf) => {
  const hash = createHash("sha256")
  hash.update(shared)
  for (const file of [...reached].filter(isAcceptInput).sort()) hash.update(`${file}:${hashFile(file)}\n`)
  return hash.digest("hex")
}

/** A key over `files`' contents and the shared key. */
export const keyOf = (shared: string, files: Iterable<string>) => {
  const hash = createHash("sha256")
  hash.update(shared)
  for (const file of [...files].sort()) hash.update(`${file}:${hashOf(file)}\n`)
  return hash.digest("hex")
}
