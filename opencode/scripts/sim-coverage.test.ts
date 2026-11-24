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
  expectTypeOf(assertWitness<string>).parameters.toEqualTypeOf<[string, string, string, string]>()
  assertWitness("letter delivered", "delivered", "delivered", "not delivered")
  expect(() => assertWitness("letter delivered", "delivered", "delivered", "delivered")).toThrow("removing the cause")
  expect(() => assertWitness("letter delivered", "delivered", "not delivered", "not delivered")).toThrow()
})

// Only ban escape hatches here. The fenced files inspect expanded Bun registrations themselves.
const registrarForms = [
  'register(`W: ${name}`, () => observe(play()))',
  'add("control", test.failing, without)',
]
const poolDefectForm = "test.failing(`pool-claim-rule seed ${name}`, law)"
const bareForms = (source: string, allowed: ReadonlyArray<string>) =>
  [...allowed.reduce((rest, form) => rest.replace(form, ""), source)
    .matchAll(/\btest\s*(?:\.\s*failing\b|\[\s*["']failing["']\s*\])|["'`]W:/g)].map(([form]) => form)

test("the source guard rejects a bare witness label or expected failure", () => {
  const source = [
    ...registrarForms,
    'test.skip(\n  "W: unpaired", run)',
    'expect(actual, "W: unpaired observation").toBe(want)',
    'test . failing("bare", control)',
    'test["failing"]("also bare", control)',
  ].join("\n")
  expect(bareForms(source, registrarForms)).toEqual(['"W:', '"W:', "test . failing", 'test["failing"]'])
})

const readSource = Effect.fn("WitnessCensus.readSource")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
  return yield* fs.readFileString(path.join(root, file))
})

const live = it.live.layer(BunServices.layer)

live("fenced files do not bypass their paired registrar", () => Effect.gen(function* () {
  const files = [
    ["mods/orchestrate/tools.test.ts", registrarForms],
    ["mods/pool/claim-rule.test.ts", [...registrarForms, poolDefectForm]],
    ["mods/update/builds.test.ts", registrarForms],
    ["mods/update/model.test.ts", registrarForms],
  ] as const
  for (const [file, allowed] of files) {
    expect(bareForms(yield* readSource(file), allowed), file).toEqual([])
  }
}))

live("unfenced files do not assert a witness label outside the common helper", () => Effect.gen(function* () {
  const files = [
    "cmd/guard/guard-faults.sim.test.ts",
    "cmd/memory/memory-faults.sim.test.ts",
    "cmd/orchestrate/record-model.sim.test.ts",
    "cmd/questions/questions-held.sim.test.ts",
    "mods/questions/opencode/form.test.ts",
    "scripts/accept-yield.test.ts",
  ]
  for (const file of files) {
    expect(bareForms(yield* readSource(file), []), file).toEqual([])
  }
}))
