// dotfiles/no-module-env-in-tests, through the oxlint binary the gate runs
// (its RuleTester needs Node, not Bun): every write form the rule's header
// lists, on every spelling of the environment, is refused where it runs while
// the file loads (module scope, a describe body, an IIFE, a static class
// member) and left alone where it is deferred (a hook, a test body, a
// function, a class field). The forms are written out here, independent of
// the rule's own lists, so dropping any one's handling turns its cases red.
//
// dotfiles/kept-suite-folders (lint/kept-scratch.ts), in the same oxlint run:
// in a file that calls keptScratch, every form its header lists is refused, at
// module scope, in a describe body, in a test body and before the Kept, bare,
// as a member or renamed; in a file with no Kept only tmpdir() is, and not in
// tests/scratch.ts; the safe forms in a Kept file are left alone.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const CODE = "dotfiles(no-module-env-in-tests)"
const KEPT_CODE = "dotfiles(kept-suite-folders)"

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
  /** Where the case's file goes, under the run's folder; a numbered file by default. */
  readonly file?: string
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

const KEPT = `const kept = keptScratch(true, "case-")`

/** Every call kept-suite-folders refuses in a Kept file, as a statement. */
const KEPT_REFUSED = {
  "a recursive mkdirSync": `mkdirSync(join(kept.path, "a/b"), { recursive: true })`,
  "a recursive fs.mkdirSync": `fs.mkdirSync(kept.path + "/a", { recursive: true })`,
  "a recursive mkdirSync by a string key": `fs["mkdirSync"](kept.path, { "recursive": true })`,
  "a recursive mkdirSync on a kept.dir result": `mkdirSync(join(kept.dir("run-"), "a/b"), { recursive: true })`,
  "a recursive mkdirSync, computed": `mkdirSync(kept.path, { recursive: deep })`,
  "a recursive mkdirSync, asserted": `mkdirSync(kept.path, { recursive: true } as const)`,
  "a recursive mkdirSync, optional-chained": `fs?.mkdirSync(kept.path, { recursive: true })`,
  "a recursive promises mkdir": `void mkdir(kept.path, { recursive: true })`,
  "a recursive fs.promises.mkdir": `void fs.promises.mkdir(kept.path, { recursive: true })`,
  "a mkdtempSync": `mkdtempSync(join(kept.path, "x-"))`,
  "a promises mkdtemp": `void mkdtemp("/nonexistent/loop-probe-x")`,
  "a recursive mkdirSync, options in a const": `const deepOptions = { recursive: true }; mkdirSync(kept.path, deepOptions)`,
  "a recursive mkdirSync, a shorthand recursive from a const": `const recursive = true; mkdirSync(kept.path, { recursive })`,
  "a recursive mkdirSync, a spread of a const": `const deepSpread = { recursive: true }; mkdirSync(kept.path, { ...deepSpread })`,
  "a mkdirSync, a spread it cannot read": `mkdirSync(kept.path, { ...options })`,
  "a mkdirSync, options a parameter": `const makeIn = (given: object) => mkdirSync(kept.path, given)`,
  "a mkdirSync, options a destructured const": `const { picked } = { picked: 1, recursive: false }; mkdirSync(kept.path, picked)`,
  "a mkdirSync, options a let": `let loose = { recursive: false }; mkdirSync(kept.path, loose)`,
  "a recursive mkdirSync, options a const another scope shadows": `const shadowed = { recursive: true }; mkdirSync(kept.path, shadowed); const flatten = () => { const shadowed = { recursive: false }; return shadowed }`,
  "a recursive mkdirSync, held in a const": `const makeDir = fs.mkdirSync; makeDir(kept.path, { recursive: true })`,
  "a mkdtempSync, renamed by a destructuring": `const { mkdtempSync: makeTemp } = fs; makeTemp(join(kept.path, "x-"))`,
  "a cpSync": `cpSync("/nonexistent/loop-probe-x", join(kept.path, "a/b"))`,
  "a cpSync, recursive: false": `cpSync("/nonexistent/loop-probe-x", join(kept.path, "a/b"), { recursive: false })`,
  "a fs.promises.cp": `void fs.promises.cp("/nonexistent/loop-probe-x", join(kept.path, "a"))`,
  "a Bun.write": `void Bun.write(join(kept.path, "a/b"), "x")`,
  "a Bun.write, createPath: true": `void Bun.write(join(kept.path, "a"), "x", { createPath: true })`,
  "a tmpdir()": `void join(tmpdir(), "x")`,
  "an os.tmpdir()": `void os.tmpdir()`,
}

