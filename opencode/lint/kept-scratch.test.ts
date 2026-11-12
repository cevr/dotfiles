// dotfiles/kept-suite-folders, through the oxlint binary the gate runs: in a file
// that calls keptScratch, every form the rule's header lists is refused, at
// module scope, in a describe body and in a test body, bare or as a member; the
// same code in a file with no Kept, and the safe forms in a Kept file, are left
// alone. The forms are written out here, independent of the rule's own lists.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const CODE = "dotfiles(kept-suite-folders)"

const KEPT = `const kept = keptScratch(true, "case-")`

/** Every refused call, as a statement. */
const REFUSED: Record<string, string> = {
  "a recursive mkdirSync": `mkdirSync(join(kept.path, "a/b"), { recursive: true })`,
  "a recursive fs.mkdirSync": `fs.mkdirSync(kept.path + "/a", { recursive: true })`,
  "a recursive mkdirSync by a string key": `fs["mkdirSync"](kept.path, { "recursive": true })`,
  "a recursive mkdirSync on a kept.dir result": `mkdirSync(join(kept.dir("run-"), "a/b"), { recursive: true })`,
  "a recursive mkdirSync, computed": `mkdirSync(kept.path, { recursive: deep })`,
  "a recursive mkdirSync, asserted": `mkdirSync(kept.path, { recursive: true } as const)`,
  "a recursive promises mkdir": `void mkdir(kept.path, { recursive: true })`,
  "a recursive fs.promises.mkdir": `void fs.promises.mkdir(kept.path, { recursive: true })`,
  "a mkdtempSync": `mkdtempSync(join(kept.path, "x-"))`,
  "a promises mkdtemp": `void mkdtemp("/nonexistent/loop-probe-x")`,
  "a tmpdir()": `void join(tmpdir(), "x")`,
  "an os.tmpdir()": `void os.tmpdir()`,
}

/** Calls a Kept file may make. */
const ALLOWED: Record<string, string> = {
  "a plain mkdirSync": `mkdirSync(join(kept.path, "a"))`,
  "a mkdirSync, recursive: false": `mkdirSync(join(kept.path, "a"), { recursive: false })`,
  "a mkdirSync with a mode": `mkdirSync(join(kept.path, "a"), { mode: 0o700 })`,
  "a kept.dir": `const d = kept.dir("run-")`,
  "a recursive rmSync": `rmSync(join(kept.path, "a"), { recursive: true, force: true })`,
  "another object's recursive option": `other({ recursive: true })`,
}

/** Where the statement stands in its file. */
const PLACES: Record<string, (statement: string) => string> = {
  "module scope": (statement) => `${KEPT}\n${statement}`,
  "a describe body": (statement) => `describe("d", () => { ${KEPT}; ${statement} })`,
  "a test body": (statement) => `describe("d", () => { ${KEPT}; test("t", kept.test(async () => { ${statement} })) })`,
  "before the Kept": (statement) => `${statement}\n${KEPT}`,
}

interface Case {
  readonly name: string
  readonly code: string
  readonly errors: number
}

const cross = (statements: Record<string, string>, errors: number): ReadonlyArray<Case> =>
  Object.entries(statements).flatMap(([form, statement]) =>
    Object.entries(PLACES).map(([place, wrap]) => ({ name: `${form} in ${place}`, code: wrap(statement), errors })),
  )

const CASES: ReadonlyArray<Case> = [
  ...cross(REFUSED, 1),
  ...cross(ALLOWED, 0),
  // No Kept in the file: the same calls are another rule's business.
  ...Object.entries(REFUSED).map(([form, statement]) => ({ name: `${form} in a file with no Kept`, code: statement.replaceAll("kept.path", `"/nonexistent/loop-probe-x"`).replaceAll(`kept.dir("run-")`, `"/nonexistent/loop-probe-x"`), errors: 0 })),
  { name: "a file that only names keptScratch, uncalled", code: `import { keptScratch } from "./scratch.ts"\nmkdirSync("/nonexistent/loop-probe-x", { recursive: true })`, errors: 0 },
  { name: "every refused form at once", code: `${KEPT}\n${Object.values(REFUSED).join("\n")}`, errors: Object.keys(REFUSED).length },
]

let dir = ""
/** The rule's diagnostics by case file, from one oxlint run over every case. */
const found = new Map<string, number>()

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "lint-kept-scratch-"))
  CASES.forEach((each, index) => writeFileSync(path.join(dir, `case-${index}.test.ts`), `${each.code}\n`))
  const config = path.join(dir, "oxlintrc.json")
  writeFileSync(config, JSON.stringify({ jsPlugins: [path.join(ROOT, "lint/test-env.ts")], rules: { "dotfiles/kept-suite-folders": "error" } }))
  const child = Bun.spawn([path.join(ROOT, "node_modules/.bin/oxlint"), "-c", config, "--format", "json", dir], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const report = JSON.parse(out) as { readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly filename: string }> }
  for (const diagnostic of report.diagnostics)
    if (diagnostic.code === CODE) found.set(path.basename(diagnostic.filename), (found.get(path.basename(diagnostic.filename)) ?? 0) + 1)
})

afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true })
})

describe("kept-suite-folders", () => {
  CASES.forEach((each, index) => {
    test(`${each.errors === 0 ? "quiet on" : "refuses"} ${each.name}`, () => {
      expect({ code: each.code, errors: found.get(`case-${index}.test.ts`) ?? 0 }).toEqual({ code: each.code, errors: each.errors })
    })
  })
})
