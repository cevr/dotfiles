import { Glob } from "bun"
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type BindingIdentifier, type CallExpression, type Expression, type ParamPattern, parseSync, Visitor } from "oxc-parser"

export type Program = ReturnType<typeof parseSync>["program"]
export type Statement = Program["body"][number]
type Argument = CallExpression["arguments"][number]
export interface TimingResolver {
  (file: string, specifier: string): Option.Option<string>
  readonly edge: (file: string, specifier: string) => Option.Option<Resolution>
  readonly intendsLocal: (file: string, specifier: string) => boolean
}
interface Resolution { readonly module: string; readonly repoFile: Option.Option<string> }

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
const Config = Schema.Struct({
  compilerOptions: Schema.optionalKey(Schema.Struct({ paths: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))) })),
  extends: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
})
const Manifest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  workspaces: Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.Struct({ packages: Schema.Array(Schema.String) })])),
})
const decodeConfig = Option.liftThrowable((text: string) => Schema.decodeUnknownSync(Config)(Bun.JSONC.parse(text)))
const decodeManifest = Option.liftThrowable((text: string) => Schema.decodeUnknownSync(Manifest)(Bun.JSONC.parse(text)))

const excludesDependencies = (file: string) => !file.split("/").includes("node_modules")
export const readTimingInputs = (root: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, forceKillAfter: "3 seconds" }))
  const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString)
  const status = Number(yield* child.exitCode)
  if (status !== 0) return yield* Effect.die(`git ls-files failed (${status}) in ${root}`)
  const files = [...new Set(output.split("\0"))].filter(excludesDependencies)
  const read = (files: ReadonlyArray<string>) => Effect.forEach(files, (file) => {
    const absolute = path.join(root, file)
    return Effect.map(Effect.when(fs.readFileString(absolute), fs.exists(absolute)), Option.map((text) => [file, text] as const))
  }).pipe(Effect.map((rows) => new Map(rows.flatMap(Option.toArray))))
  const texts = yield* read(files.filter(sourceFile))
  // A tsconfig can extend a JSON file of any name.
  const metadata = yield* read(files.filter((file) => file.endsWith(".json")))
  return { texts, metadata }
})

const nearest = <A>(path: Path.Path, inputs: ReadonlyMap<string, A>, directory: string): Option.Option<A> => {
  for (let at = directory; ; at = path.dirname(at)) {
    const found = Option.fromUndefinedOr(inputs.get(at))
    if (Option.isSome(found) || at === ".") return found
  }
}

const patternMatches = (pattern: string, name: string) => {
  const wildcard = pattern.indexOf("*")
  if (wildcard < 0) return pattern === name
  return name.length >= pattern.length - 1 && name.startsWith(pattern.slice(0, wildcard)) && name.endsWith(pattern.slice(wildcard + 1))
}

const importConfigs = (path: Path.Path, metadata: ReadonlyMap<string, string>) => {
  const configs = new Map<string, typeof Config.Type>()
  const manifests = new Map<string, typeof Manifest.Type>()
  for (const [file, text] of metadata) {
    if (path.basename(file) === "package.json") {
      for (const data of Option.toArray(decodeManifest(text))) manifests.set(path.dirname(file), data)
    } else {
      for (const data of Option.toArray(decodeConfig(text))) configs.set(file, data)
    }
  }
  return { configs, manifests }
}

const aliasPatterns = (path: Path.Path, root: string, configs: ReadonlyMap<string, typeof Config.Type>) => {
  const pathsFrom = (file: string, seen: Set<string>): ReadonlyArray<string> => {
    if (seen.has(file)) return []
    seen.add(file)
    const config = configs.get(file)
    if (!config) return []
    if (config.compilerOptions?.paths) return Object.keys(config.compilerOptions.paths)
    const parents = config.extends ?? []
    if (Schema.is(Schema.String)(parents)) return inherited(file, parents, seen)
    return parents.flatMap((parent) => inherited(file, parent, seen))
  }
  const inherited = (file: string, parent: string, seen: Set<string>) => {
    const from = path.dirname(path.join(root, file))
    return Option.match(resolveBun(parent, from), {
      onNone: () => [], onSome: (target) => pathsFrom(path.relative(root, target), seen),
    })
  }
  const aliases = new Map<string, ReadonlyArray<string>>()
  for (const file of configs.keys()) if (path.basename(file) === "tsconfig.json")
    aliases.set(path.dirname(file), pathsFrom(file, new Set()))
  return aliases
}

const workspaceNames = (path: Path.Path, manifests: ReadonlyMap<string, typeof Manifest.Type>) => {
  const workspaces = new Set<string>()
  for (const [directory, manifest] of manifests) {
    const configured = manifest.workspaces
    if (!configured) continue
    const patterns = () => {
      if (Schema.is(Schema.Array(Schema.String))(configured)) return configured
      return configured.packages
    }
    const includes = patterns().map((glob) => new Glob(glob))
    for (const [candidate, pkg] of manifests) {
      const relative = path.relative(directory, candidate)
      if (pkg.name && !relative.startsWith("..") && includes.some((glob) => glob.match(relative))) workspaces.add(pkg.name)
    }
  }
  return [...workspaces]
}

