// An operating-system clock is useful for a hang guard, not an assertion.
// This census looks at executable comparisons, not snippets in strings.
// @reads **/*.test.ts **/*.test.tsx ../workbox/test/** scripts/wall-clock-assertions.allow.json
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { expect, it } from "effect-bun-test"
import { type BinaryExpression, type CallExpression, type Expression, type VariableDeclarator, parseSync, Visitor } from "oxc-parser"

const CLOCK = /^(?:(?:Date|performance)(?:\.now|\["now"\])|Bun\.nanoseconds|process\.hrtime(?:\.bigint)?)$/
const CONVERSIONS = /^(?:Number|Math\.(?:abs|ceil|floor|round|trunc))$/
const MATCHERS = new Set(["toBeLessThan", "toBeLessThanOrEqual", "toBeGreaterThan", "toBeGreaterThanOrEqual", "toBeWithin", "toBe", "toEqual"])
const COMPARES = new Set(["<", "<=", ">", ">=", "===", "!==", "==", "!="])
const ARITHMETIC = new Set(["+", "-", "*", "/", "%", "**"])
type Span = { readonly start: number; readonly end: number }
const holds = (outer: Span, inner: Span) => outer.start <= inner.start && inner.end <= outer.end

/** Follow clock readings through local bindings, arithmetic and unit conversions; not arbitrary calls. */
const assertions = (file: string, text: string) => {
  const program = parseSync(file, text).program
  const declarations: Array<VariableDeclarator> = []
  const scopes: Array<Span> = [program]
  const calls: Array<CallExpression> = []
  const comparisons: Array<BinaryExpression> = []
  const source = (node: Span) => text.slice(node.start, node.end)
  new Visitor({
    BlockStatement: (node) => { scopes.push(node) },
    VariableDeclarator: (node) => { declarations.push(node) },
    CallExpression: (node) => { calls.push(node) },
    BinaryExpression: (node) => {
      if (COMPARES.has(node.operator)) comparisons.push(node)
    },
  }).visit(program)
  const bindings = declarations.flatMap((decl) => {
    if (decl.id.type !== "Identifier" || !decl.init) return []
    const scope = scopes.findLast((span) => holds(span, decl))
    if (!scope) return []
    return [{ name: decl.id.name, scope, init: decl.init }]
  })
  const initial = (name: string, at: Span) => Option.fromNullishOr(bindings.findLast((entry) => entry.name === name && entry.init.end < at.start && holds(entry.scope, at))?.init)
  const boundsClock = clockComparisons(source, initial)
  const hits: Array<string> = []
  for (const call of calls) {
    if (isExpect(call)) {
      for (const argument of call.arguments)
        for (const test of comparisons)
          if (holds(argument, test) && boundsClock(test.left, test.right)) hits.push(source(test))
    }
    if (matchesClock(call, boundsClock)) hits.push(source(call))
  }
  return hits
}

const isExpect = ({ callee }: CallExpression) => callee.type === "Identifier" && callee.name === "expect"
const matchesClock = ({ callee, arguments: args }: CallExpression, boundsClock: (a: Expression, b: Expression) => boolean) => {
  if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier" || !MATCHERS.has(callee.property.name)) return false
  if (callee.object.type !== "CallExpression" || !isExpect(callee.object)) return false
  return Arr.take(callee.object.arguments, 1).some((actual) =>
    args.some((bound) => actual.type !== "SpreadElement" && bound.type !== "SpreadElement" && boundsClock(actual, bound)),
  )
}

