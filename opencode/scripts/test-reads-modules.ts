import { Predicate } from "effect"
import { child, children, field, id, literal, type Node, nodes, property, unwrap } from "./test-reads-ast.ts"

export interface Reference {
  readonly file: string
  /** Empty means module initialization. `*` means that its namespace escaped. */
  readonly symbol: string
}

interface Region {
  readonly symbol: string
  readonly start: number
  readonly end: number
}

const range = (symbol: string, value: Node): Region =>
  ({ symbol, start: value.start, end: Number(field(value, "end")) })

type SymbolOf = (node: ReturnType<typeof child>) => string
const LAZY = new Set([
  "effect:Effect:gen", "effect:Effect:fn", "effect:Effect:fnUntraced", "effect:Effect:suspend",
  "effect:Effect:try", "effect:Effect:tryPromise", "effect:Effect:promise", "effect:Effect:sync",
  "effect:Layer:effect", "effect:Layer:effectDiscard", "effect:Layer:effectServices", "effect:Layer:sync",
  "effect:Layer:suspend", "effect:Layer:mergeAll", "effect:Layer:succeed", "effect:Layer:unwrap",
])
const FUNCTION = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"])
const EFFECT_FN = new Set(["effect:Effect:fn", "effect:Effect:fnUntraced"])
const SIMPLE = new Set(["Identifier", "Literal", "ThisExpression"])
const EFFECT_OPERATORS = new Set([
  "effect:Effect:as", "effect:Effect:asVoid", "effect:Effect:catch", "effect:Effect:catchAll",
  "effect:Effect:flatMap", "effect:Effect:map", "effect:Effect:mapError", "effect:Effect:option",
  "effect:Effect:orDie", "effect:Effect:orElseSucceed", "effect:Effect:scoped", "effect:Effect:tap", "effect:Effect:withSpan",
])

const valueCreation = (value: Node, symbol: SymbolOf): boolean => {
  if (SIMPLE.has(value.type) || safelyLazy(value, symbol)) return true
  if (value.type === "ArrayExpression")
    return nodes(field(value, "elements")).every((item) => valueCreation(item, symbol))
  if (value.type !== "ObjectExpression") return false
  return nodes(field(value, "properties")).every((part) => {
    const entry = child(part, "value")
    return part.type === "Property" && !field(part, "computed") && Boolean(entry && valueCreation(entry, symbol))
  })
}

const safelyLazy = (value: Node, symbol: SymbolOf): boolean => {
  if (FUNCTION.has(value.type)) return true
  if (value.type !== "CallExpression") return false
  const callee = child(value, "callee")
  const args = nodes(field(value, "arguments"))
  if (LAZY.has(symbol(callee))) return args.every((arg) => valueCreation(arg, symbol))
  if (callee?.type === "CallExpression" && EFFECT_FN.has(symbol(child(callee, "callee"))) &&
    nodes(field(callee, "arguments")).every((name) => Predicate.isString(literal(name)))) {
    return args.length > 0 && args.every((arg) => valueCreation(arg, symbol))
  }
  const receiver = child(callee, "object")
  return property(callee) === "pipe" && receiver?.type === "CallExpression" &&
    safelyLazy(receiver, symbol) && args.every((arg) => effectOperator(arg, symbol))
}

const effectOperator = (value: Node, symbol: SymbolOf) => {
  if (value.type !== "CallExpression") return EFFECT_OPERATORS.has(symbol(value))
  const operator = child(value, "callee")
  return EFFECT_OPERATORS.has(symbol(operator)) && nodes(field(value, "arguments")).every((arg) => valueCreation(arg, symbol))
}

/** A class's methods and instance initializers run only when the class is used. */
const classRegions = (declaration: Node): ReadonlyArray<Region> => {
  const name = id(child(declaration, "id")) ?? "default"
  const members = nodes(field(child(declaration, "body"), "body"))
  const accessesReceiver = (at: Node): boolean => at.type === "ThisExpression" || at.type === "Super" || children(at).some(accessesReceiver)
  // Decorators can invoke a method while defining it. Static initialization
  // can invoke one through `this` without spelling the class name.
  if ([declaration, ...members].some((at) => nodes(field(at, "decorators")).length > 0)) return []
  if (members.some((member) => {
    if (member.type === "StaticBlock") return accessesReceiver(member)
    const value = child(member, "value")
    return member.type === "PropertyDefinition" && field(member, "static") && value && accessesReceiver(value)
  })) return []
  return members.flatMap((member) => {
    const deferred = member.type === "MethodDefinition" || (member.type === "PropertyDefinition" && !field(member, "static"))
    const value = deferred && child(member, "value")
    return (value && [range(name, value)]) || []
  })
}

