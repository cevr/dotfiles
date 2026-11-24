import { Option, Schema } from "effect"
// This stops accidental test-time dependence, not concealment via names assembled at runtime, eval, or new Function (the latter two are forbidden anyway).
// Judge by static import closure. Reached product files get producer rules only: no acquisition of a runner/timing helper or re-export of a guarded binding; product clock reads and ordinary loads stay legal.
import { type CallExpression, type Expression, parseSync, Visitor } from "oxc-parser"
import { HANG_GUARDS, isProductBudget } from "../tests/hang-guard.ts"
import { WAIT_MS } from "../tests/wait.ts"
import { dateArguments, moduleText, type Program, type Statement, timingSources } from "./timing-syntax.ts"

export { relativeTimingTarget, sourceFile, testFile } from "./timing-syntax.ts"

export interface Span {
  readonly start: number
  readonly end: number
}

export type Rule = "R1" | "R2" | "R3"
export type AllowKind = "probe" | "clock" | "measured" | "dynamic"
export interface Site {
  readonly rule: Rule
  readonly at: Span
  readonly reason: string
}
export type Use =
  | { readonly kind: Exclude<AllowKind, "measured">; readonly at: Span }
  | { readonly kind: "measured"; readonly at: Span; readonly target: string; readonly budget: string }
export interface Inspection {
  readonly errors: ReadonlyArray<Site>
  readonly uses: ReadonlyArray<Use>
}

export const timingModule = "opencode/tests/hang-guard.ts"
const symbolModule = "opencode/tests/global-slot.ts"
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
const runnerArguments = new Map([
  ["test", 2], ["it", 2], ["describe", 2], ["effectTest", 2], ["platformTest", 2], ["riftsLaws", 2],
  ["simulationTest", 2], ["simulationRunner", 1],
  ["beforeAll", 1], ["afterAll", 1], ["beforeEach", 1], ["afterEach", 1], ["setDefaultTimeout", 0],
])
const bunTest = new Set(["test", "it", "describe", "beforeAll", "afterAll", "beforeEach", "afterEach", "setDefaultTimeout"])
const runnerModules = new Map([
  ["bun:test", bunTest],
  ["effect-bun-test", new Set(["test", "it", "describe"])],
  ["opencode/sim/seed.ts", new Set(["simulationTest", "simulationRunner"])],
  ["opencode/sim-tui/effect-test.ts", new Set(["effectTest", "platformTest"])],
  ["opencode/mods/work/laws.ts", new Set(["riftsLaws"])],
])
// Bun's Test and Describe types; effect-bun-test's `it` export.
const testModifiers = new Set(["only", "skip", "todo", "failing", "concurrent", "serial"])
const suiteModifiers = new Set(["only", "skip", "todo", "concurrent", "serial"])
const testFactories = new Set(["each", "if", "skipIf", "todoIf", "failingIf", "concurrentIf", "serialIf"])
const suiteFactories = new Set(["each", "if", "skipIf", "todoIf"])
const effectModes = new Set(["effect", "live", "scoped", "scopedLive"])
const processModule = /^(?:node:)?process$/
const perfModule = /^(?:node:)?perf_hooks$/
export const simulationBudgetModule = "opencode/sim/budget.ts"
const bridgeBudgetModules = new Map([["opencode/sim/seed.ts", simulationBudgetModule],
  ["opencode/sim-tui/effect-test.ts", timingModule], ["opencode/mods/work/laws.ts", timingModule]])
const simulator = "opencode/sim/seed.ts"
const bridgeConstructor = (file: string) => {
  if (file === simulator) return "simulationBudget"
  return "bridgeBudget"
}
const timingNames = new Map<string, Rule>([
  ["hangGuard", "R1"], ["probeTimeout", "R1"], ["measured", "R3"],
  ["stamp", "R2"], ["elapsedForReport", "R2"], ["watchdog", "R2"],
])

