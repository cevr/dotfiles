import { Option, Schema } from "effect"
import { type CallExpression, type Expression, parseSync, Visitor } from "oxc-parser"
import { HANG_GUARDS, isProductBudget } from "../tests/hang-guard.ts"
import { WAIT_MS } from "../tests/wait.ts"

export interface Span {
  readonly start: number
  readonly end: number
}

type Program = ReturnType<typeof parseSync>["program"]
export type Rule = "R1" | "R2" | "R3"
export type AllowKind = "probe" | "clock" | "measured"
export interface Site {
  readonly rule: Rule
  readonly at: Span
  readonly reason: string
}
export interface Use {
  readonly kind: AllowKind
  readonly at: Span
}
export interface Inspection {
  readonly errors: ReadonlyArray<Site>
  readonly uses: ReadonlyArray<Use>
}

export const sourceFile = (file: string) => /\.[cm]?[jt]sx?$/.test(file)
export const testFile = (file: string) =>
  /\.(?:test|spec|fixture)\.[cm]?[jt]sx?$/.test(file) ||
  /^(?:opencode\/(?:tests|scenarios|testbeds|sim|sim-tui)\/|workbox\/test\/)/.test(file) ||
  /\/(?:fake-[^/]+|(?:[^/]+\.)?laws|fixture|test-(?:support|helper|util)s?)\.[cm]?[jt]sx?$/.test(file)

export const timingModule = "opencode/tests/hang-guard.ts"
export const runnerBridges = new Map([
  ["opencode/sim/seed.ts", "computed simulation deadline and its runner grace"],
  ["opencode/sim-tui/effect-test.ts", "fork-Effect test registration with a named earlier diagnostic"],
  ["opencode/mods/work/laws.ts", "shared Rifts law registration with a named earlier diagnostic"],
])
export const legacyOwners = new Map([
  ["workbox/test/workrift.test.ts", "workrift-subvolume"],
  ["workbox/test/workrift-subvolume.test.ts", "workrift-subvolume"],
  ["opencode/mods/orchestrate/tool-call.test.ts", "pool-reset-backed-pace"],
])
const adapterModule = /^(?:bun:test|effect-bun-test|(?:.*\/)?(?:effect-test|laws)(?:\.ts)?)$/
const wrappers = new Set(["each", "if", "skipIf", "todoIf", "layer"])
const runnerArguments = new Map([
  ["test", 2], ["it", 2], ["describe", 2], ["effectTest", 2], ["platformTest", 2], ["scopedTest", 2], ["riftsLaws", 2],
  ["sim.effect", 2], ["sim.runner", 1],
  ["beforeAll", 1], ["afterAll", 1], ["beforeEach", 1], ["afterEach", 1], ["setDefaultTimeout", 0],
])

const spell = (node: { readonly type: string }): Option.Option<string> => {
  if ("value" in node && Schema.is(Schema.String)(node.value)) return Option.some(node.value)
  if ("name" in node && Schema.is(Schema.String)(node.name)) return Option.some(node.name)
  return Option.none()
}
const memberParts = (node: Expression): ReadonlyArray<string> => {
  if (node.type === "Identifier") return [node.name]
  if (node.type !== "MemberExpression" || node.object.type === "Super") return []
  if (node.computed && node.property.type !== "Literal") return []
  if (!node.computed && node.property.type !== "Identifier") return []
  const head = memberParts(node.object)
  if (head.length === 0) return []
  return Option.match(spell(node.property), { onNone: () => [], onSome: (name) => [...head, name] })
}
const withoutGlobal = (path: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (path[0] === "globalThis" || path[0] === "global") return path.slice(1)
  return path
}

