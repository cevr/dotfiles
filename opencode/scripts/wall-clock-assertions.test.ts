// An operating-system clock is useful for a hang guard, not an assertion.
// This census looks at executable comparisons, not snippets in strings.
// @reads **/*.ts **/*.tsx **/*.mts **/*.cts ../workbox/test/** scripts/wall-clock-assertions.allow.json
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Effect, FileSystem, Match, Option, Path, Schema, Stream } from "effect"
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
const RUNNER_MIN_MS = 10_000
const WAIT_MARGIN_MS = 1_000
const BUN_DEFAULT_MS = 5_000
const PROTECTED_BOOTSTRAP = "d0a6ff1846378010b3df55bb22b1ad30cb2ba039"
const ALLOW = "opencode/scripts/wall-clock-assertions.allow.json"
const SCRATCH_CASES = "opencode/tests/scratch-cases.ts"
const RUNNER_PROBES = new Map([
  ['runner timeout: test("hangs", kept.test(hang), HANG_MS) = 50 ms', 2],
  ['runner timeout: test("hangs then writes", kept.test(writeLate), HANG_MS) = 50 ms', 1],
  ['runner timeout: test("setup", ...kept.setup(hang, HANG_MS)) = 50 ms', 1],
  ['runner timeout: test("setup", ...kept.setup(late, HANG_MS)) = 50 ms', 1],
])

