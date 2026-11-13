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
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect"
import * as Seed from "./seed.ts"

/** opencode/: the tests run from it. */
const ROOT = process.cwd()

const WALL = [/\bBun\.sleep\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bDate\.now\b/, /\bperformance\.now\b/, /tests\/wait(\.ts)?\b/]

/** The world's own files: what a simulated test reaches in sim/, the runner aside. */
const WORLD = ["context.ts", "host.ts", "host-laws.ts", "hosts.ts", "http.ts", "law-names.ts", "plugins.ts", "provider.ts", "provider-laws.ts", "readings.ts", "runtime.ts", "server.ts", "world.ts"]

const Platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

/** Each line of `text` that names a wall-time source, as `<line>: <text>`. */
export const wallTime = (text: string) =>
  text.split("\n").flatMap((line, index) => {
    if (WALL.some((pattern) => pattern.test(line))) return [`${index + 1}: ${line.trim()}`]
    return []
  })

/** Every `*.sim.test.ts` under `dir` (a path from opencode/), node_modules and dot folders aside. */
const simulated = (dir: string): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = yield* fs.readDirectory(path.join(ROOT, dir))
    const found = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const entry = path.join(dir, name)
        const info = yield* fs.stat(path.join(ROOT, entry))
        if (info.type === "Directory" && name !== "node_modules" && !name.startsWith(".")) return yield* simulated(entry)
        if (info.type === "File" && name.endsWith(".sim.test.ts")) return [entry]
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

  Seed.effect(
    "no simulated test file names one",
    Effect.gen(function* () {
      const files = (yield* Effect.forEach(["cmd", "mods", "sim", "tests"], simulated)).flat()
      expect(files.length).toBeGreaterThanOrEqual(2)
      expect(yield* scan(files)).toEqual([])
    }).pipe(Effect.provide(Platform)),
  )

  Seed.effect(
    "the world's own files name none",
    scan(WORLD.map((file) => `sim/${file}`)).pipe(
      Effect.map((lines) => expect(lines).toEqual([])),
      Effect.provide(Platform),
    ),
  )
})