const processModule = /^(?:node:)?process$/
const clockBinding = (specifier: string, spec: Extract<Program["body"][number], { type: "ImportDeclaration" }>["specifiers"][number]): Option.Option<ReadonlyArray<string>> => {
  if (processModule.test(specifier)) {
    if (spec.type !== "ImportSpecifier") return Option.some(["process"])
    return Option.map(spell(spec.imported), (name) => ["process", name])
  }
  if (/^(?:node:)?perf_hooks$/.test(specifier) && spec.type === "ImportSpecifier" && Option.contains(spell(spec.imported), "performance"))
    return Option.some(["performance"])
  return Option.none()
}
type ImportDeclaration = Extract<Program["body"][number], { type: "ImportDeclaration" }>
const runnerBinding = (specifier: string, resolved: string, spec: ImportDeclaration["specifiers"][number]): Option.Option<ReadonlyArray<string>> => {
  const simulator = resolved === "opencode/sim/seed.ts"
  if (!simulator && resolved !== "opencode/sim-tui/app.ts" && !adapterModule.test(specifier)) return Option.none()
  const head = new Array<string>()
  if (simulator) head.push("sim")
  if (spec.type === "ImportNamespaceSpecifier") return Option.some(head)
  if (spec.type === "ImportSpecifier") return Option.map(spell(spec.imported), (name) => [...head, name])
  return Option.none()
}

const bindRunnerAliases = (program: Program, runners: Map<string, ReadonlyArray<string>>) =>
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return
      const value = node.init
      if (value.type === "CallExpression") {
        const path = boundPath(value.callee, runners)
        if (wrappers.has(path.at(-1) ?? "") && runnerArguments.has(path[0] ?? "")) runners.set(node.id.name, path.slice(0, -1))
        return
      }
      const path = boundPath(value, runners)
      if (runnerArguments.has(path[0] ?? "")) runners.set(node.id.name, path)
    },
  }).visit(program)

const bindings = (program: Program, resolve: (specifier: string) => string) => {
  const runners = new Map<string, ReadonlyArray<string>>([["Bun", []]])
  const helpers = new Map<string, string>()
  const clocks = new Map<string, ReadonlyArray<string>>()
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration") continue
    const specifier = node.source.value
    const resolved = resolve(specifier)
    for (const spec of node.specifiers) {
      const local = spec.local.name
      const runner = runnerBinding(specifier, resolved, spec)
      if (Option.isSome(runner)) runners.set(local, runner.value)
      if (resolved === timingModule && spec.type === "ImportSpecifier") {
        const name = spell(spec.imported)
        if (Option.isSome(name)) helpers.set(local, name.value)
      }
      const clock = clockBinding(specifier, spec)
      if (Option.isSome(clock)) clocks.set(local, clock.value)
    }
  }
  bindRunnerAliases(program, runners)
  return { runners, helpers, clocks }
}

const boundPath = (node: Expression, aliases: ReadonlyMap<string, ReadonlyArray<string>>) => {
  const [head = "", ...tail] = withoutGlobal(memberParts(node))
  return [...(aliases.get(head) ?? [head]), ...tail]
}

const runner = (node: CallExpression, aliases: ReadonlyMap<string, ReadonlyArray<string>>) => {
  const curried = node.callee.type === "CallExpression"
  let callee = node.callee
  if (callee.type === "CallExpression") callee = callee.callee
  const path = boundPath(callee, aliases)
  const [root = "", ...modifiers] = path
  const last = modifiers.at(-1) ?? ""
  if (wrappers.has(last) && !curried) return Option.none()
  let form = root
  if (last === "setDefaultTimeout") form = last
  if (root === "sim") form = `sim.${modifiers[0] ?? ""}`
  return Option.map(Option.fromNullishOr(runnerArguments.get(form)), (index) => ({ index, form }))
}

/** The only registration slot where a runner deadline can appear. No reading into options or evaluating runtime expressions. */
export const runnerSlot = (node: CallExpression, aliases: ReadonlyMap<string, ReadonlyArray<string>>): Option.Option<CallExpression["arguments"][number]> =>
  Option.flatMap(runner(node, aliases), ({ index, form }) => {
    const direct = node.arguments[index]
    if (form === "describe") {
      const second = node.arguments[1]
      if (second?.type === "ObjectExpression" || (direct?.type === "ArrowFunctionExpression" || direct?.type === "FunctionExpression")) return Option.fromNullishOr(second)
    }
    // A tuple spread can supply the timeout even if there is no node in its usual slot.
    const earlierSpread = node.arguments.slice(0, index).find((arg) => arg.type === "SpreadElement")
    return Option.fromNullishOr(earlierSpread ?? direct)
  })

