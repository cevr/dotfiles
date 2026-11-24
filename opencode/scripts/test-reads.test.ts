import * as BunServices from "@effect/platform-bun/BunServices"
import { file as bunFile } from "bun"
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import { it } from "effect-bun-test"
import { hangGuard } from "../tests/hang-guard.ts"
import { checkoutRoot, matchingInput } from "../tests/read-path.ts"
import { checkForkEnvironment, spawnScratchGitSync, spawnScratchShell } from "../tests/scratch-child.ts"
import { localTestPaths, localTestProcess, scratch } from "../tests/scratch.ts"
import { readMatcher } from "./read-declarations.ts"
import { acceptanceTests, checkedTests, mergeScriptTests, unitTests, workboxTestFiles } from "./test-population.ts"
import { checkReadInputs } from "./test-reads.ts"

const check = (text: string) => checkReadInputs("scripts/example.test.ts", text, (file) =>
  file === "scripts/static.ts" && "export const value = 1" || "")

const unknown = "cannot prove the read stays in scope; use a literal path or matchingInput with a declared scope; otherwise declare @reads all and name the opaque site in @reads-reason"

test("native compiler acquisitions cross runtime helper imports, but an unused helper does not open a project", () => {
  const runner = "scripts/example.test.ts"
  const source = (file: string) => file === "scripts/project.ts" && `
import { API as Compiler } from "typescript/unstable/async"
export const open = () => new Compiler()
export const noProject = () => 0
` || ""
  expect(checkReadInputs(runner, `import { open } from "./project.ts"; open()`, source).opensCompiler).toBe(true)
  expect(checkReadInputs(runner, `import { noProject } from "./project.ts"; noProject()`, source).opensCompiler).toBe(false)
  expect(checkReadInputs(runner, `import { createProgram } from "typescript"; createProgram([])`).opensCompiler).toBe(true)
})

test("a narrow declaration cannot bless an escaping path", () => {
  const source = `// @reads-indirect scripts/fixtures/**
import { join } from "node:path"
import { readFileSync } from "node:fs"
readFileSync(join("scripts/fixtures", selectPath()))`
  expect(check(source).issues.map(({ message }) => message).join(" ")).toMatch(/matchingInput|@reads all/)
})

test("joining literal alternatives proves both inputs without a blanket scope", () => {
  const source = `import { join } from "node:path"
import { readFileSync } from "node:fs"
const fixture = probe() ? "first.txt" : "second.txt"
readFileSync(join("scripts/fixtures", fixture))`
  expect(check(source).patterns).toEqual(["{scripts/fixtures/first.txt,scripts/fixtures/second.txt}"])
  expect(check(source).issues).toEqual([])
})

test("an exact static read cannot use the unknown sentinel", () => {
  const source = `// @reads all
// @reads-reason static input
import { readFileSync } from "node:fs"
readFileSync("scripts/input.txt")`
  expect(check(source).issues.map(({ message }) => message).join(" ")).toMatch(/remove @reads all/)
})

test("a literal input is inferred and does not need a declaration", () => {
  const source = `import { readFileSync as read } from "node:fs"
read("scripts/input.txt", "utf8")`
  expect(check(source).patterns).toEqual(["scripts/input.txt"])
  expect(check(source).issues).toEqual([])
})

test("a bounded computed tail needs the corresponding declared scope", () => {
  const source = `import { join } from "node:path"
import { matchingInput } from "../tests/read-path.ts"
const input = join(import.meta.dir, "fixtures")
const target = matchingInput("scripts/fixtures/**", join(input, name))
Bun.file(target).text()`
  const scan = (text: string) => checkReadInputs("scripts/example.test.ts", text, (file) =>
    file === "tests/read-path.ts" && "export const matchingInput = () => ''" || "")
  expect(scan(source).issues.map(({ message }) => message)).toEqual(["declare @reads-indirect scripts/fixtures/**", "declare @reads-indirect scripts/fixtures/**"])
  expect(scan(`// @reads-indirect scripts/fixtures/**\n${source}`).issues).toEqual([])
  expect(check(`// @reads scripts/fixtures/*\n${source}`).issues).not.toEqual([])
})

