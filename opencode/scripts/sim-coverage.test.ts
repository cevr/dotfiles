// @reads cmd/guard/guard-faults.sim.test.ts cmd/memory/memory-faults.sim.test.ts cmd/orchestrate/record-model.sim.test.ts cmd/questions/questions-held.sim.test.ts mods/orchestrate/tools.test.ts mods/pool/claim-rule.test.ts mods/questions/opencode/form.test.ts mods/update/builds.test.ts mods/update/model.test.ts scripts/accept-yield.test.ts sim/witnesses.ts
import { expect, expectTypeOf, test } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Path } from "effect"
import { it } from "effect-bun-test"
import { assertWitness, witnesses } from "../sim/witnesses.ts"

test("required outcomes select explicit cases, in the declared order, with no seed or generated tally", () => {
  const required = ["holds", "refuses"] as const
  const input = { holds: { lease: "current" }, refuses: { lease: "expired" } } as const
  expect(witnesses(required, input)).toEqual([["holds", input.holds], ["refuses", input.refuses]])
  expectTypeOf(witnesses<typeof required[number], typeof input>).parameters.toEqualTypeOf<[ReadonlyArray<typeof required[number]>, typeof input]>()
})

test("a witness fails if its matched observation survives removal of the cause", () => {
  assertWitness("letter delivered", "delivered", "delivered", "not delivered")
  expect(() => assertWitness("letter delivered", "delivered", "delivered", "delivered")).toThrow("removing the cause")
  expect(() => assertWitness("letter delivered", "delivered", "not delivered", "not delivered")).toThrow()
})

// The four domain packages cannot import the simulator. They register a positive
// and a Bun expected failure with the same W: name at the same enumeration site.
const registrations = (source: string) => {
  const examples: Array<string> = []
  const controls: Array<string> = []
  for (const [, failing, , name] of source.matchAll(/\btest(\.failing)?\(\s*(["`])(W: [^"`]+)\2/g)) {
    if (failing) controls.push(name)
    else examples.push(name)
  }
  return { examples: examples.toSorted(), controls: controls.toSorted() }
}

const missing = (source: string) => {
  const { examples, controls } = registrations(source)
  return examples.filter((name) => !controls.includes(name))
}

test("the census names an example with no registered control", () => {
  const text = 'test("W: live", run)\ntest.failing("W: live", control)\ntest("W: unchecked", run)'
  expect(missing(text)).toEqual(["W: unchecked"])
})

const readSource = Effect.fn("WitnessCensus.readSource")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
  return yield* fs.readFileString(path.join(root, file))
})

const live = it.live.layer(BunServices.layer)

live("every fenced witness registration has exactly one control registration", () => Effect.gen(function* () {
  const files = [
    ["mods/orchestrate/tools.test.ts", 2],
    ["mods/pool/claim-rule.test.ts", 4],
    ["mods/update/builds.test.ts", 2],
    ["mods/update/model.test.ts", 1],
  ] as const
  for (const [file, groups] of files) {
    const source = yield* readSource(file)
    const { examples, controls } = registrations(source)
    expect(examples, file).toHaveLength(groups)
    expect(new Set(examples).size, file).toBe(groups)
    expect(missing(source), file).toEqual([])
    expect(controls, file).toEqual(examples)
  }
}))

live("unfenced witnesses use the one helper that compares both post-run observations", () => Effect.gen(function* () {
  const files = [
    ["cmd/guard/guard-faults.sim.test.ts", 4],
    ["cmd/memory/memory-faults.sim.test.ts", 2],
    ["cmd/orchestrate/record-model.sim.test.ts", 4],
    ["cmd/questions/questions-held.sim.test.ts", 2],
    ["mods/questions/opencode/form.test.ts", 2],
    ["scripts/accept-yield.test.ts", 12],
  ] as const
  for (const [file, sites] of files) {
    const source = yield* readSource(file)
    expect([...source.matchAll(/\bassertWitness\(/g)], file).toHaveLength(sites)
  }
}))
