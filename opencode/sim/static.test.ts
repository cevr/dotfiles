// @reads all
// @reads-reason computed module resolver reads at sim/static.test.ts: const runtimeResolve = Option.liftThrowable((target: string, from: string) => Bun.resolveSync(t
// No wall time in a simulated file: a `*.sim.test.ts`, and the world it runs
// on, never names a real timer or a real clock (`Bun.sleep`, `setTimeout`,
// `setInterval`, `Date.now`, `performance.now`, `tests/wait.ts`). Time there is
// the world's clock, moved only by an advance; a real one would make a seed
// replay differently, or wait on a clock the world never moves.
//
// The seed runner (seed.ts) holds the file's CPU budget, the wall time read
// beside it through Effect's live clock, and the real run (tests/host-laws/real.ts) is real by design: neither
// is scanned. The files are read through the fork's own Effect platform layer.
import { describe, expect, test } from "bun:test"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import { Effect, FileSystem, Layer, Option, Path, PlatformError, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { gitInit } from "../tests/git-repo.ts"
import { simulationTest } from "./seed.ts"

/** opencode/: the tests run from it. */
const ROOT = process.cwd()

const WALL = [/\bBun\.sleep\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bDate\.now\b/, /\bperformance\.now\b/, /tests\/wait(\.ts)?\b/]

/** The world's own files: what a simulated test reaches in sim/, the runner aside. */
const WORLD = ["context.ts", "host.ts", "host-laws.ts", "hosts.ts", "http.ts", "law-names.ts", "plugins.ts", "provider.ts", "provider-laws.ts", "readings.ts", "runtime.ts", "server.ts", "system.ts", "world.ts"]

const Files = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const Platform = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(Files))

/** Each line of `text` that names a wall-time source, as `<line>: <text>`. */
export const wallTime = (text: string) =>
  text.split("\n").flatMap((line, index) => {
    if (WALL.some((pattern) => pattern.test(line))) return [`${index + 1}: ${line.trim()}`]
    return []
  })

/** Matching files under `dir` (a path from opencode/), node_modules and dot folders aside. */
const sources = (dir: string, includes: (file: string) => boolean): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = yield* fs.readDirectory(path.join(ROOT, dir))
    const found = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const entry = path.join(dir, name)
        const info = yield* fs.stat(path.join(ROOT, entry))
        if (info.type === "Directory" && name !== "node_modules" && !name.startsWith(".")) return yield* sources(entry, includes)
        if (info.type === "File" && includes(name)) return [entry]
        return []
      }),
    )
    return found.flat()
  })

/** Each wall-time line of the files at `files` (paths from opencode/), as `<file>:<line>: <text>`. */
const scan = (files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const found = yield* Effect.forEach(files, (file) =>
      fs.readFileString(path.join(ROOT, file)).pipe(Effect.map((text) => wallTime(text).map((line) => `${file}:${line}`))),
    )
    return found.flat()
  })

describe("no wall time in a simulated file", () => {
  test("the scan finds a planted Date.now(), and each other source of wall time", () => {
    expect(wallTime("const a = 1\nconst at = Date.now()\n")).toEqual(["2: const at = Date.now()"])
    for (const planted of ["await Bun.sleep(5)", "setTimeout(go, 5)", "setInterval(go, 5)", "performance.now()", 'import { wait } from "../../tests/wait.ts"'])
      expect(wallTime(planted)).toHaveLength(1)
    expect(wallTime("yield* Clock.currentTimeMillis\nyield* Effect.sleep(5)")).toEqual([])
  })

  simulationTest(
    "no simulated test file names one",
    Effect.gen(function* () {
      const files = (yield* Effect.forEach(["cmd", "mods", "sim", "tests"], (dir) => sources(dir, (file) => file.endsWith(".sim.test.ts")))).flat()
      expect(files.length).toBeGreaterThanOrEqual(2)
      expect(yield* scan(files)).toEqual([])
    }).pipe(Effect.provide(Platform)),
  )

  simulationTest(
    "the world's own files name none",
    scan(WORLD.map((file) => `sim/${file}`)).pipe(
      Effect.map((lines) => expect(lines).toEqual([])),
      Effect.provide(Platform),
    ),
  )
})

