// The legs of a land's merge check (scripts/gate.ts --merge <base>), from the changes since <base>.
// Beside the link, typecheck, and changed-file lint and debt ratchet, the test leg includes:
// - the docs guard, scripts/verify-docs.test.ts, when the change can turn it red (docs-guard.ts);
// - for a changed scripts/<name>.ts its own scripts/<name>.test.ts and every scripts/ test whose imports reach it
//   within scripts/, through any number of steps (fork.ts → daily.ts → daily.test), and a changed scripts/ test itself;
// - every scripts/ test whose `@reads <glob> …` line (scripts/reach.ts `readsOf`) matches a changed path, a changed
//   scripts/ test among them (merge-check.test reads the scripts/ folder, required-inputs.test every test source): a test that
//   globs or reads files by path text imports none of them, so no walk finds it (Rift U1, bb435bcc: a cmd/work/server.ts
//   import broke scripts/runtime-imports.test.ts, which reads every cmd/** and mods/** source, and main went red);
// - scripts/accept.test.ts and scripts/accept-parity.test.ts when the acceptance tree changes (tests/, its parity
//   baselines among them), the accept scripts change, or a simulated suite a parity manifest counts changes.
// - tests/git-repo.test.ts, the guard that every test and testbed file makes its repositories through gitInit or
//   gitClone, when a test or testbed file it scans is added or changed: it reads their text, it imports none, so no
//   reach finds it (batch 2026-11-16cv: scripts/verify-fork.test.ts landed a raw `git init`).
// - every workbox/test/ test when anything under workbox/ changes, and its explicit @reads outside workbox/
//   (batch 2026-11-16cy: workrift.test.ts landed red on the Mac).
// - fixed-seed unit tests not run by the acceptance swarm: a changed test or a known or observed input.
import { Option } from "effect"
import { docsGuardDue } from "./docs-guard.ts"
import type { Change } from "./git-paths.ts"
import { readMatcher } from "./read-declarations.ts"

/** A leg the merge check runs: its name, its command (from opencode/) and what its summary notes. */
export interface LegSpec {
  readonly name: string
  readonly argv: ReadonlyArray<string>
  readonly note: string
}

/** What the legs need from the host: Bun, oxlint and the typecheck's command, which files exist from opencode/, and the scripts/ tests. */
export interface Tools {
  readonly bun: string
  readonly oxlint: string
  readonly typecheck: ReadonlyArray<string>
  readonly projects: number
  readonly exists: (file: string) => boolean
  readonly scripts: ScriptsTests
  readonly workbox: Workbox
  readonly workboxReads?: (file: string) => ReadonlyArray<string>
  readonly unit?: UnitTests
}

/** Positive fixed-seed inputs: reachable sources, checked patterns, and exact observed paths. */
export interface UnitTests {
  readonly files: ReadonlyArray<string>
  readonly inputs: (test: string) => ReadonlySet<string>
  readonly reads: (test: string) => ReadonlyArray<string>
  readonly observed?: (test: string) => ReadonlyArray<string>
}

/** The repository's workbox/ folder, outside opencode/: its changes since the base and its tests, from opencode/ (`../workbox/test/…`). */
export interface Workbox {
  readonly changes: ReadonlyArray<Change>
  readonly tests: ReadonlyArray<string>
}

/** The workbox/ tests due: all of them once anything under workbox/ changed, else none. */
export const workboxTests = (workbox: Workbox): ReadonlyArray<string> => (workbox.changes.length > 0 && workbox.tests.toSorted()) || []

export const DOCS_GUARD = "scripts/verify-docs.test.ts"
export const ACCEPT_TESTS = ["scripts/accept.test.ts", "scripts/accept-parity.test.ts"] as const
export const GIT_REPO_GUARD = "tests/git-repo.test.ts"
/** The path a change leaves on disk: a rename's or a copy's new path, else its only one; none for a deletion. */
const left = (change: Change): ReadonlyArray<string> => {
  if (change.status === "D") return []
  return change.paths.slice(-1)
}
/** Every path a change names, old and new. */
const named = (changes: ReadonlyArray<Change>) => changes.flatMap((change) => change.paths)

