import { Option, Schema } from "effect"
import { type CallExpression, type Expression, type ParamPattern, Visitor } from "oxc-parser"
import { boundNames, isRequire, moduleText, type Program, type TimingResolver } from "./timing-syntax.ts"

type Span = { readonly start: number; readonly end: number }
type Origin =
  | { readonly kind: "module"; readonly from: string; readonly exported: string }
  | { readonly kind: "value"; readonly expression: Expression; readonly members: ReadonlyArray<string> }
  | { readonly kind: "body"; readonly span: Span }
  | { readonly kind: "shadow" }
interface Bound { readonly scope: Span; readonly origin: Origin }
interface File {
  readonly names: Map<string, Array<Bound>>
  readonly exports: Map<string, Origin>
  readonly stars: Array<string>
  readonly calls: Array<{ readonly at: Span; readonly callee: Expression }>
  readonly deferred: Array<Span>
}

const contains = (outer: Span, inner: Span) => outer.start <= inner.start && inner.end <= outer.end
const width = (span: Span) => span.end - span.start
const attribute = (node: { readonly type: string }): string => {
  if ("name" in node && Schema.is(Schema.String)(node.name)) return node.name
  if ("value" in node && Schema.is(Schema.String)(node.value)) return node.value
  return ""
}
const own = (expression: Expression, members: ReadonlyArray<string> = []): Origin => ({ kind: "value", expression, members })
const source = (from: string, exported: string): Origin => ({ kind: "module", from, exported })
const shadow: Origin = { kind: "shadow" }

const nodeProcess = new Set(["exec", "execSync", "execFile", "execFileSync", "fork", "spawn", "spawnSync"])
const bunProcess = new Set(["spawn", "spawnSync", "$"])
const spawnerProcess = new Set(["spawn", "string", "lines", "stream", "streamLines", "exitCode"])
const primitive = (module: string, names: ReadonlyArray<string>) => {
  const [root = "", member = ""] = names
  if (module === "bun") return names.length === 1 && bunProcess.has(root)
  if (module === "node:child_process" || module === "child_process") return names.length === 1 && nodeProcess.has(root)
  if (module === "effect/process" || module === "effect/unstable/process")
    return root === "ChildProcessSpawner" && member === "ChildProcessSpawner" && names.length === 3 && spawnerProcess.has(names[2] ?? "")
  if (module === "effect/process/ChildProcessSpawner" || module === "effect/unstable/process/ChildProcessSpawner")
    return root === "ChildProcessSpawner" && names.length === 2 && spawnerProcess.has(member)
  return false
}

const imported = (node: Extract<Program["body"][number], { type: "ImportDeclaration" }>, bind: (name: string, origin: Origin) => void) => {
  if (node.importKind === "type") return
  for (const spec of node.specifiers) {
    if (spec.type === "ImportSpecifier") {
      if (spec.importKind !== "type") bind(spec.local.name, source(node.source.value, attribute(spec.imported)))
    } else if (spec.type === "ImportDefaultSpecifier") bind(spec.local.name, source(node.source.value, "default"))
    else bind(spec.local.name, source(node.source.value, "*"))
  }
}

const exportsOf = (file: File, program: Program) => {
  // Resolve local exports in module scope, not at the call site's scope.
  const local = (name: string) => Option.fromUndefinedOr(file.names.get(name)?.filter(({ scope }) => scope === program).at(-1)?.origin)
  const expose = (name: string, exported = name) => {
    for (const origin of Option.toArray(local(name))) file.exports.set(exported, origin)
  }
  const named = (node: Extract<Program["body"][number], { type: "ExportNamedDeclaration" }>) => {
    if (node.exportKind === "type") return
    if (node.declaration?.type === "FunctionDeclaration" && node.declaration.id) expose(node.declaration.id.name)
    if (node.declaration?.type === "VariableDeclaration")
      for (const { id } of node.declaration.declarations) for (const name of boundNames(id)) expose(name)
    for (const spec of node.specifiers) {
      if (spec.exportKind === "type") continue
      if (node.source) file.exports.set(attribute(spec.exported), source(node.source.value, attribute(spec.local)))
      else expose(attribute(spec.local), attribute(spec.exported))
    }
  }
  for (const node of program.body) {
    if (node.type === "ExportAllDeclaration" && node.exportKind !== "type") {
      if (node.exported) file.exports.set(attribute(node.exported), source(node.source.value, "*"))
      else file.stars.push(node.source.value)
    }
    if (node.type === "ExportDefaultDeclaration") {
      if (node.declaration.type === "Identifier") expose(node.declaration.name, "default")
      else if (node.declaration.type === "ObjectExpression") file.exports.set("default", own(node.declaration))
      else file.exports.set("default", { kind: "body", span: node.declaration })
    }
    if (node.type === "ExportNamedDeclaration") named(node)
  }
}

