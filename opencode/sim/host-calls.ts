// The host calls a file makes: each call to an operation of OpenCode's plugin
// context (`Plugin.Context`, the fork's packages/plugin/src/effect/plugin.ts),
// with the arguments it passes, read through the compiler's types. Used by
// host-calls.test.ts to hold every argument the world's plugins pass to the
// host to one a host law passes too, so the world cannot drift from the real
// host on an argument no law runs on both.
//
// The compiler is TypeScript's own (tsgo, through `typescript/unstable/async`),
// on sim/tsconfig.json: its program is the module graph the world loads, so the
// files it holds are the world's plugins and the laws. Reading types, not text,
// is what sees an argument a spread carries (wake's `{ ...input }` passes
// `delivery`), a call through a narrowed view of the context (idle compaction's
// `Reads`), and a hook name or event type passed through a constant.
//
// A host call is `receiver.op(...)` where some domain of the context (the
// context itself, its domains and their sub-domains) has `op` and could be the
// receiver: the domain's type is assignable to the receiver's. An argument's
// facts are what the host's own declared parameter names:
// - each field of an object argument the parameter declares, by its path
//   (`location.directory`), callbacks aside;
// - where the parameter declares a choice of literals (a hook's name, an event
//   type, `order`, `reason`, `resume`, `delivery`), each value passed, as
//   `reason="auto"`; a value the compiler cannot narrow to literals is `reason=?`;
// - any other argument by its position, `#0`.
import { Data, Effect, Option, Predicate, type Scope } from "effect"
import { API, type Checker, type Project, SignatureKind, type Type, TypeFlags } from "typescript/unstable/async"
import type { CallExpression, Node, SourceFile } from "typescript/unstable/ast"
import { isCallExpression, isInterfaceDeclaration, isPropertyAccessExpression } from "typescript/unstable/ast/is"

/** The compiler could not answer. */
export class ScanFailed extends Data.TaggedError("ScanFailed")<{ readonly message: string }> {}

/** One host call: the operation's path, where it is, and the facts of its arguments. */
export interface Call {
  readonly operation: string
  readonly file: string
  readonly line: number
  readonly facts: ReadonlyArray<string>
}

/** The host calls of a project's files: open it with `open`. */
export interface Scanner {
  /** The project's source files, absolute. */
  readonly files: ReadonlyArray<string>
  /** The host calls in `file` (absolute), in source order. */
  readonly calls: (file: string) => Effect.Effect<ReadonlyArray<Call>, ScanFailed>
}

/** A domain of the context: its path ("" for the context itself), its type, and its members' names. */
interface Domain {
  readonly path: string
  readonly type: Type
  readonly members: ReadonlySet<string>
}

/** The file declaring the plugin context, inside the fork. */
const CONTEXT_FILE = "packages/plugin/src/effect/plugin.ts"
/** How deep the context's domains go: `integration.connection` is a sub-domain. */
const DOMAIN_DEPTH = 2
/** How deep an argument's fields are read: `location.directory`, `model.id`. */
const FIELD_DEPTH = 2

const NULLISH = TypeFlags.Undefined | TypeFlags.Null | TypeFlags.Void

/** A compiler request, its failure a `ScanFailed` naming `what`. */
const ask = <A>(what: string, request: () => Promise<A>) =>
  Effect.tryPromise({ try: request, catch: (cause) => new ScanFailed({ message: `${what}: ${String(cause)}` }) })

/** A compiler answer that may be absent, as an Option. */
const maybe = <A>(what: string, request: () => Promise<A>) => ask(what, request).pipe(Effect.map(Option.fromUndefinedOr))

/** The value an Option holds, or a `ScanFailed` saying `message`. */
const present = <A>(found: Option.Option<A>, message: string) => Effect.fromOption(found).pipe(Effect.mapError(() => new ScanFailed({ message })))

/** Every call under `root`, depth first. */
const callsUnder = (root: SourceFile) => {
  const found: Array<CallExpression> = []
  const visit = (node: Node): void => {
    if (isCallExpression(node)) found.push(node)
    node.forEachChild((child) => void visit(child))
  }
  visit(root)
  return found
}

/** Reads the project of `config` (a tsconfig.json, absolute), started in `cwd`; the compiler closes with the scope. */
export const open = (config: string, cwd: string): Effect.Effect<Scanner, ScanFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const api = yield* Effect.acquireRelease(
      Effect.try({ try: () => new API({ cwd }), catch: (cause) => new ScanFailed({ message: `start the compiler: ${String(cause)}` }) }),
      (opened) => ask("close the compiler", () => opened.close()).pipe(Effect.ignore),
    )
    const snapshot = yield* ask("open the project", () => api.updateSnapshot({ openProjects: [config] }))
    const project = yield* present(Option.fromUndefinedOr(snapshot.getProject(config)), `no project for ${config}`)
    const files = yield* ask("list the files", () => project.program.getSourceFileNames())
    const domains = yield* domainsOf(project, files)
    return { files, calls: (file: string) => callsOf(project, domains, file) }
  })

