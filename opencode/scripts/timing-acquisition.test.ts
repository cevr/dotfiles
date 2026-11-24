// @reads test-timing.ts ../tests/hang-guard.ts
import { expect, test } from "bun:test"
import { inspectTiming, simulationBudgetModule, timingModule } from "./test-timing.ts"
import { measurementKey, unapprovedMeasurements } from "./timing-policy.ts"

// The seam is a project of test-side files: reject at acquisition, even if
// the eventual use is harmless, without resolving a local alias.
const file = "opencode/tests/acquisition.test.ts"
const runner = 'import { test } from "bun:test";'
const measurement = 'import { measured } from "./hang-guard.ts";'
const cap = 'import { hangGuard } from "./hang-guard.ts";'
const subjects = [
  { rule: "R1", name: "test", module: "bun:test", acquire: runner, receiver: "test", member: "only", good: (x: string) => `${x}("name", () => {})`, bad: (x: string) => `${x}("name", () => {}, 55)` },
  { rule: "R2", name: "Date", module: "", acquire: "", receiver: "globalThis", member: "Date", good: (x: string) => `new ${x}(0)`, bad: (x: string) => `new ${x}()` },
  { rule: "R3", name: "measured", module: "./hang-guard.ts", acquire: measurement, receiver: "{ measured }", member: "measured", good: (x: string) => `${x}("target", "< 20 ms", fn)`, bad: (x: string) => `${x}("target", limit, fn)` },
] as const

type Subject = typeof subjects[number]
type Project = Readonly<Record<string, string>>
const reexport = ({ name, module }: Subject) => {
  if (module) return `export { ${name} as acquired } from "${module}";`
  return `export const acquired = ${name};`
}
const named = ({ name, module }: Subject) => {
  if (module) return `import { ${name} as x } from "${module}";`
  return "const x = Date;"
}
const namespace = ({ module }: Subject) => {
  if (module) return `import * as ns from "${module}";`
  return "const ns = globalThis;"
}
const defaultImport = ({ module }: Subject, use: (ref: string) => string) => {
  if (module) return `import x from "${module}";` + use("x")
  return 'import x from "node:perf_hooks"; void x.performance;' + use("Date")
}
const grammar: ReadonlyArray<readonly [string, (s: Subject, use: (ref: string) => string) => Project]> = [
  ["direct", (s, use) => ({ [file]: s.acquire + use(s.name) })],
  ["renamed", (s, use) => ({ [file]: named(s) + use("x") })],
  ["namespace", (s, use) => ({ [file]: namespace(s) + use(`ns.${s.name}`) })],
  ["default", (s, use) => ({ [file]: defaultImport(s, use) })],
  ["one re-export", (s, use) => ({ [file]: 'import { acquired } from "./first.ts";' + use("acquired"), "opencode/tests/first.ts": reexport(s) })],
  ["two re-exports", (s, use) => ({
    [file]: 'import { acquired } from "./second.ts";' + use("acquired"),
    "opencode/tests/first.ts": reexport(s), "opencode/tests/second.ts": 'export { acquired } from "./first.ts";',
  })],
  ["const alias", (s, use) => ({ [file]: s.acquire + `const x = ${s.name};` + use("x") })],
  ["destructured", (s, use) => ({ [file]: s.acquire + `const { ${s.member}: x } = ${s.receiver};` + use("x") })],
  ["literal key", (s, use) => ({ [file]: s.acquire + `const x = (${s.receiver})["${s.member}"];` + use("x") })],
  ["const key", (s, use) => ({ [file]: s.acquire + `const key = "${s.member}"; const x = (${s.receiver})[key];` + use("x") })],
  ["spread", (s, use) => ({ [file]: s.acquire + `const x = { ...${s.name} };` + use("x") })],
  ["argument", (s, use) => ({ [file]: s.acquire + `const x = wrap(${s.name});` + use("x") })],
]

const resolve = (specifier: string) => {
  if (specifier === "./hang-guard.ts") return timingModule
  if (specifier === "./budget.ts") return simulationBudgetModule
  return specifier
}
const problems = (project: Project) => Object.entries(project).flatMap(([path, source]) =>
  inspectTiming(path, source, resolve).errors)

test("closed timing acquisitions decide every generated project at its introduction", () => {
  for (const subject of subjects) {
    for (const [form, syntax] of grammar) {
      for (const [use, conforms] of [[subject.good, true], [subject.bad, false]] as const) {
        const issues = problems(syntax(subject, use))
        const message = `${subject.rule} ${form}, harmless use ${conforms}`
        if (form === "direct" && conforms) expect(issues, message).toEqual([])
        else expect(issues.some(({ rule }) => rule === subject.rule), message).toBe(true)
      }
    }
  }
})