test("a declaration proved at one site cannot bless a second read", () => {
  const source = `// @reads-indirect scripts/fixtures/**
import { matchingInput } from "../tests/read-path.ts"
import { readFileSync } from "node:fs"
readFileSync(matchingInput("scripts/fixtures/**", selectedFixture()))
readFileSync(selectedPathOutsideTheFixture())`
  const result = checkReadInputs("scripts/example.test.ts", source, (file) =>
    file === "tests/read-path.ts" && "export const matchingInput = () => ''" || "")
  expect(result.issues).toEqual([{ line: 5, message: `${unknown}: computed read` }])
})

test("a broad declaration cannot add an input the static reader does not use", () => {
  const source = `// @reads scripts/**
import { readFileSync } from "node:fs"
readFileSync("scripts/input.txt")`
  expect(check(source).issues).toEqual([{
    line: 1,
    message: "remove unsupported @reads scripts/**: no read site needs that scope",
  }])
})

test("the real scoped read refuses an escape before returning its path", () => {
  const chosen = "scripts/release-flags.ts"
  expect(bunFile(matchingInput("scripts/release-flags.ts", chosen)).size).toBeGreaterThan(0)
  expect(() => matchingInput("scripts/release-flags.ts", "scripts/fixtures/../../tests/accept.test.ts")).toThrow("not under scripts/release-flags.ts")
})

test("scratch Git refuses a checkout operand before spawning", () => {
  using fixture = scratch("read-guard-git-")
  const inside = spawnScratchGitSync(fixture.path, ["init", "-q"], {
    GIT_DIR: matchingInput("scripts/test-reads.ts"),
  })
  expect(inside.exitCode).toBe(0)
  expect(() => spawnScratchGitSync(fixture.path, ["add", matchingInput("scripts/test-reads.ts")]))
    .toThrow("checkout path in argv")
  expect(() => spawnScratchShell(fixture.path, `cat '${matchingInput("scripts/test-reads.ts")}'`))
    .toThrow("checkout path in generated shell script")
}, hangGuard("unit-law"))

it.live.layer(BunServices.layer)("fork fixture environment accepts safe PATH entries and rejects checkout, relative, symlink and home PATH entries", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    using fixture = scratch("read-guard-fork-env-")
    using scratchBin = scratch("read-guard-fork-bin-")
    const { join, resolve } = localTestPaths
    const home = join(fixture.path, "home")
    const bunDir = resolve(localTestProcess.execPath, "..")
    const homeOutsideBun = resolve(bunDir, "..")
    const base = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_DB: join(fixture.path, "opencode.db"),
    }
    expect(() => checkForkEnvironment(base)).not.toThrow()
    expect(() => checkForkEnvironment({ ...base, PATH: "/usr/bin:/bin" })).not.toThrow()
    expect(() => checkForkEnvironment({ ...base, PATH: `${bunDir}:/usr/bin:/bin` })).not.toThrow()
    expect(() => checkForkEnvironment({ ...base, PATH: `${scratchBin.path}:/usr/bin:/bin` })).not.toThrow()

    expect(() => checkForkEnvironment({ ...base, PATH: `${join(checkoutRoot, "node_modules/.bin")}:/usr/bin:/bin` }))
      .toThrow("redirecting fork fixture environment: PATH")
    expect(() => checkForkEnvironment({ ...base, PATH: "" }))
      .toThrow("redirecting fork fixture environment: PATH")
    expect(() => checkForkEnvironment({ ...base, PATH: "/usr/bin:" }))
      .toThrow("redirecting fork fixture environment: PATH")
    expect(() => checkForkEnvironment({ ...base, PATH: "./node_modules/.bin:/usr/bin" }))
      .toThrow("redirecting fork fixture environment: PATH")
    const link = join(fixture.path, "checkout-link")
    yield* fs.symlink(checkoutRoot, link)
    expect(() => checkForkEnvironment({ ...base, PATH: `${link}:/usr/bin:/bin` }))
      .toThrow("is not under")
    expect(() => checkForkEnvironment({ ...base, PATH: `${homeOutsideBun}:/usr/bin:/bin` }))
      .toThrow("is not under")
  }), hangGuard("unit-law"))