const wallMembers = new Set(["Date.now", "performance.now", "process.hrtime", "Bun.nanoseconds", "process.uptime"])
const helperName = (node: CallExpression, helpers: ReadonlyMap<string, string>): string => {
  if (node.callee.type === "Identifier") return helpers.get(node.callee.name) ?? ""
  return ""
}
const literalText = (node?: CallExpression["arguments"][number]): Option.Option<string> => {
  if (node?.type === "Literal" && Schema.is(Schema.NonEmptyString)(node.value) && node.value.trim().length > 0) return Option.some(node.value)
  return Option.none()
}
const probe = (node: CallExpression) => {
  const value = node.arguments[0]
  return node.arguments.length === 2 && value?.type === "Literal" && Schema.is(Schema.Number)(value.value) &&
    Number.isInteger(value.value) && value.value > 0 && Option.isSome(literalText(node.arguments[1]))
}
const guards = new Map<string, number>(Object.entries(HANG_GUARDS))
const hang = (node: CallExpression) =>
  node.arguments.length === 1 && Option.exists(literalText(node.arguments[0]), (kind) => guards.has(kind))
const forwarded = (node: CallExpression) =>
  node.callee.type === "Identifier" && node.callee.name === "runnerCapOf" &&
  node.arguments.length === 1 && node.arguments[0]?.type === "Identifier" && node.arguments[0].name === "budget"

const capProblem = (node: CallExpression, names: ReturnType<typeof bindings>, bridge: boolean): Option.Option<Site> => {
  const slot = runnerSlot(node, names.runners)
  if (Option.isNone(slot)) return Option.none()
  const cap = slot.value
  const form = Option.map(runner(node, names.runners), ({ form }) => form)
  if (Option.contains(form, "sim.effect") && simulationBudget(cap, names.runners)) return Option.none()
  if (Option.contains(form, "sim.runner") && cap.type === "ObjectExpression" && cap.properties.every((prop) => {
    if (prop.type !== "Property") return false
    const key = spell(prop.key)
    if (Option.contains(key, "past")) return true
    return Option.contains(key, "budget") && simulationBudget(prop.value, names.runners)
  })) return Option.none()
  if (cap.type === "CallExpression") {
    const form = helperName(cap, names.helpers)
    if (form === "hangGuard" && hang(cap) || form === "probeTimeout" && probe(cap) || bridge && forwarded(cap)) return Option.none()
  }
  if (bridge && node.callee.type === "Identifier" && node.callee.name === "effectTest" && cap.type === "Identifier" && cap.name === "timeout")
    return Option.none()
  return Option.some({ rule: "R1", at: cap, reason: 'omit the runner cap or import hangGuard("kind") from tests/hang-guard.ts; intentional probes use probeTimeout(50, "reason")' })
}

const simulationBudget = (arg: Argument, aliases: ReadonlyMap<string, ReadonlyArray<string>>) =>
  arg.type === "CallExpression" && boundPath(arg.callee, aliases).join(".") === "sim.simulationBudget" &&
  arg.arguments.length === 1 && Option.exists(numeric(arg.arguments[0]), (ms) => Number.isInteger(ms) && ms > 0)

const bridgeConstructors = new Map([
  ["opencode/sim/seed.ts", "simulationBudget"],
  ["opencode/sim-tui/effect-test.ts", "tuiTestBudget"],
  ["opencode/mods/work/laws.ts", "riftsLawBudget"],
])

const bridgeBudgetProblem = (file: string, program: Program): ReadonlyArray<Site> => {
  const required = bridgeConstructors.get(file)
  if (!required) return []
  const errors: Array<Site> = []
  const verify = (id: { readonly type: string; readonly name?: string }, value: Argument, node: Span) => {
    if (id.type !== "Identifier" || id.name !== "budget") return
    if (value.type !== "CallExpression" || value.callee.type !== "Identifier" || value.callee.name !== required)
      errors.push({ rule: "R1", at: node, reason: `runner bridge must construct its branded deadline with ${required}` })
  }
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && node.init) verify(node.id, node.init, node)
    },
    AssignmentPattern(node) {
      if (node.left.type === "Identifier") verify(node.left, node.right, node)
    },
  }).visit(program)
  return errors
}

