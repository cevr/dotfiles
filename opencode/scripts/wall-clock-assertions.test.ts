// Test timing: require the named runner cap and ban raw clock sources in test code.
// @reads **/*.ts **/*.tsx **/*.mts **/*.cts **/*.js **/*.jsx **/*.mjs **/*.cjs ../workbox/test/** scripts/wall-clock-assertions.allow.json
import * as BunServices from "@effect/platform-bun/BunServices"
import { Console, Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { expect, it } from "effect-bun-test"
import { BUDGET_MS } from "../sim/seed.ts"
import { inspectTiming, inspectTimingProject, legacyOwners, runnerBridges, sourceFile, timingModule, timingResolver } from "./test-timing.ts"
import { measurementKey, unapprovedMeasurements } from "./timing-policy.ts"

const ALLOW = "opencode/scripts/wall-clock-assertions.allow.json"
// Migration-only: once the landing base has the positive policy, it is the
// sole ceiling. Before that first landing, use the reviewed policy blob.
const BOOTSTRAP = "5c3a188dad511e31a749261db27b2aca77569428"

const BOOTSTRAP_WORKRIFT = "fdc3afd6a5a8630594e4da72871b69b74524ad85"
const infrastructure = {
  file: "opencode/sim/seed.ts",
  target: "per-file simulation CPU verdict",
  budget: "<= 5000 cpu-ms on a settled host; exceeded on a loaded host is reported unjudged",
  assertingTests: [
    "a file whose seeds spend more CPU than the budget on a settled host fails, naming its CPU and wall time",
    "past the budget on a loaded host, a file passes, reported and not judged again for its other seeds",
  ],
}
const ownerFields = {
  file: Schema.NonEmptyString,
  why: Schema.NonEmptyString,
}
const Counted = Schema.Struct({
  ...ownerFields,
  group: Schema.Literals(["probe", "clock", "bridge", "legacy", "dynamic"]),
  count: Schema.Int.check(Schema.isGreaterThan(0)),
})
const Measured = Schema.Struct({ ...ownerFields, group: Schema.Literal("measured"), target: Schema.NonEmptyString, budget: Schema.NonEmptyString })
const Infrastructure = Schema.Struct({ ...ownerFields, group: Schema.Literal("infrastructure"), target: Schema.NonEmptyString,
  budget: Schema.NonEmptyString, assertingTests: Schema.Array(Schema.NonEmptyString) })
const Row = Schema.Union([Counted, Measured, Infrastructure])
type Row = typeof Row.Type
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Row)))

const git = (...argv: ReadonlyArray<string>) => Effect.gen(function* () {
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const cwd = yield* path.fromFileUrl(new URL("../../", import.meta.url))
  const child = yield* spawner.spawn(ChildProcess.make("git", argv, { cwd, forceKillAfter: "3 seconds" }))
  const out = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString)
  expect(Number(yield* child.exitCode), `git ${argv.join(" ")}`).toBe(0)
  return out
})

type Counted = typeof Counted.Type
const isMeasured = (row: Row): row is typeof Measured.Type => row.group === "measured"
const key = (group: Counted["group"], file: string) => `${group}: ${file}`
const entries = (list: ReadonlyArray<Row>) => new Map(list.flatMap((row) => {
  if ("count" in row) return [[key(row.group, row.file), row.count] as const]
  return []
}))
const increment = (counts: Map<string, number>, group: Counted["group"], file: string, n = 1) => {
  const name = key(group, file)
  counts.set(name, (counts.get(name) ?? 0) + n)
}

const survey = (texts: ReadonlyMap<string, string>, resolve: ReturnType<typeof timingResolver>, dynamic: ReadonlySet<string>) => {
  const counts = new Map<string, number>()
  const rejected = new Array<string>()
  const measurements = new Array<{ readonly file: string; readonly target: string; readonly budget: string }>()
  for (const [file, result] of inspectTimingProject(texts, resolve, dynamic)) {
    const text = Option.getOrElse(Option.fromUndefinedOr(texts.get(file)), () => "")
    for (const usage of result.uses) {
      if (usage.kind === "measured") measurements.push({ file, target: usage.target, budget: usage.budget })
      else increment(counts, usage.kind, file)
    }
    if (runnerBridges.has(file)) increment(counts, "bridge", file)
    if (legacyOwners.has(file) && result.errors.length > 0) increment(counts, "legacy", file, result.errors.length)
    else for (const { rule, at, reason } of result.errors) {
      const line = text.slice(0, at.start).split("\n").length
      const spelling = text.slice(at.start, at.end).split("\n")[0]
      rejected.push(`${file}:${line}: ${rule}: ${reason}; found ${spelling}`)
    }
  }
  return { counts, rejected, measurements }
}