/** Missing edges need a local-intent diagnosis. These inputs never decide whether a successful edge is followed. */
const resolutionIntent = (path: Path.Path, root: string, metadata: ReadonlyMap<string, string>) => {
  const { configs, manifests } = importConfigs(path, metadata)
  const aliases = aliasPatterns(path, root, configs)
  const workspaces = workspaceNames(path, manifests)
  const packageMatches = (name: string, specifier: string) => specifier === name || specifier.startsWith(`${name}/`)
  return (file: string, specifier: string) => {
    if (/^(?:\.{1,2}(?:\/|$)|\/|file:)/.test(specifier)) return true
    const directory = path.dirname(file)
    if (Option.exists(nearest(path, aliases, directory), (keys) => keys.some((key) => patternMatches(key, specifier)))) return true
    if (Option.exists(nearest(path, manifests, directory), ({ name }) => Boolean(name && packageMatches(name, specifier)))) return true
    return workspaces.some((name) => packageMatches(name, specifier))
  }
}

const repositoryPath = (path: Path.Path, root: string, target: string) => {
  if (!path.isAbsolute(target) || !excludesDependencies(target)) return Option.none()
  // An import query distinguishes Bun module instances, not source files.
  const file = path.relative(root, target.split("?")[0] ?? target)
  if (file === ".." || file.startsWith("../")) return Option.none()
  return Option.some(file)
}

/** Bun decides whether and where a name resolves; preserve external package identities. */
export const timingResolver = (path: Path.Path, root: string, metadata: ReadonlyMap<string, string> = new Map()): TimingResolver => {
  const cache = new Map<string, Option.Option<Resolution>>()
  const edge = (file: string, specifier: string) => {
    const directory = path.dirname(path.join(root, file))
    const key = `${directory}\0${specifier}`
    return Option.getOrElse(Option.fromUndefinedOr(cache.get(key)), () => {
      const found = Option.map(resolveBun(specifier, directory), (target) => {
        const repoFile = repositoryPath(path, root, target)
        return { module: Option.getOrElse(repoFile, () => specifier), repoFile }
      })
      cache.set(key, found)
      return found
    })
  }
  const resolve = (file: string, specifier: string) => Option.map(edge(file, specifier), ({ module }) => module)
  return Object.assign(resolve, { edge, intendsLocal: resolutionIntent(path, root, metadata) })
}

const scanners = {
  js: new Bun.Transpiler({ loader: "js" }),
  jsx: new Bun.Transpiler({ loader: "jsx" }),
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
}
const runtimeImports = (file: string, text: string) => {
  if (/\.d\.[cm]?ts$/.test(file)) return []
  // The runner accepts executable files; the standalone scan API expects only the module body.
  const body = text.replace(/^#![^\r\n]*/, "")
  if (file.endsWith(".tsx")) return scanners.tsx.scanImports(body)
  if (file.endsWith(".jsx")) return scanners.jsx.scanImports(body)
  if (/[cm]?ts$/.test(file)) return scanners.ts.scanImports(body)
  return scanners.js.scanImports(body)
}

const runtimeEdges = (file: string, source: string, resolve: TimingResolver) => {
  const targets: Array<string> = []
  const missing: Array<Span> = []
  for (const { path: specifier, kind } of runtimeImports(file, source)) {
    if (kind !== "import-statement" && kind !== "require-call" && kind !== "dynamic-import") continue
    const edge = resolve.edge(file, specifier)
    if (Option.isSome(edge)) targets.push(...Option.toArray(edge.value.repoFile))
    else if (resolve.intendsLocal(file, specifier)) {
      // Bun's scanner returns module names, not source positions.
      const start = Math.max(0, source.indexOf(specifier))
      missing.push({ start, end: start + specifier.length })
    }
  }
  return { targets, missing }
}

/** Use runner-discovered test roots and explicitly designated test-support roots.
 * Bun scans the runtime edges and resolves their targets. Follow candidates
 * inside this repository that Git would see (tracked plus non-ignored untracked),
 * outside node_modules. Other reached files receive only the producer rules. */
export const timingSources = (texts: ReadonlyMap<string, string>, resolve: TimingResolver) => {
  const queue = [...texts.keys()].filter((file) => /^(?:opencode\/|workbox\/test\/)/.test(file) && testFile(file))
  const visited = new Set(queue)
  const files = new Map<string, { readonly program: Program; readonly producerOnly: boolean; readonly missing: ReadonlyArray<Span> }>()
  for (const file of queue) {
    const read = Option.fromUndefinedOr(texts.get(file))
    if (Option.isNone(read)) continue
    const source = read.value
    const program = parseSync(file, source).program
    const { targets, missing } = runtimeEdges(file, source, resolve)
    files.set(file, { program, producerOnly: !testFile(file), missing })
    for (const target of targets) {
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