/** A file of the project, parsed. */
const sourceOf = (project: Project, file: string) =>
  maybe(`read ${file}`, () => project.program.getSourceFile(file)).pipe(Effect.flatMap((found) => present(found, `the project has no file ${file}`)))

/** The context's domains: the context, each of its object-typed members, and theirs. */
const domainsOf = (project: Project, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const checker = project.checker
    const file = yield* present(Option.fromUndefinedOr(files.find((name) => name.endsWith(CONTEXT_FILE))), `the project does not reach the fork's ${CONTEXT_FILE}`)
    const source = yield* sourceOf(project, file)
    const declaration = yield* present(
      Option.fromUndefinedOr(source.statements.filter(isInterfaceDeclaration).find((statement) => statement.name.text === "Context")),
      `${file} declares no Context`,
    )
    const symbol = yield* maybe("the Context symbol", () => checker.getSymbolAtLocation(declaration.name)).pipe(
      Effect.flatMap((found) => present(found, "the Context name has no symbol")),
    )
    const context = yield* ask("the Context type", () => checker.getDeclaredTypeOfSymbol(symbol))
    const domains: Array<Domain> = []
    const add = (path: string, type: Type, depth: number): Effect.Effect<void, ScanFailed> =>
      Effect.gen(function* () {
        const members = yield* ask(`the members of ${path}`, () => checker.getPropertiesOfType(type))
        domains.push({ path, type, members: new Set(members.map((member) => member.name)) })
        if (depth === 0) return
        for (const member of members) {
          const inner = yield* maybe(`the type of ${member.name}`, () => checker.getTypeOfSymbol(member))
          if (Option.isNone(inner) || !(yield* isObject(checker, inner.value))) continue
          yield* add(joined(path, member.name), inner.value, depth - 1)
        }
      })
    yield* add("", context, DOMAIN_DEPTH)
    return domains
  })

const joined = (path: string, name: string) => [path, name].filter((part) => part !== "").join(".")

/** A union's or intersection's parts; a type of neither, none. */
const partsOf = (type: Type) => {
  if (type.isUnionType() || type.isIntersectionType()) return ask("a type's parts", () => type.getTypes())
  return Effect.succeed([])
}

/** An object type with members (an intersection of them too), not an array. */
const isObject = (checker: Checker, type: Type): Effect.Effect<boolean, ScanFailed> =>
  Effect.gen(function* () {
    if (type.isObjectType()) return !(yield* ask("array-like", () => checker.isArrayLikeType(type)))
    if (!type.isIntersectionType()) return false
    return (yield* partsOf(type)).every((part) => part.isObjectType())
  })

/** The type without `undefined` and `null`, and a type parameter as its constraint. */
const settled = (checker: Checker, type: Type): Effect.Effect<Type, ScanFailed> =>
  Effect.gen(function* () {
    const plain = Option.getOrElse(yield* maybe("non-nullable", () => checker.getNonNullableType(type)), () => type)
    if (!plain.isTypeParameter()) return plain
    const constraint = yield* maybe("a constraint", () => checker.getBaseConstraintOfType(plain))
    if (Option.isNone(constraint) || constraint.value.id === plain.id) return plain
    return yield* settled(checker, constraint.value)
  })

/** A literal as a fact writes it: a string quoted, a number or a boolean as it is. */
const valueOf = (value: string | number | boolean | bigint) => {
  if (Predicate.isString(value)) return `"${value}"`
  return String(value)
}

/** The literals a type is a choice of (an array's elements' for an array), or none when it is not one. */
const literalsOf = (checker: Checker, type: Type): Effect.Effect<Option.Option<ReadonlyArray<string>>, ScanFailed> =>
  Effect.gen(function* () {
    if (type.isLiteralType()) return Option.some([valueOf(type.value)])
    if (type.isTemplateLiteralType()) return Option.some([`\`${type.texts.join("${…}")}\``])
    if (type.isUnionType()) {
      const all: Array<string> = []
      for (const part of yield* partsOf(type)) {
        if ((part.flags & NULLISH) !== 0) continue
        const inner = yield* literalsOf(checker, part)
        if (Option.isNone(inner)) return Option.none()
        all.push(...inner.value)
      }
      return Option.some(all)
    }
    if (type.isTypeReference() && (yield* ask("array-like", () => checker.isArrayLikeType(type)))) {
      const elements = yield* ask("an array's element", () => checker.getTypeArguments(type))
      if (elements.length !== 1) return Option.none()
      return yield* literalsOf(checker, yield* settled(checker, elements[0]))
    }
    return Option.none()
  })

