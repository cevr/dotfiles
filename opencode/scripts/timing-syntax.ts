import { Option, type Path, Schema } from "effect"
import { type BindingIdentifier, type CallExpression, type Expression, type ParamPattern, parseSync, Visitor } from "oxc-parser"

export type Program = ReturnType<typeof parseSync>["program"]
export type Statement = Program["body"][number]
type Argument = CallExpression["arguments"][number]
export type TimingResolver = (file: string, specifier: string) => Option.Option<string>

const runtimeExpression = (node: Expression): Expression => {
  switch (node.type) {
    case "TSAsExpression":
    case "TSTypeAssertion":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
    case "ParenthesizedExpression":
      return runtimeExpression(node.expression)
    default:
      return node
  }
}

/** The ECMAScript forms with a static module string, with escapes already cooked. */
export const moduleText = (argument?: Argument): Option.Option<string> => {
  if (!argument || argument.type === "SpreadElement") return Option.none()
  const node = runtimeExpression(argument)
  if (node.type === "Literal" && Schema.is(Schema.String)(node.value)) return Option.some(node.value)
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return Option.fromNullishOr(node.quasis[0]?.value.cooked)
  return Option.none()
}

export const sourceFile = (file: string) => /\.[cm]?[jt]sx?$/.test(file)
// Bun's on-disk test suffixes, including both separators and ESM/CJS extensions.
const discoveredTest = (file: string) => /[._](?:test|spec)\.(?:[jt]sx?|[cm][jt]s)$/.test(file)
export const testFile = (file: string) =>
  discoveredTest(file) || /\.fixture\.[cm]?[jt]sx?$/.test(file) ||
  /^(?:opencode\/(?:tests|scenarios|testbeds|sim|sim-tui)\/|workbox\/test\/)/.test(file) ||
  /\/(?:fake-[^/]+|(?:[^/]+[.-])?laws|fixture|test-(?:support|helper|util)s?)\.[cm]?[jt]sx?$/.test(file)

const resolveBun = Option.liftThrowable((specifier: string, directory: string) => Bun.resolveSync(specifier, directory))
const localSpecifier = (specifier: string) => /^(?:\.{1,2}(?:\/|$)|\/|file:)/.test(specifier)

/** Bun decides whether and where a name resolves; preserve external package identities. */
export const timingResolver = (path: Path.Path, root: string): TimingResolver => {
  const cache = new Map<string, Option.Option<string>>()
  return (file, specifier) => {
    const directory = path.dirname(path.join(root, file))
    const key = `${directory}\0${specifier}`
    return Option.getOrElse(Option.fromUndefinedOr(cache.get(key)), () => {
      const found = Option.map(resolveBun(specifier, directory), (target) => {
        if (!path.isAbsolute(target) || target.includes("/node_modules/")) return specifier
        // An import query distinguishes Bun module instances, not source files.
        const query = target.indexOf("?")
        if (query === -1) return path.relative(root, target)
        return path.relative(root, target.slice(0, query))
      })
      cache.set(key, found)
      return found
    })
  }
}

const staticSources = (program: Program) => program.body.flatMap((node) => {
  if (node.type === "ImportDeclaration") return [node.source]
  if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source)
    return [node.source]
  return []
})

/** Use runner-discovered test roots and explicitly designated test-support roots.
 * Follow every local static edge, including export-from, with no filename test
 * on descendants. Other reached files receive only the producer rules. */
export const timingSources = (texts: ReadonlyMap<string, string>, resolve: TimingResolver) => {
  const queue = [...texts.keys()].filter((file) => /^(?:opencode\/|workbox\/test\/)/.test(file) && testFile(file))
  const visited = new Set(queue)
  const files = new Map<string, { readonly program: Program; readonly producerOnly: boolean; readonly missing: ReadonlyArray<Span> }>()
  for (const file of queue) {
    const read = Option.fromUndefinedOr(texts.get(file))
    if (Option.isNone(read)) continue
    const source = read.value
    const program = parseSync(file, source).program
    const missing: Array<Span> = []
    files.set(file, { program, producerOnly: !testFile(file), missing })
    for (const specifier of staticSources(program)) {
      const target = resolve(file, specifier.value)
      if (!localSpecifier(specifier.value)) continue
      if (Option.isNone(target)) missing.push(specifier)
      else if (texts.has(target.value) && !visited.has(target.value)) {
        visited.add(target.value)
        queue.push(target.value)
      }
    }
  }
  return files
}

const arrayElements = (node: Expression): boolean => {
  const value = runtimeExpression(node)
  return value.type === "ArrayExpression" && value.elements.some((item) => item?.type !== "SpreadElement")
}

const readonlyTuple = (node: Expression): boolean => {
  if (node.type === "ParenthesizedExpression") return readonlyTuple(node.expression)
  if (node.type !== "TSAsExpression") return false
  const type = node.typeAnnotation
  return type.type === "TSTypeReference" && type.typeName.type === "Identifier" && type.typeName.name === "const" &&
    node.expression.type === "ArrayExpression" && arrayElements(node.expression)
}