test("other legal direct forms do not acquire a runner or a real clock as a value", () => {
  const source = [
    runner, cap, 'import { it } from "effect-bun-test";',
    'test.each([1]).skipIf(false)("template", () => {}, hangGuard("local-fixture"));',
    'it.scopedLive.layer(layer)("effect", () => body, hangGuard("local-fixture"));',
    'const register = (fn) => test("local wrapper", fn, hangGuard("local-fixture"));',
    'new Date(0); Date.parse("2000-01-01"); Date.UTC(2000, 0); type At = Date;',
    'const { env: { HOME } } = process; call(process.env, Bun.file, globalThis.fetch, HOME);',
  ].join("\n")
  expect(problems({ [file]: source })).toEqual([])
})

test("Reflect and enumeration cannot acquire any host clock through a whole object", () => {
  for (const host of ["globalThis", "process", "Bun"])
    for (const operation of ["Reflect.get", "Reflect.set", "Reflect.has", "Reflect.ownKeys", "Reflect.getOwnPropertyDescriptor", "Object.entries", "Object.values", "Object.getOwnPropertyDescriptors"])
      expect(problems({ [file]: `${operation}(${host}, "now")` }).map(({ rule }) => rule)).toEqual(["R2"])
})

test("dynamic loading and code generation cannot grant a literal guarded acquisition", () => {
  for (const code of [
    'const hooks = await import("bun:test");',
    'const hooks = require("bun:test");',
    'const hooks = module.require("bun:test");',
    'import hooks = require("bun:test");',
    'import type { test } from "bun:test"; test("type import", () => {});',
    'eval("1");',
    'new Function("return 1");',
  ]) expect(problems({ [file]: code }), code).not.toEqual([])
})

test("the Bun module, like the host object, cannot introduce nanoseconds", () => {
  const bunClock = [
    ['import { nanoseconds as clock } from "bun";', "clock"],
    ['import * as bun from "bun";', "bun.nanoseconds"],
    ['import bun from "bun"; const { nanoseconds: clock } = bun;', "clock"],
  ]
  for (const [intro, ref] of bunClock) {
    for (const access of [`void ${ref};`, `${ref}();`]) {
      const code = intro + access
      expect(problems({ [file]: code }).some(({ rule }) => rule === "R2"), code).toBe(true)
    }
  }
  expect(problems({ [file]: 'export { nanoseconds } from "bun";' }).some(({ rule }) => rule === "R2")).toBe(true)
  expect(problems({ [file]: 'import { spawnSync } from "bun"; spawnSync(args);' })).toEqual([])
})

test("a local declaration with the measurement name does not grant measurement approval", () => {
  const code = 'const measured = (...args) => fn(args); measured("target", "< 20 ms", fn);'
  expect(problems({ [file]: code }).every(({ rule }) => rule === "R3")).toBe(true)
  expect(problems({ [file]: code })).toHaveLength(2)
})

test("the simulation bridge can forward only its native budget and imported forwarder", () => {
  const site = "opencode/sim/seed.ts"
  const header = 'import { test } from "bun:test"; import { simulationBudget, simulationRunnerCapOf } from "./budget.ts";'
  const direct = 'test("test", () => {}, simulationRunnerCapOf(budget));'
  const verified = 'const budget = simulationBudget(55);'
  expect(problems({ [site]: header + verified + direct })).toEqual([])
  for (const code of [
    header + 'const budget = 55;' + direct,
    header + verified + 'function shadow(simulationRunnerCapOf) {' + direct + '}',
    header + verified + 'const register = test;' + direct,
    header + verified + 'function shadow(budget) {' + direct + '}',
    header + verified + 'budget = 55;' + direct,
    header + verified + 'const cap = simulationRunnerCapOf;' + direct,
    'import { test } from "bun:test";' + verified + direct,
  ]) expect(problems({ [site]: code }).some(({ rule }) => rule === "R1"), code).toBe(true)
})

test("the measurement ceiling pins each target, unit, and budget rather than just the count", () => {
  const approved = { file, target: "dispatch", budget: "< 20 ms" }
  for (const changed of [
    { ...approved, file: "opencode/tests/other.ts" },
    { ...approved, target: "renamed" },
    { ...approved, budget: "<= 20 ms" },
    { ...approved, budget: "< 90000 ms" },
    { ...approved, budget: "< 20 cpu-ms" },
    { ...approved, budget: ">= 20 ms" },
  ]) expect(unapprovedMeasurements([approved], [changed])).toEqual([changed])
  const strict = { ...approved, budget: "<= 19 ms" }
  expect(unapprovedMeasurements([approved], [strict])).toEqual([])
  expect(measurementKey(strict)).not.toBe(measurementKey(approved))
  expect(unapprovedMeasurements([{ ...approved, budget: ">= 10 fps" }], [{ ...approved, budget: "> 10 fps" }])).toEqual([])
  expect(unapprovedMeasurements([approved], [strict, approved])).toEqual([approved])
})
