import { file as bunFile } from "bun"
import { expect, test } from "bun:test"
import { matchingInput } from "../tests/read-path.ts"
import { readMatcher } from "./read-declarations.ts"
import { acceptanceTests, checkedTests, mergeScriptTests, unitTests, workboxTestFiles } from "./test-population.ts"
import { checkReadInputs } from "./test-reads.ts"

const check = (text: string) => checkReadInputs("scripts/example.test.ts", text, (file) =>
  file === "scripts/static.ts" && "export const value = 1" || "")

const unknown = "cannot prove the read stays in scope; use a literal path or matchingInput with a declared scope; otherwise declare @reads all and name the opaque site in @reads-reason"

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

test("the real scoped read refuses an escape before returning its path", () => {
  const chosen = "scripts/release-flags.ts"
  expect(bunFile(matchingInput("scripts/release-flags.ts", chosen)).size).toBeGreaterThan(0)
  expect(() => matchingInput("scripts/release-flags.ts", "scripts/fixtures/../../tests/accept.test.ts")).toThrow("not under scripts/release-flags.ts")
})

test("implicit workspace globs cannot select a sibling; explicit siblings can", () => {
  expect(readMatcher(["**/*.test.ts"])("../skills/orchestrate/scripts/ending.test.ts")).toBe(false)
  expect(readMatcher(["{scripts/**,../skills/orchestrate/**}"])("../skills/orchestrate/scripts/ending.test.ts")).toBe(true)
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
  expect(check(source)).toEqual({ patterns: [], bounded: [], indirect: [], classification: "static", issues: [] })
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
}`
  expect(check(source).patterns).toEqual(["scripts/input.txt"])
})

test("a parameter that shadows Bun does not count as Bun's filesystem", () => {
  expect(check("function probe(Bun) { Bun.file(getPath()) }").issues).toEqual([])
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
  expect(result).toEqual({ patterns: [], bounded: [], indirect: [], classification: "static", issues: [] })
})
test("a known git executable and working directory do not bound computed argv", () => {
  const source = `// @reads scripts/fixtures/**
import { execFileSync } from "node:child_process"
execFileSync("git", selectedArguments(), { cwd: "scripts/fixtures" })`
  expect(check(source).indirect).toEqual([{ line: 3, reason: "nonliteral subprocess argv" }])
  expect(check(source).classification).toBe("unknown")
  expect(check(source).issues).toHaveLength(2)
})
