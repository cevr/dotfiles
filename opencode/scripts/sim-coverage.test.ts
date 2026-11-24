// @reads cmd/guard/guard-faults.sim.test.ts cmd/memory/memory-faults.sim.test.ts cmd/orchestrate/record-model.sim.test.ts cmd/questions/questions-held.sim.test.ts mods/orchestrate/tools.test.ts mods/pool/claim-rule.test.ts mods/questions/opencode/form.test.ts mods/update/builds.test.ts mods/update/model.test.ts scripts/accept-yield.test.ts sim/witnesses.ts sim/witness-cases.ts
import { expect, expectTypeOf, test } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Effect, FileSystem, Option, Path, Predicate } from "effect"
import { it } from "effect-bun-test"
import { type ArrayExpression, type CallExpression, type MemberExpression, parseSync, Visitor } from "oxc-parser"
import { coverage } from "../sim/witness-cases.ts"
import { assertEffectWitness, assertWitness, assertWitnessCases, witnesses } from "../sim/witnesses.ts"

test("required outcomes select explicit cases, in the declared order, with no seed or generated tally", () => {
  const required = ["holds", "refuses"] as const
  const input = { holds: { lease: "current" }, refuses: { lease: "expired" } } as const
  expect(witnesses(required, input)).toEqual([["holds", input.holds], ["refuses", input.refuses]])
  expectTypeOf(witnesses<typeof required[number], typeof input>).parameters.toEqualTypeOf<[ReadonlyArray<typeof required[number]>, typeof input]>()
})

test("a witness fails if its matched observation survives removal of the cause", () => {
  expectTypeOf(assertWitness<string>).parameters.toEqualTypeOf<[string, string, (cause: boolean) => string]>()
  const causes: Array<boolean> = []
  const completed = assertWitness("letter delivered", "delivered", (cause) => {
    causes.push(cause)
    if (cause) return "delivered"
    return "not delivered"
  })
  expect(causes).toEqual([true, false])
  expect(completed).toBe("letter delivered")
  expect(() => assertWitness("letter delivered", "delivered", () => "delivered")).toThrow("removing the cause")
  expect(() => assertWitness("letter delivered", "delivered", () => "not delivered")).toThrow()
})

it.effect("an Effect witness itself runs both causes and only records a completed pair", () => Effect.gen(function* () {
  expectTypeOf(assertEffectWitness<boolean, never, never>).parameters.toEqualTypeOf<[string, boolean, (cause: boolean) => Effect.Effect<boolean>]>()
  const causes: Array<boolean> = []
  const completed = yield* assertEffectWitness("switch lit the lamp", true, (cause) => Effect.sync(() => {
    causes.push(cause)
    return cause
  }))
  expect(causes).toEqual([true, false])
  expect(completed).toBe("switch lit the lamp")
}))

test("the table runner uses the law's order and rejects a missing fixture", () => {
  const ran: Array<readonly [string, boolean]> = []
  const fixture = (key: string) => ({ expected: true, run: (cause: boolean) => {
    ran.push([key, cause])
    return cause
  } })
  const required = ["first", "second"]
  assertWitnessCases(required, { second: fixture("second"), first: fixture("first") })
  expect(ran).toEqual([["first", true], ["first", false], ["second", true], ["second", false]])
  expect(() => assertWitnessCases(required, { first: fixture("first") })).toThrow("witness table keys")
})

// These seven failures describe known pool behavior; they are not witness controls.
const poolFile = "mods/pool/claim-rule.test.ts"
const poolFailures = [
  "pool-claim-rule seed 18926016: the aggregate flags zero room even though the expiring credit is claimed",
  "pool-claim-rule seed 18926168: spends a 5h credit after the load drops below the half-credit threshold",
  "pool-claim-rule seed 18926350: withholds a 5h credit at zero room after demand rises",
  "pool-claim-rule seed 18927240: withholds a 5h credit while eleven agents have no room",
  "pool-claim-rule seed 18927416: keeps withholding a useful 5h credit across spent periods",
  "pool-claim-rule seed 18927526: spends a 5h credit at one agent's burn",
  "pool-claim-rule seed 31415527: withholds a 5h credit while modeled demand would use more than half",
]