const indexFile = (program: Program): File => {
  const file: File = { names: new Map(), exports: new Map(), stars: [], calls: [], deferred: [] }
  const scopes: Array<{ readonly span: Span; readonly fn: boolean }> = [{ span: program, fn: true }]
  const scope = (functionOnly: boolean) => scopes.findLast(({ fn }) => !functionOnly || fn)?.span ?? program
  const bind = (name: string, origin: Origin, fn = false) => {
    const list = file.names.get(name) ?? []
    list.push({ scope: scope(fn), origin })
    file.names.set(name, list)
  }
  const pattern = (node: ParamPattern, origin: Origin, fn = false) => {
    if (node.type === "ObjectPattern" && origin.kind === "value") {
      for (const prop of node.properties) {
        if (prop.type === "Property") pattern(prop.value, own(origin.expression, [...origin.members, attribute(prop.key)]), fn)
        else pattern(prop.argument, shadow, fn)
      }
    } else for (const name of boundNames(node)) bind(name, origin, fn)
  }
  const enter = (span: Span) => { scopes.push({ span, fn: false }) }
  const enterFn = (span: Span & { readonly params: ReadonlyArray<ParamPattern> }) => {
    scopes.push({ span, fn: true })
    for (const param of span.params) pattern(param, shadow)
  }
  const leave = () => { scopes.pop() }
  new Visitor({
    BlockStatement: enter, "BlockStatement:exit": leave,
    ForStatement: enter, "ForStatement:exit": leave,
    ForOfStatement: enter, "ForOfStatement:exit": leave,
    ForInStatement: enter, "ForInStatement:exit": leave,
    SwitchStatement: enter, "SwitchStatement:exit": leave,
    CatchClause(node) { enter(node); if (node.param) pattern(node.param, shadow) },
    "CatchClause:exit": leave,
    FunctionDeclaration(node) {
      if (node.id) bind(node.id.name, { kind: "body", span: node })
      file.deferred.push(node)
      enterFn(node)
    },
    "FunctionDeclaration:exit": leave,
    FunctionExpression(node) { enterFn(node); if (node.id) bind(node.id.name, { kind: "body", span: node }) },
    "FunctionExpression:exit": leave,
    ArrowFunctionExpression: enterFn, "ArrowFunctionExpression:exit": leave,
    ImportDeclaration(node) { imported(node, bind) },
    TSImportEqualsDeclaration(node) {
      if (node.importKind !== "type" && node.moduleReference.type === "TSExternalModuleReference")
        bind(node.id.name, source(node.moduleReference.expression.value, "*"))
    },
    VariableDeclaration(node) {
      for (const { id, init } of node.declarations) {
        if (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression") file.deferred.push(init)
        if (init) pattern(id, own(init), node.kind === "var")
        else pattern(id, shadow, node.kind === "var")
      }
    },
    CallExpression(node) { file.calls.push({ at: node, callee: node.callee }) },
    TaggedTemplateExpression(node) { file.calls.push({ at: node, callee: node.tag }) },
  }).visit(program)
  exportsOf(file, program)
  return file
}

const localOrigin = (file: File, name: string, at: Span) =>
  Option.fromUndefinedOr(file.names.get(name)?.filter(({ scope }) => contains(scope, at)).toSorted((a, b) => width(a.scope) - width(b.scope))[0]?.origin)

/** Conservative bound call graph: follow called local/selected-export helpers
 * to a real launcher, not strings called `spawn` or unrelated `.exec` methods.
 * Callback bodies (including Effect generators) may run under the outer test. */
export const processGraph = (programs: ReadonlyMap<string, { readonly program: Program }>, resolve: TimingResolver) => {
  const indexes = new Map<string, File>()
  const index = (file: string) => Option.getOrElse(Option.fromUndefinedOr(indexes.get(file)), () => {
    const program = programs.get(file)?.program
    if (!program) return { names: new Map(), exports: new Map(), stars: [], calls: [], deferred: [] }
    const found = indexFile(program)
    indexes.set(file, found)
    return found
  })
  type Seen = Set<string>
  const exportsProcess = (file: string, name: string, members: ReadonlyArray<string>, seen: Seen): boolean => {
    const key = `${file}\0${name}\0${members.join(".")}`
    if (seen.has(key) || !programs.has(file)) return false
    seen.add(key)
    const indexed = index(file)
    return Option.match(Option.fromUndefinedOr(indexed.exports.get(name)), {
      onSome: (binding) => callsProcess(file, binding, members, seen),
      onNone: () => indexed.stars.some((module) => moduleProcess(file, module, [name, ...members], seen)),
    })
  }
  const moduleProcess = (file: string, module: string, names: ReadonlyArray<string>, seen: Seen): boolean => {
    if (primitive(module, names)) return true
    const [name, ...members] = names
    if (!name) return false
    return Option.exists(resolve.edge(file, module), ({ repoFiles }) => repoFiles.some((target) => exportsProcess(target, name, members, seen)))
  }
  const callsProcess = (file: string, origin: Origin, members: ReadonlyArray<string>, seen: Seen): boolean => {
    switch (origin.kind) {
      case "module": {
        if (origin.exported === "*") return moduleProcess(file, origin.from, members, seen)
        if (origin.exported === "default" && primitive(origin.from, members)) return true
        return moduleProcess(file, origin.from, [origin.exported, ...members], seen)
      }
      case "value": return expressionProcess(file, origin.expression, [...origin.members, ...members], seen)
      case "body": return members.length === 0 && spanProcess(file, origin.span, seen)
      case "shadow": return false
    }
  }
  const expressionProcess = (file: string, expression: Expression, members: ReadonlyArray<string>, seen: Seen): boolean => {
    const key = `${file}\0${expression.start}:${expression.end}\0${members.join(".")}`
    if (seen.has(key)) return false
    seen.add(key)
    switch (expression.type) {
      case "Identifier":
        return Option.match(localOrigin(index(file), expression.name, expression), {
          onSome: (origin) => callsProcess(file, origin, members, seen),
          onNone: () => expression.name === "Bun" && primitive("bun", members),
        })
      case "MemberExpression":
        return expression.object.type !== "Super" && expression.property.type !== "PrivateIdentifier" &&
          expressionProcess(file, expression.object, [attribute(expression.property), ...members], seen)
      case "YieldExpression":
        return Boolean(expression.argument && expressionProcess(file, expression.argument, members, seen))
      case "AwaitExpression":
        return expressionProcess(file, expression.argument, members, seen)
      case "TSAsExpression":
      case "TSNonNullExpression":
      case "ParenthesizedExpression":
        return expressionProcess(file, expression.expression, members, seen)
      case "CallExpression":
        if (isRequire(expression.callee))
          return Option.exists(moduleText(expression.arguments[0]), (module) => moduleProcess(file, module, members, seen))
        return spanProcess(file, expression, seen)
      case "ImportExpression":
        return Option.exists(moduleText(expression.source), (module) => moduleProcess(file, module, members, seen))
      case "ObjectExpression": {
        const [member, ...rest] = members
        if (!member) return false
        return expression.properties.some((prop) => prop.type === "Property" && attribute(prop.key) === member &&
          expressionProcess(file, prop.value, rest, seen))
      }
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        return members.length === 0 && Boolean(expression.body && spanProcess(file, expression.body, seen))
      default: return false
    }
  }
  const spanProcess = (file: string, span: Span, seen: Seen): boolean => {
    const key = `${file}\0${span.start}:${span.end}`
    if (seen.has(key)) return false
    seen.add(key)
    const indexed = index(file)
    const deferred = indexed.deferred.filter((scope) => width(span) > width(scope) && contains(span, scope))
    return indexed.calls.some(({ at, callee }) => contains(span, at) && !deferred.some((scope) => contains(scope, at)) &&
      expressionProcess(file, callee, [], seen))
  }
  return (file: string, body: CallExpression["arguments"][number]): boolean =>
    body.type !== "SpreadElement" && expressionProcess(file, body, [], new Set())
}
