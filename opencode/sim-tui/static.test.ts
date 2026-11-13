// No wall time in a simulated TUI file: a `*.sim.test.tsx`, and every file of
// sim-tui/ but the fixture boot (app.ts, the one that holds the clocks), never
// names a real timer or a real clock (`Bun.sleep`, `setTimeout`,
// `setInterval`, `Date.now`, `performance.now`, `tests/wait.ts`). Time there
// is the virtual clock the harness moves; a real one would make a seed replay
// differently, or wait on a clock nothing moves. This file names them to find
// them, so it is not scanned either.
import { describe, expect, test } from "bun:test"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect"
import * as Seed from "../sim/seed.ts"

/** opencode/: the tests run from it. */
const ROOT = process.cwd()

const WALL = [/\bBun\.sleep\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bDate\.now\b/, /\bperformance\.now\b/, /tests\/wait(\.ts)?\b/]

/** The files of sim-tui/ that may read real time: the fixture boot, and this scan. */
const EXEMPT = new Set(["sim-tui/app.ts", "sim-tui/static.test.ts"])

const Platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

/** Each line of `text` that names a wall-time source, as `<line>: <text>`. */
export const wallTime = (text: string) =>
  text.split("\n").flatMap((line, index) => [`${index + 1}: ${line.trim()}`].filter(() => WALL.some((pattern) => pattern.test(line))))

/** Every file under `dir` (a path from opencode/) that `keep` takes, node_modules and dot folders aside. */
const files = (dir: string, keep: (name: string) => boolean): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = yield* fs.readDirectory(path.join(ROOT, dir))
    const found = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const entry = path.join(dir, name)
        const info = yield* fs.stat(path.join(ROOT, entry))
        if (info.type === "Directory" && name !== "node_modules" && !name.startsWith(".")) return yield* files(entry, keep)
        if (info.type === "File" && keep(name)) return [entry]
        return []
      }),
    )
    return found.flat()
  })

/** Each wall-time line of `paths` (from opencode/), as `<file>:<line>: <text>`. */
const scan = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const found = yield* Effect.forEach(paths, (file) =>
      fs.readFileString(path.join(ROOT, file)).pipe(Effect.map((text) => wallTime(text).map((line) => `${file}:${line}`))),
    )
    return found.flat()
  })

describe("no wall time in a simulated TUI file", () => {
  test("the scan finds a planted Date.now(), and each other source of wall time", () => {
    expect(wallTime("const a = 1\nconst at = Date.now()\n")).toEqual(["2: const at = Date.now()"])
    for (const planted of ["await Bun.sleep(5)", "setTimeout(go, 5)", "setInterval(go, 5)", "performance.now()", 'import { wait } from "../../tests/wait.ts"'])
      expect(wallTime(planted)).toHaveLength(1)
    expect(wallTime("yield* tui.advance(500)\nconst at = tui.elapsed()")).toEqual([])
  })

  Seed.effect(
    "no *.sim.test.tsx names one",
    Effect.gen(function* () {
      const found = (yield* Effect.forEach(["cmd", "mods"], (dir) => files(dir, (name) => name.endsWith(".sim.test.tsx")))).flat()
      expect(found.length).toBeGreaterThanOrEqual(3)
      expect(yield* scan(found)).toEqual([])
    }).pipe(Effect.provide(Platform)),
  )

  Seed.effect(
    "no file of sim-tui/ but the fixture boot names one",
    Effect.gen(function* () {
      const found = (yield* files("sim-tui", (name) => /\.tsx?$/.test(name))).filter((file) => !EXEMPT.has(file))
      expect(found).toContain("sim-tui/server.ts")
      expect(yield* scan(found)).toEqual([])
    }).pipe(Effect.provide(Platform)),
  )
})