const spell = (node: { readonly type: string }): Option.Option<string> => {
  if ("value" in node && Schema.is(Schema.String)(node.value)) return Option.some(node.value)
  if ("name" in node && Schema.is(Schema.String)(node.name)) return Option.some(node.name)
  return Option.none()
}
const word = (node: { readonly type: string }) => Option.getOrElse(spell(node), () => "")
const dot = (node: Expression) => {
  if (node.type === "MemberExpression" && !node.computed && !node.optional && node.object.type !== "Super" && node.property.type === "Identifier")
    return Option.some({ object: node.object, name: node.property.name })
  return Option.none()
}

type Mode = "test" | "suite" | "fixed" | "effect-root" | "effect" | "layered"
interface Runner { readonly root: Span & { readonly name: string }; readonly mode: Mode }
const baseMode = (name: string, module: string): Mode => {
  if (module === "effect-bun-test" && name === "it") return "effect-root"
  if (name === "describe") return "suite"
  if (name === "test" || name === "it") return "test"
  return "fixed"
}
const dotModifiers = new Map<Mode, readonly [ReadonlySet<string>, Mode]>([
  ["test", [testModifiers, "test"]], ["suite", [suiteModifiers, "suite"]],
  ["effect-root", [effectModes, "effect"]], ["effect", [new Set(["serial"]), "layered"]],
])
const curryModifiers = new Map<Mode, readonly [ReadonlySet<string>, Mode]>([
  ["test", [testFactories, "test"]], ["suite", [suiteFactories, "suite"]],
  ["effect", [new Set(["layer"]), "layered"]],
])
const modify = (runner: Runner, name: string, table: typeof dotModifiers) => Option.flatMap(
  Option.fromUndefinedOr(table.get(runner.mode)),
  ([members, mode]) => {
    if (members.has(name)) return Option.some({ ...runner, mode })
    return Option.none()
  },
)

const registration = (node: Expression, imports: ReadonlyMap<string, string>): Option.Option<Runner> => {
  if (node.type === "Identifier") return Option.map(Option.fromUndefinedOr(imports.get(node.name)), (module) => ({ root: node, mode: baseMode(node.name, module) }))
  if (node.type === "CallExpression" && !node.optional)
    return Option.flatMap(dot(node.callee), ({ object, name }) => Option.flatMap(registration(object, imports), (base) => modify(base, name, curryModifiers)))
  return Option.flatMap(dot(node), ({ object, name }) => Option.flatMap(registration(object, imports), (base) => modify(base, name, dotModifiers)))
}

const runner = (node: CallExpression, imports: ReadonlyMap<string, string>) => {
  const reg = registration(node.callee, imports)
  if (node.optional || Option.isNone(reg) || reg.value.mode === "effect-root") return Option.none()
  const { root } = reg.value
  return Option.map(Option.fromNullishOr(runnerArguments.get(root.name)), (index) => ({ index, form: root.name, root }))
}

/** The only registration slot where a runner deadline can appear. No reading into options or evaluating runtime expressions. */
const runnerSlot = (node: CallExpression, imports: ReadonlyMap<string, string>): Option.Option<CallExpression["arguments"][number]> =>
  Option.flatMap(runner(node, imports), ({ index, form }) => {
    const direct = node.arguments[index]
    if (form === "describe") {
      const second = node.arguments[1]
      if (second?.type === "ObjectExpression" || (direct?.type === "ArrowFunctionExpression" || direct?.type === "FunctionExpression")) return Option.fromNullishOr(second)
    }
    // A tuple spread can supply the timeout even if there is no node in its usual slot.
    const earlierSpread = node.arguments.slice(0, index).find((arg) => arg.type === "SpreadElement")
    return Option.fromNullishOr(earlierSpread ?? direct)
  })