/** The refused forms that are refused in a file with no Kept as well: they make a folder straight under tmpdir(). */
const LOOSE_REFUSED = new Set(["a tmpdir()", "an os.tmpdir()"])

/** A mkdir a Kept file may make whose options come from a const: the const's name, its declaration, the call. */
interface ConstOptions {
  readonly name: string
  readonly declaration: string
  readonly call: string
}

/** The allowed forms that read their options through a const, by form. */
const CONST_OPTIONS = {
  "a mkdirSync, recursive: false in a const": { name: "flatOptions", declaration: `const flatOptions = { recursive: false }`, call: `mkdirSync(join(kept.path, "a"), flatOptions)` },
  "a mkdirSync, a shorthand recursive: false from a const": { name: "recursive", declaration: `const recursive = false`, call: `mkdirSync(join(kept.path, "a"), { recursive })` },
  "a mkdirSync, a spread of a const with no recursive": { name: "modeOnly", declaration: `const modeOnly = { mode: 0o700 }`, call: `mkdirSync(join(kept.path, "a"), { ...modeOnly })` },
} satisfies Record<string, ConstOptions>

/** Every binding that shadows a const's name where the call reads it, so the call's options are not the const's. */
const SHADOWS = {
  "a parameter": (name: string, call: string) => `const viaParameter = (${name}) => ${call}`,
  "a destructured parameter": (name: string, call: string) => `const viaPattern = ({ ${name} }) => ${call}`,
  "a parameter with a default": (name: string, call: string) => `const viaDefault = (${name} = {}) => ${call}`,
  "a rest parameter": (name: string, call: string) => `const viaRest = (...${name}) => ${call}`,
  "a function's parameter": (name: string, call: string) => `function viaFunction(${name}) { ${call} }`,
  "a catch parameter": (name: string, call: string) => `try { void 0 } catch (${name}) { ${call} }`,
  "a let in an inner block": (name: string, call: string) => `{ let ${name} = pick(); ${call} }`,
}

/** Each const-options form with its name shadowed where the call reads it: refused, as options the rule cannot read. */
const SHADOWED: ReadonlyArray<Case> = Object.entries(CONST_OPTIONS).flatMap(([form, each]) =>
  Object.entries(SHADOWS).map(([shadow, wrap]) => ({ name: `${form}, shadowed by ${shadow}`, code: `${KEPT}\n${each.declaration}\n${wrap(each.name, each.call)}`, errors: 1 })),
)

/** A refused callee: where it is imported from, the namespace object it is a member of, and a call's arguments. */
interface Callee {
  readonly from: string
  readonly object: string
  readonly args: string
}

/** Every callee a Kept file refuses, by its exported name. */
const CALLEES = {
  mkdirSync: { from: "node:fs", object: "fs", args: `kept.path, { recursive: true }` },
  mkdir: { from: "node:fs/promises", object: "fsp", args: `kept.path, { recursive: true }` },
  mkdtempSync: { from: "node:fs", object: "fs", args: `join(kept.path, "x-")` },
  mkdtemp: { from: "node:fs/promises", object: "fsp", args: `join(kept.path, "x-")` },
  tmpdir: { from: "node:os", object: "os", args: `` },
  cpSync: { from: "node:fs", object: "fs", args: `"/nonexistent/loop-probe-x", join(kept.path, "a")` },
  cp: { from: "node:fs/promises", object: "fsp", args: `"/nonexistent/loop-probe-x", join(kept.path, "a")` },
  write: { from: "bun", object: "Bun", args: `join(kept.path, "a/b"), "x"` },
} satisfies Record<string, Callee>

/** Every rename the rule's header lists, as a whole Kept file calling the callee through it. */
const RENAMES = {
  "renamed on import": (name: string, callee: Callee) => `import { ${name} as renamed } from "${callee.from}"\n${KEPT}\nvoid renamed(${callee.args})`,
  "imported as is": (name: string, callee: Callee) => `import { ${name} } from "${callee.from}"\n${KEPT}\nvoid ${name}(${callee.args})`,
  "renamed by a destructuring": (name: string, callee: Callee) => `${KEPT}\nconst { ${name}: renamed } = ${callee.object}\nvoid renamed(${callee.args})`,
  "destructured as is": (name: string, callee: Callee) => `${KEPT}\nconst { ${name} } = ${callee.object}\nvoid ${name}(${callee.args})`,
  "held in a const": (name: string, callee: Callee) => `${KEPT}\nconst renamed = ${callee.object}.${name}\nvoid renamed(${callee.args})`,
}

