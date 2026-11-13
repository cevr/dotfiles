// `bun run accept`'s order (scripts/accept-plan.ts, scripts/accept.ts): the
// pool first, as wide as the host's load leaves room for, then the files marked
// `// accept: one at a time`, one at a time; and every acceptance file that
// asserts an upper bound on a time, rate or CPU (its own text or the scenario
// it drives) carries that marker, where a file that only waits for events does
// not need it. Run from opencode/, as the gate runs it.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Option } from "effect"
import { owned } from "../tests/owned.ts"
import { scratch } from "../tests/scratch.ts"
import { waitUntil } from "../tests/wait.ts"
import { FIXED_SEEDS, isSerial, isSimSuite, longSwarmDue, plan, poolWidth, reachedSuites, replayLine, requestedWidth, scenariosOf, swarmBox, swarmFirst, swarmRead, swarmSlot, timingSigns } from "./accept-plan.ts"
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

/**
 * A run of scripts/accept.ts started: its process (the `bun` the shell execs, so its pid is the run's) and its end.
 * `owned` stops all it started when it exits, which would hide what the run itself failed to stop; `unowned` runs it
 * bare (its own group), for a test that checks the run's own stop and then ends its stand-ins' groups itself.
 */
const startAccept = (args: ReadonlyArray<string>, env: typeof process.env, unowned = false) => {
  const started = performance.now()
  const argv = ["/bin/sh", "-c", 'exec "$0" scripts/accept.ts "$@" 2>&1', process.execPath, ...args]
  const child = (unowned && Bun.spawn(argv, { cwd: ROOT, env, stdout: "pipe", detached: true })) || owned(argv, { cwd: ROOT, env, stdout: "pipe" })
  const done = (async () => {
    const out = await Bun.readableStreamToText(child.stdout)
    const code = await child.exited
    return { code, lines: linesOf(out).filter((line) => line !== ""), seconds: (performance.now() - started) / 1000 }
  })()
  return { child, done }
}

/** This process's environment, without the fork (its real-OpenCode tests skip) and without the clock switch below. */
const { OPENCODE_DEV: _fork, ACCEPT_TIMED: timedSwitch, ...INHERITED } = process.env

/**
 * Whether the real runs below judge their wall-clock bounds too: only with ACCEPT_TIMED=1, set by the acceptance file
 * tests/accept-clock.test.ts, which runs one at a time. In the gate a loaded host stretches real time many times over,
 * and a gate unit test does not judge it: there the runs judge what happened and in what order, never how fast.
 */
const TIMED = timedSwitch === "1"

/** A wall-clock bound: judged only when TIMED; holds otherwise. */
const bound = (holds: boolean) => holds || !TIMED