/** The test driver is not an OpenCode plugin capability. Only the fork-checked `session.context` crosses it. */
const driverAccess = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'](?:@dotfiles\/opencode-sim(?:\/|["'])|(?:\.\.?\/)+(?:opencode\/)?sim\/)|\bworld\s*(?:\.\s*messages\b|\[\s*["']messages["']\s*\])/
const code = /\.(?:[cm]?[jt]s|[jt]sx)$/
const testFile = /\.(?:test|spec|bench)\.(?:[cm]?[jt]s|[jt]sx)$/
const product = /^(?:cmd|mods)\//
const adapter = "sim/context.ts"

const git = (root: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* spawner.string(ChildProcess.make("git", args, { cwd: root, stdin: "ignore", forceKillAfter: "1 second" }))
  })

const listed = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const prefix = (yield* git(root, "rev-parse", "--show-prefix")).trim()
    const output = yield* git(root, "ls-files", "--full-name", "-z", "--", ":/")
    return output.split("\0").filter(Boolean).map((file) => path.relative(prefix, file))
  })
const names = (root: string) => listed(root).pipe(Effect.map((files) => files.filter((file) => code.test(file))))
const manifest = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  name: Schema.String,
  exports: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})))

const ts = new Bun.Transpiler({ loader: "ts" })
const tsx = new Bun.Transpiler({ loader: "tsx" })

/** Source-level imports; `scanImports` omits type-only edges, which still matter when a product depends on a shape. */
const dependencies = (file: string, source: string) => [
  ...((file.endsWith("x") && tsx) || ts).scanImports(source.replace(/^#!.*/, "")).map((found) => found.path),
  ...[...source.matchAll(/(?:import|export)\s+type\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/g)].map((match) => String(match[1])),
  ...[...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => String(match[1])),
]

const packageEntries = (root: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const entries = new Set<string>([adapter])
    for (const file of paths) {
      if (path.basename(file) !== "package.json" || !product.test(file)) continue
      for (const pkg of Option.toArray(manifest(yield* fs.readFileString(path.join(root, file))))) {
        for (const target of Object.values(pkg.exports || {})) if (!target.includes("*")) entries.add(path.join(path.dirname(file), target))
      }
    }
    return entries
  })

// resolveSync expects the importer's directory, not the filename.
const runtimeResolve = Option.liftThrowable((target: string, from: string) => Bun.resolveSync(target, from))

const leaksIn = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const paths = yield* listed(root)
    const files = paths.filter((file) => code.test(file))
    const entries = yield* packageEntries(root, paths)
    const content = yield* Effect.forEach(files, (file) => fs.readFileString(path.join(root, file)).pipe(Effect.map((text) => [file, text] as const)))
    const absoluteFiles = new Map(yield* Effect.forEach(files, (file) => fs.realPath(path.join(root, file)).pipe(Effect.map((absolute) => [file, absolute] as const))))
    const tracked = new Map([...absoluteFiles].map(([file, absolute]) => [absolute, file] as const))
    const importers = new Map<string, Set<string>>()
    const imports = new Map<string, Set<string>>()
    for (const [file, text] of content) {
      const fromDir = path.dirname(absoluteFiles.get(file) || path.join(root, file))
      for (const target of dependencies(file, text)) {
        const imported = Option.getOrUndefined(Option.flatMapNullishOr(runtimeResolve(target, fromDir), (absolute) => tracked.get(absolute)))
        if (!imported) continue
        const from = importers.get(imported) || new Set<string>()
        from.add(file)
        importers.set(imported, from)
        const to = imports.get(file) || new Set<string>()
        to.add(imported)
        imports.set(file, to)
      }
    }
    const testDeps = new Set(files.filter((file) => testFile.test(file)))
    for (const file of testDeps) for (const each of imports.get(file) || []) testDeps.add(each)

    // A fixture may have fixture callers, but a non-test root (including a detached cycle) is not test support.
    const testOnly = (file: string): boolean => {
      const seen = new Set([file])
      for (const source of seen) {
        if (source === adapter || !testDeps.has(source)) return false
        const from = importers.get(source)
        if (!from || from.size === 0) return false
        for (const each of from) if (!testFile.test(each)) seen.add(each)
      }
      return true
    }
    const reachable = new Set([...entries, ...files.filter((file) => product.test(file) && !testFile.test(file) && !testOnly(file))])
    for (const entry of reachable) for (const imported of imports.get(entry) || []) reachable.add(imported)
    return content
      .filter(([file, text]) => reachable.has(file) && driverAccess.test(text))
      .map(([file]) => file)
  })

