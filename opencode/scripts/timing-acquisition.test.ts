// @reads test-timing.ts timing-syntax.ts ../tests/hang-guard.ts
import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { gitInit } from "../tests/git-repo.ts"
import { hangGuard } from "../tests/hang-guard.ts"
import { inspectTiming, inspectTimingProject, readTimingInputs, simulationBudgetModule, timingModule, timingResolver } from "./test-timing.ts"
import { measurementKey, unapprovedMeasurements } from "./timing-policy.ts"

// The seam is a project of test-side files: reject at acquisition, even if
// the eventual use is harmless, without resolving a local alias.
const file = "opencode/scripts/acquisition_spec.mts"
const runner = 'import { test } from "bun:test";'
const measurement = 'import { measured } from "../tests/hang-guard.ts";'
const cap = 'import { hangGuard } from "../tests/hang-guard.ts";'
const first = "opencode/mods/cache/bench.ts"
const second = "opencode/mods/cache/scenario.ts"
const subjects = [
  { rule: "R1", name: "test", module: "bun:test", acquire: runner, receiver: "test", member: "only", good: (x: string) => `${x}("name", () => {})`, bad: (x: string) => `${x}("name", () => {}, 55)` },
  { rule: "R2", name: "Date", module: "", acquire: "", receiver: "globalThis", member: "Date", good: (x: string) => `new ${x}(0)`, bad: (x: string) => `new ${x}()` },
  { rule: "R3", name: "measured", module: "../tests/hang-guard.ts", acquire: measurement, receiver: "{ measured }", member: "measured", good: (x: string) => `${x}("target", "< 20 ms", fn)`, bad: (x: string) => `${x}("target", limit, fn)` },
] as const

type Subject = typeof subjects[number]
type Project = Readonly<Record<string, string>>
const reexport = ({ name, module }: Subject) => {
  if (module === "../tests/hang-guard.ts") return `export { ${name} as acquired } from "../../tests/hang-guard.ts";`
  if (module) return `export { ${name} as acquired } from "${module}";`
  return 'export { performance as acquired } from "node:perf_hooks";'
}
const named = ({ name, module }: Subject) => {
  if (module) return `import { ${name} as x } from "${module}";`
  return "const x = Date;"
}
const namespace = ({ module }: Subject) => {
  if (module) return `import * as ns from "${module}";`
  return "const ns = globalThis;"
}
const defaultImport = ({ module }: Subject, use: (ref: string) => string, clause: string) => {
  if (module) return `import ${clause} from "${module}";` + use("x")
  return `import ${clause} from "node:perf_hooks"; void x.performance;` + use("Date")
}
const grammar: ReadonlyArray<readonly [string, (s: Subject, use: (ref: string) => string) => Project]> = [
  ["direct", (s, use) => ({ [file]: s.acquire + use(s.name) })],
  ["renamed", (s, use) => ({ [file]: named(s) + use("x") })],
  ["namespace", (s, use) => ({ [file]: namespace(s) + use(`ns.${s.name}`) })],
  ["default", (s, use) => ({ [file]: defaultImport(s, use, "x") })],
  ["named default", (s, use) => ({ [file]: defaultImport(s, use, "{ default as x }") })],
  ["quoted default", (s, use) => ({ [file]: defaultImport(s, use, '{ "default" as x }') })],
  ["default and namespace", (s, use) => ({ [file]: defaultImport(s, use, "x, * as whole") })],
  ["default and named", (s, use) => ({ [file]: defaultImport(s, use, "x, { other }") })],
  ["quoted named", (s, use) => {
    if (s.module) return { [file]: `import { "${s.name}" as x } from "${s.module}";` + use("x") }
    return { [file]: 'import { "performance" as x } from "node:perf_hooks";' + use("Date") }
  }],
  ["side-effect then direct", (s, use) => ({
    [file]: `import "${s.module || "node:perf_hooks"}";` + s.acquire + use(s.name),
  })],
  ["one re-export", (s, use) => ({ [file]: 'import { acquired } from "../mods/cache/bench";' + use("acquired"), [first]: reexport(s) })],
  ["two re-exports", (s, use) => ({
    [file]: 'import { acquired } from "../mods/cache/scenario.ts";' + use("acquired"),
    [first]: reexport(s), [second]: 'export { acquired } from "./bench.js";',
  })],
  ["const alias", (s, use) => ({ [file]: s.acquire + `const x = ${s.name};` + use("x") })],
  ["destructured", (s, use) => ({ [file]: s.acquire + `const { ${s.member}: x } = ${s.receiver};` + use("x") })],
  ["literal key", (s, use) => ({ [file]: s.acquire + `const x = (${s.receiver})["${s.member}"];` + use("x") })],
  ["const key", (s, use) => ({ [file]: s.acquire + `const key = "${s.member}"; const x = (${s.receiver})[key];` + use("x") })],
  ["spread", (s, use) => ({ [file]: s.acquire + `const x = { ...${s.name} };` + use("x") })],
  ["argument", (s, use) => ({ [file]: s.acquire + `const x = wrap(${s.name});` + use("x") })],
]

