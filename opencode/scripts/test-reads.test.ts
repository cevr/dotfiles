// @reads-indirect scripts/**
import { expect, test } from "bun:test"
import { checkReadInputs } from "./test-reads.ts"

const check = (text: string) => checkReadInputs("scripts/example.test.ts", text, (file) =>
  file === "scripts/static.ts" && "export const value = 1" || "")

const unknown = "cannot resolve read path; use a literal file, a literal directory before the computed part, or a scratch root; for an indirect read declare @reads-indirect dir/** or @reads all"

test("a literal input must appear in the test's reads", () => {
  const source = `import { readFileSync as read } from "node:fs"
read("scripts/input.txt", "utf8")`
  expect(check(source).issues).toEqual([{ line: 2, message: "declare @reads scripts/input.txt" }])
  expect(check(`// @reads scripts/input.txt\n${source}`).issues).toEqual([])
})

test("a computed tail needs a directory and its recursive glob", () => {
  const source = `import { join } from "node:path"
const input = join(import.meta.dir, "fixtures")
Bun.file(join(input, name)).text()`
  expect(check(source).issues).toEqual([{ line: 3, message: "declare @reads scripts/fixtures/**" }])
  expect(check(`// @reads scripts/fixtures/**\n${source}`).issues).toEqual([])
  expect(check(`// @reads scripts/fixtures/*\n${source}`).issues).not.toEqual([])
})

test("a declaration cannot excuse a read with an unknown base", () => {
  const source = `// @reads scripts/**
import * as fs from "node:fs/promises"
await fs.readFile(pickAtRuntime())`
  expect(check(source).issues).toEqual([{ line: 3, message: `${unknown}: computed read` }])
})

test("a glob predicts newly added files without running the test", () => {
  const source = `import { Glob } from "bun"
new Glob("*.json").scanSync({ cwd: "./fixtures" })`
  expect(check(source).patterns).toEqual(["fixtures/*.json"])
  expect(check(`// @reads fixtures/*.json\n${source}`).issues).toEqual([])
})

test("scratch roots are not repository reads", () => {
  const source = `import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
const tmp = mkdtempSync(\`\${tmpdir()}/fixture-\`)
readFileSync(\`\${tmp}/\${file}\`)`
  expect(check(source)).toEqual({ patterns: [], indirect: [], classification: "static", issues: [] })
})

test("a computed import is checked even when static imports also name files", () => {
  const source = `import "./static.ts"
await import(\`./fixtures/\${name}.ts\`)`
  expect(check(source).patterns).toEqual(["scripts/fixtures/**"])
  expect(check(`// @reads-indirect scripts/fixtures/**\n${source}`).issues).toEqual([])
})

test("spawned git and grep reads must name their repository inputs", () => {
  const source = `import { spawnSync } from "bun"
spawnSync(["git", "show", "base:opencode/scripts/input.txt"])
spawnSync(["grep", "needle", "scripts/second.txt"])`
  expect(check(source).patterns).toEqual(["scripts/input.txt", "scripts/second.txt"])
  expect(check(`// @reads scripts/input.txt scripts/second.txt\n${source}`).issues).toEqual([])
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
  expect(check(`// @reads scripts/second.txt\n${source}`).issues.map(({ line }) => line)).toEqual([3, 4, 5])
  expect(check(`// @reads all\n${source}`).issues).toEqual([])
  expect(check(`// @reads all\n${source}`).classification).toBe("unknown")
})

test("an imported helper may hide a read even through a forwarding module", () => {
  const source = `import { load } from "./forward.ts"\nload()`
  const sources = new Map([
    ["scripts/forward.ts", `export { load } from "./loader.ts"`],
    ["scripts/loader.ts", `import { readFileSync } from "node:fs"; export const load = () => readFileSync("scripts/input.txt")`],
  ])
  const scan = (text: string) => checkReadInputs("scripts/example.test.ts", text, (file) => sources.get(file) ?? "")
  expect(scan(source).issues).toEqual([{ line: 1, message: `${unknown}: imported helper scripts/forward.ts` }])
  expect(scan(`// @reads-indirect scripts/**\n${source}`).classification).toBe("declared")
  expect(scan(`// @reads-indirect scripts/**\n${source}`).issues).toEqual([])
})

test("a known git executable and working directory do not bound computed argv", () => {
  const source = `// @reads scripts/fixtures/**
import { execFileSync } from "node:child_process"
execFileSync("git", selectedArguments(), { cwd: "scripts/fixtures" })`
  expect(check(source).indirect).toEqual([{ line: 3, reason: "nonliteral subprocess argv" }])
  expect(check(source).classification).toBe("unknown")
  expect(check(source).issues).toHaveLength(1)
})
