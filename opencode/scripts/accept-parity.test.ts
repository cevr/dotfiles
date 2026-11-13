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
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { NAMES } from "../sim/law-names.ts"
import { owned } from "../tests/owned.ts"

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
const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(readFileSync(join(ROOT, "tests/parity.json"), "utf8"))

/** A command's stdout, run from opencode/ in a process group of its own. */
const output = async (command: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) => {
  const child = owned(command, { cwd: ROOT, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  await child.exited
  return { code: child.exitCode, stdout: await stdout, stderr: await stderr }
}

/** A file's text at a commit, from opencode/. */
const at = async (commit: string, file: string) => (await output(["git", "show", `${commit}:./${file}`])).stdout

/** The test names a file declares: each title literal `test(` or `seeded(` opens with. */
export const declared = (text: string) => [...text.matchAll(/\b(?:test(?:\.skipIf\([^\n]*?\))?|seeded)\(\s*"([^"]+)"/g)].map((match) => match[1] ?? "")

/** The `expect(` calls in each declared test's body: from its title to the next title, or the end. */
export const expects = (text: string) => {
  const titles = [...text.matchAll(/\b(?:test(?:\.skipIf\([^\n]*?\))?|seeded)\(\s*"([^"]+)"/g)]
  return new Map(
    titles.map((match, index) => {
      const end = titles[index + 1]?.index ?? text.length
      return [match[1] ?? "", text.slice(match.index, end).split("expect(").length - 1]
    }),
  )
}

/** The simulated tests' `expect()` calls at one seed, as the seed runner prints them. */
const simulatedCounts = async (file: string) => {
  const run = await output([process.execPath, "test", `./${file}`], { SIM_EXPECTS: "1" })
  const prefix = `sim-expects ${file} `
  const lines = `${run.stdout}\n${run.stderr}`.split("\n").filter((line) => line.startsWith(prefix))
  return new Map(lines.map((line) => [line.slice(prefix.length, line.lastIndexOf(" ")), Number(line.slice(line.lastIndexOf(" ") + 1))]))
}

const files = Object.entries(manifest.files)

describe("no assertion lost", () => {
  test("the manifest names every baseline test with its baseline expect() calls", async () => {
    for (const [file, entry] of files) {
      const baseline = await at(manifest.baseline, file)
      const named = [...entry.tests.map((item) => item.name), ...manifest.retired.filter((item) => item.file === file).map((item) => item.name)]
      expect(named.toSorted()).toEqual(declared(baseline).toSorted())
      const counts = expects(baseline)
      expect(Object.fromEntries(entry.tests.map((item) => [item.name, item.expects]))).toEqual(
        Object.fromEntries(entry.tests.map((item) => [item.name, counts.get(item.name) ?? -1])),
      )
    }
  })

  test("every baseline name exists today where the manifest says", () => {
    for (const [file, entry] of files) {
      const real = declared(readFileSync(join(ROOT, file), "utf8"))
      const simulated = declared(readFileSync(join(ROOT, entry.simulated), "utf8"))
      for (const item of entry.tests) {
        expect({ name: item.name, simulated: simulated.includes(item.name) }).toEqual({ name: item.name, simulated: item.carried !== "real" })
        expect({ name: item.name, real: real.includes(item.name) }).toEqual({ name: item.name, real: item.carried !== "simulated" })
      }
    }
  })

  test("each file's simulated and remaining real expect() calls are at least the baseline's", async () => {
    for (const [file, entry] of files) {
      const simulated = await simulatedCounts(entry.simulated)
      const real = expects(readFileSync(join(ROOT, file), "utf8"))
      const carried = entry.tests.map((item) => {
        const fromSimulated = simulated.get(item.name) ?? 0
        if (item.carried === "simulated") expect({ name: item.name, counted: simulated.has(item.name) }).toEqual({ name: item.name, counted: true })
        return fromSimulated + (real.get(item.name) ?? 0)
      })
      const baseline = entry.tests.reduce((sum, item) => sum + item.expects, 0)
      expect({ file, atLeastBaseline: carried.reduce((sum, calls) => sum + calls, 0) >= baseline }).toEqual({ file, atLeastBaseline: true })
    }
  }, 60_000)

  test("a name leaves its real file only in the commit that adds it to its simulated file, and a retired name names what carries it", async () => {
    for (const [file, entry] of files)
      for (const item of entry.tests.filter((each) => each.carried === "simulated")) {
        const log = await output(["git", "log", "--format=%H", `-S${item.name}`, `${manifest.baseline}..HEAD`, "--", file])
        const removals = log.stdout.split("\n").filter((commit) => commit !== "")
        expect({ name: item.name, removals: removals.length }).toEqual({ name: item.name, removals: 1 })
        for (const commit of removals) {
          const added = await output(["git", "show", "--format=", commit, "--", entry.simulated])
          expect({ name: item.name, commit, adds: added.stdout.split("\n").some((line) => line.startsWith("+") && line.includes(item.name)) }).toEqual({
            name: item.name,
            commit,
            adds: true,
          })
        }
      }
    const carriers = new Set([...NAMES, ...files.flatMap(([, entry]) => declared(readFileSync(join(ROOT, entry.simulated), "utf8")))])
    for (const item of manifest.retired) expect({ name: item.name, carriedBy: carriers.has(item.by) }).toEqual({ name: item.name, carriedBy: true })
  }, 60_000)
})