test("a resolver with finite local operands anchors every candidate", () => {
  const source = `const name = choose() ? "./static.ts" : "./alternate.ts"
Bun.resolveSync(name, import.meta.dir)`
  const r = checkReadInputs("scripts/example.test.ts", source, (file) =>
    ["scripts/static.ts", "scripts/alternate.ts"].includes(file) && "export {}" || "")
  expect(r.patterns).toEqual(["scripts/alternate.ts", "scripts/static.ts"])
  expect(r.issues).toEqual([])
  expect(check(source).indirect.map(({ reason }) => reason)).toContain("unresolved resolver candidate ./alternate.ts")
})

test("finite dynamic imports follow each candidate's runtime input", () => {
  const modules = new Map([
    ["scripts/first.ts", 'Bun.file("fixtures/first.txt").text()'],
    ["scripts/second.ts", 'import { readFileSync } from "node:fs"; export const b = () => readFileSync("fixtures/second.txt")'],
  ])
  const r = checkReadInputs("scripts/example.test.ts",
    'await import(pick() ? "./first.ts" : "./second.ts")', (file) => modules.get(file) || "")
  expect(r.patterns).toEqual(["fixtures/first.txt", "fixtures/second.txt", "scripts/first.ts", "scripts/second.ts"])
  expect(r.issues).toEqual([])
  const viaRequire = checkReadInputs("scripts/example.test.ts",
    'require(pick() ? "./first.ts" : "./second.ts")', (file) => modules.get(file) || "")
  expect(viaRequire).toEqual(r)
})

test("a typeof reference erased by TypeScript cannot reach a runtime read", () => {
  const source = `import { runtime } from "./helper.ts"
type Signature = typeof runtime
const check: Signature = () => "nothing was read"
check()`
  const r = checkReadInputs("scripts/example.test.ts", source, (file) => file === "scripts/helper.ts" &&
    'import { readFileSync } from "node:fs"; export const runtime = () => readFileSync(pick())' || "")
  expect(r.patterns).toEqual([])
  expect(r.issues).toEqual([])
})

test("implicit workspace globs cannot select a sibling; explicit siblings can", () => {
  expect(readMatcher(["**/*.test.ts"])("../skills/orchestrate/scripts/ending.test.ts")).toBe(false)
  expect(readMatcher(["{scripts/**,../skills/orchestrate/**}"])("../skills/orchestrate/scripts/ending.test.ts")).toBe(true)
})

test("a source inventory can exclude sibling test files without excluding source or directories", () => {
  const match = readMatcher(["../skills/orchestrate/scripts/**/!(*.test.ts|*.test.tsx)"])
  expect(match("../skills/orchestrate/scripts/ending.test.ts")).toBe(false)
  expect(match("../skills/orchestrate/scripts/nested/ending.test.tsx")).toBe(false)
  expect(match("../skills/orchestrate/scripts/nested/ending.ts")).toBe(true)
  expect(match("../skills/orchestrate/scripts/nested")).toBe(true)
})

test("the checker takes the union of the actual runner populations", () => {
  const workspace = {
    files: ["scripts/gate.test.ts", "scripts/fork/deep.test.ts", "sim/verification-nested.test.ts", "cmd/queue/queue.sim.test.ts",
      "mods/queue/plan.test.ts", "mods/queue/plan.ts", "tests/queue.test.ts", "tests/helpers/not-a-runner.test.ts",
      "testbeds/gamut/fixture/ignored.test.ts"],
    siblings: ["../workbox/test/workrift.test.ts", "../workbox/test/fixtures/not-a-runner.test.ts"],
    packages: new Map(),
  }
  const expected = [
    "scripts/gate.test.ts", "scripts/fork/deep.test.ts", "sim/verification-nested.test.ts", "cmd/queue/queue.sim.test.ts",
    "mods/queue/plan.test.ts", "tests/queue.test.ts", "../workbox/test/workrift.test.ts",
  ].sort()
  expect(checkedTests(workspace)).toEqual(expected)
  expect([...unitTests(workspace), ...acceptanceTests(workspace), ...workboxTestFiles(workspace)].sort()).toEqual(expected)
  expect(mergeScriptTests(workspace)).toEqual(["scripts/gate.test.ts"])
})