/** The environment of a run on a scratch lock and ledger, without the fork (its real-OpenCode tests skip). */
const scratchEnv = (dir: string, extra: Record<string, string> = {}) => ({
  ...INHERITED,
  ACCEPT_LOCK: join(dir, "lock"),
  ACCEPT_LEDGER: join(dir, "ledger.json"),
  ACCEPT_LOGS: join(dir, "logs"),
  ACCEPT_SWARM: join(dir, "swarm.json"),
  // No simulated suite unless a test names its own stand-ins: a run swarms none of the real ones.
  ACCEPT_SIM_FILES: join(dir, "sim", "*.sim.test.ts"),
  ...extra,
})

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

  test("every path the runner reads from the environment (ACCEPT_*) is in scratch for every test that runs it: none touches the owner's ledger, lock, logs or swarm state, or swarms the real suites", () => {
    const read = new Set(Array.from(readFileSync(join(ROOT, "scripts/accept.ts"), "utf8").matchAll(/ENV\.(ACCEPT_[A-Z_]+)/g), (match) => String(match[1])))
    // Not paths: the land budget, the long swarm's box, and the files glob each test sets to its own stand-ins. The
    // simulated suites' glob is one: unset, a run swarms the real suites.
    const paths = [...read].filter((name) => name !== "ACCEPT_BUDGET_MS" && name !== "ACCEPT_LONG_SWARM_MS" && name !== "ACCEPT_FILES").sort()
    const env = new Map(Object.entries(scratchEnv("/scratch/x")))
    expect({ paths, outside: paths.filter((name) => !Option.exists(Option.fromUndefinedOr(env.get(name)), (value) => value.startsWith("/scratch/x/"))) }).toEqual({
      paths: ["ACCEPT_LEDGER", "ACCEPT_LOCK", "ACCEPT_LOGS", "ACCEPT_SIM_FILES", "ACCEPT_SWARM"],
      outside: [],
    })
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

/**
 * A detached child (a process group of its own, as `opencode service` is) that starts a long sleeper of
 * its own and waits: Bun ends the direct child when its `bun test` is stopped, so only the runner's stop of
 * the test's own processes ends the grandchild (accept-ledger-land M1). The child's pid leads its group.
 */
const GRANDCHILD = '  const child = Bun.spawn(["/bin/sh", "-c", "sleep 120 & wait"], { detached: true, stdout: "ignore" })'

/** Three stand-in acceptance files: one passes in 1 s, one fails, one sleeps 120 s beside a process group of its own with a grandchild in it. */
const STAND_INS = {
  "pass.test.ts": 'import { expect, test } from "bun:test"\ntest("passes", async () => {\n  await Bun.sleep(1000)\n  expect(1).toBe(1)\n})\n',
  "fail.test.ts": 'import { expect, test } from "bun:test"\ntest("fails", () => {\n  expect(1).toBe(2)\n})\n',
  "sleep.test.ts": [
    'import { test } from "bun:test"',
    'import { writeFileSync } from "node:fs"',
    'import { join } from "node:path"',
    'test("sleeps", async () => {',
    GRANDCHILD,
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
      // Bare, so only the run's own stop can end the sleeper's grandchild (accept-ledger-land M1).
      const first = await startAccept(["--land"], env, true).done
      const groups = Option.match(Option.liftPredicate(join(files, "groups.json"), existsSync), {
        onNone: () => [],
        onSome: (file): ReadonlyArray<number> => JSON.parse(readFileSync(file, "utf8")),
      })
      const alive = groups.filter(groupAlive)
      // What the run left of this test's own stand-in, ended here so a red run leaks nothing.
      for (const group of alive) Bun.spawnSync(["kill", "-KILL", `-${group}`], { stderr: "ignore" })
      expect({ failed: first.code !== 0, inTime: bound(first.seconds < 12), closing: closingOf(first.lines), groups: groups.length, alive }).toEqual({
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
    GRANDCHILD,
    '  writeFileSync(join(dir, "groups.json"), JSON.stringify([process.pid, child.pid]))',
    "  await Bun.sleep((first && 60_000) || 1000)",
    "  process.kill(-child.pid, \"SIGKILL\")",
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
    /** How many files the scratch ledger holds a pass for. */
    passed: () =>
      Object.values(
        readLedger({ read: (each) => Option.liftPredicate(each, existsSync).pipe(Option.map((found) => readFileSync(found, "utf8"))), write: () => {}, rename: () => {} }, join(dir, "ledger.json")).ledger.passes,
      ).filter((passes) => passes.length > 0).length,
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
      // The two quick files pass in this hold, before the yield: the deep run must count them as its own passes after it, not as passed before it.
      await until("the quick files passed in the deep run's first hold", () => world.passed() >= 2)
      const land = await accept(["--land"], world.landEnv)
      const deep = await deepRun
      const seen = JSON.parse(readFileSync(join(dir.path, "seen.json"), "utf8"))
      const waited = waitedOf(land.lines)
      expect({
        land: land.code,
        inBudget: bound(land.seconds < 20),
        waitedUnder5: bound(Option.exists(waited, (each) => each.waited < 5)),
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
      await until("the deep run stopping the sleeper's groups", () => stopping.every((group) => !groupAlive(group)))
      land.child.kill("SIGKILL")
      const killedAt = Date.now()
      await land.done
      // The deep run takes the lock back and writes itself as its owner.
      await until(
        "the deep run holding the lock again",
        () => existsSync(world.owner) && statSync(world.owner).mtimeMs >= killedAt && readFileSync(world.owner, "utf8").includes(`"pid":${deep.child.pid}`),
      )
      const resumedIn = Date.now() - killedAt
      const ended = await deep.done
      expect({ within2s: bound(resumedIn < 2000), closing: closingOf(ended.lines) }).toEqual({
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
      await until("the killed run's sleeper groups gone", () => orphans.every((group) => !groupAlive(group)))
      const read = readLedger({ read: (each) => Option.liftPredicate(each, existsSync).pipe(Option.map((found) => readFileSync(found, "utf8"))), write: () => {}, rename: () => {} }, join(dir.path, "ledger.json"))
      expect({
        land: land.code,
        // The killed run's flock ended with it: the land run found the lock free and waited for no one.
        free: !land.lines.some((line) => line.startsWith("accept: waiting for")),
        atOnce: bound(Option.exists(waitedOf(land.lines), (each) => each.waited < 1)),
        problem: read.problem,
      }).toEqual({ land: 0, free: true, atOnce: true, problem: Option.none() })
    },
    RUN_MS,
  )
})

/** A stand-in that fails on its first run in the scratch dir and passes on every later one: a load flake. */
const FLAKY = [
  'import { expect, test } from "bun:test"',
  'import { existsSync, writeFileSync } from "node:fs"',
  'import { join } from "node:path"',
  'const dir = process.env.YIELD_DIR ?? ""',
  'test("fails once", () => {',
  '  const first = !existsSync(join(dir, "flaky-ran"))',
  '  writeFileSync(join(dir, "flaky-ran"), "")',
  "  expect(first).toBe(false)",
    "})",
  "",
].join("\n")

/** A stand-in that sleeps 15 s on its first run, 1 s after: it holds the deep run's first hold open. */
const SLOW_FIRST = [
  'import { test } from "bun:test"',
  'import { existsSync, writeFileSync } from "node:fs"',
  'import { join } from "node:path"',
  'const dir = process.env.YIELD_DIR ?? ""',
  'test("sleeps", async () => {',
  '  const first = !existsSync(join(dir, "slept"))',
  '  writeFileSync(join(dir, "slept"), "")',
  "  await Bun.sleep((first && 15_000) || 1000)",
    "})",
  "",
].join("\n")

/** Whether the deep run has logged `name` (its run ended and its outcome is in the run's hand). */
const logged = (logs: string, name: string) => existsSync(logs) && readdirSync(logs).some((head) => existsSync(join(logs, head, `${name}.log`)))

describe("a deep run's second runs", () => {
  test(
    "a file that failed once before a land run took the lock runs once more after the yield, alone, and passes: the run is green (round 1's M2)",
    async () => {
      using dir = scratch("accept-second-")
      mkdirSync(join(dir.path, "deep"))
      mkdirSync(join(dir.path, "land"))
      writeFileSync(join(dir.path, "deep", "flaky.test.ts"), FLAKY)
      writeFileSync(join(dir.path, "deep", "slow.test.ts"), SLOW_FIRST)
      writeFileSync(join(dir.path, "land", "quick.test.ts"), 'import { test } from "bun:test"\ntest("quick", () => {})\n')
      const base = scratchEnv(dir.path, { YIELD_DIR: dir.path })
      const flaky = join(dir.path, "deep", "flaky.test.ts")
      const deepRun = accept(["--owed", "--parallel=2"], { ...base, ACCEPT_FILES: join(dir.path, "deep", "*.test.ts") })
      // The flaky file failed and its log is written; the slow one still runs, so the hold is open.
      await until("the flaky file's first run ended", () => logged(join(dir.path, "logs"), "flaky.test.ts"))
      const land = await accept(["--land"], { ...base, ACCEPT_FILES: join(dir.path, "land", "*.test.ts"), ACCEPT_BUDGET_MS: "20000" })
      const deep = await deepRun
      expect({
        land: land.code,
        deep: deep.code,
        yields: deep.lines.filter((line) => line.startsWith("accept: yielded the lock to a land run")).length,
        second: deep.lines.filter((line) => line.startsWith(`accept: passed ${flaky} on its second run at load`)).length,
        closing: closingOf(deep.lines),
      }).toEqual({ land: 0, deep: 0, yields: 1, second: 1, closing: Option.some({ mode: "owed", passed: 2, failed: 0, owed: 0, deep: 0, budget: 0 }) })
    },
    RUN_MS,
  )

  test(
    "with no land run, the failed file runs once more at the end of the run and passes",
    async () => {
      using dir = scratch("accept-second-alone-")
      mkdirSync(join(dir.path, "deep"))
      writeFileSync(join(dir.path, "deep", "flaky.test.ts"), FLAKY)
      const flaky = join(dir.path, "deep", "flaky.test.ts")
      const deep = await accept(["--owed"], scratchEnv(dir.path, { YIELD_DIR: dir.path, ACCEPT_FILES: join(dir.path, "deep", "*.test.ts") }))
      expect({
        deep: deep.code,
        second: deep.lines.filter((line) => line.startsWith(`accept: passed ${flaky} on its second run at load`)).length,
        closing: closingOf(deep.lines),
      }).toEqual({ deep: 0, second: 1, closing: Option.some({ mode: "owed", passed: 1, failed: 0, owed: 0, deep: 0, budget: 0 }) })
    },
    RUN_MS,
  )

  test(
    "a land run that cuts a failed file's second run: the file runs once more after the yield and ends failed, and a file whose second run ended runs no third time (round 2's M1 and M2)",
    async () => {
      using dir = scratch("accept-second-cut-")
      mkdirSync(join(dir.path, "deep"))
      mkdirSync(join(dir.path, "land"))
      // a-red fails on every run; b-late fails at once on its first run, sleeps 15 s and fails on its second (the
      // run the land run cuts), and fails at once after. Each counts its runs in the scratch dir.
      writeFileSync(join(dir.path, "deep", "a-red.test.ts"), counted("a-red", "expect(n).toBe(0)"))
      writeFileSync(join(dir.path, "deep", "b-late.test.ts"), counted("b-late", "if (n === 2) await Bun.sleep(15_000)\n  expect(n).toBe(0)"))
      writeFileSync(join(dir.path, "land", "quick.test.ts"), 'import { test } from "bun:test"\ntest("quick", () => {})\n')
      const base = scratchEnv(dir.path, { YIELD_DIR: dir.path })
      const runs = (name: string) => Option.match(Option.liftPredicate(join(dir.path, `${name}.runs`), existsSync), { onNone: () => 0, onSome: (file) => readFileSync(file, "utf8").length })
      const deepRun = accept(["--owed", "--parallel=2"], { ...base, ACCEPT_FILES: join(dir.path, "deep", "*.test.ts") })
      // Second runs go one at a time in file order: once b-late's has started, a-red's has ended.
      await until("b-late's second run started", () => runs("b-late") >= 2 && runs("a-red") >= 2)
      const land = await accept(["--land"], { ...base, ACCEPT_FILES: join(dir.path, "land", "*.test.ts"), ACCEPT_BUDGET_MS: "20000" })
      const deep = await deepRun
      expect({
        land: land.code,
        failed: deep.code !== 0,
        yields: deep.lines.filter((line) => line.startsWith("accept: yielded the lock to a land run")).length,
        runs: { "a-red": runs("a-red"), "b-late": runs("b-late") },
        closing: closingOf(deep.lines),
      }).toEqual({
        land: 0,
        failed: true,
        yields: 1,
        runs: { "a-red": 2, "b-late": 3 },
        closing: Option.some({ mode: "owed", passed: 0, failed: 2, owed: 0, deep: 0, budget: 0 }),
      })
    },
    RUN_MS,
  )
})

/** A stand-in named `name` that counts its runs in the scratch dir (`n`, 1 on its first run) and then runs `body` in its one test. */
const counted = (name: string, body: string) =>
  [
    'import { expect, test } from "bun:test"',
    'import { appendFileSync, existsSync, readFileSync } from "node:fs"',
    'import { join } from "node:path"',
    'const dir = process.env.YIELD_DIR ?? ""',
    `const runs = join(dir, "${name}.runs")`,
    'const n = ((existsSync(runs) && readFileSync(runs, "utf8").length) || 0) + 1',
    'appendFileSync(runs, "x")',
    `test("${name}", async () => {`,
    `  ${body}`,
    "})",
    "",
  ].join("\n")

describe("the swarm's plan", () => {
  test("a swarm's first seed is past the gate's fixed seeds, the same for one head and purpose, another for another, and leaves a day's seeds inside 32 bits", () => {
    const heads = Array.from({ length: 200 }, (_, index) => `${index.toString(16).padStart(40, "0")}`)
    const firsts = heads.map((head) => swarmFirst(head, "land"))
    expect({
      // sim/seed.ts's own constant, read from its text: the runner's gate seeds.
      fixed: readFileSync(join(ROOT, "sim/seed.ts"), "utf8").includes(`export const SEEDS = ${FIXED_SEEDS}\n`),
      past: firsts.every((first) => first > FIXED_SEEDS),
      inRange: firsts.every((first) => first + 10_000_000 < 2 ** 31 - 1),
      same: swarmFirst("abc", "land") === swarmFirst("abc", "land"),
      distinct: new Set(firsts).size,
      daily: swarmFirst("abc", "land") !== swarmFirst("abc", "daily:2026-11-13") && swarmFirst("abc", "daily:2026-11-13") !== swarmFirst("abc", "daily:2026-11-14"),
    }).toEqual({ fixed: true, past: true, inRange: true, same: true, distinct: 200, daily: true })
  })

  test("the box is a third of the land budget; suites that fit at once each get all of it, more share it by waves", () => {
    expect([swarmBox(60_000), swarmBox(6000), swarmSlot(20_000, 4, 3), swarmSlot(20_000, 4, 8), swarmSlot(20_000, 1, 11), swarmSlot(20_000, 0, 2)]).toEqual([20_000, 2000, 20_000, 10_000, 1818, 10_000])
  })

  // scripts/reach.ts's reach, the gate's: a package reaches all of its files, and the world (sim/plugins.ts) loads
  // every server plugin together, so a server-side change reaches every server suite; a TUI pane's change reaches
  // only the TUI suites that load it, and a change no suite loads reaches none.
  test("the change reaches a suite through what it loads: an escape change only the escape suite, the TUI harness only the TUI suites, the world only the server suites, a git change none", async () => {
    const workspace = await load()
    const suites = workspace.files.filter(isSimSuite)
    const memo = new Map<string, ReadonlyArray<string>>()
    const reached = (file: string) => reachedSuites(suites, (suite) => reach(workspace, [suite], memo), [file])
    const tui = suites.filter((suite) => suite.endsWith(".tsx"))
    expect({
      escape: reached("mods/escape/escape.ts").includes("cmd/escape/escape-states.sim.test.tsx"),
      escapeServer: reached("mods/escape/escape.ts").filter((suite) => !tui.includes(suite)),
      harness: reached("sim-tui/app.ts"),
      world: reached("sim/world.ts").filter((suite) => tui.includes(suite)),
      worldServer: reached("sim/world.ts").includes("cmd/wake/wake.sim.test.ts"),
      git: reached("mods/git/branch.ts"),
      itself: reachedSuites(suites, () => new Set(), ["cmd/wake/wake.sim.test.ts"]),
    }).toEqual({ escape: true, escapeServer: [], harness: tui, world: [], worldServer: true, git: [], itself: ["cmd/wake/wake.sim.test.ts"] })
  })

  test("reads a suite's swarm output: the seeds it passed, and each failing seed of that suite alone", () => {
    const output = [
      "sim-swarm cmd/a.sim.test.ts 900",
      "sim-swarm cmd/a.sim.test.ts 901",
      "sim-swarm cmd/b.sim.test.ts 900",
      "error: SIM_SEED=902 bun test cmd/a.sim.test.ts: a name",
      "error: SIM_SEED=902 bun test cmd/a.sim.test.ts: a name",
      "error: SIM_SEED=7 bun test cmd/b.sim.test.ts: another",
    ].join("\n")
    expect([swarmRead(output, "cmd/a.sim.test.ts"), swarmRead("", "cmd/a.sim.test.ts"), replayLine("cmd/a.sim.test.ts", 902)]).toEqual([
      { passed: 2, failing: [902] },
      { passed: 0, failing: [] },
      "SIM_SEED=902 bun test cmd/a.sim.test.ts",
    ])
  })

  test("the long swarm is due when it never ran or last ran to its end a day ago", () => {
    const day = 24 * 60 * 60 * 1000
    expect([longSwarmDue(Option.none(), 5), longSwarmDue(Option.some(0), day - 1), longSwarmDue(Option.some(0), day)]).toEqual([true, false, true])
  })
})

/** The stand-in suite with a bug only seed-dependent input reaches (sim/fixtures/swarm-bug.fixture.ts). */
const BUG = "sim/fixtures/swarm-bug.fixture.ts"

/** A `bun test` of `file` from opencode/ with `env` over this process's, stdout and stderr in one stream. */
const bunTest = async (file: string, env: Record<string, string> = {}) => {
  const child = owned(["/bin/sh", "-c", 'exec "$0" test "$1" 2>&1', process.execPath, `./${file}`], { cwd: ROOT, env: { ...INHERITED, ...env }, stdout: "pipe" })
  const out = await Bun.readableStreamToText(child.stdout)
  return { code: await child.exited, out }
}

describe("a land run's swarm", () => {
  test(
    "finds a bug the gate's 20 fixed seeds miss within its box, fails the run with the line that replays it, and the line replays it red, three times",
    async () => {
      using dir = scratch("accept-swarm-")
      const gate = await bunTest(BUG)
      const env = scratchEnv(dir.path, { ACCEPT_FILES: join(dir.path, "none", "*.test.ts"), ACCEPT_SIM_FILES: join(ROOT, BUG), ACCEPT_BUDGET_MS: "15000" })
      const land = await accept(["--land"], env)
      const failing = land.lines.flatMap((line) => Option.toArray(Option.map(Option.fromNullishOr(/^accept: swarm: a failing seed: SIM_SEED=(\d+) bun test (\S+)$/.exec(line)), (match) => ({ seed: Number(match[1]), file: String(match[2]) }))))
      const swarmed = land.lines.flatMap((line) => Option.toArray(Option.map(Option.fromNullishOr(/^accept: swarm \(land\): (\d+) seeds over 1 simulated suites in ([\d.]+) s, ([\d.]+) seeds\/s/.exec(line)), (match) => ({ seeds: Number(match[1]), seconds: Number(match[2]) }))))
      const seed = failing[0]?.seed ?? 0
      const replays: Array<{ code: number; out: string }> = []
      for (const _ of [1, 2, 3]) replays.push(await bunTest(BUG, { SIM_SEED: String(seed) }))
      expect({
        gate: gate.code,
        land: land.code,
        files: failing.map((each) => each.file),
        pastFixed: seed > 20,
        found: Option.exists(Option.fromUndefinedOr(swarmed[0]), (each) => each.seeds > 0),
        // Inside the box (a third of the 15 s budget) and its grace.
        inBox: bound(Option.exists(Option.fromUndefinedOr(swarmed[0]), (each) => each.seconds < 5 + 3 + 1)),
        closing: closingOf(land.lines),
        replays: replays.map((each) => ({ code: each.code, names: each.out.includes(`SIM_SEED=${seed} bun test ${BUG}: every queued message is delivered`) })),
      }).toEqual({
        gate: 0,
        land: 1,
        files: [BUG],
        pastFixed: true,
        found: true,
        inBox: true,
        closing: Option.some({ mode: "land", passed: 0, failed: 1, owed: 0, deep: 0, budget: 0 }),
        replays: [1, 2, 3].map(() => ({ code: 1, names: true })),
      })
    },
    RUN_MS,
  )

  test("a simulated TUI file's seeds past the fixed ones reach its body: its gate seeds pass, a swarm of it fails", async () => {
    const file = "sim-tui/fixtures/swarm-count.fixture.tsx"
    const gate = await bunTest(file)
    const swarm = await bunTest(file, { SIM_SWARM: "100", SIM_SWARM_MS: "500" })
    expect({ gate: gate.code, swarm: swarm.code, seed: swarm.out.includes(`SIM_SEED=100 bun test ${file}`) }).toEqual({ gate: 0, swarm: 1, seed: true })
  }, RUN_MS)
})

describe("the deep run's daily long swarm", () => {
  test(
    "runs every suite once a day: the first owed run swarms and reports the failing seed, the next one the same day does not swarm",
    async () => {
      using dir = scratch("accept-long-swarm-")
      const env = scratchEnv(dir.path, { ACCEPT_FILES: join(dir.path, "none", "*.test.ts"), ACCEPT_SIM_FILES: join(ROOT, BUG), ACCEPT_LONG_SWARM_MS: "3000" })
      const first = await accept(["--owed"], env)
      const second = await accept(["--owed"], env)
      const daily = (lines: ReadonlyArray<string>) => lines.filter((line) => line.startsWith("accept: swarm (daily): ")).length
      expect({
        first: first.code,
        swarmed: daily(first.lines),
        failing: first.lines.some((line) => line.startsWith(`accept: swarm: a failing seed: SIM_SEED=`) && line.endsWith(` bun test ${BUG}`)),
        closing: closingOf(first.lines),
        state: existsSync(join(dir.path, "swarm.json")),
        second: second.code,
        again: daily(second.lines),
      }).toEqual({ first: 1, swarmed: 2, failing: true, closing: Option.some({ mode: "owed", passed: 0, failed: 1, owed: 0, deep: 0, budget: 0 }), state: true, second: 0, again: 0 })
    },
    RUN_MS,
  )
})
