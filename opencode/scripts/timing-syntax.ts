import { Option, Schema } from "effect"
import { type CallExpression, type Expression, type ParamPattern, parseSync, Visitor } from "oxc-parser"

export type Program = ReturnType<typeof parseSync>["program"]
export type Statement = Program["body"][number]
type Argument = CallExpression["arguments"][number]
type Resolve = (file: string, specifier: string) => string

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

const extensions = [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs", ".cts", ".cjs"]
export const relativeTimingTarget = (file: string, specifier: string, exists: (file: string) => boolean) => {
  const path = new URL(specifier, `file:///${file}`).pathname.slice(1)
  const candidates = [path, path.replace(/\.[cm]?jsx?$/, ".ts"), path.replace(/\.jsx$/, ".tsx"),
    ...extensions.map((extension) => path + extension), ...extensions.map((extension) => `${path}/index${extension}`)]
  return Option.getOrElse(Option.fromUndefinedOr(candidates.find(exists)), () => path)
}

const staticSources = (program: Program) => program.body.flatMap((node) => {
  if (node.type === "ImportDeclaration" && node.importKind !== "type") return [node.source.value]
  if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source && node.exportKind !== "type")
    return [node.source.value]
  return []
})

/** Use runner-discovered test roots and explicitly designated test-support roots.
 * Follow every local static edge, including export-from, with no filename test
 * on descendants. Other reached files receive only the producer rules. */
export const timingSources = (texts: ReadonlyMap<string, string>, resolve: Resolve) => {
  const queue = [...texts.keys()].filter((file) => /^(?:opencode\/|workbox\/test\/)/.test(file) && testFile(file))
  const visited = new Set(queue)
  const files = new Map<string, { readonly source: string; readonly program: Program; readonly producerOnly: boolean }>()
  for (const file of queue) {
    const read = Option.fromUndefinedOr(texts.get(file))
    if (Option.isNone(read)) continue
    const source = read.value
    const program = parseSync(file, source).program
    files.set(file, { source, program, producerOnly: !testFile(file) })
    for (const specifier of staticSources(program)) {
      const target = resolve(file, specifier)
      if (!texts.has(target) || visited.has(target)) continue
      visited.add(target)
      queue.push(target)
    }
  }
  return files
}

const arrayElements = (node: Expression): boolean => {
  const value = runtimeExpression(node)
  return value.type === "ArrayExpression" && value.elements.some((item) => item?.type !== "SpreadElement")
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

/** This is evidence about nonemptiness, not evaluation: imported/computed
 * values and ambiguous bindings never prove that Date has an argument. */
export const dateArguments = (program: Program) => {
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
        const nonempty = node.kind === "const" && id.type === "Identifier" && Boolean(init && arrayElements(init))
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
