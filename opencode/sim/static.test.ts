// No wall time in a simulated file: a `*.sim.test.ts`, and the world it runs
// on, never names a real timer or a real clock (`Bun.sleep`, `setTimeout`,
// `setInterval`, `Date.now`, `performance.now`, `tests/wait.ts`). Time there is
// the world's clock, moved only by an advance; a real one would make a seed
// replay differently, or wait on a clock the world never moves.
//
// The seed runner (seed.ts) holds the file's wall budget through Effect's live
// clock, and the real run (real.ts) is real by design: neither is scanned.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** opencode/: the tests run from it. */
const ROOT = process.cwd()

const WALL = [/\bBun\.sleep\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bDate\.now\b/, /\bperformance\.now\b/, /tests\/wait(\.ts)?\b/]

/** The world's own files: what a simulated test reaches in sim/, the runner and the real run aside. */
const WORLD = ["context.ts", "host.ts", "host-laws.ts", "law-names.ts", "plugins.ts", "runtime.ts", "server.ts", "world.ts"]

/** Each line of `text` that names a wall-time source, as `<line>: <text>`. */
export const wallTime = (text: string) =>
  text.split("\n").flatMap((line, index) => {
    if (WALL.some((pattern) => pattern.test(line))) return [`${index + 1}: ${line.trim()}`]
    return []
  })

/** Every `*.sim.test.ts` under `dir`, as a path from opencode/, node_modules aside. */
const simulated = (dir: string): ReadonlyArray<string> =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) return simulated(path)
    if (entry.isFile() && entry.name.endsWith(".sim.test.ts")) return [path]
    return []
  })

describe("no wall time in a simulated file", () => {
  test("the scan finds a planted Date.now(), and each other source of wall time", () => {
    expect(wallTime("const a = 1\nconst at = Date.now()\n")).toEqual(["2: const at = Date.now()"])
    for (const planted of ["await Bun.sleep(5)", "setTimeout(go, 5)", "setInterval(go, 5)", "performance.now()", 'import { wait } from "../../tests/wait.ts"'])
      expect(wallTime(planted)).toHaveLength(1)
    expect(wallTime("yield* Clock.currentTimeMillis\nyield* Effect.sleep(5)")).toEqual([])
  })

  test("no simulated test file names one", () => {
    const files = [...simulated("cmd"), ...simulated("mods"), ...simulated("sim"), ...simulated("tests")]
    expect(files.length).toBeGreaterThanOrEqual(2)
    expect(files.flatMap((file) => wallTime(readFileSync(join(ROOT, file), "utf8")).map((line) => `${file}:${line}`))).toEqual([])
  })

  test("the world's own files name none", () => {
    expect(WORLD.flatMap((file) => wallTime(readFileSync(join(ROOT, "sim", file), "utf8")).map((line) => `sim/${file}:${line}`))).toEqual([])
  })
})