const keepsReadonly = (binding: BindingIdentifier) => {
  const annotation = binding.typeAnnotation?.typeAnnotation
  return !annotation || annotation.type === "TSTypeOperator" && annotation.operator === "readonly" && annotation.typeAnnotation.type === "TSTupleType"
}

type Span = { readonly start: number; readonly end: number }
const contains = (span: Span, node: Span) => span.start <= node.start && node.end <= span.end
const boundNames = (pattern: ParamPattern): ReadonlyArray<string> => {
  switch (pattern.type) {
    case "Identifier": return [pattern.name]
    case "AssignmentPattern": return boundNames(pattern.left)
    case "RestElement": return boundNames(pattern.argument)
    case "TSParameterProperty": return boundNames(pattern.parameter)
    case "ObjectPattern":
      return pattern.properties.flatMap((field) => {
        if (field.type === "RestElement") return boundNames(field.argument)
        return boundNames(field.value)
      })
    case "ArrayPattern": return pattern.elements.flatMap((field) => Option.match(Option.fromNullishOr(field), { onSome: boundNames, onNone: () => [] }))
  }
}
interface Scope { readonly span: Span; readonly functionLevel: boolean }
interface Declared { readonly declaring: Span; readonly scope: Span; readonly nonempty: boolean }

/** A spread is evidence only if the array is inline or a readonly local tuple.
 * A plain const array can lose elements even though the binding cannot change. */
export const calendarArgument = (program: Program) => {
  const bindings = new Map<string, Array<Declared>>()
  const scopes: Array<Scope> = [{ span: program, functionLevel: true }]
  const scoped = (functionOnly = false) => Option.getOrElse(
    Option.fromUndefinedOr(scopes.findLast(({ functionLevel }) => !functionOnly || functionLevel)), () => ({ span: program, functionLevel: true }),
  ).span
  const note = (pattern: ParamPattern, declaring: Span = pattern, scope = scoped(), nonempty = false) => {
    for (const name of boundNames(pattern)) {
      const declarations = Option.getOrElse(Option.fromUndefinedOr(bindings.get(name)), (): Array<Declared> => [])
      declarations.push({ declaring, scope, nonempty })
      bindings.set(name, declarations)
    }
  }
  const enter = (span: Span) => { scopes.push({ span, functionLevel: false }) }
  const enterFn = (node: Span & { readonly params: ReadonlyArray<ParamPattern> }) => {
    scopes.push({ span: node, functionLevel: true })
    for (const param of node.params) note(param)
  }
  const leave = () => { scopes.pop() }
  new Visitor({
    BlockStatement: enter, "BlockStatement:exit": leave,
    ForStatement: enter, "ForStatement:exit": leave,
    ForOfStatement: enter, "ForOfStatement:exit": leave,
    ForInStatement: enter, "ForInStatement:exit": leave,
    StaticBlock: enter, "StaticBlock:exit": leave,
    SwitchStatement: enter, "SwitchStatement:exit": leave,
    ImportDeclaration(node) { for (const spec of node.specifiers) note(spec.local) },
    FunctionDeclaration(node) { if (node.id) note(node.id); enterFn(node) },
    "FunctionDeclaration:exit": leave,
    FunctionExpression(node) { enterFn(node); if (node.id) note(node.id) },
    "FunctionExpression:exit": leave,
    ArrowFunctionExpression: enterFn, "ArrowFunctionExpression:exit": leave,
    CatchClause(node) { enter(node); if (node.param) note(node.param) },
    "CatchClause:exit": leave,
    ClassDeclaration(node) { if (node.id) note(node.id) },
    ClassExpression(node) { enter(node); if (node.id) note(node.id) },
    "ClassExpression:exit": leave,
    VariableDeclaration(node) {
      const scope = scoped(node.kind === "var")
      for (const { id, init } of node.declarations) {
        const nonempty = node.kind === "const" && id.type === "Identifier" && keepsReadonly(id) && Boolean(init && readonlyTuple(init))
        note(id, node, scope, nonempty)
      }
    },
  }).visit(program)
  return (node: Argument) => {
    if (node.type !== "SpreadElement") return true
    const value = runtimeExpression(node.argument)
    if (arrayElements(value)) return true
    if (value.type !== "Identifier") return false
    const local = Option.getOrElse(Option.fromUndefinedOr(bindings.get(value.name)), () => []).filter(({ scope }) => contains(scope, value))
    const closest = local.toSorted((a, b) => (a.scope.end - a.scope.start) - (b.scope.end - b.scope.start))
    return Option.exists(Option.fromUndefinedOr(closest[0]), ({ nonempty, declaring }) => nonempty && declaring.end <= value.start)
  }
}