/** Whether a value of the type can be called: a callback, which is the plugin's code, not an argument's shape. */
const isCallable = (checker: Checker, type: Type) =>
  ask("call signatures", () => checker.getSignaturesOfType(type, SignatureKind.Call)).pipe(Effect.map((all) => all.length > 0))

/** A field's path under an argument: its own name at the top (under `#0`), the parent's then its own below. */
const fieldPath = (label: string, name: string) => {
  if (label.startsWith("#")) return name
  return `${label}.${name}`
}

/** The facts of an argument of type `passed` where the host declares `declared`, under `label`. */
const factsOf = (checker: Checker, passed: Type, declared: Option.Option<Type>, label: string, depth: number): Effect.Effect<ReadonlyArray<string>, ScanFailed> =>
  Effect.gen(function* () {
    if (yield* isCallable(checker, passed)) return []
    const choice = yield* literalsOf(checker, passed)
    // A union passed (`{ prefix } | { prefix, after }`) that is not a choice of literals: each part's facts.
    if (passed.isUnionType() && Option.isNone(choice)) {
      const parts = (yield* partsOf(passed)).filter((part) => (part.flags & NULLISH) === 0)
      const each = yield* Effect.forEach(parts, (part) => factsOf(checker, part, declared, label, depth))
      return [...new Set(each.flat())]
    }
    const host = yield* Effect.transposeOption(Option.map(declared, (type) => settled(checker, type)))
    if (Option.isNone(host)) return [label]
    if (Option.isSome(yield* literalsOf(checker, host.value))) return [label, ...Option.getOrElse(choice, () => ["?"]).map((value) => `${label}=${value}`)]
    if (depth === 0 || !(yield* isObject(checker, host.value)) || !(yield* isObject(checker, passed))) return [label]
    const fields = new Map((yield* ask("declared fields", () => checker.getPropertiesOfType(host.value))).map((field) => [field.name, field]))
    const facts: Array<string> = [label]
    for (const field of yield* ask("passed fields", () => checker.getPropertiesOfType(passed))) {
      const twin = Option.fromUndefinedOr(fields.get(field.name))
      if (Option.isNone(twin)) continue
      const type = yield* maybe(`the type of ${field.name}`, () => checker.getTypeOfSymbol(field))
      if (Option.isNone(type)) continue
      const twinType = yield* maybe(`the declared type of ${field.name}`, () => checker.getTypeOfSymbol(twin.value))
      facts.push(...(yield* factsOf(checker, type.value, twinType, fieldPath(label, field.name), depth - 1)))
    }
    return facts
  })

/** The 1-based line of `position` in `source`. */
const lineOf = (source: SourceFile, position: number) => source.text.slice(0, position).split("\n").length

/** The host calls in `file`. */
const callsOf = (project: Project, domains: ReadonlyArray<Domain>, file: string) =>
  Effect.gen(function* () {
    const checker = project.checker
    const source = yield* sourceOf(project, file)
    const found: Array<Call> = []
    for (const call of callsUnder(source)) {
      const callee = call.expression
      if (!isPropertyAccessExpression(callee)) continue
      const op = callee.name.text
      const candidates = domains.filter((domain) => domain.members.has(op))
      if (candidates.length === 0) continue
      const receiver = yield* maybe("a receiver's type", () => checker.getTypeAtLocation(callee.expression))
      // An `any` or `unknown` receiver could be anything: it is no evidence of the host.
      if (Option.isNone(receiver) || (receiver.value.flags & TypeFlags.AnyOrUnknown) !== 0) continue
      const domain = yield* Effect.findFirst(candidates, (candidate) => ask("assignable", () => checker.isTypeAssignableTo(candidate.type, receiver.value)))
      if (Option.isNone(domain)) continue
      // The host's own declaration (a generic's, not this call's instance), so a field is the host's and a choice its own.
      const resolved = yield* maybe("a call's signature", () => checker.getResolvedSignature(call))
      const target = yield* Effect.transposeOption(Option.map(resolved, (instance) => maybe("a signature's target", () => instance.getTarget())))
      const signature = Option.orElse(Option.flatten(target), () => resolved)
      const facts = yield* Effect.forEach(call.arguments, (argument, index) =>
        Effect.gen(function* () {
          const passed = yield* maybe("an argument's type", () => checker.getTypeAtLocation(argument))
          if (Option.isNone(passed)) return [`#${index}?`]
          const declared = yield* Effect.transposeOption(Option.map(signature, (host) => maybe("a parameter's type", () => checker.getParameterType(host, index))))
          return yield* factsOf(checker, passed.value, Option.flatten(declared), `#${index}`, FIELD_DEPTH)
        }),
      )
      found.push({ operation: joined(domain.value.path, op), file, line: lineOf(source, call.getStart(source)), facts: [...new Set(facts.flat())] })
    }
    return found
  })