const ceiling = Effect.gen(function* () {
  const base = (yield* git("merge-base", "HEAD", "origin/main")).trim()
  const tracked = (yield* git("ls-tree", "--name-only", base, "--", ALLOW)).trim() === ALLOW
  if (tracked) {
    const rows = yield* git("show", `${base}:${ALLOW}`).pipe(Effect.flatMap(decode))
    return { rows, source: (file: string) => git("show", `${base}:${file}`) }
  }
  const rows = yield* git("cat-file", "blob", BOOTSTRAP).pipe(Effect.flatMap(decode))
  return { rows, source: (file: string) => {
    expect(file, "only Workrift has legacy debt before the first landing").toBe("workbox/test/workrift.test.ts")
    return git("cat-file", "blob", BOOTSTRAP_WORKRIFT)
  } }
})

// On a stricter rule, recompute from the old blob, not the new file. A site
// in a new hunk is new code. The pinned Workrift blob includes its authorized R2 witness.
const legacySites = (file: string, text: string, resolve: (specifier: string) => string, dynamic: boolean) => {
  const lines = text.split("\n")
  return inspectTiming(file, text, resolve, dynamic).errors.map(({ rule, at }) => {
    const line = text.slice(0, at.start).split("\n").length - 1
    return `${rule}: ${text.slice(at.start, at.end)} in ${Option.getOrElse(Option.fromUndefinedOr(lines[line]), () => "").trim()}`
  })
}

const newSites = (before: ReadonlyArray<string>, after: ReadonlyArray<string>) => {
  const pool = [...before]
  return after.filter((item) => {
    const index = pool.indexOf(item)
    if (index < 0) return true
    pool.splice(index, 1)
    return false
  })
}

const readSources = (root: string, files: ReadonlyArray<string>) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const rows = yield* Effect.forEach(files, (file) => {
    const absolute = path.join(root, file)
    return Effect.map(Effect.when(fs.readFileString(absolute), fs.exists(absolute)), Option.map((text) => [file, text] as const))
  })
  return new Map(rows.flatMap(Option.toArray))
})

it.scopedLive("test timings use named runner caps, explicit measurement contracts, and no raw wall clock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
    const candidate = yield* fs.readFileString(path.join(root, ALLOW)).pipe(Effect.flatMap(decode))
    const old = yield* ceiling
    const baseRows = old.rows
    const base = entries(baseRows)
    const declared = entries(candidate)
    const files = (yield* git("ls-files", "-z", "--cached", "--others", "--exclude-standard")).split("\0").filter(sourceFile)
    const texts = yield* readSources(root, files)
    const resolve = timingResolver(path, yield* fs.realPath(root))
    const dynamic = new Set(candidate.filter((row) => row.group === "dynamic").map(({ file }) => file))
    const { counts, rejected, measurements } = survey(texts, resolve, dynamic)
    for (const row of candidate) {
      if (row.group === "legacy") {
        const owner = Option.fromNullishOr(legacyOwners.get(row.file))
        expect(Option.exists(owner, (name) => row.why.includes(name)), `not a live-writer legacy file: ${row.file}`).toBe(true)
        yield* Console.log(`test timing legacy debt: ${row.file} (${row.count} sites) — ${row.why}`)
      }
      if (row.group === "bridge") expect(runnerBridges.has(row.file), `not a known runner bridge: ${row.file}`).toBe(true)
    }
    const approved = candidate.filter(isMeasured)
    const keys = approved.map(measurementKey)
    expect(declared.size + new Set(keys).size + 1, "duplicate allow-list key").toBe(candidate.length)
    expect(candidate.filter((row) => row.group === "infrastructure").map(({ file, target, budget, assertingTests }) =>
      ({ file, target, budget, assertingTests }))).toEqual([infrastructure])
    expect(BUDGET_MS, infrastructure.target).toBe(5_000)
    const seedTests = texts.get("opencode/sim/seed.test.ts")
    for (const name of infrastructure.assertingTests) expect(seedTests, `missing simulation CPU assertion: ${name}`).toContain(name)
    expect([...declared].filter(([name, count]) => count > (base.get(name) ?? 0)), "timing policy may only shrink from the landing base").toEqual([])
    expect(unapprovedMeasurements(baseRows.filter(isMeasured), approved), "measurement target, unit, and budget may not grow from the landing base").toEqual([])
    expect(measurements.map(measurementKey).sort(), "measurement policy must match the source exactly").toEqual(keys.sort())
    expect(rejected, "use hangGuard, a virtual clock, or an approved named timing helper").toEqual([])
    expect([...counts].filter(([name, count]) => count > (declared.get(name) ?? 0)), "new or changed timing uses require approved counts").toEqual([])
    expect([...declared].filter(([name, count]) => count > (counts.get(name) ?? 0)), "remove stale timing policy rows or counts").toEqual([])
    for (const { file } of candidate.filter((row) => row.group === "legacy")) {
      const before = yield* old.source(file)
      const after = Option.getOrElse(Option.fromUndefinedOr(texts.get(file)), () => "")
      const sites = (text: string) => legacySites(file, text, (specifier) => Option.getOrElse(resolve(file, specifier), () => specifier), dynamic.has(file))
      expect(newSites(sites(before), sites(after)), `${file} contains new legacy timing sites`).toEqual([])
    }
  }).pipe(Effect.provide(BunServices.layer)),
)