const partOf = (inner: Span, outer: Span) => outer.start <= inner.start && inner.end <= outer.end
type Argument = CallExpression["arguments"][number]
const numeric = (arg?: Argument): Option.Option<number> => {
  if (arg?.type !== "Literal") return Option.none()
  return Option.liftPredicate(Schema.is(Schema.Number))(arg.value)
}

// Evaluating a wait budget is only for checking diagnostic precedence. It can
// never make an expression valid in R1's runner-cap slot.
const waitNumber = (program: Program) => {
  const declarations: Array<{ readonly name: string; readonly value: Expression; readonly scope: Span }> = []
  const scopes: Array<Span> = [program]
  new Visitor({
    BlockStatement: (node) => { scopes.push(node) },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return
      const scope = scopes.findLast((scope) => partOf(node, scope)) ?? program
      declarations.push({ name: node.id.name, value: node.init, scope })
    },
  }).visit(program)
  const read = (arg: Argument, depth = 16): Option.Option<number> => {
    if (depth <= 0) return Option.none()
    if (arg.type === "Identifier") {
      const name = arg.name
      const binding = declarations.findLast((each) => each.name === name && each.value.end < arg.start && partOf(arg, each.scope))
      return Option.flatMap(Option.fromNullishOr(binding), ({ value }) => read(value, depth - 1))
    }
    if (arg.type === "BinaryExpression" && arg.left.type !== "PrivateIdentifier") {
      return Option.flatMap(Option.product(read(arg.left, depth - 1), read(arg.right, depth - 1)), ([a, b]) => {
        switch (arg.operator) {
          case "+": return Option.some(a + b)
          case "-": return Option.some(a - b)
          case "*": return Option.some(a * b)
          case "/": return Option.some(a / b)
          default: return Option.none()
        }
      })
    }
    return numeric(arg)
  }
  return read
}

const waitBindings = (program: Program) => {
  const waits = new Map([["waitUntil", 2], ["eventuallyPasses", 1]])
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration" || !/(?:^|\/)wait(?:\.ts)?$/.test(node.source.value)) continue
    for (const binding of node.specifiers) {
      if (binding.type !== "ImportSpecifier") continue
      const slot = Option.flatMap(spell(binding.imported), (name) => Option.fromNullishOr(waits.get(name)))
      if (Option.isSome(slot)) waits.set(binding.local.name, slot.value)
    }
  }
  return waits
}

const runnerBudget = (names: ReturnType<typeof bindings>, calls: ReadonlyArray<CallExpression>) => {
  const registrations = calls.flatMap((node) => Option.toArray(Option.map(runner(node, names.runners), ({ form }) => ({ node, form })))).toReversed()
  return (call: CallExpression): Option.Option<number> => {
    const enclosing = registrations.filter(({ node, form }) => partOf(call, node) && form !== "setDefaultTimeout")
    if (enclosing.length === 0 || enclosing[0]?.form === "describe") return Option.none()
    const defaults = registrations.filter(({ node, form }) => form === "setDefaultTimeout" && node.start < call.start)
    const [slot] = [...enclosing, ...defaults].flatMap(({ node }) => Option.toArray(runnerSlot(node, names.runners)))
    if (!slot) return Option.some(5_000)
    if (slot.type !== "CallExpression") return Option.none()
    const helper = helperName(slot, names.helpers)
    if (helper === "probeTimeout") return numeric(slot.arguments[0])
    if (helper === "hangGuard") return Option.flatMap(literalText(slot.arguments[0]), (kind) => Option.fromNullishOr(guards.get(kind)))
    return Option.none()
  }
}

