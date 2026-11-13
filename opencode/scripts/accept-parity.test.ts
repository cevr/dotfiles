// No assertion lost: a real acceptance test leaves real OpenCode only through
// a parity manifest (tests/parity.json, and each tests/parity/*.json beside it,
// each with its own baseline), and only for a simulated test, under the same
// name, that asserts at least as much. A real file all of whose tests moved is
// gone. Three rules, over every manifest together:
//
// 1. Every baseline name exists today, under the same name, in its simulated
//    file or still in its real file, where the manifest says.
// 2. For each baseline file, the `expect()` calls of its simulated tests
//    (counted by the seed runner at one seed, `SIM_EXPECTS=1`) plus those of
//    what stays real are at least the baseline's.
// 3. A name leaves its real file only in the commit that adds it to its
//    simulated file, and a baseline name is retired only by a manifest line
//    naming the law or the test that now carries its claim.
//
// A baseline count is the `expect(` calls in the test's body in the real file
// at the baseline commit; this test checks the manifest's against it.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NAMES } from "../sim/law-names.ts"

/** opencode/: the tests run from it. */
const ROOT = process.cwd()

const Carried = Schema.Literals(["simulated", "real", "both"])
const Manifest = Schema.Struct({
  baseline: Schema.String,
  files: Schema.Record(
    Schema.String,
    Schema.Struct({
      simulated: Schema.String,
      tests: Schema.Array(Schema.Struct({ name: Schema.String, expects: Schema.Number, carried: Carried, why: Schema.optional(Schema.String) })),
    }),
  ),
  retired: Schema.Array(Schema.Struct({ file: Schema.String, name: Schema.String, by: Schema.String })),
})

/** A file's text, from opencode/. */
const read = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* fs.readFileString(path.join(ROOT, file))
  })

/** A real file's text, or none once every test of it has moved to its simulated file and the file is gone. */
const readReal = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (!(yield* fs.exists(path.join(ROOT, file)))) return ""
    return yield* fs.readFileString(path.join(ROOT, file))
  })

/** One manifest, decoded, and its files as `[real file, entry]` pairs. */
const decode = (file: string) =>
  read(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))),
    Effect.map((decoded) => ({ ...decoded, entries: Object.entries(decoded.files) })),
  )

/**
 * Every manifest: tests/parity.json and each tests/parity/*.json (one per group of conversions,
 * each with its own baseline), held to the same three rules.
 */
const manifests = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(ROOT, "tests/parity")
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
  const more = names.filter((name) => name.endsWith(".json")).toSorted()
  return yield* Effect.forEach(["tests/parity.json", ...more.map((name) => `tests/parity/${name}`)], decode)
})

type Decoded = Effect.Success<ReturnType<typeof decode>>

/** Rule 1 today: each name of `manifest` where it is not where the manifest says, as `name: simulated|real`. */
export const misplaced = (manifest: { readonly entries: ReadonlyArray<readonly [string, Decoded["entries"][number][1]]> }) =>
  Effect.gen(function* () {
    const found: Array<string> = []
    for (const [file, entry] of manifest.entries) {
      const real = declared(yield* readReal(file))
      const simulated = declared(yield* read(entry.simulated))
      for (const item of entry.tests) {
        if (simulated.includes(item.name) !== (item.carried !== "real")) found.push(`${item.name}: simulated`)
        if (real.includes(item.name) !== (item.carried !== "simulated")) found.push(`${item.name}: real`)
      }
    }
    return found
  })

/** A child's whole output, as text. */
const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** A command's stdout and stderr, run from opencode/ in a process group of its own, with `env` over this process's. */
const output = (command: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: ROOT, env, extendEnv: true, stdin: "ignore", forceKillAfter: "3 seconds" }))
    const [stdout, stderr] = yield* Effect.all([text(child.stdout), text(child.stderr)], { concurrency: 2 })
    yield* child.exitCode
    return { stdout, stderr }
  }).pipe(Effect.scoped)

/** A file's text at a commit, from opencode/. */
const at = (commit: string, file: string) => output("git", ["show", `${commit}:./${file}`]).pipe(Effect.map((run) => run.stdout))

/** A test's title: the literal `test(`, `seeded(`, or effect-bun-test's `it.live(` or `it.effect(` opens with. */
const TITLE = /\b(?:test(?:\.skipIf\([^\n]*?\))?|seeded|it\.(?:live|effect))\(\s*"([^"]+)"/g

/** The test names a file declares: each title literal a test opens with. */
export const declared = (source: string) => [...source.matchAll(TITLE)].map((match) => match[1] ?? "")

/** The `expect(` calls in each declared test's body: from its title to the next title, or the end. */
export const expects = (source: string) => {
  const titles = [...source.matchAll(TITLE)]
  return new Map(
    titles.map((match, index) => {
      const end = titles[index + 1]?.index ?? source.length
      return [match[1] ?? "", source.slice(match.index, end).split("expect(").length - 1]
    }),
  )
}