type Span = { readonly start: number; readonly end: number }
const within = (node: Span, container: Span) => node.start >= container.start && node.end <= container.end
const nameOf = (node: CallExpression["callee"]): string => {
  if (node.type === "Identifier") return node.name
  if (node.type === "MemberExpression") return nameOf(node.object)
  if (node.type === "CallExpression") return nameOf(node.callee)
  return ""
}
const methodOf = (node: MemberExpression): string => {
  if (!node.computed && node.property.type === "Identifier") return node.property.name
  if (node.property.type === "Literal" && Predicate.isString(node.property.value)) return node.property.value
  return ""
}
const titleOf = (call: CallExpression): string => Option.getOrElse(Option.map(Arr.head(call.arguments), (arg) => {
  if (arg.type === "Literal" && Predicate.isString(arg.value)) return arg.value
  if (arg.type === "TemplateLiteral") return arg.quasis.map((part) => part.value.raw).join("${…}")
  return ""
}), () => "")

const ordinaryTest = ({ callee }: CallExpression) =>
  (callee.type === "Identifier" && ["test", "effectTest"].includes(callee.name)) ||
  (callee.type === "MemberExpression" && callee.object.type === "Identifier" && callee.object.name === "Seed" && methodOf(callee) === "effect")

/** A callback expression or Effect expression that directly delegates data to the helper. */
const delegateOf = (call: CallExpression) => {
  const body = call.arguments[1]
  if (call.callee.type === "Identifier" && call.callee.name === "test") {
    if (body?.type !== "ArrowFunctionExpression" || body.async || body.params.length !== 0) return Option.none()
    return delegateCall(body.body)
  }
  return delegateCall(body)
}
const delegateCall = (node?: CallExpression["arguments"][number] | CallExpression["callee"] | { readonly type: "BlockStatement" }) => {
  if (node?.type !== "CallExpression" || node.callee.type !== "Identifier" || node.arguments.length !== 2) return Option.none()
  const [law, table] = node.arguments
  if (law?.type !== "Identifier" || table?.type !== "ObjectExpression") return Option.none()
  return Option.some([node.callee.name, law.name] as const)
}

// Inspect the test body, not a ledger or a count of generated registrations.
const witnessSources = (file: string, text: string) => {
  const parsed = parseSync(file, text)
  const calls: Array<CallExpression> = []
  const modifiers: Array<MemberExpression> = []
  new Visitor({
    CallExpression: (node) => { calls.push(node) },
    MemberExpression: (node) => {
      if (["failing", "skip", "todo", "only"].includes(methodOf(node))) modifiers.push(node)
    },
  }).visit(parsed.program)

  const runners = ["test", "effectTest", "Seed"]
  const examples = calls.filter((call) => titleOf(call).startsWith("W: "))
  const allowed: Array<string> = []
  const forbidden: Array<string> = []
  for (const member of modifiers) {
    const insideWitness = examples.some((call) => within(member, call))
    if (!insideWitness && file === poolFile && methodOf(member) === "failing" && member.object.type === "Identifier" && member.object.name === "test") {
      const named = Arr.map(Arr.filter(calls, (call) => call.callee === member), titleOf)
      if (named.length === 1 && named.every((name) => poolFailures.includes(name))) {
        allowed.push(...named)
        continue
      }
    }
    if (insideWitness || [...runners, "describe", "it"].includes(nameOf(member))) {
      forbidden.push(text.slice(member.start, member.end))
    }
  }
  return {
    parsed: parsed.errors,
    allowed,
    forbidden,
    notOrdinary: Arr.map(Arr.filter(examples, (call) => !ordinaryTest(call)), titleOf),
    delegated: examples.map((call) => [titleOf(call), Option.getOrElse(delegateOf(call), () => [])] as const),
  }
}