const clockComparisons = (source: (span: Span) => string, initial: (name: string, at: Span) => Option.Option<Expression>) => {
  const feedsClock = (node: Expression): boolean => {
    switch (node.type) {
      case "CallExpression":
        if (CLOCK.test(source(node.callee))) return true
        return CONVERSIONS.test(source(node.callee)) && node.arguments.some((arg) => arg.type !== "SpreadElement" && feedsClock(arg))
      case "BinaryExpression":
        return ARITHMETIC.has(node.operator) && node.left.type !== "PrivateIdentifier" && (feedsClock(node.left) || feedsClock(node.right))
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSNonNullExpression":
        return feedsClock(node.expression)
      case "Identifier": {
        const found = initial(node.name, node)
        return Option.exists(found, feedsClock)
      }
      default:
        return false
    }
  }
  const numberBound = (node: Expression): boolean => {
    switch (node.type) {
      case "Literal":
        return /^\d[\d_]*(?:\.\d+)?n?$/.test(source(node))
      case "Identifier": {
        const found = initial(node.name, node)
        if (Option.isSome(found)) return numberBound(found.value)
        return /^[A-Z][A-Z_\d]*$/.test(node.name)
      }
      case "ParenthesizedExpression":
        return numberBound(node.expression)
      case "BinaryExpression":
        return ARITHMETIC.has(node.operator) && node.left.type !== "PrivateIdentifier" && (numberBound(node.left) || numberBound(node.right))
      default:
        return false
    }
  }
  return (a: Expression, b: Expression) => (feedsClock(a) && numberBound(b)) || (feedsClock(b) && numberBound(a))
}

const Entry = Schema.Struct({ file: Schema.String, assertion: Schema.String, why: Schema.NonEmptyString, count: Schema.Int.check(Schema.isGreaterThan(0)) })
const decodeAllow = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Entry)))
const key = (file: string, assertion: string) => `${file}: ${assertion}`

const files = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const cwd = yield* Path.Path
  const list = yield* spawner.spawn(ChildProcess.make("git", ["ls-files", "-z", "--", "opencode", "workbox/test"], { cwd: cwd.resolve(".."), forceKillAfter: "3 seconds" }))
  const out = yield* list.stdout.pipe(Stream.decodeText(), Stream.mkString)
  expect(Number(yield* list.exitCode)).toBe(0)
  return out.split("\0").filter((file) => /\.test\.tsx?$/.test(file))
})

it.scopedLive("new tests assert event order or virtual time, never a numeric wall-clock deadline", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const allow = yield* fs.readFileString("scripts/wall-clock-assertions.allow.json").pipe(Effect.flatMap(decodeAllow))
    const listed = new Map(allow.map((entry) => [key(entry.file, entry.assertion), entry.count]))
    const read = yield* Effect.forEach(yield* files, (file) =>
      Effect.map(fs.readFileString(path.resolve("..", file)), (text) => assertions(file, text).map((assertion) => key(file, assertion))),
    )
    const found = new Map<string, number>()
    for (const each of read.flat()) found.set(each, (found.get(each) ?? 0) + 1)
    expect([...found].filter(([each, count]) => listed.get(each) !== count)).toEqual([])
    expect([...listed].filter(([each, count]) => found.get(each) !== count)).toEqual([])
    expect(listed.size).toBe(allow.length)
  }).pipe(Effect.provide(BunServices.layer)),
)

it.effect("detects a deadline in a matcher or a compound expect, not in a hang guard, fixture string, or virtual clock", () =>
  Effect.sync(() => {
    const direct = "expect(Date.now() - before).toBeLessThan(100)"
    const aliased = "expect(seconds).toBeLessThan(LIMIT_MS)"
    const compound = "seconds < 1"
    const code = [
      "const before = performance.now()",
      "const seconds = (performance.now() - before) / 1000",
      direct, aliased, `expect({ inTime: ${compound} }).toEqual({ inTime: true })`,
      "if (Date.now() > hangDeadline) throw new Error('no event')",
      "expect(fake.now() - start).toBeLessThan(100)",
      "'expect(Date.now() - before).toBeLessThan(100)'",
    ].join("\n")
    expect(assertions("planted.test.ts", code)).toEqual([direct, aliased, compound])
  }),
)
