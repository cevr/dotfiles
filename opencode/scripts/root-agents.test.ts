/**
 * The root AGENTS.md carries the owner's rules, never a plugin's behaviour (owner, 2026-11-24: "Don't put plug-in
 * behavior in agents.md … Plug-in behavior should be kind of self-contained"). Every session reads that file, Claude
 * Code's and Codex's too, which have none of our plugins; a plugin says what it does in its own tools' descriptions and
 * prompts. So the file names no tool our plugins register (in a code span, as a call would name it) and no model id
 * or family: which model a role runs on is the orchestrate plugin's choice.
 *
 * The tool names are read from the plugins themselves: every `add` inside a `<ctx>.tool.transform(…)` of a source under
 * cmd/ and mods/, its `name` resolved through the module that exports it, read as source and never run. A registration
 * this check cannot read fails it, so a new tool is never missed. The model families are the pool's price rows'
 * (mods/pool/limits.ts `PRICE`, `familyOf`), and a model id is a Claude or GPT id as the catalog spells one.
 *
 * It finds its sources by walking, not import, so it declares them for the gate's selection (scripts/reach.ts `readsOf`):
 * @reads ../AGENTS.md cmd/** mods/**
 */
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Effect, FileSystem, Option, Path, Predicate } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { type Argument, type Expression, type ImportDeclarationSpecifier, type ObjectProperty, type ObjectPropertyKind, parseSync, type StaticMemberExpression, type StringLiteral, Visitor } from "oxc-parser"
import { familyOf, PRICE } from "../mods/pool/limits.ts"

/**
 * The tools the file may name, each with why. The one exception (owner, 2026-11-24: "I don't mind the work tool
 * because that's an actual CLI"): a real CLI a person can run may be named; a plugin's tools and routing may not.
 */
const ALLOWED: ReadonlyArray<{ readonly tools: ReadonlyArray<string>; readonly why: string }> = [
  {
    tools: ["work", "rift"],
    why: "the work plugin's tool and its alias run Ergo's `work` CLI (and the workbox's `workrift`), which a person runs too; the Isolated workspaces rules name the CLI",
  },
]

/** A source the check reads: TypeScript, not a test, not a dependency. */
const isSource = (name: string) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)

/** Every source under `dir`, as absolute paths. */
const sourcesUnder = (dir: string): Effect.Effect<ReadonlyArray<string>, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = (yield* fs.readDirectory(dir)).filter((name) => name !== "node_modules")
    const each = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const child = path.join(dir, name)
        if ((yield* fs.stat(child)).type === "Directory") return yield* sourcesUnder(child)
        return Arr.filter([child], () => isSource(name))
      }),
    )
    return each.flat()
  })

/** How a registration names its tool: a string, a binding of the file, `NS.member`, or a call `NS.fn(…)` whose module exports `name`. */
type NameRef =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binding"; readonly local: string }
  | { readonly kind: "member"; readonly namespace: string; readonly member: string }
  | { readonly kind: "unread"; readonly source: string }

/** Any node the parser gives, as far as these reads need: its kind. */
type Typed = { readonly type: string }

const isIdentifier = (node: Typed): node is { readonly type: "Identifier"; readonly name: string } => node.type === "Identifier"
const isString = (node: Typed): node is StringLiteral => node.type === "Literal" && "value" in node && Predicate.isString(node.value)
const isStatic = (node: Expression): node is StaticMemberExpression => node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier"

const identifierOf = (node: Typed): Option.Option<string> => Option.map(Option.liftPredicate(node, isIdentifier), (each) => each.name)
const stringOf = (node: Typed): Option.Option<string> => Option.map(Option.liftPredicate(node, isString), (each) => each.value)
/** `object.property` with a plain property name: the object, and the name. */
const memberOf = (node: Expression): Option.Option<{ readonly object: Expression; readonly property: string }> =>
  Option.map(Option.liftPredicate(node, isStatic), (each) => ({ object: each.object, property: each.property.name }))
/** `NS.member` with a plain namespace: the namespace and the member. */
const namespacedOf = (node: Expression): Option.Option<{ readonly namespace: string; readonly member: string }> =>
  Option.flatMap(memberOf(node), (each) => Option.map(identifierOf(each.object), (namespace) => ({ namespace, member: each.property })))