const writeProject = (root: string, project: Project) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  for (const [file, source] of Object.entries(project)) {
    const absolute = path.join(root, file)
    yield* fs.makeDirectory(path.dirname(absolute), { recursive: true })
    yield* fs.writeFileString(absolute, source)
  }
})

const projectProblems = (project: Project) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "timing-project-" }).pipe(Effect.flatMap(fs.realPath))
  yield* writeProject(root, { [timingModule]: "", [simulationBudgetModule]: "", ...project })
  const result = inspectTimingProject(new Map(Object.entries(project)), timingResolver(path, root))
  return [...result].flatMap(([path, verdict]) => verdict.errors.map((issue) => ({ path, ...issue })))
})

const resolveSnippet = (specifier: string) => {
  if (specifier === "../tests/hang-guard.ts") return timingModule
  if (specifier === "./budget.ts") return simulationBudgetModule
  return specifier
}
const problems = (project: Project) => Object.entries(project).flatMap(([path, source]) =>
  inspectTiming(path, source, resolveSnippet).errors)

it.scopedLive.layer(BunServices.layer)("closed timing acquisitions decide every generated project at its introduction", () => Effect.gen(function* () {
  for (const subject of subjects) {
    for (const [form, syntax] of grammar) {
      for (const [use, conforms] of [[subject.good, true], [subject.bad, false]] as const) {
        const issues = yield* projectProblems(syntax(subject, use))
        const message = `${subject.rule} ${form}, harmless use ${conforms}`
        if ((form === "direct" || form === "side-effect then direct") && conforms) expect(issues, message).toEqual([])
        else expect(issues.some(({ path, rule }) => rule === subject.rule && (!form.endsWith("re-export") || path === first)), message).toBe(true)
      }
    }
  }
}))

it.scopedLive.layer(BunServices.layer)("only producers in the static import closure are judged, and they keep product clocks", () => Effect.gen(function* () {
  const unrelated = { [first]: 'export { test as scenario } from "bun:test";', [file]: 'import "./plain.ts";', "opencode/scripts/plain.ts": "export const x = 0;" }
  expect(yield* projectProblems(unrelated)).toEqual([])
  const reached = { [file]: 'import "../mods/cache/bench";', [first]: 'import { performance } from "node:perf_hooks"; export const clock = () => performance.now();' }
  expect(yield* projectProblems(reached)).toEqual([])
  const wrapper = { ...reached, [first]: 'import { measured as time } from "../../tests/hang-guard.ts"; export const scenario = () => time("x", "< 1 ms", fn);' }
  expect((yield* projectProblems(wrapper)).map(({ path, rule }) => [path, rule])).toEqual([[first, "R3"]])
  const clockExport = { ...reached, [first]: 'import { performance as clock } from "node:perf_hooks"; export { clock };' }
  expect((yield* projectProblems(clockExport)).map(({ path, rule }) => [path, rule])).toEqual([[first, "R2"]])
  const queried = { ...clockExport, [file]: 'import "../mods/cache/bench.js?instance=1";' }
  expect((yield* projectProblems(queried)).map(({ path, rule }) => [path, rule])).toEqual([[first, "R2"]])
}))

it.scopedLive.layer(BunServices.layer)("each extension mapping Bun discovers reaches the producer through two hops", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "timing-bun-mappings-" }).pipe(Effect.flatMap(fs.realPath))
  const extensions = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]
  const probe = Option.liftThrowable((specifier: string) => Bun.resolveSync(specifier, root))
  const verified = new Set<string>()
  for (const target of extensions) {
    const basename = `bench-${target}`
    yield* fs.writeFileString(path.join(root, `${basename}.${target}`), "")
    for (const requested of ["", ...extensions]) {
      if (requested === target) continue
      const suffix = requested && `.${requested}`
      const spec = `./${basename}${suffix}`
      if (!Option.contains(probe(spec), path.join(root, `${basename}.${target}`))) continue
      const producer = `opencode/mods/cache/bench.${target}`
      const issues = yield* projectProblems({
        [file]: 'import { scenario } from "../mods/cache/bridge.mts"; scenario("over cap", () => {}, 55);',
        "opencode/mods/cache/bridge.mts": `export { scenario } from "./bench${suffix}";`,
        [producer]: 'export { test as scenario } from "bun:test";',
      })
      const mapping = `${requested} → ${target}`
      expect(issues.map(({ path, rule }) => [path, rule]), mapping).toEqual([[producer, "R1"]])
      verified.add(mapping)
    }
  }
  expect(verified.has("mjs → mts")).toBe(true)
}))