const inspect = (source: string) =>
  inspectTiming("opencode/tests/plant.test.ts", source, (specifier) => {
    if (specifier === "./hang-guard.ts") return timingModule
    return specifier
  })

it.effect("R1 rejects the timeout slot, not a list of known bad expressions", () => Effect.sync(() => {
  const controls = [
    'test("number", () => {}, 50)',
    'const FAST = 50; test("constant", () => {}, FAST)',
    'import { FAST } from "./limits.ts"; it.only("import", () => {}, FAST)',
    'beforeEach(() => {}, 50)',
    'setDefaultTimeout(50)',
    'describe("suite", { timeout: 55 }, () => {})',
    'const fast = { timeout: 55 }; test("spread", () => {}, {...fast})',
    'const fast = { timeout: 55 }; test("override", () => {}, {timeout: 10_000, ...fast})',
    'const fast = { timeout: 60_000 }; test("even a safe options spread", () => {}, {...fast})',
    'const hangGuard = () => 50; test("not the imported helper", () => {}, hangGuard("local-fixture"))',
    'const matrix = test.each([1]); matrix("curried alias", () => {}, 55)',
    'test("tuple spread", ...fixture())',
  ]
  for (const source of controls) {
    const direct = 'import { test, it, describe, beforeEach, setDefaultTimeout } from "bun:test";\n'
    expect(inspect(direct + source).errors.map((error) => error.rule), source).toEqual(["R1"])
  }
  const allowed = [
    'import { test, afterAll } from "bun:test"',
    'import { hangGuard } from "./hang-guard.ts"',
    'test("default", () => {})',
    'test.skipIf(false)("long fixture", () => {}, hangGuard("local-fixture"))',
    'afterAll(() => {}, hangGuard("installer"))',
  ].join("\n")
  expect(inspect(allowed)).toEqual({ errors: [], uses: [] })
}))

it.effect("R2 rejects the clock reference regardless of its data flow or assertion", () => Effect.sync(() => {
  const controls = [
    "expect(Date.now() - start).toBeLessThan(100)",
    "expect(performance.now() - start).toBeLessThan(100)",
    "expect(Date.now() - start).not.toBeGreaterThanOrEqual(50)",
    "const quick = Date.now() - start < 50; expect(quick).toBe(true)",
    'import assert from "node:assert/strict"; assert(Date.now() - start < 50)',
    'const now = globalThis.performance["now"]',
    "const { now: later } = Date",
    "new Date",
    "const n = process.hrtime.bigint",
    "const n = Bun.nanoseconds",
    "const n = process.uptime",
  ]
  for (const source of controls) expect(inspect(source).errors.map((error) => error.rule), source).toEqual(["R2"])
  expect(inspect('new Date(0); TestClock.adjust(50); "Date.now()"; // process.uptime()')).toEqual({ errors: [], uses: [] })
}))

it.effect("R3 accepts only a named target and a literal budget with comparator and unit", () => Effect.sync(() => {
  const prefix = 'import { measured } from "./hang-guard.ts"; '
  expect(inspect(prefix + 'measured("idle TUI frames", "<= 2 fps", ({sample}) => sample(frameRate))').uses.map(({ kind }) => kind)).toEqual(["measured"])
  expect(inspect(prefix + 'measured("idle TUI frames", N, fn)').errors.map(({ rule }) => rule)).toEqual(["R3"])
}))

it.effect("R1 reports a named wait before its effective runner timeout can mask it", () => Effect.sync(() => {
  const src = [
    'import { test, describe } from "bun:test"',
    'import { hangGuard } from "./hang-guard.ts"',
    'describe("suite", () => { test("a", () => waitUntil("the source", () => false, 29500)) }, hangGuard("local-fixture"))',
    'test("b", () => waitUntil("the owner", () => false, 5000))',
    'test("c", () => waitUntil("the release", () => false), hangGuard("inspector"))',
  ].join("\n")
  expect(inspect(src).errors.map(({ reason }) => reason)).toEqual([
    "named wait 29500 ms needs at least 1000 ms before its 30000 ms runner hang guard",
    "named wait 5000 ms needs at least 1000 ms before its 5000 ms runner hang guard",
  ])
}))