/** The name a registration's argument gives its tool. */
const refOf = (text: string, arg: Argument): NameRef => {
  const unread: NameRef = { kind: "unread", source: text.slice(arg.start, arg.end).slice(0, 80) }
  if (arg.type === "CallExpression")
    return Option.getOrElse(Option.map(namespacedOf(arg.callee), ({ namespace }): NameRef => ({ kind: "member", namespace, member: "name" })), () => unread)
  if (arg.type !== "ObjectExpression") return unread
  const named = Arr.findFirst(arg.properties, (each): each is ObjectProperty => each.type === "Property" && Option.contains(identifierOf(each.key), "name"))
  return Option.match(named, {
    onNone: () => unread,
    onSome: ({ value }) =>
      Option.firstSomeOf([
        Option.map(stringOf(value), (text): NameRef => ({ kind: "text", text })),
        Option.map(identifierOf(value), (local): NameRef => ({ kind: "binding", local })),
        Option.map(namespacedOf(value), ({ namespace, member }): NameRef => ({ kind: "member", namespace, member })),
      ]).pipe(Option.getOrElse(() => unread)),
  })
}

/** `{ … } as const` and `… satisfies T` are the value they wrap. */
const unwrapped = (node: Expression): Expression => {
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") return unwrapped(node.expression)
  return node
}

/** An object literal's properties; none for any other value. */
const propertiesOf = (node: Expression): ReadonlyArray<ObjectPropertyKind> => {
  if (node.type === "ObjectExpression") return node.properties
  return []
}

/** The name an import specifier takes from its module: `X` of `{ X }` or `{ X as Y }`; none for a default or namespace import. */
const importedOf = (specifier: ImportDeclarationSpecifier): Option.Option<string> => {
  if (specifier.type !== "ImportSpecifier") return Option.none()
  return Option.orElse(identifierOf(specifier.imported), () => stringOf(specifier.imported))
}

/** A module's string constants, read without running it: `const X = "…"`, and `const X = { key: "…", … }` as `X.key`. */
const constantsOf = (file: string, text: string): ReadonlyMap<string, string> => {
  const constants = new Map<string, string>()
  new Visitor({
    VariableDeclarator: (node) => {
      const init = Option.map(Option.fromNullishOr(node.init), unwrapped)
      Option.map(identifierOf(node.id), (id) => {
        Option.map(Option.flatMap(init, stringOf), (value) => constants.set(id, value))
        for (const property of Option.getOrElse(Option.map(init, propertiesOf), () => []))
          if (property.type === "Property") Option.map(Option.all([identifierOf(property.key), stringOf(property.value)]), ([key, value]) => constants.set(`${id}.${key}`, value))
      })
    },
  }).visit(parseSync(file, text).program)
  return constants
}

/** One source's tool registrations, its imports (local name → module and exported name) and its string constants. */
const registrationsOf = (file: string, text: string) => {
  const transforms: Array<readonly [number, number]> = []
  const adds: Array<Argument> = []
  const imports = new Map<string, { readonly from: string; readonly exported: Option.Option<string> }>()
  new Visitor({
    CallExpression: (node) => {
      const member = memberOf(node.callee)
      const ofTool = Option.exists(member, (each) => each.property === "transform" && Option.exists(memberOf(each.object), (owner) => owner.property === "tool"))
      for (const arg of node.arguments.slice(0, 1)) {
        if (ofTool) transforms.push([arg.start, arg.end])
        if (Option.exists(member, (each) => each.property === "add")) adds.push(arg)
      }
    },
    ImportDeclaration: (node) => {
      for (const specifier of node.specifiers) imports.set(specifier.local.name, { from: node.source.value, exported: importedOf(specifier) })
    },
  }).visit(parseSync(file, text).program)
  const inTransform = (node: Argument) => transforms.some(([start, end]) => node.start >= start && node.end <= end)
  return { refs: adds.flatMap((arg) => Arr.filter([refOf(text, arg)], () => inTransform(arg))), imports, constants: constantsOf(file, text) }
}

/** The tool names every plugin registers; a registration that does not resolve to a string has none. */
const registeredTools = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const opencode = path.resolve(".")
  const files = (yield* Effect.forEach(["cmd", "mods"], (dir) => sourcesUnder(path.join(opencode, dir)))).flat()
  const found = yield* Effect.forEach(files, (file) =>
    Effect.gen(function* () {
      const text = yield* fs.readFileString(file)
      if (!text.includes(".transform(")) return []
      const { refs, imports, constants } = registrationsOf(file, text)
      const where = path.relative(opencode, file)
      /** The string an imported binding names (`X`, `X.key`, or a namespace's `NS.member`), read from its module's source. */
      const exportOf = (local: string, member: Option.Option<string>) =>
        Option.match(Option.fromUndefinedOr(imports.get(local)), {
          onNone: () => Effect.succeed(Option.none<string>()),
          onSome: (imported) =>
            Effect.gen(function* () {
              const from = Bun.resolveSync(imported.from, path.dirname(file))
              const module = constantsOf(from, yield* fs.readFileString(from))
              return Option.fromUndefinedOr(module.get([...Option.toArray(imported.exported), ...Option.toArray(member)].join(".")))
            }),
        })
      const nameOf = (ref: NameRef): Effect.Effect<Option.Option<string>, unknown> => {
        if (ref.kind === "text") return Effect.succeed(Option.some(ref.text))
        if (ref.kind === "unread") return Effect.succeed(Option.none())
        if (ref.kind === "member") return exportOf(ref.namespace, Option.some(ref.member))
        return Option.match(Option.fromUndefinedOr(constants.get(ref.local)), { onSome: (text) => Effect.succeed(Option.some(text)), onNone: () => exportOf(ref.local, Option.none()) })
      }
      return yield* Effect.forEach(refs, (ref) => Effect.map(nameOf(ref), (name) => ({ where, name, ref })))
    }),
  )
  return found.flat()
})