test("a declaration cannot excuse a read with an unknown base", () => {
  const source = `// @reads scripts/**
import * as fs from "node:fs/promises"
await fs.readFile(pickAtRuntime())`
  expect(check(source).issues).toContainEqual({ line: 3, message: `${unknown}: computed read` })
})

test("a glob predicts newly added files without running the test", () => {
  const source = `import { Glob } from "bun"
new Glob("*.json").scanSync({ cwd: "./fixtures" })`
  expect(check(source).patterns).toEqual(["fixtures/*.json"])
  expect(check(source).issues).toEqual([])
})

test("scratch roots are not repository reads", () => {
  const source = `import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
const tmp = mkdtempSync(\`\${tmpdir()}/fixture-\`)
 readFileSync(\`\${tmp}/literal.txt\`)`
  expect(check(source)).toEqual({ patterns: [], bounded: [], indirect: [], classification: "static", issues: [], opensCompiler: false })
})

test("a computed import is checked even when static imports also name files", () => {
  const source = `import "./static.ts"
await import(\`./fixtures/\${name}.ts\`)`
  expect(check(source).patterns).toEqual([])
  expect(check(`// @reads-indirect scripts/fixtures/**\n${source}`).issues.map(({ message }) => message).join(" ")).toMatch(/@reads all/)
})

test("spawned git and grep reads must name their repository inputs", () => {
  const source = `import { spawnSync } from "bun"
spawnSync(["git", "show", "base:opencode/scripts/input.txt"])
spawnSync(["grep", "needle", "scripts/second.txt"])`
  expect(check(source).patterns).toEqual(["scripts/input.txt", "scripts/second.txt"])
  expect(check(source).issues).toEqual([])
})

test("destructuring a filesystem namespace does not hide an unanchored read", () => {
  const source = `import * as fs from "node:fs"
const { readFileSync: read } = fs
read(getPath())`
  expect(check(source).issues).toEqual([{ line: 3, message: `${unknown}: computed read` }])
})

test("destructuring the Effect platform does not hide a read", () => {
  const source = `import { FileSystem } from "effect"
function* input() {
  const { readFileString: read } = yield* FileSystem.FileSystem
  yield* read("scripts/input.txt")
}
input()`
  expect(check(source).patterns).toEqual(["scripts/input.txt"])
})

test("a parameter that shadows Bun does not count as Bun's filesystem", () => {
  expect(check("function probe(Bun) { Bun.file(getPath()) }; probe(custom())").issues).toEqual([])
})

test("a callback that is only defined, not registered or passed, cannot read in the test", () => {
  const probe = 'import { test } from "bun:test"; const pruned = () => Bun.file(selectPath()); test("pure", () => 1)'
  expect(check(probe).issues).toEqual([])
  expect(check(`${probe}; test("reads", pruned)`).classification).toBe("unknown")
})

test("a declaration for the entire checkout is rejected", () => {
  for (const pattern of ["**", "{scripts/input.txt,**}"])
    expect(check(`// @reads ${pattern}\nimport { file } from "bun"\nfile("probe.txt")`).issues).toContainEqual({
      line: 1,
      message: "@reads must name the input or use @reads all for an opaque read",
    })
})

test("an arbitrary shell, archive, or dynamic argv cannot hide behind a subprocess", () => {
  const source = 'import { $ } from "bun"\nawait $`cat scripts/second.txt`\nBun.spawnSync(["git", "archive", "HEAD", "opencode"])\nBun.spawnSync(resolveArgv())'
  expect(check(source).issues.map(({ line }) => line)).toEqual([2, 3, 4])
  expect(check(`// @reads scripts/second.txt\n${source}`).issues.map(({ line }) => line)).toEqual([3, 4, 5, 1])
  expect(check(`// @reads all\n// @reads-reason shell reads at scripts/example.test.ts: cat through the test shell\n${source}`).issues).toEqual([])
  expect(check(`// @reads all\n${source}`).classification).toBe("unknown")
})