const SCRIPT = /^scripts\/([\w.-]+)\.tsx?$/
const IMPORTABLE = /^scripts\/(?:[\w.-]+\.tsx?|(?:[\w.-]+\/)*[\w.-]+\.json)$/
const TEST = /^scripts\/[\w.-]+\.test\.tsx?$/
const acceptTouched = (path: string) => path.startsWith("tests/") || /^scripts\/accept[\w-]*\.ts$/.test(path) || (!path.startsWith("../") && /\.sim\.test\.tsx?$/.test(path))
/** A file tests/git-repo.test.ts scans for a raw `git init` or `git clone` (its `testFiles`). */
const gitGuarded = (path: string) => !path.startsWith("../") && (/\.test\.tsx?$/.test(path) || /^(tests|testbeds)\/.*\.tsx?$/.test(path))

/**
 * The scripts/ tests, the import specifiers each scripts/ file holds (`import`, `export … from` and `import()`,
 * as Bun's transpiler scans them), from which the selection walks the import graph within scripts/, and the globs
 * each test declares it reads by path (its `@reads` lines, scripts/reach.ts `readsOf`).
 */
export interface ScriptsTests {
  readonly files: ReadonlyArray<string>
  readonly imports: (file: string) => ReadonlyArray<string>
  readonly reads: (file: string) => ReadonlyArray<string>
}

/** The scripts/ file a relative specifier in the scripts/ file `from` names, if it exists. */
const resolved = (from: string, specifier: string, exists: (file: string) => boolean): ReadonlyArray<string> => {
  if (!specifier.startsWith("./")) return []
  const base = `${from.slice(0, from.lastIndexOf("/") + 1)}${specifier.slice(2)}`
  return [base, `${base}.ts`, `${base}.tsx`].filter((file) => IMPORTABLE.test(file) && exists(file)).slice(0, 1)
}

/** Every scripts/ file `test` loads through its imports, any number of steps deep, itself included. */
export const reachedWithin = (test: string, scripts: ScriptsTests, exists: (file: string) => boolean): ReadonlySet<string> => {
  const seen = new Set([test])
  // A for-of over a Set visits what is added while it runs: each reached file once, breadth first.
  for (const from of seen) for (const next of scripts.imports(from).flatMap((specifier) => resolved(from, specifier, exists))) seen.add(next)
  return seen
}

/** A scripts/ test's inputs: the scripts/ files its imports reach, and the globs of the files it declares it reads. */
interface Inputs {
  readonly test: string
  readonly files: ReadonlySet<string>
  readonly reads: (path: string) => boolean
}

/**
 * The tests a changed path selects: itself when it is a scripts/ test, a script's own test, every scripts/ test whose
 * imports reach it, and every scripts/ test that declares it reads it (runtime-imports.test globs cmd/** and mods/**
 * and imports neither: Rift U1's cmd/work/server.ts import reached main red, bb435bcc).
 */
const testsOf = (path: string, inputs: ReadonlyArray<Inputs>): ReadonlyArray<string> => {
  // A scripts/ test is its own; the tests that read it run too (required-inputs.test reads every test source, and
  // merge-check.test every scripts/ file: fe8b7bd1 and fe8d8243 added tests that only ran themselves and reddened it).
  const own = (TEST.test(path) && [path]) || Option.match(Option.fromNullishOr(SCRIPT.exec(path)), { onNone: () => [], onSome: (match) => [`scripts/${String(match[1])}.test.ts`] })
  return [...own, ...inputs.flatMap((each) => ((each.files.has(path) || each.reads(path)) && [each.test]) || [])]
}

const NO_SCRIPTS: ScriptsTests = { files: [], imports: () => [], reads: () => [] }

