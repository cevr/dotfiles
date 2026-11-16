// The legs of a land's merge check (scripts/gate.ts --merge <base>), from the changes since <base>. The merge check
// runs no unit leg, so a change could break a scripts/ test and still land (batch 2026-11-15cq: accept.test and
// accept-parity went red on main). Beside the link, the typecheck, oxlint and the debt ratchet over the changed
// files, it runs the tests a change can break and the full gate's unit leg would have caught:
// - the docs guard, scripts/verify-docs.test.ts, when the change can turn it red (docs-guard.ts);
// - for a changed scripts/<name>.ts its own scripts/<name>.test.ts and every scripts/ test whose imports reach it
//   within scripts/, through any number of steps (fork.ts → daily.ts → daily.test), and a changed scripts/ test itself;
// - scripts/accept.test.ts and scripts/accept-parity.test.ts when the acceptance tree changes (tests/, its parity
//   baselines among them), the accept scripts change, or a simulated suite a parity manifest counts changes.
// - tests/git-repo.test.ts, the guard that every test and testbed file makes its repositories through gitInit or
//   gitClone, when a test or testbed file it scans is added or changed: it reads their text, it imports none, so no
//   reach finds it (batch 2026-11-16cv: scripts/verify-fork.test.ts landed a raw `git init`).
import { Option } from "effect"
import { docsGuardDue, type Change } from "./docs-guard.ts"

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
}

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
const TEST = /^scripts\/[\w.-]+\.test\.tsx?$/
const acceptTouched = (path: string) => path.startsWith("tests/") || /^scripts\/accept[\w-]*\.ts$/.test(path) || /\.sim\.test\.tsx?$/.test(path)
/** A file tests/git-repo.test.ts scans for a raw `git init` or `git clone` (its `testFiles`). */
const gitGuarded = (path: string) => /\.test\.tsx?$/.test(path) || /^(tests|testbeds)\/.*\.tsx?$/.test(path)

/**
 * The scripts/ tests and the import specifiers each scripts/ file holds (`import`, `export … from` and `import()`,
 * as Bun's transpiler scans them), from which the selection walks the import graph within scripts/.
 */
export interface ScriptsTests {
  readonly files: ReadonlyArray<string>
  readonly imports: (file: string) => ReadonlyArray<string>
}

/** The scripts/ file a relative specifier in the scripts/ file `from` names, if it exists. */
const resolved = (from: string, specifier: string, exists: (file: string) => boolean): ReadonlyArray<string> => {
  if (!specifier.startsWith("./")) return []
  const base = `${from.slice(0, from.lastIndexOf("/") + 1)}${specifier.slice(2)}`
  return [base, `${base}.ts`, `${base}.tsx`].filter((file) => SCRIPT.test(file) && exists(file)).slice(0, 1)
}

/** Every scripts/ file `test` loads through its imports, any number of steps deep, itself included. */
export const reachedWithin = (test: string, scripts: ScriptsTests, exists: (file: string) => boolean): ReadonlySet<string> => {
  const seen = new Set([test])
  // A for-of over a Set visits what is added while it runs: each reached file once, breadth first.
  for (const from of seen) for (const next of scripts.imports(from).flatMap((specifier) => resolved(from, specifier, exists))) seen.add(next)
  return seen
}

/** The tests a changed path selects: itself when it is a scripts/ test, a script's own test, and every scripts/ test whose imports reach it. */
const testsOf = (path: string, reached: ReadonlyArray<{ readonly test: string; readonly files: ReadonlySet<string> }>): ReadonlyArray<string> => {
  if (TEST.test(path)) return [path]
  const own = Option.match(Option.fromNullishOr(SCRIPT.exec(path)), { onNone: () => [], onSome: (match) => [`scripts/${String(match[1])}.test.ts`] })
  return [...own, ...reached.flatMap((each) => (each.files.has(path) && [each.test]) || [])]
}

const NO_SCRIPTS: ScriptsTests = { files: [], imports: () => [] }

/** The scripts/ tests the changes can break, each once, sorted; only those on disk. */
export const scriptTests = (changes: ReadonlyArray<Change>, exists: (file: string) => boolean, scripts: ScriptsTests = NO_SCRIPTS): ReadonlyArray<string> => {
  const paths = named(changes)
  const reached = scripts.files.map((test) => ({ test, files: reachedWithin(test, scripts, exists) }))
  const due = new Set(paths.flatMap((path) => testsOf(path, reached)))
  if (paths.some(acceptTouched)) for (const test of ACCEPT_TESTS) due.add(test)
  if (docsGuardDue(changes)) due.add(DOCS_GUARD)
  if (changes.flatMap(left).some(gitGuarded)) due.add(GIT_REPO_GUARD)
  return [...due].filter(exists).toSorted()
}

/** The files oxlint reads among the changed ones still on disk. */
export const lintFiles = (changes: ReadonlyArray<Change>, exists: (file: string) => boolean): ReadonlyArray<string> =>
  changes.flatMap(left).filter((file) => /\.tsx?$/.test(file) && exists(file))

/** oxlint over `files`; given no file oxlint lints the whole folder, so with none changed there is nothing to lint. */
const lintLeg = (files: ReadonlyArray<string>, tools: Tools): LegSpec => {
  if (files.length === 0) return { name: "lint", argv: ["true"], note: "0 changed files" }
  return { name: "lint", argv: [tools.oxlint, "--quiet", ...files], note: `${files.length} changed files` }
}

/** `bun test` over `tests`; none due is a passed leg saying so. */
const testLeg = (tests: ReadonlyArray<string>, tools: Tools): LegSpec => {
  if (tests.length === 0) return { name: "tests", argv: ["true"], note: "none due" }
  return { name: "tests", argv: [tools.bun, "test", "--parallel=4", ...tests.map((file) => `./${file}`)], note: tests.join(" ") }
}

/** The merge check's legs over `changes` since `base`. */
export const mergeLegs = (base: string, changes: ReadonlyArray<Change>, tools: Tools): ReadonlyArray<LegSpec> => {
  const lint = lintFiles(changes, tools.exists)
  const tests = scriptTests(changes, tools.exists, tools.scripts)
  return [
    lintLeg(lint, tools),
    { name: "debt", argv: [tools.bun, "scripts/effect-debt.ts", "--check", "--since", base], note: "changed files" },
    { name: "types", argv: [...tools.typecheck, "--no-pretty"], note: `${tools.projects} projects` },
    testLeg(tests, tools),
  ]
}