/** The simulated tests' `expect()` calls at one seed, as the seed runner prints them. */
const simulatedCounts = (file: string) =>
  output(process.execPath, ["test", `./${file}`], { SIM_EXPECTS: "1" }).pipe(
    Effect.map((run) => {
      const prefix = `sim-expects ${file} `
      const lines = `${run.stdout}\n${run.stderr}`.split("\n").filter((line) => line.startsWith(prefix))
      return new Map(lines.map((line) => [line.slice(prefix.length, line.lastIndexOf(" ")), Number(line.slice(line.lastIndexOf(" ") + 1))]))
    }),
  )

describe("no assertion lost", () => {
  const live = it.live.layer(BunServices.layer)

  live("the manifest names every baseline test with its baseline expect() calls", () =>
    Effect.gen(function* () {
      for (const { baseline, entries, retired } of yield* manifests)
      for (const [file, entry] of entries) {
        const before = yield* at(baseline, file)
        const named = [...entry.tests.map((item) => item.name), ...retired.filter((item) => item.file === file).map((item) => item.name)]
        expect(named.toSorted()).toEqual(declared(before).toSorted())
        const counts = expects(before)
        expect(Object.fromEntries(entry.tests.map((item) => [item.name, item.expects]))).toEqual(
          Object.fromEntries(entry.tests.map((item) => [item.name, counts.get(item.name) ?? -1])),
        )
      }
    }),
  )

  live("a title is a test's, a seeded body's, or an Effect test's (it.live, it.effect), with its expect() calls", () =>
    Effect.sync(() => {
      const source = [
        'test("plain", async () => { expect(1) })',
        'seeded("seeded", () => { expect(1); expect(2) })',
        'it.live("live", () =>\n  Effect.gen(function* () { expect(1) }))',
        'it.effect("effect", () => Effect.void)',
      ].join("\n")
      expect(declared(source)).toEqual(["plain", "seeded", "live", "effect"])
      expect(Object.fromEntries(expects(source))).toEqual({ plain: 1, seeded: 2, live: 1, effect: 0 })
    }),
  )

  live("every baseline name exists today where the manifest says", () =>
    Effect.gen(function* () {
      for (const manifest of yield* manifests) expect(yield* misplaced(manifest)).toEqual([])
    }),
  )

  live("a name the TUI manifest says is simulated but its simulated file lacks is found", () =>
    Effect.gen(function* () {
      const tui = yield* decode("tests/parity/tui.json")
      const [file, entry] = tui.entries[0] ?? ["", { simulated: "", tests: [] }]
      const first = entry.tests[0]
      const planted = { ...first, name: "a planted name no simulated file declares", expects: 0, carried: "simulated" as const }
      const broken = { ...tui, entries: [[file, { ...entry, tests: [planted, ...entry.tests.slice(1)] }] as const] }
      expect(yield* misplaced(broken)).toEqual(["a planted name no simulated file declares: simulated"])
      expect(yield* misplaced({ ...tui, entries: [[file, entry] as const] })).toEqual([])
    }),
  )

  live(
    "each file's simulated and remaining real expect() calls are at least the baseline's",
    () =>
      Effect.gen(function* () {
        for (const [file, entry] of (yield* manifests).flatMap((manifest) => manifest.entries)) {
          const simulated = yield* simulatedCounts(entry.simulated)
          const real = expects(yield* readReal(file))
          const carried = entry.tests.map((item) => {
            const fromSimulated = simulated.get(item.name) ?? 0
            if (item.carried === "simulated") expect({ name: item.name, counted: simulated.has(item.name) }).toEqual({ name: item.name, counted: true })
            return fromSimulated + (real.get(item.name) ?? 0)
          })
          const baseline = entry.tests.reduce((sum, item) => sum + item.expects, 0)
          expect({ file, atLeastBaseline: carried.reduce((sum, calls) => sum + calls, 0) >= baseline }).toEqual({ file, atLeastBaseline: true })
        }
      }),
    60_000,
  )

  live(
    "a name leaves its real file only in the commit that adds it to its simulated file, and a retired name names what carries it",
    () =>
      Effect.gen(function* () {
        const all = yield* manifests
        const entries = all.flatMap((manifest) => manifest.entries)
        const retired = all.flatMap((manifest) => manifest.retired)
        for (const { baseline, entries: own } of all)
        for (const [file, entry] of own)
          for (const item of entry.tests.filter((each) => each.carried === "simulated")) {
            const log = yield* output("git", ["log", "--format=%H", `-S${item.name}`, `${baseline}..HEAD`, "--", file])
            const removals = log.stdout.split("\n").filter((commit) => commit !== "")
            expect({ name: item.name, removals: removals.length }).toEqual({ name: item.name, removals: 1 })
            for (const commit of removals) {
              const added = yield* output("git", ["show", "--format=", commit, "--", entry.simulated])
              expect({ name: item.name, commit, adds: added.stdout.split("\n").some((line) => line.startsWith("+") && line.includes(item.name)) }).toEqual({
                name: item.name,
                commit,
                adds: true,
              })
            }
          }
        const simulatedNames = yield* Effect.forEach(entries, ([, entry]) => read(entry.simulated).pipe(Effect.map(declared)))
        const carriers = new Set([...NAMES, ...simulatedNames.flat()])
        for (const item of retired) expect({ name: item.name, carriedBy: carriers.has(item.by) }).toEqual({ name: item.name, carriedBy: true })
      }),
    60_000,
  )
})
