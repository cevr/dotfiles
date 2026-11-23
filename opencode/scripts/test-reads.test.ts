import { expect, test } from "bun:test"
import { checkReadInputs } from "./test-reads.ts"

const check = (text: string) => checkReadInputs("scripts/example.test.ts", text)

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
  expect(check(source).issues).toEqual([{ line: 3, message: "cannot resolve read path; use a literal file, a literal directory before the computed part, or a scratch root" }])
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
  expect(check(source)).toEqual({ patterns: [], issues: [] })
})

test("a computed import is checked even when static imports also name files", () => {
  const source = `import "./static.ts"
await import(\`./fixtures/\${name}.ts\`)`
  expect(check(source).patterns).toEqual(["scripts/fixtures/**"])
  expect(check(`// @reads scripts/fixtures/**\n${source}`).issues).toEqual([])
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
  expect(check(source).issues).toEqual([{ line: 3, message: "cannot resolve read path; use a literal file, a literal directory before the computed part, or a scratch root" }])
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
      message: "@reads must name the input, not the whole checkout",
    })
})

test("Bun shell reads cannot hide behind a literal subprocess", () => {
  const source = 'import { $ } from "bun"\nawait $`git grep anchor -- scripts/input.txt`\nawait $`cat scripts/second.txt`'
  expect(check(source).patterns).toEqual(["scripts/input.txt", "scripts/second.txt"])
  expect(check(`// @reads scripts/input.txt scripts/second.txt\n${source}`).issues).toEqual([])
})