/** The code spans of a Markdown text, and the identifiers each holds. */
const codeWords = (markdown: string): ReadonlyArray<{ readonly span: string; readonly words: ReadonlyArray<string> }> =>
  [...markdown.matchAll(/`([^`\n]+)`/g)].map(([, span = ""]) => ({ span, words: [...span.matchAll(/[A-Za-z_][\w-]*/g)].map(([word]) => word) }))

/** The model families of the pool's price rows, and the catalog's spellings of a Claude or GPT id. */
const MODEL_FAMILIES = [...new Set(Object.keys(PRICE).map((id) => familyOf(id).toLowerCase()))]
const modelMentions = (text: string): ReadonlyArray<string> => [
  ...MODEL_FAMILIES.flatMap((family) => [...text.matchAll(new RegExp(`\\b${family}\\b`, "gi"))].map(([match]) => match)),
  ...[...text.matchAll(/\b(?:claude-[a-z]+-\d[\w.-]*|gpt-\d[\w.-]*)/gi)].map(([match]) => match),
]

/** The root AGENTS.md's text. */
const rootAgents = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* fs.readFileString(path.join(path.resolve("."), "..", "AGENTS.md"))
})

/** The names the plugins register. */
const toolNames = Effect.map(registeredTools, (found) => new Set(found.flatMap((each) => Option.toArray(each.name))))

describe("the root AGENTS.md names no plugin mechanics", () => {
  it.live.layer(BunServices.layer)("every tool registration reads as a name, and the plugins' tools are found", () =>
    Effect.gen(function* () {
      const found = yield* registeredTools
      expect(found.flatMap((each) => Arr.filter([{ where: each.where, ref: each.ref }], () => Option.isNone(each.name)))).toEqual([])
      // Tools of several plugins, so a parse that finds nothing cannot pass the next test vacuously.
      const names = yield* toolNames
      expect(names.size).toBeGreaterThan(20)
      for (const anchor of ["queue", "principles", "ask_orchestrator", "orchestrate", "work", "wake_list", "subagents"]) expect(names.has(anchor)).toBe(true)
    }),
  )

  it.live.layer(BunServices.layer)("it names no plugin tool in a code span, but the allowed ones", () =>
    Effect.gen(function* () {
      const tools = yield* toolNames
      const allowed = new Set(ALLOWED.flatMap((entry) => entry.tools))
      const named = codeWords(yield* rootAgents).flatMap(({ span, words }) =>
        words.flatMap((tool) => Arr.filter([{ tool, span }], () => tools.has(tool) && !allowed.has(tool))),
      )
      expect(named).toEqual([])
    }),
  )

  it.live.layer(BunServices.layer)("it names no model id or family", () =>
    Effect.gen(function* () {
      expect(MODEL_FAMILIES).toContain("opus")
      expect(modelMentions(yield* rootAgents)).toEqual([])
    }),
  )

  it.live.layer(BunServices.layer)("each allowed tool is a registered one and says why", () =>
    Effect.gen(function* () {
      const tools = yield* toolNames
      for (const entry of ALLOWED) {
        expect(entry.why.length).toBeGreaterThan(20)
        for (const tool of entry.tools) expect(tools.has(tool)).toBe(true)
      }
    }),
  )

  it.effect("the checks catch what they are for: a tool in a code span, a model family in prose", () =>
    Effect.sync(() => {
      expect(codeWords("use the `queue` tool").flatMap((each) => each.words)).toContain("queue")
      expect(modelMentions("Fable plans, Opus first; newest standard Sol; gpt-6.1-sol-fast")).toEqual(["Opus", "Fable", "Sol", "sol", "gpt-6.1-sol-fast"])
    }),
  )
})