/** Follow clock readings through local bindings, arithmetic and unit conversions; not arbitrary calls. */
const assertions = (file: string, text: string) => {
  const program = parseSync(file, text).program
  const calls: Array<CallExpression> = []
  const comparisons: Array<BinaryExpression> = []
  const source = (node: Span) => text.slice(node.start, node.end)
  new Visitor({
    CallExpression: (node) => { calls.push(node) },
    BinaryExpression: (node) => {
      if (COMPARES.has(node.operator)) comparisons.push(node)
    },
  }).visit(program)
  const boundsClock = clockComparisons(source, localsOf(program))
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

type Program = ReturnType<typeof parseSync>["program"]
type Texts = ReadonlyMap<string, string>
const testFiles = (file: string) => /\.test\.tsx?$/.test(file) || file === SCRATCH_CASES
const localsOf = (program: Program) => {
  const declarations: Array<VariableDeclarator> = []
  const scopes: Array<Span> = [program]
  new Visitor({
    VariableDeclarator: (node) => { declarations.push(node) },
    BlockStatement: (node) => { scopes.push(node) },
  }).visit(program)
  const bindings = declarations.flatMap(({ id, init, end, start }) => {
    if (id.type !== "Identifier" || !init) return []
    const scope = scopes.findLast((candidate) => holds(candidate, { start, end }))
    if (!scope) return []
    return [{ name: id.name, init, scope }]
  })
  return (name: string, at: Span) => Option.fromNullishOr(bindings.findLast((binding) => binding.name === name && binding.init.end < at.start && holds(binding.scope, at))?.init)
}

const identifier = (node: { readonly type: string; readonly name?: string; readonly value?: string }) =>
  Option.orElse(Option.fromNullishOr(node.name), () => Option.fromNullishOr(node.value))

const propertyOf = (object: Expression, key: string) => {
  if (object.type !== "ObjectExpression") return Option.none()
  for (const property of object.properties) {
    if (property.type !== "Property" || !("name" in property.key || "value" in property.key)) continue
    if ("name" in property.key && property.key.name === key || "value" in property.key && property.key.value === key)
      return expression(property.value)
  }
  return Option.none()
}

type ObjectProperty = Extract<Extract<Expression, { type: "ObjectExpression" }>["properties"][number], { type: "Property" }>
const expression = (node?: CallExpression["arguments"][number] | ObjectProperty["value"]): Option.Option<Expression> => {
  if (!node || node.type === "SpreadElement") return Option.none()
  return Option.some(node)
}

/** Resolve a literal declaration, arithmetic, or a named/default import of a literal. */
const numbersOf = (file: string, program: Program, texts: Texts, resolve: (file: string, specifier: string) => string) => {
  const seen = new Map<string, Option.Option<number>>()
  const local = localsOf(program)
  const imported = (name: string, depth: number): Option.Option<number> => {
    const prior = Option.fromNullishOr(seen.get(name))
    if (Option.isSome(prior)) return prior.value
    for (const node of program.body) {
      if (node.type !== "ImportDeclaration") continue
      for (const specifier of node.specifiers) {
        if (specifier.local.name !== name || specifier.type === "ImportNamespaceSpecifier") continue
        const from = resolve(file, node.source.value)
        const content = Option.fromNullishOr(texts.get(from))
        if (Option.isNone(content)) continue
        const other = parseSync(from, content.value).program
        const foreign = numbersOf(from, other, texts, resolve)
        let value = Option.none<number>()
        if (specifier.type === "ImportDefaultSpecifier") value = foreign.exported("default", depth - 1)
        else value = Option.flatMap(identifier(specifier.imported), (exportName) => foreign.exported(exportName, depth - 1))
        seen.set(name, value)
        return value
      }
    }
    return Option.none()
  }
  const wakeBody = (node: CallExpression) => {
    if (node.callee.type !== "Identifier" || node.callee.name !== "testLimitMs" || !file.startsWith("opencode/mods/wake/")) return Option.none()
    const arg = node.arguments[0]
    if (arg?.type !== "Identifier") return Option.none()
    // The wake readiness policy separately checks this exact helper: its cap is
    // body duration plus nonnegative release and runner margin.
    return local(arg.name, arg).pipe(
      Option.flatMap((body) => propertyOf(body, "body")),
      Option.flatMap((body) => {
        if (body.type !== "Literal" || !Schema.is(Schema.String)(body.value) || !/^\d+ seconds$/.test(body.value)) return Option.none()
        return Option.some(Number(body.value.replace(/ seconds$/, "")) * 1_000)
      }),
      Option.filter(Number.isFinite),
    )
  }
  const arithmetic = (left: Expression, right: Expression, operator: string, depth: number): Option.Option<number> =>
    Option.flatMap(Option.product(number(left, depth - 1), number(right, depth - 1)), ([a, b]) => {
      switch (operator) {
        case "+": return Option.some(a + b)
        case "-": return Option.some(a - b)
        case "*": return Option.some(a * b)
        case "/": return Option.some(a / b)
        case "**": return Option.some(a ** b)
        default: return Option.none()
      }
    })
  const objectNumber = (node: Extract<Expression, { type: "MemberExpression" }>, depth: number) => {
    if (node.object.type !== "Identifier" || node.property.type !== "Identifier" || node.computed) return Option.none()
    const key = node.property.name
    return local(node.object.name, node).pipe(Option.flatMap((object) => propertyOf(object, key)), Option.flatMap((value) => number(value, depth - 1)))
  }
  const number = (node: Expression, depth = 16): Option.Option<number> => {
    if (depth <= 0) return Option.none()
    switch (node.type) {
      case "Literal": return Option.liftPredicate(Schema.is(Schema.Number))(node.value)
      case "Identifier": {
        const init = local(node.name, node)
        return Option.match(init, { onSome: (value) => number(value, depth - 1), onNone: () => imported(node.name, depth - 1) })
      }
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
        return number(node.expression, depth - 1)
      case "UnaryExpression": {
        if (node.operator !== "-") return Option.none()
        return Option.map(number(node.argument, depth - 1), (value) => -value)
      }
      case "MemberExpression": return objectNumber(node, depth)
      case "CallExpression": {
        const call = node.callee
        if (call.type === "MemberExpression" && call.object.type === "Identifier" && call.object.name === "Math" && call.property.type === "Identifier" && call.property.name === "max")
          return Arr.head(node.arguments.flatMap((arg) => Option.toArray(Option.flatMap(expression(arg), (value) => number(value, depth - 1)))).toSorted((a, b) => b - a))
        return wakeBody(node)
      }
      case "BinaryExpression": {
        if (node.left.type === "PrivateIdentifier") return Option.none()
        return arithmetic(node.left, node.right, node.operator, depth)
      }
      default: return Option.none()
    }
  }
  const exported = (name: string, depth: number): Option.Option<number> => {
    for (const node of program.body) {
      if (node.type === "ExportDefaultDeclaration" && name === "default" && node.declaration.type !== "FunctionDeclaration" && node.declaration.type !== "ClassDeclaration" && node.declaration.type !== "TSInterfaceDeclaration")
        return number(node.declaration, depth)
      if (node.type !== "ExportNamedDeclaration") continue
      if (node.declaration?.type === "VariableDeclaration") {
        const declaration = node.declaration.declarations.find(({ id }) => id.type === "Identifier" && id.name === name)
        if (declaration?.init) return number(declaration.init, depth)
      }
      const alias = node.specifiers.find(({ exported }) => Option.contains(identifier(exported), name))
      if (alias?.local.type === "Identifier") {
        const init = local(alias.local.name, node)
        if (Option.isSome(init)) return number(init.value, depth)
      }
    }
    return Option.none()
  }
  const argument = (node: Expression) => {
    if (node.type !== "Identifier") return Option.none()
    return local(node.name, node)
  }
  return { number, exported, argument }
}

const runner = /^(?:test|it|describe|afterAll|beforeAll|afterEach|beforeEach|effectTest|platformTest|scopedTest)(?:\.(?:skip|only|todo|concurrent|serial|failing|if|skipIf|todoIf|each|effect|scoped|live|effectLive|scopedLive))*$/
const setter = /^(?:(?:Bun|bun)\.)?(?:(?:test|it)\.)?setDefaultTimeout$/
const hooks = /^(?:afterAll|beforeAll|afterEach|beforeEach)$/
const wrappers = /\.(?:skipIf|todoIf|if|each)$/
const waitHelper = /^(?:waitUntil|eventuallyPasses)$/

const bindingsOf = (program: Program) => {
  const aliases = new Map<string, string>()
  const namespaces = new Set(["Bun"])
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || !/^(?:bun:test|effect-bun-test|.*\/(?:wait|effect-test)(?:\.ts)?)$/.test(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(specifier.local.name)
      if (specifier.type === "ImportSpecifier") {
        const name = identifier(specifier.imported)
        if (Option.isSome(name)) aliases.set(specifier.local.name, name.value)
      }
    }
  }
  return (callee: string) => {
    const [head = "", ...path] = callee.replace(/\[["']([\w]+)["']\]/g, ".$1").split(".")
    if (namespaces.has(head)) return path.join(".")
    return [aliases.get(head) ?? head, ...path].join(".")
  }
}
const limitIndex = (form: string) => {
  if (setter.test(form)) return 0
  if (hooks.test(form)) return 1
  return 2
}
const timeoutOf = (file: string, source: (span: Span) => string, initializer: (node: Expression) => Option.Option<Expression>) =>
  (call: CallExpression, form: string): Option.Option<{ readonly value: Expression; readonly raw: Span }> => {
  for (const arg of call.arguments) {
    const opt = expression(arg).pipe(
      Option.flatMap((object) => Option.orElse(initializer(object), () => Option.some(object))),
      Option.flatMap((object) => propertyOf(object, "timeout")),
    )
    if (Option.isSome(opt)) return Option.some({ value: opt.value, raw: opt.value })
    // keptScratch.setup returns the body and timeout as a two-element tuple.
    if (file === SCRATCH_CASES && arg.type === "SpreadElement" && arg.argument.type === "CallExpression" && source(arg.argument.callee) === "kept.setup") {
      const cap = expression(arg.argument.arguments[1])
      if (Option.isSome(cap)) return Option.some({ value: cap.value, raw: arg })
    }
  }
  return expression(call.arguments[limitIndex(form)]).pipe(
    Option.filter((arg) => arg.type !== "ObjectExpression" && !Option.exists(initializer(arg), (value) => value.type === "ObjectExpression") && source(arg) !== "undefined"),
    Option.map((arg) => ({ value: arg, raw: arg })),
  )
}
const labelOf = (call: CallExpression, form: string, source: (span: Span) => string) => {
  if (setter.test(form) || hooks.test(form)) return form
  return `${form} ${Option.getOrElse(Arr.head(call.arguments).pipe(Option.map((title) => source(title).split("\n")[0])), () => "")}`
}
const deadlines = (calls: Array<CallExpression>, source: (span: Span) => string, nameOf: (node: CallExpression) => string, limit: ReturnType<typeof timeoutOf>, number: (node: Expression) => Option.Option<number>) => {
  const results: Array<string> = []
  const named: Array<string> = []
  for (const call of calls) {
    const form = nameOf(call)
    if (!(runner.test(form) || setter.test(form)) || (wrappers.test(form) && call.callee.type !== "CallExpression")) continue
    const picked = limit(call, form)
    if (Option.isNone(picked)) continue
    const ms = number(picked.value.value)
    const label = labelOf(call, form, source)
    if (Option.isNone(ms)) named.push(`${label}: cannot resolve explicit runner timeout ${source(picked.value.raw)}; use a numeric hang-guard constant`)
    else if (!Number.isFinite(ms.value) || ms.value < RUNNER_MIN_MS) results.push(`runner timeout: ${source(call)} = ${ms.value} ms`)
  }
  return { results, named }
}
const namedWaits = (calls: Array<CallExpression>, source: (span: Span) => string, nameOf: (node: CallExpression) => string, limit: ReturnType<typeof timeoutOf>, number: (node: Expression) => Option.Option<number>, defaultWait: Option.Option<number>) => {
  const named: Array<string> = []
  for (const call of calls) {
    const helper = nameOf(call)
    if (!waitHelper.test(helper)) continue
    // Direct waits and waits inside fixture closures nested in a registered test.
    const enclosing = calls.filter((outer) => outer !== call && holds(outer, call) && runner.test(nameOf(outer))).sort((a, b) => a.end - a.start - (b.end - b.start))
    const nearest = Arr.head(enclosing)
    if (Option.isNone(nearest) || nameOf(nearest.value).startsWith("describe")) continue
    const defaults = calls.filter((outer) => outer.start < nearest.value.start && setter.test(nameOf(outer))).toReversed()
    const cap = Arr.head([...enclosing, ...defaults].flatMap((outer) => Option.toArray(limit(outer, nameOf(outer)))))
    const outer = Option.match(cap, { onNone: () => Option.some(BUN_DEFAULT_MS), onSome: ({ value }) => number(value) })
    const waitIndex = Match.value(helper).pipe(Match.when("waitUntil", () => 2), Match.orElse(() => 1))
    const ms = Option.match(expression(call.arguments[waitIndex]), { onNone: () => defaultWait, onSome: number })
    if (Option.isSome(ms) && Option.isSome(outer) && ms.value + WAIT_MARGIN_MS > outer.value)
      named.push(`${source(call).split("\n")[0]}: ${ms.value} ms named wait needs at least ${WAIT_MARGIN_MS} ms before runner cap ${outer.value} ms`)
  }
  return named
}
const timeouts = (file: string, text: string, texts: Texts, resolve: (file: string, specifier: string) => string) => {
  const program = parseSync(file, text).program
  const { number, argument } = numbersOf(file, program, texts, resolve)
  const source = (node: Span) => text.slice(node.start, node.end)
  const binding = bindingsOf(program)
  const nameOf = ({ callee }: CallExpression) => {
    if (callee.type === "CallExpression") return binding(source(callee.callee))
    return binding(source(callee))
  }
  const limit = timeoutOf(file, source, argument)
  const calls: Array<CallExpression> = []
  new Visitor({ CallExpression: (node) => { calls.push(node) } }).visit(program)
  const defaultWait = Option.flatMap(Option.fromNullishOr(texts.get("opencode/tests/wait.ts")), (body) =>
    numbersOf("opencode/tests/wait.ts", parseSync("wait.ts", body).program, texts, resolve).exported("WAIT_MS", 16),
  )
  const found = deadlines(calls, source, nameOf, limit, number)
  return { results: found.results, named: [...found.named, ...namedWaits(calls, source, nameOf, limit, number, defaultWait)] }
}

const Entry = Schema.Struct({ file: Schema.String, assertion: Schema.String, why: Schema.NonEmptyString, count: Schema.Int.check(Schema.isGreaterThan(0)) })
const decodeAllow = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Entry)))
const key = (file: string, assertion: string) => `${file}: ${assertion}`