const clockName = (name: string) => name === "hrtime" || name === "uptime" || name === "performance" || name === "nanoseconds"
const helperName = (node: CallExpression, helpers: ReadonlySet<string>): string => {
  if (!node.optional && node.callee.type === "Identifier" && helpers.has(node.callee.name)) return node.callee.name
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
const forwarderName = (file: string) => {
  if (file === simulator) return "simulationRunnerCapOf"
  return "runnerCapOf"
}
const forwarded = (node: CallExpression, helpers: ReadonlySet<string>, file: string) =>
  helperName(node, helpers) === forwarderName(file) && node.arguments.length === 1 &&
  node.arguments[0]?.type === "Identifier" && node.arguments[0].name === "budget"

type Imports = { readonly runners: ReadonlyMap<string, string>; readonly helpers: ReadonlySet<string> }
const capProblem = (node: CallExpression, names: Imports, file: string): Option.Option<Site> => {
  const slot = runnerSlot(node, names.runners)
  if (Option.isNone(slot)) return Option.none()
  const cap = slot.value
  const form = Option.map(runner(node, names.runners), ({ form }) => form)
  if (Option.contains(form, "simulationTest") && simulationBudget(cap, names.helpers)) return Option.none()
  if (Option.contains(form, "simulationRunner") && cap.type === "ObjectExpression" && cap.properties.every((prop) => {
    if (prop.type !== "Property" || prop.computed) return false
    const key = spell(prop.key)
    if (Option.contains(key, "past")) return true
    return Option.contains(key, "budget") && simulationBudget(prop.value, names.helpers)
  })) return Option.none()
  if (cap.type === "CallExpression") {
    const form = helperName(cap, names.helpers)
    if (form === "hangGuard" && hang(cap) || form === "probeTimeout" && probe(cap) ||
      bridgeBudgetModules.has(file) && forwarded(cap, names.helpers, file)) return Option.none()
  }
  if (file === "opencode/sim-tui/effect-test.ts" && Option.contains(form, "effectTest") && cap.type === "Identifier" && cap.name === "timeout")
    return Option.none()
  return Option.some({ rule: "R1", at: cap, reason: 'omit the runner cap or import hangGuard("kind") from tests/hang-guard.ts; intentional probes use probeTimeout(50, "reason")' })
}

const simulationBudget = (arg: Argument, helpers: ReadonlySet<string>) =>
  arg.type === "CallExpression" && helperName(arg, helpers) === "simulationBudget" &&
  arg.arguments.length === 1 && Option.exists(numeric(arg.arguments[0]), (ms) => Number.isInteger(ms) && ms > 0)

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

const runnerBudget = (names: Imports, calls: ReadonlyArray<CallExpression>) => {
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

const namedWaits = (program: Program, calls: ReadonlyArray<CallExpression>, names: Imports): ReadonlyArray<Site> => {
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

const budgetModules = new Map([
  ["simulationBudget", simulationBudgetModule], ["simulationRunnerCapOf", simulationBudgetModule],
  ["bridgeBudget", timingModule], ["runnerCapOf", timingModule],
])
type ImportStatement = Extract<Statement, { type: "ImportDeclaration" }>
type ExportStatement = Extract<Statement, { type: "ExportNamedDeclaration" | "ExportAllDeclaration" }>
const hostRoots = ["process", "Bun", "globalThis", "global"]
const globalRoots = new Set(["globalThis", "global"])
const globalHostModules = new Map([["process", "process"], ["Bun", "bun"]])
const rawNames = new Set(["Date", "performance", "eval", "Function"])
const hostModule = (mod: string) => processModule.test(mod) || mod === "bun"
const clockModule = (mod: string) => hostModule(mod) || perfModule.test(mod)
const moduleRule = (mod: string): Option.Option<Rule> => {
  if (runnerModules.has(mod) || mod === simulationBudgetModule) return Option.some("R1")
  if (mod === timingModule) return Option.some("R3")
  if (clockModule(mod)) return Option.some("R2")
  if (mod === symbolModule) return Option.some("R2")
  return Option.none()
}

interface Binding { readonly module: string; readonly exported: string }
const hostBinding = ({ module, exported }: Binding) => hostModule(module) && (exported === "default" || exported === "*")
const bindingRule = ({ module, exported }: Binding): Option.Option<Rule> => {
  if (exported === "default" || exported === "*") return moduleRule(module)
  if (runnerModules.get(module)?.has(exported) || budgetModules.get(exported) === module) return Option.some("R1")
  if (module === timingModule) return Option.fromUndefinedOr(timingNames.get(exported))
  if (clockModule(module) && clockName(exported)) return Option.some("R2")
  return Option.none()
}

const closedNames = (file: string) => {
  const runners = new Map<string, string>()
  const helpers = new Set<string>()
  const clocks = new Set(hostRoots)
  const hostImports = new Map(globalHostModules)
  const approved = new Set<number>()
  const errors: Array<Site> = []
  const uses: Array<Use> = []
  const mark = (site: Span) => { approved.add(site.start) }
  const reject = (rule: Rule, at: Span, reason: string) => { errors.push({ rule, at, reason }) }
  const clock = (at: Span, name: string) => reject("R2", at, `${name} can acquire real time; use a virtual clock or an approved named clock helper`)
  const rule = (name: string): Option.Option<Rule> => {
    if (runnerArguments.has(name) || budgetModules.has(name)) return Option.some("R1")
    if (name === "measured") return Option.some("R3")
    return Option.filter(Option.fromUndefinedOr(timingNames.get(name)), () => helpers.has(name))
  }
  const declarations = runnerModules.get(file)
  if (declarations) for (const name of declarations) runners.set(name, file)
  return { runners, helpers, clocks, hostImports, approved, errors, uses, mark, reject, clock, rule, declarations }
}
type ClosedNames = ReturnType<typeof closedNames>

const allowedImport = (file: string, mod: string, name: string) => {
  if (runnerModules.get(mod)?.has(name) || mod === timingModule && timingNames.has(name)) return true
  if (bridgeBudgetModules.has(file) && name === forwarderName(file)) return bridgeBudgetModules.get(file) === mod
  return budgetModules.get(name) === mod
}

type ImportSpecifier = ImportStatement["specifiers"][number]
const exportName = (spec: ImportSpecifier): string => {
  if (spec.type === "ImportSpecifier") return word(spec.imported)
  if (spec.type === "ImportDefaultSpecifier") return "default"
  return "*"
}

const declareBinding = (file: string, names: ClosedNames, binding: Binding, spec: ImportSpecifier, typeOnly: boolean) => {
  if (hostBinding(binding)) {
    names.clocks.add(spec.local.name)
    names.hostImports.set(spec.local.name, binding.module)
    return
  }
  const { module, exported } = binding
  const rule = Option.orElse(bindingRule(binding), () => Option.orElse(names.rule(exported), () => names.rule(spec.local.name)))
  if (Option.isNone(rule)) return
  if (typeOnly || spec.local.name !== exported || !allowedImport(file, module, exported))
    names.reject(rule.value, spec, "use the guarded name in a direct value import from its canonical module without a rename")
  else if (runnerArguments.has(exported)) names.runners.set(exported, module)
  else names.helpers.add(exported)
}

const declareImport = (file: string, names: ClosedNames, decl: ImportStatement, mod: string) => {
  for (const spec of decl.specifiers) {
    names.mark(spec.local)
    if (spec.type === "ImportSpecifier") names.mark(spec.imported)
    const typeOnly = decl.importKind === "type" || spec.type === "ImportSpecifier" && spec.importKind === "type"
    declareBinding(file, names, { module: mod, exported: exportName(spec) }, spec, typeOnly)
  }
}

const declareExport = (names: ClosedNames, decl: ExportStatement, mod: string) => {
  const from = moduleRule(mod)
  if (decl.type === "ExportAllDeclaration") {
    if (Option.isSome(from)) names.reject(from.value, decl, "do not re-export a guarded module")
    return
  }
  for (const spec of decl.specifiers) {
    names.mark(spec.local)
    names.mark(spec.exported)
    const name = word(spec.local)
    const rule = Option.orElse(bindingRule({ module: mod, exported: name }), () => Option.orElse(names.rule(name), () => names.rule(word(spec.exported))))
    if (Option.isSome(rule)) names.reject(rule.value, spec, "do not re-export a guarded binding")
    else if (names.clocks.has(name) || rawNames.has(name)) names.clock(spec, name)
  }
}

const permittedDateCall = (node: CallExpression) => Option.filter(dot(node.callee), ({ object, name }) =>
  !node.optional && object.type === "Identifier" && object.name === "Date" && (name === "parse" || name === "UTC"))

const recordTimingCall = (names: ClosedNames, node: CallExpression) => {
  const helper = helperName(node, names.helpers)
  if (!helper) return
  names.mark(node.callee)
  if (helper === "probeTimeout") {
    if (probe(node)) names.uses.push({ kind: "probe", at: node })
    else names.reject("R1", node, 'intentional probes must use probeTimeout(50, "reason") with literal arguments')
  }
  if (helper === "stamp" || helper === "elapsedForReport" || helper === "watchdog") names.uses.push({ kind: "clock", at: node })
  if (helper !== "measured") return
  const target = literalText(node.arguments[0])
  const budget = literalText(node.arguments[1])
  if (node.arguments.length === 3 && node.arguments[2]?.type !== "SpreadElement" &&
    Option.isSome(target) && Option.isSome(budget) && isProductBudget(budget.value))
    names.uses.push({ kind: "measured", at: node, target: target.value, budget: budget.value })
  else names.reject("R3", node, 'use measured("product target", "budget with unit", fn)')
}

const readHostMember = (names: ClosedNames, node: Extract<Expression, { type: "MemberExpression" }>) => {
  if (!node.computed) names.mark(node.property)
  if (node.object.type !== "Identifier" || !names.clocks.has(node.object.name)) return
  names.mark(node.object)
  const member = word(node.property)
  const host = node.object.name
  const guarded = names.rule(member)
  if (Option.isSome(guarded)) names.reject(guarded.value, node, "use a direct named import and call, not a property on the host")
  else if (node.computed || hostClockMember(names, host, member) || globalRoots.has(host) && (rawNames.has(member) || names.clocks.has(member)))
    names.clock(node, host)
}

const hostClockMember = (names: ClosedNames, host: string, member: string) =>
  Option.exists(Option.fromUndefinedOr(names.hostImports.get(host)), (module) =>
    Option.contains(bindingRule({ module, exported: member }), "R2"))

const readReference = (names: ClosedNames, node: Span & { readonly name: string }, types: ReadonlyArray<Span>, effectFunction: boolean) => {
  if (names.approved.has(node.start) || types.some((type) => partOf(node, type))) return
  const { name } = node
  const rule = names.rule(name)
  if (Option.contains(rule, "R2")) names.uses.push({ kind: "clock", at: node })
  else if (Option.isSome(rule)) names.reject(rule.value, node, "guarded names may only be introduced by a canonical named import and used at their call")
  else if (names.clocks.has(name) || rawNames.has(name) && !(effectFunction && name === "Function")) names.clock(node, name)
}

const dynamicSource = (names: ClosedNames, resolve: (specifier: string) => string, approved: boolean, site: Span, argument?: Argument) => {
  const target = moduleText(argument)
  if (Option.isNone(target)) {
    if (approved) names.uses.push({ kind: "dynamic", at: site })
    else names.reject("R1", site, "non-static module loads require an approved fixture loader entry")
    return
  }
  const rule = moduleRule(resolve(target.value))
  if (Option.isSome(rule)) names.reject(rule.value, site, "guarded modules require a static import declaration")
}

const isRequire = (node: Expression) => {
  if (node.type === "Identifier") return node.name === "require"
  return Option.exists(dot(node), ({ name }) => name === "require")
}

const inspectBridgeBinding = (file: string, names: ClosedNames, pattern: Span & { readonly type: string; readonly name?: string }, value?: Argument) => {
  if (!bridgeBudgetModules.has(file) || pattern.type !== "Identifier" || pattern.name !== "budget") return
  const constructor = bridgeConstructor(file)
  if (value?.type !== "CallExpression" || helperName(value, names.helpers) !== constructor)
    names.reject("R1", pattern, `runner bridge must construct its branded deadline with imported ${constructor}`)
}

type Declarator = Extract<Statement, { type: "VariableDeclaration" }>["declarations"][number]
const inspectDeclarator = (file: string, names: ClosedNames, { id, init }: Declarator) => {
  inspectBridgeBinding(file, names, id, Option.getOrUndefined(Option.fromNullishOr(init)))
  if (id.type === "Identifier" && names.declarations?.has(id.name)) names.mark(id)
  if (id.type === "Identifier" && file === simulationBudgetModule && budgetModules.get(id.name) === file) names.mark(id)
  if (file === symbolModule && init?.type === "Identifier" && init.name === "globalThis") names.mark(init)
  markHostDestructuring(names, id, init)
}

const markHostDestructuring = (names: ClosedNames, id: Declarator["id"], init: Declarator["init"]) => {
  if (id.type !== "ObjectPattern" || init?.type !== "Identifier" || !names.clocks.has(init.name) || globalRoots.has(init.name)) return
  if (id.properties.every((field) => field.type === "Property" && !field.computed && !hostClockMember(names, init.name, word(field.key)))) names.mark(init)
}

const inspectDeclarations = (file: string, names: ClosedNames, program: Program, resolve: (specifier: string) => string) => {
  // Import order does not affect the acquisition policy.
  for (const decl of program.body) if (decl.type === "ImportDeclaration") declareImport(file, names, decl, resolve(decl.source.value))
  for (const decl of program.body) if (decl.type === "ExportNamedDeclaration" || decl.type === "ExportAllDeclaration")
    declareExport(names, decl, Option.match(Option.fromNullishOr(decl.source), { onNone: () => "", onSome: ({ value }) => resolve(value) }))
}

const inspectFull = (file: string, program: Program, resolve: (specifier: string) => string, dynamic: boolean): Inspection => {
  const names = closedNames(file)
  const calls: Array<CallExpression> = []
  const types: Array<Span> = []
  const effectFunction = program.body.some((decl) => decl.type === "ImportDeclaration" && decl.source.value === "effect" &&
    decl.specifiers.some((spec) => spec.type === "ImportSpecifier" && word(spec.imported) === "Function" && spec.local.name === "Function"))
  const params = (node: { readonly params: ReadonlyArray<Span & { readonly type: string }> }) => {
    for (const parameter of node.params) inspectBridgeBinding(file, names, parameter)
  }
  const key = (node: Span, computed: boolean) => { if (!computed) names.mark(node) }
  const hasArgument = dateArguments(program)
  inspectDeclarations(file, names, program, resolve)
  new Visitor({
    CallExpression(node) {
      calls.push(node)
      if (isRequire(node.callee)) dynamicSource(names, resolve, dynamic, node, node.arguments[0])
      for (const { object } of Option.toArray(permittedDateCall(node))) names.mark(object)
      for (const { root } of Option.toArray(runner(node, names.runners))) names.mark(root)
      recordTimingCall(names, node)
      names.errors.push(...Option.toArray(capProblem(node, names, file)))
    },
    ImportExpression(node) { dynamicSource(names, resolve, dynamic, node, node.source) },
    TSExternalModuleReference(node) { dynamicSource(names, resolve, dynamic, node, node.expression) },
    MemberExpression(node) { readHostMember(names, node) },
    NewExpression(node) {
      if (node.callee.type !== "Identifier") return
      if (node.callee.name === "Function") {
        names.mark(node.callee)
        names.reject("R2", node.callee, "dynamic code generation cannot introduce a guarded acquisition")
      }
      if (node.callee.name === "Date" && node.arguments.some(hasArgument)) names.mark(node.callee)
    },
    TSTypeReference(node) { types.push(node.typeName) },
    TSTypeQuery(node) { types.push(node.exprName) },
    TSPropertySignature(node) { key(node.key, node.computed) },
    Property(node) { if (!node.shorthand) key(node.key, node.computed) },
    MethodDefinition(node) { key(node.key, node.computed) },
    PropertyDefinition(node) { key(node.key, node.computed) },
    VariableDeclarator(node) { inspectDeclarator(file, names, node) },
    AssignmentPattern(node) { inspectBridgeBinding(file, names, node.left, node.right) },
    AssignmentExpression(node) { inspectBridgeBinding(file, names, node.left) },
    ArrowFunctionExpression: params, FunctionDeclaration: params, FunctionExpression: params,
    Identifier(node) { readReference(names, node, types, effectFunction) },
  }).visit(program)
  return { errors: [...names.errors, ...namedWaits(program, calls, names)], uses: names.uses }
}

export const inspectTiming = (file: string, source: string, resolve: (specifier: string) => string, dynamic = false): Inspection => {
  if (file === timingModule) return { errors: [], uses: [] }
  return inspectFull(file, parseSync(file, source).program, resolve, dynamic)
}

// Reached product sources may read the clock, including through a legitimate
// local adapter. They cannot launder a real test runner or timing helper, or
// directly re-export a guarded binding from a canonical source.
const producerImports = (decl: ImportStatement, mod: string, names: ClosedNames, local: Map<string, Binding>) => {
  for (const spec of decl.specifiers) {
    const binding = { module: mod, exported: exportName(spec) }
    const rule = bindingRule(binding)
    if (Option.isNone(rule)) continue
    if (clockModule(mod)) local.set(spec.local.name, binding)
    else names.reject(rule.value, spec, "a reached product file must not acquire a guarded test runner or timing helper")
  }
}

const producerExports = (decl: ExportStatement, mod: string, names: ClosedNames, local: ReadonlyMap<string, Binding>) => {
  if (decl.type === "ExportAllDeclaration") {
    const rule = moduleRule(mod)
    if (Option.isSome(rule)) names.reject(rule.value, decl, "a reached product file must not re-export a guarded module")
    return
  }
  for (const spec of decl.specifiers) {
    const exported = word(spec.local)
    const binding = Option.getOrElse(Option.filter(Option.fromUndefinedOr(local.get(exported)), () => mod === ""), () => ({ module: mod, exported }))
    const rule = bindingRule(binding)
    if (Option.isSome(rule)) names.reject(rule.value, spec, "a reached product file must not re-export a guarded binding")
  }
}

const inspectProducer = (file: string, program: Program, resolve: (specifier: string) => string): Inspection => {
  const names = closedNames(file)
  const local = new Map<string, Binding>()
  for (const decl of program.body) if (decl.type === "ImportDeclaration") producerImports(decl, resolve(decl.source.value), names, local)
  for (const decl of program.body) {
    if (decl.type === "ExportNamedDeclaration" || decl.type === "ExportAllDeclaration")
      producerExports(decl, Option.match(Option.fromNullishOr(decl.source), { onSome: ({ value }) => resolve(value), onNone: () => "" }), names, local)
    if (decl.type === "ExportDefaultDeclaration" && decl.declaration.type === "Identifier" && local.has(decl.declaration.name))
      names.reject("R2", decl.declaration, "a reached product file must not re-export a guarded binding")
  }
  const load = (at: Span, arg?: Argument) => {
    const target = Option.map(moduleText(arg), resolve)
    if (Option.isSome(target) && !clockModule(target.value)) dynamicSource(names, resolve, false, at, arg)
  }
  new Visitor({
    CallExpression(node) { if (isRequire(node.callee)) load(node, node.arguments[0]) },
    ImportExpression(node) { load(node, node.source) },
    TSExternalModuleReference(node) { load(node, node.expression) },
  }).visit(program)
  return { errors: names.errors, uses: [] }
}

export const inspectTimingProject = (texts: ReadonlyMap<string, string>, resolve: (file: string, specifier: string) => string,
  dynamic: ReadonlySet<string> = new Set()) => {
  const results = new Map<string, Inspection>()
  for (const [file, { program, producerOnly }] of timingSources(texts, resolve)) {
    if (file === timingModule) continue
    const from = (specifier: string) => resolve(file, specifier)
    if (producerOnly) results.set(file, inspectProducer(file, program, from))
    else results.set(file, inspectFull(file, program, from, dynamic.has(file)))
  }
  return results
}