const namedWaits = (program: Program, calls: ReadonlyArray<CallExpression>, names: ReturnType<typeof bindings>): ReadonlyArray<Site> => {
  const waits = waitBindings(program)
  const waiting = calls.filter((node) => node.callee.type === "Identifier" && waits.has(node.callee.name))
  if (waiting.length === 0) return []
  const number = waitNumber(program)
  const runnerMs = runnerBudget(names, calls)
  const warnings: Array<Site> = []
  for (const call of waiting) {
    if (call.callee.type !== "Identifier") continue
    const cap = runnerMs(call)
    const duration = Option.match(Option.fromNullishOr(call.arguments[waits.get(call.callee.name) ?? 2]), { onNone: () => Option.some(WAIT_MS), onSome: (arg) => number(arg) })
    if (Option.isSome(cap) && Option.isSome(duration) && duration.value + 1_000 > cap.value)
      warnings.push({ rule: "R1", at: call, reason: `named wait ${duration.value} ms needs at least 1000 ms before its ${cap.value} ms runner hang guard` })
  }
  return warnings
}

export const inspectTiming = (file: string, source: string, resolve: (specifier: string) => string): Inspection => {
  if (file === timingModule) return { errors: [], uses: [] }
  const program = parseSync(file, source).program
  const names = bindings(program, resolve)
  const errors: Array<Site> = [...bridgeBudgetProblem(file, program)]
  const uses: Array<Use> = []
  const calls: Array<CallExpression> = []
  const approvedCalls = new Set<number>()
  const timingImports = program.body.filter((node) => node.type === "ImportDeclaration" && resolve(node.source.value) === timingModule)
  const clock = (at: Span, name: string) => errors.push({ rule: "R2", at, reason: `${name} reads real time; use a virtual clock or an approved named clock helper` })
  new Visitor({
    CallExpression(node) {
      calls.push(node)
      const helper = helperName(node, names.helpers)
      if (helper !== "") approvedCalls.add(node.callee.start)
      if (helper === "probeTimeout") {
        if (probe(node)) uses.push({ kind: "probe", at: node })
        else errors.push({ rule: "R1", at: node, reason: 'intentional probes must use probeTimeout(50, "reason") with literal arguments' })
      }
      if (helper === "stamp" || helper === "elapsedForReport" || helper === "watchdog") uses.push({ kind: "clock", at: node })
      if (helper === "measured") {
        if (node.arguments.length === 3 && Option.isSome(literalText(node.arguments[0])) && Option.exists(literalText(node.arguments[1]), isProductBudget))
          uses.push({ kind: "measured", at: node })
        else errors.push({ rule: "R3", at: node, reason: 'use measured("product target", "budget with unit", fn)' })
      }
      const found = capProblem(node, names, runnerBridges.has(file))
      if (Option.isSome(found)) errors.push(found.value)
    },
    Identifier(node) {
      const name = names.helpers.get(node.name)
      if (!name || approvedCalls.has(node.start) || timingImports.some((decl) => partOf(node, decl))) return
      if (name === "stamp" || name === "elapsedForReport" || name === "watchdog") uses.push({ kind: "clock", at: node })
      if (name === "measured") errors.push({ rule: "R3", at: node, reason: "call imported measured directly with its literal arguments" })
      if (name === "probeTimeout") errors.push({ rule: "R1", at: node, reason: "call imported probeTimeout directly with its literal arguments" })
    },
    MemberExpression(node) {
      const path = boundPath(node, names.clocks).join(".")
      if (wallMembers.has(path)) clock(node, path)
    },
    NewExpression(node) {
      if (node.arguments.length === 0 && boundPath(node.callee, names.clocks).join(".") === "Date") clock(node, "new Date()")
    },
    ImportDeclaration(node) {
      if (!processModule.test(node.source.value)) return
      for (const specifier of node.specifiers) {
        if (specifier.type !== "ImportSpecifier") continue
        const name = spell(specifier.imported)
        if (Option.isSome(name) && wallMembers.has(`process.${name.value}`)) clock(specifier, `process.${name.value}`)
      }
    },
    VariableDeclarator(node) {
      if (node.id.type !== "ObjectPattern" || !node.init) return
      const root = boundPath(node.init, names.clocks).join(".")
      for (const field of node.id.properties) {
        if (field.type !== "Property") continue
        const key = spell(field.key)
        if (Option.isSome(key) && wallMembers.has(`${root}.${key.value}`)) clock(field, `${root}.${key.value}`)
      }
    },
  }).visit(program)
  return { errors: [...errors, ...namedWaits(program, calls, names)], uses }
}