it.scopedLive.layer(BunServices.layer)("missing local imports fail at the edge rather than vanishing from the closure", () => Effect.gen(function* () {
  const direct = yield* projectProblems({ [file]: 'import "./missing.mjs"; import external from "external-package";' })
  const transit = yield* projectProblems({ [file]: 'import "../mods/cache/bench";', [first]: 'export { scenario } from "./missing";' })
  expect(direct.map((issue) => [issue.path, issue.reason])).toEqual([[file, "unresolvable local import in test-side code"]])
  expect(transit.map((issue) => [issue.path, issue.reason])).toEqual(
    [[first, `unresolvable local import in test-side code; reached via "../mods/cache/bench" from ${file}:1`]],
  )
}))

const entry = "opencode/tests/edge.test.ts"
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const edgeCases = [
  (name: string) => `import ${name};`,
  (name: string) => `export { count } from ${name};`,
  (name: string) => `void require(${name});`,
  (name: string) => `import data = require(${name}); void data.count;`,
  (name: string) => `await import(${name});`,
  (name: string) => `import { count } from ${name};`,
  (name: string) => `import type { Count } from ${name};`,
  (name: string) => `import { type Count } from ${name};`,
  (name: string) => `export type { Count } from ${name};`,
  (name: string) => `export { type Count } from ${name};`,
]

const runCommand = (cwd: string, program: string, args: ReadonlyArray<string>) => Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make(program, args, { cwd, forceKillAfter: "3 seconds" }))
  const output = yield* child.all.pipe(Stream.decodeText(), Stream.mkString)
  return { code: Number(yield* child.exitCode), output }
})
const actualBun = (cwd: string, ...options: ReadonlyArray<string>) => runCommand(cwd, process.execPath, ["test", ...options, "./tests/edge.test.ts"])

const markerProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "timing-edge-oracle-" }).pipe(Effect.flatMap(fs.realPath))
  const files = ["plain", "esm", "cjs", "bun", "node", "fallback", "ignored"].map((name) => `opencode/mods/${name}.ts`)
  const dependency = "opencode/node_modules/edge-external/index.ts"
  const marker = (file: string) => `console.log(${quote(`TIMING_LOADED ${file}`)}); export const count = 1; export type Count = number;`
  const exports = {
    "./mode": { import: "./mods/esm.ts", require: "./mods/cjs.ts", default: "./mods/fallback.ts" },
    "./host": { node: "./mods/node.ts", bun: "./mods/bun.ts", default: "./mods/fallback.ts" },
    "./bun-first": { bun: "./mods/bun.ts", node: "./mods/node.ts" },
    "./fallback": { default: "./mods/fallback.ts" },
    "./wild/*": { import: "./mods/*.ts", require: "./mods/cjs.ts" },
  }
  yield* writeProject(root, {
    ".gitignore": "/opencode/mods/ignored.ts\n/opencode/node_modules/\n",
    "opencode/package.json": quote({ name: "edge-fixture", exports, imports: { "#mode": exports["./mode"] } }),
    "opencode/tsconfig.json": quote({ compilerOptions: { paths: { "@edge/*": ["./mods/*"] } } }),
    "opencode/node_modules/edge-external/package.json": quote({ exports: "./index.ts" }),
    ...Object.fromEntries([...files, dependency].map((file) => [file, marker(file)])),
  })
  yield* Effect.sync(() => gitInit(root, ["-q"]))
  const { texts, metadata } = yield* readTimingInputs(root)
  const resolve = timingResolver(path, root, metadata)
  return { root, cwd: path.join(root, "opencode"), files, texts, resolve }
})