test("a fixed checkout launcher follows the entry's execution closure", () => {
  const source = `import { detachedCheckoutBun } from "../tests/scratch-child.ts"
detachedCheckoutBun("scripts/entry.ts", "FIXTURE_OWNER")`
  const program = `import { readFileSync } from "node:fs"
if (import.meta.main) readFileSync("fixtures/used-by-entry.txt")`
  const modules = new Map([
    ["scripts/entry.ts", program],
    ["tests/scratch-child.ts", "export const detachedCheckoutBun = () => {}"],
  ])
  const r = checkReadInputs("scripts/example.test.ts", source, (file) => modules.get(file) || "")
  expect(r.patterns).toEqual(["bun.plugins/config", "fixtures/used-by-entry.txt", "scripts/entry.ts"])
  expect(r.issues).toEqual([])
})

test("a checked Drive launch follows its scenario, never an unknown entry", () => {
  const sources = new Map([
    ["tests/owned.ts", "export const ownedDriveScenario = () => {}"],
    ["scenarios/wake.ts", 'Bun.file("themes/prime.json").text()'],
  ])
  const load = (file: string) => sources.get(file) ?? ""
  const setup = 'import { ownedDriveScenario } from "./owned.ts"; '
  const fixed = checkReadInputs("tests/wake.test.ts", `${setup}ownedDriveScenario("scenarios/wake.ts", out, fork)`, load)
  expect(fixed.patterns).toEqual(["bunx.plugins/config", "scenarios/wake.ts", "themes/prime.json"])
  expect(fixed.classification).toBe("static")
  const dynamic = checkReadInputs("tests/wake.test.ts", `${setup}ownedDriveScenario(chosen, out, fork)`, load)
  expect(dynamic.classification).toBe("unknown")
  expect(dynamic.indirect).toEqual([{ line: 1, reason: "nonliteral checkout scenario" }])
})

test("a checkout entry's computed checkout operands remain opaque", () => {
  const program = 'export const checkoutBunCommand = () => {}'
  const load = (file: string) => file === "tests/scratch-child.ts" && program || ""
  const setup = 'import { checkoutBunCommand } from "../tests/scratch-child.ts"; '
  const fixed = checkReadInputs("scripts/example.test.ts", `${setup}checkoutBunCommand("scripts/entry.ts", { checkout: { INPUT: "fixtures/pinned.ts" } })`, load)
  expect(fixed.patterns).toEqual(["bun.plugins/config", "fixtures/pinned.ts", "scripts/entry.ts"])
  const dynamic = checkReadInputs("scripts/example.test.ts", `${setup}checkoutBunCommand("scripts/entry.ts", { ...generateInputs() })`, load)
  expect(dynamic.classification).toBe("unknown")
  expect(dynamic.indirect.map(({ reason }) => reason)).toContain("computed checkout fixture inputs")
  const redefined = checkReadInputs("scripts/example.test.ts", `${setup}checkoutBunCommand("scripts/entry.ts", {
    checkout: { INPUT: "fixtures/pinned.ts" },
    get checkout() { return selectCheckoutOperands() },
  })`, load)
  expect(redefined.classification).toBe("unknown")
})

test("nested Bun tests contribute the named closures, not a computed suite list", () => {
  const files = new Map([
    ["tests/owned.ts", "export const ownedCheckoutTests = () => {}"],
    ["tests/inner.test.ts", 'const content = await Bun.file("fixtures/inner.txt").text()'],
  ])
  const input = 'import { ownedCheckoutTests } from "../tests/owned.ts"; '
  const reads = (call: string) => checkReadInputs("scripts/example.test.ts", input + call, (file) => files.get(file) || "")
  expect(reads('ownedCheckoutTests({ temp, state }, "tests/inner.test.ts")').patterns)
    .toEqual(["bun.plugins/config", "fixtures/inner.txt", "tests/inner.test.ts"])
  expect(reads("ownedCheckoutTests({ temp, state }, suiteName)").indirect)
    .toEqual([{ line: 1, reason: "nonliteral nested checkout test" }])
})