/** Every refused callee through every rename: each refused. */
const RENAMED: ReadonlyArray<Case> = Object.entries(CALLEES).flatMap(([name, callee]) =>
  Object.entries(RENAMES).map(([rename, write]) => ({ name: `${name} ${rename}`, code: write(name, callee), errors: 1 })),
)

/** Calls a Kept file may make. */
const KEPT_ALLOWED = {
  "a plain mkdirSync": `mkdirSync(join(kept.path, "a"))`,
  "a mkdirSync, recursive: false": `mkdirSync(join(kept.path, "a"), { recursive: false })`,
  "a mkdirSync with a mode": `mkdirSync(join(kept.path, "a"), { mode: 0o700 })`,
  "a mkdirSync with a mode for options": `mkdirSync(join(kept.path, "a"), 0o700)`,
  ...Object.fromEntries(Object.entries(CONST_OPTIONS).map(([form, each]) => [form, `${each.declaration}; ${each.call}`])),
  "a mkdirSync, recursive: false after a spread that sets it": `mkdirSync(join(kept.path, "a"), { ...{ recursive: true }, recursive: false })`,
  "a kept.dir": `const d = kept.dir("run-")`,
  "a recursive rmSync": `rmSync(join(kept.path, "a"), { recursive: true, force: true })`,
  "another call's recursive option": `other(kept.path, { recursive: true })`,
  "a copyFileSync": `copyFileSync("/nonexistent/loop-probe-x", join(kept.path, "a"))`,
  "a Bun.write, createPath: false": `void Bun.write(join(kept.path, "a"), "x", { createPath: false })`,
  "another object's write": `stream.write(join(kept.path, "a"))`,
}

/** Forms that stand at a module's top (imports), each a whole file, and the refusals each earns. */
const KEPT_FILES: ReadonlyArray<Case> = [
  { name: "r1 M1 p1: options through a parameter named as a const", code: `${KEPT}\nconst options = { recursive: false }\nconst make = (options: object) => mkdirSync(kept.path, options)\nmake({ recursive: true })`, errors: 1 },
  { name: "r1 M1 p4: a destructured parameter named as a const", code: `${KEPT}\nconst recursive = false\nconst make = ({ recursive }: { recursive: boolean }) => mkdirSync(kept.path, { recursive })\nmake({ recursive: true })`, errors: 1 },
  { name: "r1 M2 p2: Bun.write destructured", code: `${KEPT}\nconst { write } = Bun\nvoid write(join(kept.path, "a/b"), "x")`, errors: 1 },
  { name: "a write destructured from another object", code: `${KEPT}\nconst { write } = stream\nvoid write(join(kept.path, "a/b"), "x")`, errors: 0 },
  { name: "a write imported from another module", code: `import { write } from "./stream.ts"\n${KEPT}\nvoid write(join(kept.path, "a/b"), "x")`, errors: 0 },
  { name: "a parameter named as a refused callee, matched by its own name", code: `${KEPT}\nconst viaParameter = (mkdtempSync) => mkdtempSync(join(kept.path, "x-"))`, errors: 1 },
  { name: "a renamed import called before it is imported", code: `${KEPT}\nmakeTemp(join(kept.path, "x-"))\nimport { mkdtempSync as makeTemp } from "node:fs"`, errors: 1 },
  { name: "keptScratch renamed on import", code: `import { keptScratch as holdSuite } from "./scratch.ts"\nconst kept = holdSuite(true, "case-")\nmkdirSync(kept.path, { recursive: true })`, errors: 1 },
  { name: "a tmpdir renamed on import, in a file with no Kept", code: `import { tmpdir as systemTemp } from "node:os"\nvoid systemTemp()`, errors: 1 },
  { name: "a harmless import renamed to a refused name", code: `import { join as mkdtempSync } from "node:path"\n${KEPT}\nmkdtempSync(kept.path, "a")`, errors: 0 },
  { name: "tests/scratch.ts, which makes the folders", code: `mkdtempSync(\`\${tmpdir()}/x-\`)\nmkdirSync(\`\${tmpdir()}/y\`, { recursive: true })`, errors: 0, file: "helper/tests/scratch.ts" },
  { name: "a scratch.ts outside tests/", code: `void tmpdir()`, errors: 1, file: "helper/other/scratch.ts" },
]