const git = (...argv: ReadonlyArray<string>) => Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const cwd = yield* Path.Path
  const list = yield* spawner.spawn(ChildProcess.make("git", argv, { cwd: cwd.resolve(".."), forceKillAfter: "3 seconds" }))
  const out = yield* list.stdout.pipe(Stream.decodeText(), Stream.mkString)
  expect(Number(yield* list.exitCode)).toBe(0)
  return out
})

const countsOf = (hits: Iterable<string>) => {
  const found = new Map<string, number>()
  for (const each of hits) found.set(each, (found.get(each) ?? 0) + 1)
  return found
}
const growth = (candidate: ReadonlyMap<string, number>, base: ReadonlyMap<string, number>) =>
  [...candidate].filter(([entry, count]) => count > (base.get(entry) ?? 0))

it.scopedLive("new tests assert event order or virtual time, never a numeric wall-clock deadline", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const allow = yield* fs.readFileString(path.resolve("..", ALLOW)).pipe(Effect.flatMap(decodeAllow))
    const listed = new Map(allow.map((entry) => [key(entry.file, entry.assertion), entry.count]))
    const tracked = (yield* git("ls-files", "-z", "--", "opencode", "workbox/test")).split("\0")
    const texts = new Map(yield* Effect.forEach(tracked.filter((file) => /\.[cm]?tsx?$/.test(file)), (file) =>
      Effect.map(fs.readFileString(path.resolve("..", file)), (text) => [file, text] as const),
    ))
    const resolve = (file: string, specifier: string) => {
      if (!specifier.startsWith(".")) return specifier
      const joined = path.normalize(path.join(path.dirname(file), specifier))
      return [joined, joined.replace(/\.[cm]?js$/, ".ts"), `${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`].find((candidate) => texts.has(candidate)) ?? joined
    }
    const mergeBase = (yield* git("merge-base", "HEAD", "origin/main")).trim()
    const established = (yield* git("ls-tree", "--name-only", mergeBase, "--", ALLOW)).trim() === ALLOW
    const baselineRef = Match.value(established).pipe(Match.when(true, () => mergeBase), Match.orElse(() => PROTECTED_BOOTSTRAP))
    const baseline = yield* git("show", `${baselineRef}:${ALLOW}`).pipe(Effect.flatMap(decodeAllow))
    const base = new Map(baseline.map((entry) => [key(entry.file, entry.assertion), entry.count]))
    // First landing only: the prior reviewed list bounds clock entries; the
    // only short timeouts are already existing deliberate Bun-timeout probes.
    if (!established) {
      const original = yield* git("show", `${mergeBase}:${SCRATCH_CASES}`)
      for (const [entry, count] of countsOf(timeouts(SCRATCH_CASES, original, texts, resolve).results)) {
        if (RUNNER_PROBES.has(entry)) base.set(key(SCRATCH_CASES, entry), Math.min(count, RUNNER_PROBES.get(entry) ?? 0))
      }
    }
    const scanned = texts.entries().filter(([file]) => testFiles(file)).map(([file, text]) => ({ file, text, timing: timeouts(file, text, texts, resolve) })).toArray()
    const found = countsOf(scanned.flatMap(({ file, text, timing }) =>
      [...assertions(file, text), ...timing.results].map((assertion) => key(file, assertion)),
    ))
    expect(growth(listed, base), "allow-list membership and maximum counts may only shrink from the landing base").toEqual([])
    expect(scanned.flatMap(({ file, timing }) => timing.named.map((problem) => key(file, problem))), "named wait and runner cap").toEqual([])
    expect([...found].filter(([each, count]) => listed.get(each) !== count), "use an event or virtual clock; explicit runner caps must be at least 10000 ms").toEqual([])
    expect([...listed].filter(([each, count]) => found.get(each) !== count), "remove stale allow-list entries").toEqual([])
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

it.effect("finds runner limits, including aliased calls and imported duration literals", () =>
  Effect.sync(() => {
    const code = [
      'import { test as check, describe, afterEach, setDefaultTimeout } from "bun:test"',
      'import { TINY as DELAY } from "./guard.ts"',
      'const LOCAL = 2 * DELAY',
      'setDefaultTimeout(DELAY)',
      'describe("a suite", { timeout: LOCAL }, () => {})',
      'afterEach(() => {}, LOCAL)',
      'check.skipIf(false)("a test", () => {}, { timeout: DELAY })',
      'const options = { timeout: LOCAL }',
      'check("named options", () => {}, options)',
      'check("no cap", () => {})',
      'check("a hang guard", () => {}, 10_000)',
    ].join("\n")
    const found = timeouts("case.test.ts", code, new Map([["./guard.ts", "export const TINY = 50"]]), (_file, specifier) => specifier)
    expect(found).toEqual({
      results: [
        "runner timeout: setDefaultTimeout(DELAY) = 50 ms",
        'runner timeout: describe("a suite", { timeout: LOCAL }, () => {}) = 100 ms',
        "runner timeout: afterEach(() => {}, LOCAL) = 100 ms",
        'runner timeout: check.skipIf(false)("a test", () => {}, { timeout: DELAY }) = 50 ms',
        'runner timeout: check("named options", () => {}, options) = 100 ms',
      ],
      named: [],
    })
  }),
)

it.effect("points to the named wait when the effective runner cap would mask it", () =>
  Effect.sync(() => {
    const code = [
      'import { test as check, describe } from "bun:test"',
      'import { waitUntil as wait } from "./wait.ts"',
      'describe("a suite", { timeout: 20_000 }, () => {',
      '  check("too close", async () => { await wait("mask me", () => false, 19_500) })',
      '  check("room to report", async () => { await wait("has room", () => false, 18_000) })',
      '})',
      'check("Bun default", async () => { await wait("default cap", () => false, 5_000) })',
    ].join("\n")
    const found = timeouts("case.test.ts", code, new Map(), (_file, specifier) => specifier)
    expect(found).toEqual({
      results: [],
      named: [
        'wait("mask me", () => false, 19_500): 19500 ms named wait needs at least 1000 ms before runner cap 20000 ms',
        'wait("default cap", () => false, 5_000): 5000 ms named wait needs at least 1000 ms before runner cap 5000 ms',
      ],
    })
  }),
)
