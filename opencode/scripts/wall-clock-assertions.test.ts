// Test timing: require the named runner cap and ban raw clock sources in test code.
// @reads **/*.ts **/*.tsx **/*.mts **/*.cts **/*.js **/*.jsx **/*.mjs **/*.cjs ../workbox/test/** scripts/wall-clock-assertions.allow.json
import * as BunServices from "@effect/platform-bun/BunServices"
import { Console, Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { expect, it } from "effect-bun-test"
import { inspectTiming, legacyOwners, runnerBridges, sourceFile, testFile, timingModule } from "./test-timing.ts"

const ALLOW = "opencode/scripts/wall-clock-assertions.allow.json"
// Migration-only: once the landing base has the positive policy, it is the
// sole ceiling. Before that first landing, use the reviewed policy blob.
const BOOTSTRAP = "b882254e67204b2129b2f9f553f1a4bd0701616b"

const Group = Schema.Literals(["probe", "clock", "measured", "bridge", "legacy"])
const Row = Schema.Struct({
  group: Group,
  file: Schema.NonEmptyString,
  count: Schema.Int.check(Schema.isGreaterThan(0)),
  why: Schema.NonEmptyString,
})
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

const key = (group: Row["group"], file: string) => `${group}: ${file}`
const entries = (list: ReadonlyArray<Row>) => new Map(list.map(({ group, file, count }) => [key(group, file), count]))
const increment = (counts: Map<string, number>, group: Row["group"], file: string, n = 1) => {
  const name = key(group, file)
  counts.set(name, (counts.get(name) ?? 0) + n)
}

const survey = (texts: ReadonlyMap<string, string>, resolve: (file: string, specifier: string) => string) => {
  const counts = new Map<string, number>()
  const rejected = new Array<string>()
  for (const [file, text] of texts) {
    const result = inspectTiming(file, text, (specifier) => resolve(file, specifier))
    for (const usage of result.uses) increment(counts, usage.kind, file)
    if (runnerBridges.has(file)) increment(counts, "bridge", file)
    if (legacyOwners.has(file) && result.errors.length > 0) increment(counts, "legacy", file, result.errors.length)
    else for (const { rule, at, reason } of result.errors) {
      const line = text.slice(0, at.start).split("\n").length
      const spelling = text.slice(at.start, at.end).split("\n")[0]
      rejected.push(`${file}:${line}: ${rule}: ${reason}; found ${spelling}`)
    }
  }
  return { counts, rejected }
}

const ceiling = Effect.gen(function* () {
  const base = (yield* git("merge-base", "HEAD", "origin/main")).trim()
  const tracked = (yield* git("ls-tree", "--name-only", base, "--", ALLOW)).trim() === ALLOW
  if (tracked) return yield* git("show", `${base}:${ALLOW}`).pipe(Effect.flatMap(decode))
  return yield* git("cat-file", "blob", BOOTSTRAP).pipe(Effect.flatMap(decode))
})

it.scopedLive("test timings use named runner caps, explicit measurement contracts, and no raw wall clock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
    const candidate = yield* fs.readFileString(path.join(root, ALLOW)).pipe(Effect.flatMap(decode))
    const base = entries(yield* ceiling)
    const declared = entries(candidate)
    const files = (yield* git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "opencode", "workbox/test")).split("\0").filter(sourceFile).filter(testFile)
    const texts = new Map(yield* Effect.forEach(files, (file) => Effect.map(fs.readFileString(path.join(root, file)), (text) => [file, text] as const)))
    const resolve = (file: string, specifier: string) => {
      if (!specifier.startsWith(".")) return specifier
      const normalized = path.normalize(path.join(path.dirname(file), specifier))
      return [normalized, `${normalized}.ts`, normalized.replace(/\.[cm]?js$/, ".ts")].find((candidate) => candidate === timingModule || texts.has(candidate)) ?? normalized
    }
    const { counts, rejected } = survey(texts, resolve)
    for (const row of candidate) {
      if (row.group === "legacy") {
        const owner = Option.fromNullishOr(legacyOwners.get(row.file))
        expect(Option.exists(owner, (name) => row.why.includes(name)), `not a live-writer legacy file: ${row.file}`).toBe(true)
        yield* Console.log(`test timing legacy debt: ${row.file} (${row.count} sites) — ${row.why}`)
      }
      if (row.group === "bridge") expect(runnerBridges.has(row.file), `not a known runner bridge: ${row.file}`).toBe(true)
    }
    expect(declared.size, "duplicate allow-list key").toBe(candidate.length)
    expect([...declared].filter(([name, count]) => count > (base.get(name) ?? 0)), "timing policy may only shrink from the landing base").toEqual([])
    expect(rejected, "use hangGuard, a virtual clock, or an approved named timing helper").toEqual([])
    expect([...counts].filter(([name, count]) => count > (declared.get(name) ?? 0)), "new or changed timing uses require approved counts").toEqual([])
    expect([...declared].filter(([name, count]) => count > (counts.get(name) ?? 0)), "remove stale timing policy rows or counts").toEqual([])
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
    'test("tuple spread", ...fixture())',
  ]
  for (const source of controls) expect(inspect(source).errors.map((error) => error.rule), source).toEqual(["R1"])
  const allowed = [
    'import { test as check } from "bun:test"',
    'import { hangGuard as cap } from "./hang-guard.ts"',
    'check("default", () => {})',
    'check.skipIf(false)("long fixture", () => {}, cap("local-fixture"))',
    'afterAll(() => {}, cap("installer"))',
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