/** Where the statement stands in its file. */
const KEPT_PLACES = {
  "module scope": (statement: string) => `${KEPT}\n${statement}`,
  "a describe body": (statement: string) => `describe("d", () => { ${KEPT}; ${statement} })`,
  "a test body": (statement: string) => `describe("d", () => { ${KEPT}; test("t", kept.test(async () => { ${statement} })) })`,
  "before the Kept": (statement: string) => `${statement}\n${KEPT}`,
}

const keptCross = (statements: Readonly<Record<string, string>>, errors: number): ReadonlyArray<Case> =>
  Object.entries(statements).flatMap(([form, statement]) =>
    Object.entries(KEPT_PLACES).map(([place, wrap]) => ({ name: `${form} in ${place}`, code: wrap(statement), errors })),
  )

/** The same call with no Kept in its file: kept-suite-folders leaves it alone, but for tmpdir(). */
const noKept = (statement: string) => statement.replaceAll("kept.path", `"/nonexistent/loop-probe-x"`).replaceAll(`kept.dir("run-")`, `"/nonexistent/loop-probe-x"`)

const KEPT_CASES: ReadonlyArray<Case> = [
  ...keptCross(KEPT_REFUSED, 1),
  ...keptCross(KEPT_ALLOWED, 0),
  ...Object.entries(KEPT_REFUSED).map(([form, statement]) => ({ name: `${form} in a file with no Kept`, code: noKept(statement), errors: Number(LOOSE_REFUSED.has(form)) })),
  ...KEPT_FILES,
  ...SHADOWED,
  ...RENAMED,
  { name: "a file that only imports keptScratch", code: `import { keptScratch } from "./scratch.ts"\nmkdirSync("/nonexistent/loop-probe-x", { recursive: true })`, errors: 0 },
  { name: "every refused form in one Kept file", code: `${KEPT}\n${Object.values(KEPT_REFUSED).join("\n")}`, errors: Object.keys(KEPT_REFUSED).length },
]

/** A Kept case's file, under the run's folder. */
const keptFile = (each: Case, index: number) => each.file ?? `kept-${index}.test.ts`

let dir = ""
/** The rule's diagnostics by case file, from one oxlint run over every case. */
const found = new Map<string, number>()

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "lint-test-env-"))
  CASES.forEach((each, index) => writeFileSync(path.join(dir, `case-${index}.test.ts`), `${each.code}\n`))
  KEPT_CASES.forEach((each, index) => {
    const file = path.join(dir, keptFile(each, index))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${each.code}\n`)
  })
  const config = path.join(dir, "oxlintrc.json")
  writeFileSync(config, JSON.stringify({ jsPlugins: [path.join(ROOT, "lint/test-env.ts")], rules: { "dotfiles/no-module-env-in-tests": "error", "dotfiles/kept-suite-folders": "error" } }))
  const child = Bun.spawn([path.join(ROOT, "node_modules/.bin/oxlint"), "-c", config, "--format", "json", dir], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const report = JSON.parse(out) as { readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly filename: string }> }
  for (const diagnostic of report.diagnostics) {
    const key = `${diagnostic.code} ${path.relative(dir, path.resolve(ROOT, diagnostic.filename))}`
    found.set(key, (found.get(key) ?? 0) + 1)
  }
})

afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true })
})

describe("no-module-env-in-tests", () => {
  CASES.forEach((each, index) => {
    test(`${each.errors === 0 ? "quiet on" : "refuses"} ${each.name}`, () => {
      expect({ code: each.code, errors: found.get(`${CODE} case-${index}.test.ts`) ?? 0 }).toEqual({ code: each.code, errors: each.errors })
    })
  })
})

describe("kept-suite-folders", () => {
  KEPT_CASES.forEach((each, index) => {
    test(`${each.name}: ${each.errors} refused`, () => {
      expect({ code: each.code, errors: found.get(`${KEPT_CODE} ${keptFile(each, index)}`) ?? 0 }).toEqual({ code: each.code, errors: each.errors })
    })
  })
})
