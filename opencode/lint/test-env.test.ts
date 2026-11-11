// dotfiles/no-module-env-in-tests, through the oxlint binary the gate runs
// (its RuleTester needs Node, not Bun): each write form is refused where it
// runs while the file loads (module scope, a describe body) and left alone
// where it is deferred (a hook, a test body, a function).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const CODE = "dotfiles(no-module-env-in-tests)"

/** Every write form, as a statement. */
const WRITES: Record<string, string> = {
  "a key": `process.env.X = "1"`,
  "a computed key": `process.env["X"] = "1"`,
  "a compound operator": `process.env.X ??= "1"`,
  "an update": `process.env.N++`,
  delete: `delete process.env.X`,
  "a destructuring target": `;({ a: process.env.X } = { a: "1" })`,
  "an array target": `;[process.env.X] = ["1"]`,
  "the whole object, spread": `process.env = { ...process.env, X: "1" }`,
  "Object.assign": `Object.assign(process.env, { X: "1" })`,
  "Object.defineProperty": `Object.defineProperty(process.env, "X", { value: "1" })`,
  "Object.defineProperties": `Object.defineProperties(process.env, { X: { value: "1" } })`,
  "Reflect.set": `Reflect.set(process.env, "X", "1")`,
  "Reflect.deleteProperty": `Reflect.deleteProperty(process.env, "X")`,
  "a type assertion": `;(process.env as Record<string, string>).X = "1"`,
  "Bun.env": `Bun.env.X = "1"`,
}

/** Where code runs while the file loads. */
const AT_LOAD: Record<string, (write: string) => string> = {
  "module scope": (write) => write,
  "a top-level block": (write) => `if (true) { ${write} }`,
  "a describe body": (write) => `describe("d", () => { ${write} })`,
  "a nested describe body": (write) => `describe("d", () => { describe("e", function () { ${write} }) })`,
  "a describe.each body": (write) => `describe.each([1])("d %i", () => { ${write} })`,
  "a describe.skip body": (write) => `describe.skip("d", () => { ${write} })`,
  "a static block": (write) => `class C { static { ${write} } }`,
}

/** Where it is deferred. */
const DEFERRED: Record<string, (write: string) => string> = {
  beforeAll: (write) => `beforeAll(() => { ${write} })`,
  afterEach: (write) => `afterEach(() => { ${write} })`,
  "a test body": (write) => `test("t", () => { ${write} })`,
  "a hook in a describe": (write) => `describe("d", () => { beforeAll(() => { ${write} }) })`,
  "a test in a describe": (write) => `describe("d", () => { test("t", async () => { ${write} }) })`,
  "a function": (write) => `function set() { ${write} }`,
  "an arrow": (write) => `const set = () => { ${write} }`,
  "a method": (write) => `class C { set() { ${write} } }`,
  "a class field": (write) => `class C { f = (${write.replace(/^;/, "")}) }`,
}

/** Code that never writes the environment, at module scope. */
const NO_WRITE: Record<string, string> = {
  "a read": `const home = process.env.HOME ?? "/tmp"`,
  "a copy, written": `const env = { ...process.env }; env.X = "1"; Object.assign(env, { Y: "2" })`,
  "Object.assign onto another object": `Object.assign({}, process.env)`,
  "a callback of a call that is not describe": `someOther(() => { process.env.X = "1" })`,
}

interface Case {
  readonly name: string
  readonly code: string
  readonly errors: number
}

const cross = (places: Record<string, (write: string) => string>, errors: number): ReadonlyArray<Case> =>
  Object.entries(WRITES).flatMap(([form, write]) => Object.entries(places).map(([place, wrap]) => ({ name: `${form} in ${place}`, code: wrap(write), errors })))

const CASES: ReadonlyArray<Case> = [
  ...cross(AT_LOAD, 1),
  ...cross(DEFERRED, 0),
  ...Object.entries(NO_WRITE).map(([name, code]) => ({ name, code, errors: 0 })),
]

let dir = ""
/** The rule's diagnostics by case file, from one oxlint run over every case. */
const found = new Map<string, number>()

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "lint-test-env-"))
  CASES.forEach((each, index) => writeFileSync(path.join(dir, `case-${index}.test.ts`), `${each.code}\n`))
  const config = path.join(dir, "oxlintrc.json")
  writeFileSync(config, JSON.stringify({ jsPlugins: [path.join(ROOT, "lint/test-env.ts")], rules: { "dotfiles/no-module-env-in-tests": "error" } }))
  const child = Bun.spawn([path.join(ROOT, "node_modules/.bin/oxlint"), "-c", config, "--format", "json", dir], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const report = JSON.parse(out) as { readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly filename: string }> }
  for (const diagnostic of report.diagnostics)
    if (diagnostic.code === CODE) found.set(path.basename(diagnostic.filename), (found.get(path.basename(diagnostic.filename)) ?? 0) + 1)
})

afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true })
})

describe("no-module-env-in-tests", () => {
  CASES.forEach((each, index) => {
    test(`${each.errors === 0 ? "quiet on" : "refuses"} ${each.name}`, () => {
      expect({ code: each.code, errors: found.get(`case-${index}.test.ts`) ?? 0 }).toEqual({ code: each.code, errors: each.errors })
    })
  })
})