const functionRegions = (statement: Node, symbol: SymbolOf): ReadonlyArray<Region> => {
  const declaration = child(statement, "declaration") ?? statement
  if (declaration.type === "ClassDeclaration") return classRegions(declaration)
  if (declaration.type === "FunctionDeclaration") {
    const name = id(child(declaration, "id"))
    return [range(name ?? "default", declaration)]
  }
  if (declaration.type !== "VariableDeclaration") return []
  return nodes(field(declaration, "declarations")).flatMap((binding) => {
    const name = id(child(binding, "id"))
    const init = unwrap(child(binding, "init"))
    return (name && init && valueCreation(init, symbol) && [range(name, binding)]) || []
  })
}

/** Only unambiguously deferred top-level functions can be skipped at module load. */
export const regionsOf = (program: Node, symbol: SymbolOf) => nodes(field(program, "body")).flatMap((at) => functionRegions(at, symbol))

const mainTest = (target: ReturnType<typeof child>) => {
  const object = child(target, "object")
  return property(target) === "main" && object?.type === "MetaProperty" &&
    id(child(object, "meta")) === "import" && id(child(object, "property")) === "meta"
}

/** A literal `import.meta.main` branch runs only as a program, not as an ESM dependency. */
export const entryRegions = (nodes: ReadonlyArray<Node>) => nodes.flatMap((at) => {
  if (at.type !== "IfStatement" && at.type !== "ConditionalExpression") return []
  const test = child(at, "test")
  const inverted = test?.type === "UnaryExpression" && field(test, "operator") === "!"
  const entry = (inverted && mainTest(child(test, "argument")) && child(at, "alternate")) ||
    (mainTest(test) && child(at, "consequent"))
  return (entry && [range("@main", entry)]) || []
})

export const regionOf = (regions: ReadonlyArray<Region>, at: Node): string =>
  regions.find((region) => region.start <= at.start && at.start < region.end)?.symbol ?? ""

const symbolOf = (at: Node, key: string) => id(child(at, key)) ?? literal(child(at, key)) ?? ""

const importRef = (node: Node, file: string) => {
  if (field(node, "importKind") === "type") return []
  const local = symbolOf(node, "local")
  const symbol = (node.type === "ImportDefaultSpecifier" && "default") || symbolOf(node, "imported") || "*"
  return [{ local, target: { file, symbol } }]
}

const exportRef = (node: Node, file: string) => {
  if (field(node, "exportKind") === "type") return []
  return [{ local: symbolOf(node, "exported"), target: { file, symbol: symbolOf(node, "local") || "*" } }]
}

export const moduleReferences = (at: Node, file: string) => {
  const specifiers = nodes(field(at, "specifiers"))
  if (at.type === "ImportDeclaration") return specifiers.flatMap((spec) => importRef(spec, file))
  if (at.type === "ExportNamedDeclaration") return specifiers.flatMap((spec) => exportRef(spec, file))
  if (at.type === "ExportAllDeclaration") return [{ local: symbolOf(at, "exported") || "*", target: { file, symbol: "*" } }]
  return []
}

/** Local `export { original as view }` keeps the local function reachable through its public name. */
export const exportedAliases = (program: Node) => nodes(field(program, "body")).flatMap((statement) => {
  if (statement.type === "ExportDefaultDeclaration") {
    const original = id(child(statement, "declaration")) ?? id(child(child(statement, "declaration"), "id"))
    return (original && [{ original, alias: "default" }]) || []
  }
  if (statement.type !== "ExportNamedDeclaration" || child(statement, "source")) return []
  return nodes(field(statement, "specifiers"))
    .filter((spec) => field(spec, "exportKind") !== "type")
    .map((spec) => ({ original: symbolOf(spec, "local"), alias: symbolOf(spec, "exported") }))
})