const markerCases = [
  ["../mods/plain.js", "opencode/mods/plain.ts", []],
  ["@edge/plain", "opencode/mods/plain.ts", []],
  ["edge-fixture/mode", "opencode/mods/cjs.ts", []],
  ["edge-fixture/bun-first", "opencode/mods/bun.ts", []],
  ["edge-fixture/host", "opencode/mods/node.ts", ["--conditions", "node"]],
  ["edge-fixture/fallback", "opencode/mods/fallback.ts", []],
  ["edge-fixture/wild/plain", "opencode/mods/plain.ts", []],
  ["#mode", "opencode/mods/cjs.ts", []],
  ["edge-external", "opencode/node_modules/edge-external/index.ts", []],
  ["../mods/ignored.ts", "opencode/mods/ignored.ts", []],
] as const
for (const [specifier, witness, options] of markerCases) {
  it.scopedLive.layer(BunServices.layer)(`covers Git-visible loads of ${specifier} [${options.join(" ")}]`, () => Effect.gen(function* () {
    const { root, cwd, texts, resolve } = yield* markerProject
    const observed = new Set<string>()
    for (const make of edgeCases) {
      const edge = make(quote(specifier))
      const source = `import { test } from "bun:test"; test("runner oracle", () => {}); ${edge}`
      yield* writeProject(root, { [entry]: source })
      const run = yield* actualBun(cwd, ...options)
      expect(run.code, `${edge}\n${run.output}`).toBe(0)
      const closure = inspectTimingProject(new Map([...texts, [entry, source]]), resolve)
      for (const [, loaded] of run.output.matchAll(/^TIMING_LOADED (.+)$/gm)) {
        if (!loaded) continue
        observed.add(loaded)
        if (texts.has(loaded)) expect(closure.has(loaded), `${edge} loaded ${loaded}`).toBe(true)
      }
    }
    expect(observed.has(witness), `Bun must actually load ${witness} in at least one form`).toBe(true)
  }), hangGuard("local-fixture"))
}

it.scopedLive.layer(BunServices.layer)("a side-effect import includes local targets from untaken conditions", () => Effect.gen(function* () {
  const { files, texts, resolve } = yield* markerProject
  const imports = 'import "edge-fixture/mode"; import "edge-fixture/host"; import "edge-fixture/wild/plain";'
  const closure = inspectTimingProject(new Map([...texts, [entry, imports]]), resolve)
  for (const file of files.slice(0, -1)) expect(closure.has(file), file).toBe(true)
}), hangGuard("short-fixture"))

it.scopedLive.layer(BunServices.layer)("Git-visible tracked and unstaged producers are followed, but an ignored producer is not", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "timing-edge-git-" }).pipe(Effect.flatMap(fs.realPath))
  const files = ["opencode/mods/tracked.ts", "opencode/mods/unstaged.ts", "opencode/mods/ignored.ts"]
  const reexport = 'export { test as scenario } from "bun:test";'
  const source = files.map((file) => `import ${quote(`../mods/${path.basename(file)}`)};`).join("\n")
  yield* writeProject(root, { ".gitignore": "/opencode/mods/ignored.ts\n", [entry]: source,
    ...Object.fromEntries(files.map((file) => [file, reexport])) })
  yield* Effect.sync(() => gitInit(root, ["-q"]))
  const staged = yield* runCommand(root, "git", ["add", "--", "opencode/mods/tracked.ts"])
  expect(staged.code, staged.output).toBe(0)
  const { texts, metadata } = yield* readTimingInputs(root)
  const inspected = inspectTimingProject(texts, timingResolver(path, root, metadata))
  expect([...inspected].flatMap(([file, result]) => result.errors.map(({ rule }) => [file, rule])).sort()).toEqual(
    [["opencode/mods/tracked.ts", "R1"], ["opencode/mods/unstaged.ts", "R1"]],
  )
}), hangGuard("short-fixture"))

it.scopedLive.layer(BunServices.layer)("unresolved imports diagnose only the repository's declared aliases and package names", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "timing-edge-intent-" }).pipe(Effect.flatMap(fs.realPath))
  const metadata = {
    "opencode/package.json": quote({ name: "edge-fixture", workspaces: ["mods/*"] }),
    "opencode/mods/workspace/package.json": quote({ name: "@edge/workspace" }),
    "opencode/tsconfig.json": quote({ extends: "./shared.json" }),
    "opencode/shared.json": quote({ compilerOptions: { paths: { "@support/*": ["./mods/*"] } } }),
  }
  yield* writeProject(root, { ...metadata, [entry]: "" })
  const resolver = timingResolver(path, root, new Map(Object.entries(metadata)))
  for (const [specifier, rules] of [
    ["@edge/workspace/absent", ["R1"]], ["@support/absent", ["R1"]], ["@unrelated/missing", []], ["@edge/workspace-extra", []],
  ] as const) {
    const source = `import ${quote(specifier)};`
    const info = inspectTimingProject(new Map([[entry, source]]), resolver).get(entry)
    expect(info?.errors.map(({ rule }) => rule), specifier).toEqual([...rules])
  }
}))

