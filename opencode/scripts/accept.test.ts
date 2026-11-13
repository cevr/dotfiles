// `bun run accept`'s order (scripts/accept-plan.ts, scripts/accept.ts): the
// pool first, as wide as the host's load leaves room for, then the files marked
// `// accept: one at a time`, one at a time; and every acceptance file that
// measures time or waits under a short deadline (its own text or the scenario
// it drives) carries that marker. Run from opencode/, as the gate runs it.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Option } from "effect"
import { owned } from "../tests/owned.ts"
import { scratch } from "../tests/scratch.ts"
import { isSerial, plan, poolWidth, requestedWidth, scenariosOf, timingSigns } from "./accept-plan.ts"

const ROOT = process.cwd()

/** The acceptance files, as scripts/reach.ts lists them: tests/*.test.ts. */
const acceptance = () => [...new Bun.Glob("tests/*.test.ts").scanSync({ cwd: ROOT })].sort()
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

/** A real accept run takes the machine's lock and spawns bun test twice: a loaded machine gets room. */
const RUN_MS = 120_000

describe("the acceptance run's plan", () => {
  test("puts the marked files after the pool, one at a time, and the rest in a pool no wider than asked or than its files", () => {
    const texts = new Map([
      ["tests/a.test.ts", "// a plain one\n"],
      ["tests/b.test.ts", "// accept: one at a time (it measures).\n"],
      ["tests/c.test.ts", "// c\n"],
      ["tests/d.test.ts", "// d\n// accept: one at a time (it waits).\n"],
      ["tests/e.test.ts", 'const note = "// accept: one at a time"\n'],
    ])
    const text = (file: string) => Option.getOrElse(Option.fromNullishOr(texts.get(file)), () => "")
    expect(plan([...texts.keys()], text, 8)).toEqual([
      { name: "pool", files: ["tests/a.test.ts", "tests/c.test.ts", "tests/e.test.ts"], width: 3 },
      { name: "one at a time", files: ["tests/b.test.ts", "tests/d.test.ts"], width: 1 },
    ])
    expect(plan(["tests/b.test.ts"], text, 8)).toEqual([{ name: "one at a time", files: ["tests/b.test.ts"], width: 1 }])
    expect(plan(["tests/a.test.ts", "tests/c.test.ts"], text, 1)).toEqual([{ name: "pool", files: ["tests/a.test.ts", "tests/c.test.ts"], width: 1 }])
  })

  test("runs the pool on the cores the 1-minute load leaves free, at least one, and no more than --parallel asks", () => {
    const four = Option.some(4)
    expect([poolWidth(12, 0.4), poolWidth(12, 5.6), poolWidth(12, 13), poolWidth(12, 300), poolWidth(12, 2, four), poolWidth(12, 10, four), poolWidth(1, 0)]).toEqual([
      11, 6, 1, 1, 4, 2, 1,
    ])
    expect([requestedWidth([]), requestedWidth(["--list", "--parallel=3"])]).toEqual([
      { ok: true, width: Option.none() },
      { ok: true, width: Option.some(3) },
    ])
    expect([requestedWidth(["--parallel=0"]), requestedWidth(["--parallel=two"])]).toEqual([
      { ok: false, problem: "--parallel takes a positive whole number, not --parallel=0" },
      { ok: false, problem: "--parallel takes a positive whole number, not --parallel=two" },
    ])
  })

  test("reads a timing sign where a file measures time, names a short deadline or bounds a time, and none where it only sets a time", () => {
    expect(timingSigns("expect(Date.now() - started).toBeLessThan(5_000)").length).toBeGreaterThan(0)
    expect(timingSigns("yield* Effect.sleep(Math.max(0, start + ms - Date.now()))").length).toBeGreaterThan(0)
    expect(timingSigns("const BACK_WITHIN_MS = 20_000")).toEqual(["names a short deadline: const BACK_WITHIN_MS = 20_000"])
    expect(timingSigns("expect(result.quiet.loops).toBeLessThan(QUIET)").length).toBeGreaterThan(0)
    expect(timingSigns(["const TIMEOUT_MS = 180_000", "login(account, Date.now() - 1000)", "expect(rows.length).toBeLessThan(3)"].join("\n"))).toEqual([])
    expect(scenariosOf('owned(["bunx", "opencode-drive", "run", "scenarios/prime-wake.ts"])')).toEqual(["scenarios/prime-wake.ts"])
  })
})

