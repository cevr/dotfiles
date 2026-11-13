// `bun run accept`'s order (scripts/accept-plan.ts, scripts/accept.ts): the
// pool first, as wide as the host's load leaves room for, then the files marked
// `// accept: one at a time`, one at a time; and every acceptance file that
// asserts an upper bound on a time, rate or CPU (its own text or the scenario
// it drives) carries that marker, where a file that only waits for events does
// not need it. Run from opencode/, as the gate runs it.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Option } from "effect"
import { owned } from "../tests/owned.ts"
import { scratch } from "../tests/scratch.ts"
import { waitUntil } from "../tests/wait.ts"
import { isSerial, plan, poolWidth, requestedWidth, scenariosOf, timingSigns } from "./accept-plan.ts"
import { parseClosing, readLedger, SLOW_DEEP, tierOf } from "./accept-ledger.ts"
import { table } from "./leaks.ts"
import { acceptanceTests, acceptReach, load, packageOf, reach } from "./reach.ts"

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

  test("runs the pool on the cores the 1-minute load leaves free, at least one, or exactly as wide as --parallel asks at any load", () => {
    const four = Option.some(4)
    expect([poolWidth(12, 0.4), poolWidth(12, 5.6), poolWidth(12, 13), poolWidth(12, 300), poolWidth(12, 2, four), poolWidth(12, 10, four), poolWidth(12, 300, Option.some(2)), poolWidth(1, 0)]).toEqual([
      11, 6, 1, 1, 4, 4, 2, 1,
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

  test("reads a timing sign where a file asserts a time, rate or CPU stays under a limit, and none where it only waits or bounds from below", () => {
    const signed = [
      "expect(Date.now() - started).toBeLessThan(5_000)",
      "expect(summaries[0]?.at).toBeLessThan(due + 5_000)",
      "expect(result.quiet.loops).toBeLessThan(QUIET)",
      "expect(result.busy[0]!.share).toBeLessThan(BUDGET)",
      "expect(result.locations.filter((location) => !(location.cpu < LIVE_CPU_MS))).toEqual([])",
    ]
    expect(signed.filter((line) => timingSigns(line).length === 0)).toEqual([])
    expect(timingSigns("expect(Date.now() - started).toBeLessThan(5_000)")).toEqual(["bounds a time, rate or CPU from above: expect(Date.now() - started).toBeLessThan(5_000)"])
    const unsigned = [
      "const BACK_WITHIN_MS = 20_000",
      "await waitUntil(\"the dock\", () => settled, BACK_WITHIN_MS)",
      "yield* Effect.sleep(Math.max(0, start + ms - Date.now()))",
      "expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(5_000)",
      "expect(rows.length).toBeLessThan(3)",
      "if (Date.now() > deadline) return expect.unreachable(label)",
    ]
    expect(unsigned.flatMap(timingSigns)).toEqual([])
    expect(scenariosOf('owned(["bunx", "opencode-drive", "run", "scenarios/prime-wake.ts"])')).toEqual(["scenarios/prime-wake.ts"])
  })
})

describe("the acceptance files", () => {
  test("every one that asserts an upper bound on a time, rate or CPU, in its own text or the scenario it drives, is marked one at a time", () => {
    const unmarked = acceptance().flatMap((file) => {
      const text = read(file)
      const driven = scenariosOf(text).filter((scenario) => existsSync(join(ROOT, scenario)))
      const signs = [...timingSigns(text), ...driven.flatMap((scenario) => timingSigns(read(scenario)).map((sign) => `${scenario}: ${sign}`))]
      if (signs.length === 0 || isSerial(text)) return []
      return [`${file}: ${signs[0]}`]
    })
    expect(unmarked).toEqual([])
  })

  test("the files the survey judged: those that measure are marked, those that only wait for events are not", () => {
    // Measured: setup CPU, paints a second, a refresh's duration, the dock's settle time, a stop check's
    // requests within 6.5 s, a 1 s stall under the 2 s threshold. The rest wait for events under
    // generous deadlines (herdr's release among them, since the scenario waits for it).
    const judged = {
      "tests/plugin-start.test.ts": true,
      "tests/tui-paint.test.ts": true,
      "tests/pool-store-refresh.test.ts": true,
      "tests/dock-reconnect.test.ts": true,
      "tests/escape-send.test.ts": true,
      "tests/prime-escape.test.ts": true,
      "tests/stall.test.ts": true,
      "tests/herdr.test.ts": false,
      "tests/reconnect-session.test.ts": false,
      "tests/gamut.test.ts": false,
      "tests/lost-login.test.ts": false,
      "tests/escape-states.test.ts": false,
      "tests/escape-subagent.test.ts": false,
      "tests/prime-wake.test.ts": false,
    }
    expect(Object.fromEntries(Object.keys(judged).map((file) => [file, isSerial(read(file))]))).toEqual(judged)
  })
})

/** What a run printed, ANSI codes stripped, one trimmed line each. */
const linesOf = (out: string) =>
  Bun.stripANSI(out)
    .split("\n")
    .map((line) => line.trim())

/** A run of scripts/accept.ts with `args` and `env`, stdout and stderr in one stream so its lines keep their order. */
const accept = (args: ReadonlyArray<string>, env: typeof process.env) => startAccept(args, env).done

/** A run of scripts/accept.ts started: its process (the `bun` the shell execs, so its pid is the run's) and its end. */
const startAccept = (args: ReadonlyArray<string>, env: typeof process.env) => {
  const started = performance.now()
  const child = owned(["/bin/sh", "-c", 'exec "$0" scripts/accept.ts "$@" 2>&1', process.execPath, ...args], { cwd: ROOT, env, stdout: "pipe" })
  const done = (async () => {
    const out = await Bun.readableStreamToText(child.stdout)
    const code = await child.exited
    return { code, lines: linesOf(out).filter((line) => line !== ""), seconds: (performance.now() - started) / 1000 }
  })()
  return { child, done }
}

/** The environment of a run on a scratch lock and ledger, without the fork (its real-OpenCode tests skip). */
const scratchEnv = (dir: string, extra: Record<string, string> = {}) => {
  const { OPENCODE_DEV: _fork, ...inherited } = process.env
  return { ...inherited, ACCEPT_LOCK: join(dir, "lock"), ACCEPT_LEDGER: join(dir, "ledger.json"), ...extra }
}

/** Waits until `what` holds (tests/wait.ts), for `ms` at most; a wait in vain fails the test, naming it. */
const until = (what: string, ready: () => boolean, ms = 30_000) => waitUntil(what, ready, ms)

/** A child this test starts that holds the scratch accept lock (through mods/rift/process/flock.ts) until the test disposes of it. */
const holdLock = (dir: string) => {
  const script = join(dir, "hold.ts")
  const ready = join(dir, "held")
  writeFileSync(
    script,
    [
      `import { writeFileSync } from "node:fs"`,
      `import { exclusively } from ${JSON.stringify(join(ROOT, "mods/rift/process/flock.ts"))}`,
      `await exclusively(process.argv[2] ?? "")(() => {`,
      `  writeFileSync(process.argv[3] ?? "", "held")`,
      `  return new Promise(() => {})`,
      `})`,
      "",
    ].join("\n"),
  )
  const child = owned([process.execPath, script, join(dir, "lock"), ready], { cwd: ROOT, stdout: "ignore" })
  return { ready: until("the lock held by the test's child", () => existsSync(ready)), [Symbol.dispose]: () => child.kill("SIGKILL") }
}

/** The closing line's counts, none when the run printed none. */
const closingOf = (lines: ReadonlyArray<string>) => Option.flatMap(Option.fromNullishOr(lines.findLast((line) => line.startsWith("accept: land ") || line.startsWith("accept: owed ") || line.startsWith("accept: all "))), parseClosing)

/** The files a --list printed as due. */
const dueOf = (lines: ReadonlyArray<string>) => lines.flatMap((line) => Option.toArray(Option.map(Option.fromNullishOr(/^due: (\S+)/.exec(line)), (match) => String(match[1]))))

describe("bun run accept", () => {
  test("lists the pool, then the marked files one at a time, then the closing line", async () => {
    using dir = scratch("accept-list-")
    const { code, lines } = await accept(["--list", "--parallel=3"], scratchEnv(dir.path))
    const pooled = lines.findIndex((line) => /^accept: \d+ files, \d+ at a time \(/.test(line))
    const serial = lines.findIndex((line) => line.endsWith("timing-sensitive files, one at a time"))
    const files = acceptance()
    const heading = Option.map(Option.fromNullishOr(/^accept: (\d+) files, (\d+) at a time \(/.exec(String(lines[pooled]))), (match) => ({
      files: Number(match[1]),
      width: Number(match[2]),
    }))
    expect({
      code,
      files: Option.map(heading, (each) => each.files),
      pool: dueOf(lines.slice(pooled, serial)),
      serial: dueOf(lines.slice(serial)),
      closing: closingOf(lines),
    }).toEqual({
      code: 0,
      files: Option.some(files.filter((file) => !isSerial(read(file))).length),
      pool: files.filter((file) => !isSerial(read(file))),
      serial: files.filter((file) => isSerial(read(file))),
      closing: Option.some({ mode: "all", passed: 0, failed: 0, owed: files.length, deep: 0, budget: 0 }),
    })
    // At most what --parallel asks, and at least one.
    expect(Option.getOrElse(Option.map(heading, (each) => each.width), () => 0)).toBeWithin(1, 4)
  })

  test(
    "runs the pool to its end, then each marked file, in that order; a file whose tests skip records no pass",
    async () => {
      using dir = scratch("accept-run-")
      // tests/git-options.test.ts is unmarked; tests/tui-paint.test.ts is marked and, without OPENCODE_DEV, skips.
      const { code, lines } = await accept(["tests/tui-paint.test.ts", "tests/git-options.test.ts"], scratchEnv(dir.path))
      const shown = lines
        .filter((line) => /^accept: (\d|passed|owed|failed)/.test(line) || line.startsWith("owed: "))
        .map((line) => line.replace(/ \(\d+ cores.*\)$/, "").replace(/ in [\d.]+ s/, ""))
      expect({ code, shown, closing: closingOf(lines) }).toEqual({
        code: 0,
        shown: [
          "accept: 1 files, 1 at a time",
          "accept: passed tests/git-options.test.ts",
          "accept: 1 timing-sensitive files, one at a time",
          "accept: owed tests/tui-paint.test.ts",
          ...acceptance()
            .filter((file) => file !== "tests/tui-paint.test.ts" && file !== "tests/git-options.test.ts")
            .map((file) => `owed: ${file} (not named)`),
          expect.stringMatching(/^owed: tests\/tui-paint\.test\.ts \(skipped: \d+ of \d+ tests skipped: no pass recorded\)$/),
        ],
        closing: Option.some({ mode: "all", passed: 1, failed: 0, owed: acceptance().length - 1, deep: 0, budget: 0 }),
      })
      expect(Object.keys(ledgerAt(join(dir.path, "ledger.json")).passes)).toEqual(["tests/git-options.test.ts"])
    },
    RUN_MS,
  )
})

/** The passes a scratch ledger holds, by file. */
const ledgerAt = (file: string) => readLedger({ read: (each) => Option.liftPredicate(each, existsSync).pipe(Option.map((found) => readFileSync(found, "utf8"))), write: () => {}, rename: () => {} }, file).ledger

describe("the acceptance tiers over the real tree", () => {
  test("each file's acceptance reach is its reach less only in-package unit tests, benches and Markdown", async () => {
    const workspace = await load()
    const memo = new Map<string, ReadonlyArray<string>>()
    const wrong = acceptanceTests(workspace).flatMap((file) => {
      const all = reach(workspace, [file], memo)
      const inputs = acceptReach(workspace, file, memo)
      const extra = [...inputs].filter((each) => !all.has(each))
      const dropped = [...all].filter((each) => !inputs.has(each))
      const unexpected = dropped.filter((each) => !packageOf(each) || !/(\.test\.tsx?|\.bench\.ts|\.md)$/.test(each))
      return [...extra.map((each) => `${file}: ${each} is not in its reach`), ...unexpected.map((each) => `${file}: ${each} dropped`)]
    })
    expect(wrong).toEqual([])
  })

  test("every file allowed past the deep share exists, each with the unit that removes it: the list only shrinks", () => {
    expect(SLOW_DEEP.filter(([file, unit]) => !existsSync(join(ROOT, file)) || unit === "")).toEqual([])
  })

  test("every one-at-a-time file is deep, and every deep marker names its measured time", () => {
    const files = acceptance()
    expect(files.filter((file) => isSerial(read(file)) && tierOf(read(file)) !== "deep")).toEqual([])
    const markers = files.flatMap((file) => read(file).split("\n").filter((line) => line.startsWith("// accept: deep")).map((line) => `${file}: ${line}`))
    expect(markers.filter((line) => !/: \/\/ accept: deep \(\d+(\.\d+)? s alone on a quiet host: .+\)$/.test(line))).toEqual([])
  })

  test(
    "--list prints each tier's due files and the closing line, and exits without taking the lock",
    async () => {
      using dir = scratch("accept-tiers-")
      // The lock is held by a process this test started, alive: a run that took it would wait for good.
      using held = holdLock(dir.path)
      await held.ready
      const files = acceptance()
      const land = await accept(["--land", "--list"], scratchEnv(dir.path))
      const owed = await accept(["--owed", "--list"], scratchEnv(dir.path))
      const settled = await accept(["--owed", "--settled", "--list"], scratchEnv(dir.path))
      const deep = files.filter((file) => tierOf(read(file)) === "deep")
      expect({ code: land.code, due: [...dueOf(land.lines)].sort(), closing: closingOf(land.lines) }).toEqual({
        code: 0,
        due: files.filter((file) => tierOf(read(file)) === "land"),
        closing: Option.some({ mode: "land", passed: 0, failed: 0, owed: files.length, deep: deep.length, budget: 0 }),
      })
      // Without --settled the files that bound a time stay owed, by name and why.
      const timing = files.filter((file) => isSerial(read(file)))
      expect({ code: owed.code, due: [...dueOf(owed.lines)].sort(), held: owed.lines.filter((line) => line.endsWith("(waits for a settled host)")), closing: closingOf(owed.lines) }).toEqual({
        code: 0,
        due: files.filter((file) => !isSerial(read(file))),
        held: timing.map((file) => `owed: ${file} (waits for a settled host)`),
        closing: Option.some({ mode: "owed", passed: 0, failed: 0, owed: files.length, deep: 0, budget: 0 }),
      })
      expect({ code: settled.code, due: [...dueOf(settled.lines)].sort() }).toEqual({ code: 0, due: files })
      expect(land.lines.concat(owed.lines, settled.lines).filter((line) => line.includes("waiting for"))).toEqual([])
    },
    RUN_MS,
  )
})

/** Three stand-in acceptance files: one passes in 1 s, one fails, one sleeps 120 s beside a process group of its own. */
const STAND_INS = {
  "pass.test.ts": 'import { expect, test } from "bun:test"\ntest("passes", async () => {\n  await Bun.sleep(1000)\n  expect(1).toBe(1)\n})\n',
  "fail.test.ts": 'import { expect, test } from "bun:test"\ntest("fails", () => {\n  expect(1).toBe(2)\n})\n',
  "sleep.test.ts": [
    'import { test } from "bun:test"',
    'import { writeFileSync } from "node:fs"',
    'import { join } from "node:path"',
    'test("sleeps", async () => {',
    '  const child = Bun.spawn(["sleep", "120"], { detached: true, stdout: "ignore" })',
    '  writeFileSync(join(import.meta.dir, "groups.json"), JSON.stringify([process.pid, child.pid]))',
    "  await Bun.sleep(120_000)",
    "})",
    "",
  ].join("\n"),
}

/** Whether any process still runs in the group `group` leads. */
const groupAlive = (group: number) => table().some((row) => row.pgid === group)

describe("a land run under its budget", () => {
  test(
    "passes one, fails one, stops and owes the sleeper with its own group, and records the one pass; a second run skips the pass",
    async () => {
      using dir = scratch("accept-land-")
      const files = join(dir.path, "files")
      mkdirSync(files)
      for (const [name, body] of Object.entries(STAND_INS)) writeFileSync(join(files, name), body)
      const env = scratchEnv(dir.path, { ACCEPT_FILES: join(files, "*.test.ts"), ACCEPT_BUDGET_MS: "6000" })
      const first = await accept(["--land"], env)
      const groups = Option.match(Option.liftPredicate(join(files, "groups.json"), existsSync), {
        onNone: () => [],
        onSome: (file): ReadonlyArray<number> => JSON.parse(readFileSync(file, "utf8")),
      })
      expect({ failed: first.code !== 0, inTime: first.seconds < 12, closing: closingOf(first.lines), groups: groups.length, alive: groups.filter(groupAlive) }).toEqual({
        failed: true,
        inTime: true,
        closing: Option.some({ mode: "land", passed: 1, failed: 1, owed: 1, deep: 0, budget: 1 }),
        groups: 2,
        alive: [],
      })
      expect(Object.keys(ledgerAt(join(dir.path, "ledger.json")).passes)).toEqual([join(files, "pass.test.ts")])

      const second = await accept(["--land"], env)
      expect({ failed: second.code !== 0, closing: closingOf(second.lines), before: second.lines.filter((line) => line.startsWith("accept: 1 files passed before")).length }).toEqual({
        failed: true,
        closing: Option.some({ mode: "land", passed: 0, failed: 1, owed: 1, deep: 0, budget: 1 }),
        before: 1,
      })
    },
    RUN_MS,
  )
})

/** A deep run's stand-ins: two that pass in 1 s, and one that sleeps 60 s beside a process group of its own on its first run (1 s after). */
const DEEP_STAND_INS = {
  "a.test.ts": 'import { expect, test } from "bun:test"\ntest("passes", async () => {\n  await Bun.sleep(1000)\n  expect(1).toBe(1)\n})\n',
  "b.test.ts": 'import { expect, test } from "bun:test"\ntest("passes", async () => {\n  await Bun.sleep(1000)\n  expect(2).toBe(2)\n})\n',
  "sleep.test.ts": [
    'import { test } from "bun:test"',
    'import { existsSync, writeFileSync } from "node:fs"',
    'import { join } from "node:path"',
    'const dir = process.env.YIELD_DIR ?? ""',
    'test("sleeps", async () => {',
    '  const first = !existsSync(join(dir, "slept"))',
    '  writeFileSync(join(dir, "slept"), "")',
    '  const child = Bun.spawn(["sleep", "120"], { detached: true, stdout: "ignore" })',
    '  writeFileSync(join(dir, "groups.json"), JSON.stringify([process.pid, child.pid]))',
    "  await Bun.sleep((first && 60_000) || 1000)",
    "  child.kill()",
    "})",
    "",
  ].join("\n"),
}

/** A land run's one stand-in: it records which of the deep run's groups still run as it starts. */
const LAND_STAND_IN = [
  'import { test } from "bun:test"',
  'import { existsSync, readFileSync, writeFileSync } from "node:fs"',
  'import { join } from "node:path"',
  'const dir = process.env.YIELD_DIR ?? ""',
  'test("starts after the deep run gave the lock up", () => {',
  '  const file = join(dir, "groups.json")',
  '  const groups: Array<number> = (existsSync(file) && JSON.parse(readFileSync(file, "utf8"))) || []',
  "  const alive = groups.filter((group) => {",
  "    try {",
  "      process.kill(-group, 0)",
  "      return true",
  "    } catch {",
  "      return false",
  "    }",
  "  })",
  '  writeFileSync(join(dir, "seen.json"), JSON.stringify({ groups, alive }))',
  "})",
  "",
].join("\n")

/** A scratch world for a deep run and land runs on one scratch lock, ledger and logs. */
const yieldWorld = (dir: string) => {
  for (const [name, body] of Object.entries(DEEP_STAND_INS)) {
    mkdirSync(join(dir, "deep"), { recursive: true })
    writeFileSync(join(dir, "deep", name), body)
  }
  mkdirSync(join(dir, "land"), { recursive: true })
  writeFileSync(join(dir, "land", "quick.test.ts"), LAND_STAND_IN)
  const base = scratchEnv(dir, { ACCEPT_LOGS: join(dir, "logs"), YIELD_DIR: dir })
  const groupsFile = join(dir, "groups.json")
  return {
    deepEnv: { ...base, ACCEPT_FILES: join(dir, "deep", "*.test.ts") },
    landEnv: { ...base, ACCEPT_FILES: join(dir, "land", "*.test.ts"), ACCEPT_BUDGET_MS: "20000" },
    groupsFile,
    owner: join(dir, "lock.owner.json"),
    mark: (pid: number) => join(dir, "lock.wanted", String(pid)),
    groups: (): ReadonlyArray<number> => (existsSync(groupsFile) && JSON.parse(readFileSync(groupsFile, "utf8"))) || [],
  }
}

/** The land run's wait line: the whole wait and the part on its clock. */
const waitedOf = (lines: ReadonlyArray<string>) =>
  Option.map(Option.fromNullishOr(lines.map((line) => /^accept: waited ([\d.]+) s for the lock \(([\d.]+) s on the run's clock/.exec(line)).find(Boolean)), (match) => ({
    waited: Number(match[1]),
    onClock: Number(match[2]),
  }))

describe("a deep run yields the lock to a land run", () => {
  test(
    "the lock is free within 5 s of the mark, the land run ends in its budget with the wait on its clock, the sleeper is gone before it starts, and the deep run then passes all three",
    async () => {
      using dir = scratch("accept-yield-")
      const world = yieldWorld(dir.path)
      const deepRun = accept(["--owed", "--parallel=3"], world.deepEnv)
      await until("the sleeper running in the deep run", () => world.groups().length === 2)
      const land = await accept(["--land"], world.landEnv)
      const deep = await deepRun
      const seen = JSON.parse(readFileSync(join(dir.path, "seen.json"), "utf8"))
      const waited = waitedOf(land.lines)
      expect({
        land: land.code,
        inBudget: land.seconds < 20,
        waitedUnder5: Option.exists(waited, (each) => each.waited < 5),
        // The wait ends as the lock is taken: its line comes before the first file, so it counts the wait alone.
        waitBeforeFiles: land.lines.findIndex((line) => line.startsWith("accept: waited ")) < land.lines.findIndex((line) => line.startsWith("accept: passed ")),
        onClock: Option.exists(waited, (each) => each.onClock === each.waited),
        seen,
        deep: deep.code,
        closing: closingOf(deep.lines),
        yields: deep.lines.filter((line) => line.startsWith("accept: yielded the lock to a land run")).length,
      }).toEqual({
        land: 0,
        inBudget: true,
        waitedUnder5: true,
        waitBeforeFiles: true,
        onClock: true,
        seen: { groups: expect.any(Array), alive: [] },
        deep: 0,
        closing: Option.some({ mode: "owed", passed: 3, failed: 0, owed: 0, deep: 0, budget: 0 }),
        yields: 1,
      })
      expect(seen.groups.length).toBe(2)
    },
    RUN_MS,
  )

  test(
    "a land run killed while its mark is set: the deep run goes on within 2 s",
    async () => {
      using dir = scratch("accept-yield-land-dies-")
      const world = yieldWorld(dir.path)
      const deep = startAccept(["--owed", "--parallel=3"], world.deepEnv)
      await until("the sleeper running in the deep run", () => world.groups().length === 2)
      const land = startAccept(["--land"], world.landEnv)
      await until("the land run's wanted mark", () => existsSync(world.mark(land.child.pid)))
      // The deep run saw the mark: it stopped the sleeper's groups to give the lock up.
      const stopping = world.groups()
      await until("the deep run stopping the sleeper's groups", () => stopping.every((group) => !groupAlive(group)), 10_000)
      land.child.kill("SIGKILL")
      const killedAt = Date.now()
      await land.done
      // The deep run takes the lock back and writes itself as its owner.
      await until(
        "the deep run holding the lock again",
        () => existsSync(world.owner) && statSync(world.owner).mtimeMs >= killedAt && readFileSync(world.owner, "utf8").includes(`"pid":${deep.child.pid}`),
        10_000,
      )
      const resumedIn = Date.now() - killedAt
      const ended = await deep.done
      expect({ within2s: resumedIn < 2000, closing: closingOf(ended.lines) }).toEqual({
        within2s: true,
        closing: Option.some({ mode: "owed", passed: 3, failed: 0, owed: 0, deep: 0, budget: 0 }),
      })
    },
    RUN_MS,
  )

  test(
    "a deep run killed while it holds the lock: the land run takes it at once, and the ledger reads",
    async () => {
      using dir = scratch("accept-yield-deep-dies-")
      const world = yieldWorld(dir.path)
      const deep = startAccept(["--owed", "--parallel=3"], world.deepEnv)
      await until("the sleeper running in the deep run", () => world.groups().length === 2)
      const orphans = world.groups()
      deep.child.kill("SIGKILL")
      await deep.done
      const land = await accept(["--land"], world.landEnv)
      // The killed run stopped nothing: its sleeper's groups (started by this test's run) go now.
      for (const group of orphans) Bun.spawnSync(["kill", "-KILL", `-${group}`], { stderr: "ignore" })
      await until("the killed run's sleeper groups gone", () => orphans.every((group) => !groupAlive(group)), 5000)
      const read = readLedger({ read: (each) => Option.liftPredicate(each, existsSync).pipe(Option.map((found) => readFileSync(found, "utf8"))), write: () => {}, rename: () => {} }, join(dir.path, "ledger.json"))
      expect({ land: land.code, atOnce: Option.exists(waitedOf(land.lines), (each) => each.waited < 1), problem: read.problem }).toEqual({ land: 0, atOnce: true, problem: Option.none() })
    },
    RUN_MS,
  )
})