it.scopedLive.layer(BunServices.layer)("uncapped process registrations are found by their bindings, through helper exports", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "timing-process-" }).pipe(Effect.flatMap(fs.realPath))
  const bridge = "opencode/mods/process-bridge.ts"
  const wrapper = "opencode/mods/process-wrapper.ts"
  const sources = {
    [timingModule]: "",
    [bridge]: 'export { run as wrapped } from "./process-wrapper.ts";',
    [wrapper]: 'import * as child from "node:child_process"; export const run = () => child.execFileSync("true");',
    [entry]: `${runner}
      import { hangGuard } from "./hang-guard.ts";
      import { ChildProcessSpawner } from "effect/process";
      import { spawn as launch } from "bun";
      import { wrapped } from "../mods/process-bridge.ts";
      function withHelper() { return wrapped(); }
      test("through helper", withHelper);
      test("Bun host", () => Bun.spawn(["true"]));
      test("Bun import", () => launch(["true"]));
      test("Effect service", function* () { const service = yield* ChildProcessSpawner.ChildProcessSpawner; service.string(cmd); });
      test("named cap", withHelper, hangGuard("short-fixture"));
      test("ordinary methods", () => ({ exec() {}, spawn() {} }).spawn());
      test("shadow", () => { const launch = () => 0; launch(); });
      test("declaration only", () => { function unused() { return launch(["true"]); } });
    `,
  }
  yield* writeProject(root, sources)
  const uses = inspectTimingProject(new Map(Object.entries(sources)), timingResolver(path, root)).get(entry)?.uses ?? []
  expect(uses.filter(({ kind }) => kind === "process").map(({ at }) => sources[entry].slice(at.start, at.end))).toEqual(
    ['"through helper"', '"Bun host"', '"Bun import"', '"Effect service"'],
  )
}))

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

test("module acquisition depends on the exported binding, not its spelling", () => {
  for (const code of [
    'const runner = require(`bun:test`); runner.test("x", () => {}, 55)',
    'const runner = await import(`bun:test`); runner.test("x", () => {}, 55)',
    'const runner = await import(`bun:test` as const); runner.test("x", () => {}, 55)',
    'const t = await import(`../tests/hang-guard.ts`); t.measured("x", "< 1 ms", fn)',
    'import { default as hooks } from "node:perf_hooks"; hooks.performance.now()',
    'const mod = await import(fixture);',
  ]) expect(problems({ [file]: code }), code).not.toEqual([])
  expect(problems({ [file]: 'import { execPath as executable } from "node:process"; launch(executable);' })).toEqual([])
})

test("a spread into Date must provably contribute a calendar argument", () => {
  for (const code of [
    'const civil = [2020, 0, 1] as const; new Date(...civil)',
    'const civil: readonly [number, number, number] = [2020, 0, 1] as const; new Date(...civil)',
    'new Date(...[2020, 0, 1])',
    'const civil = [2020, 0, 1] as const; { const civil = []; } new Date(...civil)',
    'const civil = []; { const civil = [2020, 0, 1] as const; new Date(...civil); }',
  ]) expect(problems({ [file]: code }), code).toEqual([])
  for (const code of [
    'new Date(...[])',
    'import { civil } from "./calendar.ts"; new Date(...civil)',
    'const civil = parts(); new Date(...civil)',
    'const civil = [...parts()]; new Date(...civil)',
    'const civil = []; new Date(...civil)',
    'const civil: [number, number, number] = [2020, 0, 1]; new Date(...civil)',
    'const civil: [number, number, number] = [2020, 0, 1] as const; civil.pop(); new Date(...civil)',
    'const values = [2000]; values.pop(); new Date(...values)',
    'const civil = [2020, 0, 1]; new Date(...civil)',
    'const civil = [0, 1]; new Date(2020, ...civil)',
    'const civil = [2020, 0, 1] as const; function date({ civil }) { new Date(...civil); }',
    'const civil = [2020, 0, 1] as const; function date() { if (fixed) { var civil = []; } new Date(...civil); }',
  ]) expect(problems({ [file]: code }).map(({ rule }) => rule), code).toEqual(["R2"])
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
