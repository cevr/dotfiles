// No assertion lost: a real acceptance test leaves real OpenCode only through
// the parity manifest (tests/parity.json), and only for a simulated test, under
// the same name, that asserts at least as much. Three rules:
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

/** The manifest, and its files as `[real file, entry]` pairs. */
const manifest = read("tests/parity.json").pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))),
  Effect.map((decoded) => ({ ...decoded, entries: Object.entries(decoded.files) })),
)

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

/** The test names a file declares: each title literal `test(` or `seeded(` opens with. */
export const declared = (source: string) => [...source.matchAll(/\b(?:test(?:\.skipIf\([^\n]*?\))?|seeded)\(\s*"([^"]+)"/g)].map((match) => match[1] ?? "")

/** The `expect(` calls in each declared test's body: from its title to the next title, or the end. */
export const expects = (source: string) => {
  const titles = [...source.matchAll(/\b(?:test(?:\.skipIf\([^\n]*?\))?|seeded)\(\s*"([^"]+)"/g)]
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
      const { baseline, entries, retired } = yield* manifest
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

  live("every baseline name exists today where the manifest says", () =>
    Effect.gen(function* () {
      for (const [file, entry] of (yield* manifest).entries) {
        const real = declared(yield* read(file))
        const simulated = declared(yield* read(entry.simulated))
        for (const item of entry.tests) {
          expect({ name: item.name, simulated: simulated.includes(item.name) }).toEqual({ name: item.name, simulated: item.carried !== "real" })
          expect({ name: item.name, real: real.includes(item.name) }).toEqual({ name: item.name, real: item.carried !== "simulated" })
        }
      }
    }),
  )

  live(
    "each file's simulated and remaining real expect() calls are at least the baseline's",
    () =>
      Effect.gen(function* () {
        for (const [file, entry] of (yield* manifest).entries) {
          const simulated = yield* simulatedCounts(entry.simulated)
          const real = expects(yield* read(file))
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
        const { baseline, entries, retired } = yield* manifest
        for (const [file, entry] of entries)
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