/** The scripts/ tests the changes can break, each once, sorted; only those on disk. */
export const scriptTests = (changes: ReadonlyArray<Change>, exists: (file: string) => boolean, scripts: ScriptsTests = NO_SCRIPTS): ReadonlyArray<string> => {
  const paths = named(changes)
  const reached = scripts.files.map((test) => ({ test, files: reachedWithin(test, scripts, exists), reads: readMatcher(scripts.reads(test)) }))
  const due = new Set(paths.flatMap((path) => testsOf(path, reached)))
  if (paths.some(acceptTouched)) for (const test of ACCEPT_TESTS) due.add(test)
  if (docsGuardDue(changes.filter((change) => change.paths.some((path) => !path.startsWith("../"))))) due.add(DOCS_GUARD)
  if (changes.flatMap(left).some(gitGuarded)) due.add(GIT_REPO_GUARD)
  return [...due].filter(exists).toSorted()
}

/** These unit tests had no land leg. Their known inputs select them; opaque sites stay opaque. */
export const affectedUnits = (paths: ReadonlyArray<string>, unit: UnitTests) => {
  if (paths.length === 0) return []
  const changed = new Set(paths)
  return unit.files.filter((test) => {
    if (changed.has(test) || unit.observed?.(test).some((file) => changed.has(file))) return true
    const reachable = unit.inputs(test)
    if (paths.some((file) => reachable.has(file))) return true
    const reads = readMatcher(unit.reads(test).filter((scope) => scope !== "all"))
    return paths.some(reads)
  })
}

/** The files oxlint reads among the changed ones still on disk. */
export const lintFiles = (changes: ReadonlyArray<Change>, exists: (file: string) => boolean): ReadonlyArray<string> =>
  changes.flatMap(left).filter((file) => /\.tsx?$/.test(file) && exists(file))

/** oxlint over `files`; given no file oxlint lints the whole folder, so with none changed there is nothing to lint. */
const lintLeg = (files: ReadonlyArray<string>, tools: Tools): LegSpec => {
  if (files.length === 0) return { name: "lint", argv: ["true"], note: "0 changed files" }
  return { name: "lint", argv: [tools.oxlint, "--quiet", ...files.map((file) => (file.startsWith("-") && `./${file}`) || file)], note: `${files.length} changed files` }
}

/** `bun test` over `tests`; none due is a passed leg saying so. */
const testLeg = (tests: ReadonlyArray<string>, tools: Tools): LegSpec => {
  if (tests.length === 0) return { name: "tests", argv: ["true"], note: "none due" }
  return { name: "tests", argv: [tools.bun, "test", "--parallel=4", ...tests.map((file) => `./${file}`)], note: tests.join(" ") }
}

/** The merge check's legs over `changes` since `base`. */
export const mergeLegs = (base: string, changes: ReadonlyArray<Change>, tools: Tools): ReadonlyArray<LegSpec> => {
  const lint = lintFiles(changes, tools.exists).filter((file) => !file.startsWith("../"))
  const paths = named(changes)
  const workbox = new Set(workboxTests(tools.workbox))
  for (const file of tools.workbox.tests) {
    if (paths.some(readMatcher(tools.workboxReads?.(file) ?? []))) workbox.add(file)
  }
  const unit = Option.match(Option.fromUndefinedOr(tools.unit), { onNone: () => [], onSome: (tests) => affectedUnits(paths, tests) })
  const tests = [...new Set([...scriptTests(changes, tools.exists, tools.scripts), ...[...workbox].toSorted(), ...unit])]
  return [
    lintLeg(lint, tools),
    { name: "test-reads", argv: [tools.bun, "scripts/check-test-reads.ts"], note: "static read anchors" },
    { name: "debt", argv: [tools.bun, "scripts/effect-debt.ts", "--check", "--since", base], note: "changed files" },
    { name: "types", argv: [...tools.typecheck, "--no-pretty"], note: `${tools.projects} projects` },
    testLeg(tests, tools),
  ]
}