describe("the acceptance files", () => {
  test("every one that measures time or waits under a short deadline, in its own text or the scenario it drives, is marked one at a time", () => {
    const unmarked = acceptance().flatMap((file) => {
      const text = read(file)
      const driven = scenariosOf(text).filter((scenario) => existsSync(join(ROOT, scenario)))
      const signs = [...timingSigns(text), ...driven.flatMap((scenario) => timingSigns(read(scenario)).map((sign) => `${scenario}: ${sign}`))]
      if (signs.length === 0 || isSerial(text)) return []
      return [`${file}: ${signs[0]}`]
    })
    expect(unmarked).toEqual([])
  })

  test("the files batch bi's load turned red, and those that wait on a real TUI or herdr, are marked", () => {
    const judged = [
      "tests/plugin-start.test.ts",
      "tests/herdr.test.ts",
      "tests/tui-paint.test.ts",
      "tests/pool-store-refresh.test.ts",
      "tests/reconnect-session.test.ts",
      "tests/dock-reconnect.test.ts",
      "tests/gamut.test.ts",
      "tests/lost-login.test.ts",
      "tests/escape-send.test.ts",
      "tests/escape-states.test.ts",
      "tests/escape-subagent.test.ts",
      "tests/prime-wake.test.ts",
    ]
    expect(judged.filter((file) => !isSerial(read(file)))).toEqual([])
  })
})

/** What a run printed, ANSI codes stripped, one trimmed line each. */
const linesOf = (out: string) =>
  Bun.stripANSI(out)
    .split("\n")
    .map((line) => line.trim())

describe("bun run accept", () => {
  test("lists the pool, then the marked files one at a time", async () => {
    const run = owned([process.execPath, "scripts/accept.ts", "--list", "--parallel=3"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
    const out = await Bun.readableStreamToText(run.stdout)
    const code = await run.exited
    const lines = linesOf(out).filter((line) => line !== "")
    const serial = lines.findIndex((line) => line.endsWith("timing-sensitive files, one at a time"))
    const files = acceptance()
    const pool = files.filter((file) => !isSerial(read(file)))
    const heading = Option.map(Option.fromNullishOr(/^accept: (\d+) files, (\d+) at a time \(/.exec(String(lines[0]))), (match) => ({
      files: Number(match[1]),
      width: Number(match[2]),
    }))
    expect({ code, files: Option.map(heading, (each) => each.files), pool: lines.slice(1, serial), serial: lines.slice(serial + 1) }).toEqual({
      code: 0,
      files: Option.some(pool.length),
      pool,
      serial: files.filter((file) => isSerial(read(file))),
    })
    // At most what --parallel asks, and at least one.
    expect(Option.getOrElse(Option.map(heading, (each) => each.width), () => 0)).toBeWithin(1, 4)
  })

  test(
    "runs the pool to its end, then each marked file, in that order",
    async () => {
      using lock = scratch("accept-lock-")
      // tests/git-options.test.ts is unmarked; tests/tui-paint.test.ts is marked and, without OPENCODE_DEV, skips.
      const { OPENCODE_DEV: _fork, ...inherited } = process.env
      const env = { ...inherited, ACCEPT_LOCK: join(lock.path, "lock") }
      // One stream, so accept's headings and bun's summaries keep their order.
      const merged = 'exec "$0" scripts/accept.ts tests/tui-paint.test.ts tests/git-options.test.ts 2>&1'
      const run = owned(["/bin/sh", "-c", merged, process.execPath], { cwd: ROOT, env, stdout: "pipe" })
      const out = await Bun.readableStreamToText(run.stdout)
      const code = await run.exited
      // Each phase is its own bun test run: its heading, bun's banner with its width, then its summary.
      const lines = linesOf(out).filter((line) => /^accept: \d|^bun test |^Ran \d+ tests? across/.test(line))
      expect({ code, lines: lines.map((line) => line.replace(/ v[\d.]+ \(\w+\)/, "").replace(/ \(\d+ cores.*\)$/, "").replace(/ \[[\d.]+m?s\]$/, "")) }).toEqual({
        code: 0,
        lines: [
          "accept: 1 files, 1 at a time",
          "bun test 1x PARALLEL",
          "Ran 2 tests across 1 file.",
          "accept: 1 timing-sensitive files, one at a time",
          "bun test 1x PARALLEL",
          "Ran 1 test across 1 file.",
        ],
      })
    },
    RUN_MS,
  )
})