test("a registry of deferred programs does not run its effects when the module loads", () => {
  const program = `import { Effect } from "effect"
const refresh = Effect.fn("refresh")(function* () { yield* Bun.file("fixtures/deferred.txt").text() })
export const programs = { refresh }
export const describe = () => "refresh"`
  const load = (file: string) => file === "scripts/programs.ts" && program || ""
  const unused = checkReadInputs("scripts/example.test.ts", 'import { describe } from "./programs.ts"; describe()', load)
  const used = checkReadInputs("scripts/example.test.ts", 'import { programs } from "./programs.ts"; programs.refresh()', load)
  expect(unused.patterns).toEqual([])
  expect(used.patterns).toEqual(["fixtures/deferred.txt"])
})

test("importing a module runs static class fields but not constructors or methods", () => {
  const program = `export class File {
  static schema = Bun.file("fixtures/schema.txt").text();
  constructor() { Bun.file("fixtures/constructor.txt").text() }
  read() { return Bun.file("fixtures/body.txt").text() }
}
export const version = 1`
  const load = (file: string) => file === "scripts/file.ts" && program || ""
  const unused = checkReadInputs("scripts/example.test.ts", 'import { version } from "./file.ts"; use(version)', load)
  const used = checkReadInputs("scripts/example.test.ts", 'import { File } from "./file.ts"; new File().read()', load)
  expect(unused.patterns).toEqual(["fixtures/schema.txt"])
  expect(used.patterns).toEqual(["fixtures/body.txt", "fixtures/constructor.txt", "fixtures/schema.txt"])
})

test("a local variable does not invoke a same-named top-level filesystem helper", () => {
  const program = `export const result = () => { const report = "computed"; return report }
export const report = () => Bun.file("fixtures/unrelated.txt").text()`
  const load = (file: string) => file === "scripts/alias.ts" && program || ""
  expect(checkReadInputs("scripts/example.test.ts", 'import { result } from "./alias.ts"; result()', load).patterns).toEqual([])
})

test("an imported helper may hide a read even through a forwarding module", () => {
  const source = `import { load } from "./forward.ts"\nload()`
  const sources = new Map([
    ["scripts/forward.ts", `export { load } from "./loader.ts"`],
    ["scripts/loader.ts", `import { readFileSync } from "node:fs"; export const load = () => readFileSync("scripts/input.txt")`],
  ])
  const scan = (text: string) => checkReadInputs("scripts/example.test.ts", text, (file) => sources.get(file) ?? "")
  expect(scan(source).issues).toEqual([])
  expect(scan(source).classification).toBe("static")
  expect(scan(source).patterns).toEqual(["scripts/input.txt"])
})

test("an imported pure export does not inherit reads from an unused export or a forwarding import", () => {
  const sources = new Map([
    ["scripts/forward.ts", `export { pure as selected, load } from "./loader.ts"`],
    ["scripts/loader.ts", `import { readFileSync } from "node:fs"; export const pure = (value: number) => value + 1; export const load = (file: string) => readFileSync(file)`],
  ])
  const source = `import { selected, load } from "./forward.ts"\nselected(42)`
  const result = checkReadInputs("scripts/example.test.ts", source, (file) => sources.get(file) ?? "")
  expect(result).toEqual({ patterns: [], bounded: [], indirect: [], classification: "static", issues: [], opensCompiler: false })
})

test("known lazy Effect operators do not run an unused callback; a foreign operator is not assumed lazy", () => {
  const source = `import { selected } from "./helper.ts"; selected(42)`
  const helper = `import { Effect } from "effect"
export const selected = (v) => v + 1
export const unused = Effect.sync(() => Bun.file(dynamicPath())).pipe(OPERATOR)`
  const scan = (operator: string) => checkReadInputs("scripts/example.test.ts", source, (file) =>
    file === "scripts/helper.ts" && helper.replace("OPERATOR", operator) || "")
  expect(scan("Effect.orDie").classification).toBe("static")
  expect(scan("unknownOperator").classification).toBe("unknown")
})

test("a known git executable and working directory do not bound computed argv", () => {
  const source = `// @reads scripts/fixtures/**
import { execFileSync } from "node:child_process"
execFileSync("git", selectedArguments(), { cwd: "scripts/fixtures" })`
  expect(check(source).indirect).toEqual([{ line: 3, reason: "nonliteral subprocess argv" }])
  expect(check(source).classification).toBe("unknown")
  expect(check(source).issues).toHaveLength(2)
})
