// dotfiles/no-module-env-in-tests, through the oxlint binary the gate runs
// (its RuleTester needs Node, not Bun): every write form the rule's header
// lists, on every spelling of the environment, is refused where it runs while
// the file loads (module scope, a describe body, an IIFE, a static class
// member) and left alone where it is deferred (a hook, a test body, a
// function, a class field). The forms are written out here, independent of
// the rule's own lists, so dropping any one's handling turns its cases red.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const CODE = "dotfiles(no-module-env-in-tests)"

/** One spelling of the environment: plain, and optional-chained. */
interface Env {
  readonly plain: string
  readonly chained: string
}

/** Every spelling of the environment object. */
const ENVS: Record<string, Env> = {
  "process.env": { plain: "process.env", chained: "process?.env" },
  "Bun.env": { plain: "Bun.env", chained: "Bun?.env" },
  'process["env"]': { plain: `process["env"]`, chained: `process?.["env"]` },
}

/** Every write form, as a statement on an environment. */
const WRITES: Record<string, (env: Env) => string> = {
  "a key": ({ plain }) => `${plain}.X = "1"`,
  "a computed key": ({ plain }) => `${plain}["X"] = "1"`,
  "a compound operator": ({ plain }) => `${plain}.X ??= "1"`,
  "an update": ({ plain }) => `${plain}.N++`,
  delete: ({ plain }) => `delete ${plain}.X`,
  "a destructuring target": ({ plain }) => `;({ a: ${plain}.X } = { a: "1" })`,
  "a rest in an object target": ({ plain }) => `;({ ...${plain}.X } = { a: "1" })`,
  "an array target": ({ plain }) => `;[${plain}.X] = ["1"]`,
  "a default in an array target": ({ plain }) => `;[${plain}.X = "d"] = []`,
  "a rest in an array target": ({ plain }) => `;[...${plain}.X] = ["1"]`,
  "the whole object, spread": ({ plain }) => `${plain} = { ...${plain}, X: "1" }`,
  "Object.assign": ({ plain }) => `Object.assign(${plain}, { X: "1" })`,
  "Object.defineProperty": ({ plain }) => `Object.defineProperty(${plain}, "X", { value: "1" })`,
  "Object.defineProperties": ({ plain }) => `Object.defineProperties(${plain}, { X: { value: "1" } })`,
  "Reflect.set": ({ plain }) => `Reflect.set(${plain}, "X", "1")`,
  "Reflect.defineProperty": ({ plain }) => `Reflect.defineProperty(${plain}, "X", { value: "1" })`,
  "Reflect.deleteProperty": ({ plain }) => `Reflect.deleteProperty(${plain}, "X")`,
  "an as assertion": ({ plain }) => `;(${plain} as Record<string, string>).X = "1"`,
  "an angle-bracket assertion": ({ plain }) => `;(<Record<string, string>>${plain}).X = "1"`,
  "a satisfies": ({ plain }) => `;(${plain} satisfies object).X = "1"`,
  "a non-null assertion": ({ plain }) => `${plain}!.X = "1"`,
  "parentheses": ({ plain }) => `;(${plain}).X = "1"`,
  "an optional chain": ({ chained }) => `Object.assign(${chained}, { X: "1" })`,
}

/** Where code runs while the file loads. */
const AT_LOAD: Record<string, (write: string) => string> = {
  "module scope": (write) => write,
  "a top-level block": (write) => `if (true) { ${write} }`,
  "a describe body": (write) => `describe("d", () => { ${write} })`,
  "a nested describe body": (write) => `describe("d", () => { describe("e", function () { ${write} }) })`,
  "a describe.each body": (write) => `describe.each([1])("d %i", () => { ${write} })`,
  "a describe.skip body": (write) => `describe.skip("d", () => { ${write} })`,
  "an IIFE": (write) => `;(() => { ${write} })()`,
  "a static block": (write) => `class C { static { ${write} } }`,
  "a static field": (write) => `class C { static f = (${write.replace(/^;/, "")}) }`,
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
  "a comparison": `const set = process.env.X === "1"`,
  "a typeof": `const kind = typeof process.env.X`,
  "Reflect.get": `const x = Reflect.get(process.env, "X")`,
  "another object's key, written": `other.X = "1"; other.N++; delete other.X; ({ a: other.X } = { a: "1" }); Reflect.set(other, "X", "1")`,
  "another object's env, written": `other.env.X = "1"; Object.assign(other.env, { X: "1" })`,
}

interface Case {
  readonly name: string
  readonly code: string
  readonly errors: number
}

const cross = (places: Record<string, (write: string) => string>, errors: number): ReadonlyArray<Case> =>
  Object.entries(WRITES).flatMap(([form, write]) =>
    Object.entries(ENVS).flatMap(([spelling, env]) =>
      Object.entries(places).map(([place, wrap]) => ({ name: `${form} on ${spelling} in ${place}`, code: wrap(write(env)), errors })),
    ),
  )

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