test("the source guard rejects a witness with no comparison and attempts to skip or narrow it", () => {
  const source = [
    'test.skip("W: no helper", () => {})',
    'test("W: only in a comment", () => { /* assertWitness(a, b, c, d) */ })',
    'describe.only("narrow", () => test("W: live", () => { test.todo("inside"); assertWitnessCases(KEYS, {}) }))',
    'const bypass = test["failing"]',
    'bypass("W: aliased", () => assertWitness(a, b, c, d))',
    'test("W: direct", () => assertWitnessCases(KEYS, { ...fixtures }))',
    'Seed.effect("W: effect", assertEffectWitnessCases(KEYS, { one: { expected: true, run } }))',
    'test("W: conditional", () => ready && assertWitnessCases(KEYS, {}))',
    'test("W: return", () => { if (skip) return; assertWitnessCases(KEYS, {}) })',
    'test("W: filtered", () => assertWitnessCases(KEYS.filter(keep), {}))',
    'test("W: nonliteral", () => assertWitnessCases(KEYS, fixtures))',
  ].join("\n")
  expect(witnessSources("fixture.ts", source)).toEqual({
    parsed: [],
    allowed: [],
    forbidden: ["test.skip", "describe.only", "test.todo", 'test["failing"]'],
    notOrdinary: ["W: no helper", "W: aliased"],
    delegated: [
      ["W: no helper", []], ["W: only in a comment", []], ["W: live", []], ["W: aliased", []],
      ["W: direct", ["assertWitnessCases", "KEYS"]], ["W: effect", ["assertEffectWitnessCases", "KEYS"]],
      ["W: conditional", []], ["W: return", []], ["W: filtered", []], ["W: nonliteral", []],
    ],
  })
})

const readSource = Effect.fn("WitnessSources.readSource")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
  return yield* fs.readFileString(path.join(root, file))
})

const live = it.live.layer(BunServices.layer)

const files = [
  "cmd/guard/guard-faults.sim.test.ts",
  "cmd/memory/memory-faults.sim.test.ts",
  "cmd/orchestrate/record-model.sim.test.ts",
  "cmd/questions/questions-held.sim.test.ts",
  "mods/questions/opencode/form.test.ts",
  "scripts/accept-yield.test.ts",
  "mods/orchestrate/tools.test.ts",
  poolFile,
  "mods/update/builds.test.ts",
  "mods/update/model.test.ts",
]

live("every named witness calls its helper in one ordinary test", () => Effect.gen(function* () {
  for (const file of files) {
    const { allowed, delegated, ...guard } = witnessSources(file, yield* readSource(file))
    expect(guard, file).toEqual({ parsed: [], forbidden: [], notOrdinary: [] })
    const required = Arr.map(Arr.filter(coverage, ([path]) => path === file), ([, title, , law]) => [title, law] as const)
    expect(delegated.toSorted(), `${file}: every registered witness body must directly call its helper with its law and a literal fixture table`).toEqual(required.toSorted())
    if (file === poolFile) expect(allowed.toSorted(), file).toEqual(poolFailures.toSorted())
    else expect(allowed, file).toEqual([])
  }
}))

const fenced = ["mods/orchestrate/tools.test.ts", poolFile, "mods/update/builds.test.ts", "mods/update/model.test.ts"]
const mirrorValues = (array: ArrayExpression): ReadonlyArray<unknown> =>
  array.elements.map((item) => {
    if (item?.type === "Literal") return item.value
    if (item?.type === "ArrayExpression") return mirrorValues(item)
    return { invalid: "not a literal case key or bound" }
  })
const mirrorsOf = (file: string, text: string, names: ReadonlySet<string>) => {
  const found: Array<readonly [string, ReadonlyArray<unknown>]> = []
  new Visitor({
    VariableDeclaration: ({ kind, declarations }) => {
      if (kind !== "const") return
      for (const { id, init } of declarations) {
        if (id.type !== "Identifier" || !names.has(id.name) || init?.type !== "TSAsExpression" || init.expression.type !== "ArrayExpression") continue
        if (text.slice(init.typeAnnotation.start, init.typeAnnotation.end) !== "const") continue
        found.push([id.name, mirrorValues(init.expression)])
      }
    },
  }).visit(parseSync(file, text).program)
  return found
}

live("fenced case declarations mirror the independent registry exactly", () => Effect.gen(function* () {
  for (const file of fenced) {
    const expected = coverage.flatMap(([path, , law]) => Object.entries(law).filter(() => path === file))
    const names = new Set(expected.map(([name]) => name))
    expect(names.size, file).toBe(expected.length)
    expect(mirrorsOf(file, yield* readSource(file), names).toSorted(), file).toEqual(expected.toSorted())
  }
}))
