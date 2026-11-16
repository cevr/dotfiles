// The legs of a land's merge check (scripts/gate.ts --merge <base>), from the changes since <base>. The merge check
// runs no unit leg, so a change could break a scripts/ test and still land (batch 2026-11-15cq: accept.test and
// accept-parity went red on main). Beside the link, the typecheck, oxlint and the debt ratchet over the changed
// files, it runs the tests a change can break and the full gate's unit leg would have caught:
// - the docs guard, scripts/verify-docs.test.ts, when the change can turn it red (docs-guard.ts);
// - for a changed scripts/<name>.ts its own scripts/<name>.test.ts, and a changed scripts/ test itself;
// - scripts/accept.test.ts and scripts/accept-parity.test.ts when the acceptance tree changes (tests/, its parity
//   baselines among them), the accept scripts change, or a simulated suite a parity manifest counts changes.
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

/** The scripts/ tests and their texts the selection reads: which test imports which script. */
export interface ScriptsTests {
  readonly files: ReadonlyArray<string>
  readonly read: (file: string) => string
}

/** The tests a changed path selects: itself when it is a scripts/ test; for a script, its own test and every scripts/ test that imports it. */
const testsOf = (path: string, scripts: ScriptsTests): ReadonlyArray<string> => {
  if (TEST.test(path)) return [path]
  return Option.match(Option.fromNullishOr(SCRIPT.exec(path)), {
    onNone: () => [],
    onSome: (match) => {
      const name = String(match[1])
      return [`scripts/${name}.test.ts`, ...scripts.files.filter((file) => scripts.read(file).includes(`"./${name}.ts"`))]
    },
  })
}

/** The scripts/ tests the changes can break, each once, sorted; only those on disk. */
export const scriptTests = (changes: ReadonlyArray<Change>, exists: (file: string) => boolean, scripts: ScriptsTests = { files: [], read: () => "" }): ReadonlyArray<string> => {
  const paths = named(changes)
  const due = new Set(paths.flatMap((path) => testsOf(path, scripts)))
  if (paths.some(acceptTouched)) for (const test of ACCEPT_TESTS) due.add(test)
  if (docsGuardDue(changes)) due.add(DOCS_GUARD)
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