test("the plugin cannot import or expose the simulated driver's raw transcript", () => {
  expect(driverAccess.test('import { make } from "../../../sim/world.ts"')).toBe(true)
  expect(driverAccess.test('const expose = () => world.messages(sessionID)')).toBe(true)
  expect(driverAccess.test('yield* ctx.session.context({ sessionID })')).toBe(false)
})

simulationTest("tracked production sources cannot see the simulated driver's raw transcript",
  leaksIn(ROOT).pipe(Effect.map((leaks) => expect(leaks).toEqual([])), Effect.provide(Platform)),
)

simulationTest("the git-listed guard catches an arbitrary production helper, but allows a fixture reached only from tests",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const candidates = (yield* names(ROOT)).filter((file) => file.startsWith("cmd/") && !testFile.test(file) && !/(?:^|\/)(?:server\.ts|tui\.tsx)$/.test(file))
    expect(candidates.length).toBeGreaterThan(10)
    const file = candidates[Math.floor(candidates.length / 2)]
    if (!file) return yield* Effect.die("no tracked production helper")
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "sim-driver-guard-" })
    yield* Effect.sync(() => gitInit(scratch, ["-q"]))
    const folder = path.dirname(file)
    yield* fs.makeDirectory(path.join(scratch, folder), { recursive: true })
    const original = yield* fs.readFileString(path.join(ROOT, file))
    const target = path.join(scratch, file)
    yield* fs.writeFileString(target, original)
    yield* git(scratch, "add", "--", file)
    expect(yield* leaksIn(scratch)).toEqual([])
    yield* fs.writeFileString(target, `${original}\nimport type { Message } from "@dotfiles/opencode-sim/world"\n`)
    expect(yield* leaksIn(scratch)).toEqual([file])
    const probe = path.join(folder, "driver-control.test.ts")
    const reexport = path.join(folder, "fixture-adapter.ts")
    const caller = path.join(folder, "a-production-consumer.ts")
    yield* fs.writeFileString(path.join(scratch, reexport), `export * from "./${path.basename(file)}"\n`)
    yield* fs.writeFileString(path.join(scratch, probe), 'import "./fixture-adapter.ts"\n')
    yield* git(scratch, "add", "--", reexport, probe)
    expect(yield* leaksIn(scratch)).toEqual([])
    yield* fs.writeFileString(path.join(scratch, caller), 'import type { Fixture } from "./fixture-adapter.ts"\n')
    yield* git(scratch, "add", "--", caller)
    expect(yield* leaksIn(scratch)).toEqual([file])
  }).pipe(Effect.scoped, Effect.provide(Platform)),
)

simulationTest("the git-listed guard follows a production import through a tracked helper outside cmd and mods",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "sim-transitive-guard-" })
    yield* Effect.sync(() => gitInit(scratch, ["-q"]))
    const project = path.join(scratch, "opencode")
    const entry = "cmd/wake/backstop.ts"
    const helper = "tests/git-repo.ts"
    for (const file of [entry, helper]) {
      const target = path.join(project, file)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, yield* fs.readFileString(path.join(ROOT, file)))
    }
    yield* git(project, "add", "--", entry, helper)
    const helperPath = path.join(project, helper)
    const entryPath = path.join(project, entry)
    const original = yield* fs.readFileString(entryPath)
    yield* fs.writeFileString(helperPath, `${yield* fs.readFileString(helperPath)}\nimport "../sim/world.ts"\n`)
    expect(yield* leaksIn(project)).toEqual([])
    yield* fs.makeDirectory(path.join(project, "tests", "adapter"))
    yield* fs.writeFileString(path.join(project, "tests", "adapter", "index.ts"), 'import "../git-repo.js"\n')
    yield* git(project, "add", "--", "tests/adapter/index.ts")
    for (const spelling of ["../../tests/git-repo.ts", "../../tests/git-repo.js", "../../tests/git-repo", "../../tests/adapter"]) {
      yield* fs.writeFileString(entryPath, `${original}\nimport "${spelling}"\n`)
      expect(yield* leaksIn(project), spelling).toEqual([helper])
    }
    yield* fs.writeFileString(path.join(scratch, "bridge.ts"), 'import "./opencode/tests/git-repo.ts"\n')
    yield* git(scratch, "add", "--", "bridge.ts")
    yield* fs.writeFileString(entryPath, `${original}\nimport "../../../bridge.ts"\n`)
    expect(yield* leaksIn(project)).toEqual([helper])
  }).pipe(Effect.scoped, Effect.provide(Platform)),
)
