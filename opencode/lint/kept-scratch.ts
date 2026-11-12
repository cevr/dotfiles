// `dotfiles/kept-suite-folders`: a test makes its temp folders through tests/scratch.ts,
// and an e2e suite that holds a Kept (keptScratch) makes its folders through the Kept, so
// its end removes them all and nothing is made again after it.
//
// In every file under tests/ but tests/scratch.ts itself (which makes the folders):
// - `tmpdir()`: a folder straight under the system's temp directory is the test's to
//   remove, and one it forgets stays. Take it from `scratch(prefix)` (a test or a
//   suite) or `keptScratch` (an e2e suite).
// In a file that calls keptScratch, these too are refused, at any depth:
// - a recursive `mkdirSync`/`mkdir`: it makes every missing parent, so one that runs
//   after the suite's end makes the suite's folder again, and nothing removes it.
//   Make each folder parents first without `recursive` (it fails with ENOENT once the
//   suite has ended), or take a fresh one from `kept.dir(prefix)`. Its options pass
//   when the rule reads `recursive` as absent or the literal `false`: an object
//   literal, through spreads, a shorthand `{ recursive }` or a variable, as far as a
//   `const` holding a literal reaches. A name is read through its own binding, by
//   scope, so a parameter shadows a const of the same name. Options it cannot read
//   (a parameter, a catch parameter, a destructured const, a call, a `let`, an
//   undeclared name) are refused.
// - `cpSync`/`cp`: it makes the target's missing parents whatever its options. Copy a
//   file with `copyFileSync`, which makes none.
// - `Bun.write`, unless its options read `createPath: false`: it makes the target's
//   parents by default.
// - `mkdtempSync`/`mkdtemp` and `tmpdir()`: a folder beside the suite's, which its
//   end never removes. Take it from `kept.dir(prefix)`.
// The callee is matched by name, bare (`mkdirSync(…)`) or as a member (`fs.mkdirSync(…)`,
// `fs["mkdirSync"](…)`, `Bun.write(…)`), through a type assertion, `!` or `?.`, and
// through a rename, by its binding: an import (`import { mkdtempSync as m }`,
// `import { write } from "bun"`), a const destructuring (`const { tmpdir: t } = os`,
// `const { write } = Bun`) or a const (`const m = fs.mkdirSync`). keptScratch is
// followed the same way.
// Not followed: a call through `.call`/`.apply`, a function passed in as a parameter.
//
// lint/test-env.test.ts holds a case for each form, in a Kept file and out of one.

interface Node {
  readonly type: string
  readonly name?: string
  readonly value?: unknown
  readonly computed?: boolean
  readonly kind?: string
  readonly object?: Node
  readonly property?: Node
  readonly callee?: Node
  readonly expression?: Node
  readonly argument?: Node
  readonly arguments?: ReadonlyArray<Node>
  readonly properties?: ReadonlyArray<Property>
  readonly imported?: Node
  readonly source?: Node
  readonly id?: Node
  readonly init?: Node
  readonly left?: Node
}

/** An object literal's or pattern's member: `key: value`, or a spread / rest (whose type is not "Property"). */
interface Property {
  readonly type: string
  readonly computed?: boolean
  readonly key?: Node
  readonly value?: Node
  readonly argument?: Node
}

/** One binding of a name, as oxlint's scope manager gives it. */
interface Definition {
  /** "Variable", "Parameter", "ImportBinding", "CatchClause", … */
  readonly type: string
  /** The declarator, import specifier, function or catch clause. */
  readonly node: Node
  /** The declaration (`const`/`let`/`var`) or the import declaration. */
  readonly parent?: Node
}

interface Variable {
  readonly defs: ReadonlyArray<Definition>
}

interface Scope {
  readonly set: Map<string, Variable>
  readonly upper?: Scope
}

interface Context {
  readonly filename: string
  readonly sourceCode: { readonly getScope: (node: Node) => Scope }
  readonly report: (report: { readonly node: Node; readonly message: string }) => void
}

/** The stand-in for a missing node: it matches no type. */
const NONE: Node = { type: "" }

/** The stand-in for a binding the rule cannot read. */
const NO_DEFINITION: Definition = { type: "", node: NONE }

const WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ChainExpression"])

/** How many bindings a value is followed through before the rule gives up on it (a cycle ends here). */
const DEPTH = 8

/** The node under any type assertion, `!` or optional chain. */
const bare = (node: Node = NONE): Node => {
  let at = node
  while (WRAPPERS.has(at.type)) at = at.expression || NONE
  return at
}

/** A name a node spells: an identifier unless `computed`, or a literal; "" for anything else. */
const nameOf = (node: Node = NONE, computed = false): string => {
  if (!computed && node.type === "Identifier") return String(node.name)
  if (node.type === "Literal") return String(node.value)
  return ""
}

/** Reads a file's bindings: an identifier resolves to the one definition its scope gives it. */
interface Bindings {
  /** The identifier's own definition: NO_DEFINITION when it is undeclared. */
  readonly of: (identifier: Node) => Definition
}

const bindings = (context: Context): Bindings => ({
  of: (identifier) => lookup(context.sourceCode.getScope(identifier), String(identifier.name)),
})

/**
 * The definition `name` has in `scope` or the nearest scope above it that binds it. A name bound more
 * than once in one scope is a `var` or a function, which no reading follows, so its first binding serves.
 */
const lookup = (scope: Scope, name: string): Definition => {
  const variable = scope.set.get(name)
  if (variable) return variable.defs[0] || NO_DEFINITION
  if (!scope.upper) return NO_DEFINITION
  return lookup(scope.upper, name)
}

/** The value a plain `const name = value` binds; NONE for any other binding. */
const constValue = (definition: Definition): Node => {
  if (definition.type !== "Variable" || (definition.parent || NONE).kind !== "const") return NONE
  if ((definition.node.id || NONE).type !== "Identifier") return NONE
  return definition.node.init || NONE
}

/** The node a value stands for: a const's identifier is followed to the const's value. */
const resolve = (files: Bindings, node: Node = NONE, depth = 0): Node => {
  const at = bare(node)
  if (at.type !== "Identifier" || depth >= DEPTH) return at
  const init = constValue(files.of(at))
  if (init === NONE) return at
  return resolve(files, init, depth + 1)
}

/** `Bun.write` for the key `write` taken from `Bun` (or from "bun"); the key itself for anything else. */
const qualified = (key: string, from: string): string => {
  if (key === "write" && (from === "Bun" || from === "bun")) return "Bun.write"
  return key
}

/** The name a call's callee ends in: `f(…)` → f, `a.f(…)` and `a["f"](…)` → f, `Bun.write(…)` → Bun.write; renames followed. */
const calleeName = (files: Bindings, callee: Node = NONE, depth = 0): string => {
  const at = bare(callee)
  if (at.type === "Identifier") return identifierName(files, at, depth)
  if (at.type !== "MemberExpression") return ""
  return qualified(nameOf(at.property, at.computed), nameOf(bare(at.object)))
}

/** The name a called identifier stands for, by its binding: an import's name, a destructured key, a const's callee, or itself. */
const identifierName = (files: Bindings, identifier: Node, depth: number): string => {
  const name = String(identifier.name)
  const definition = files.of(identifier)
  if (definition.type === "ImportBinding") return imported(definition, name)
  if (definition.type !== "Variable" || (definition.parent || NONE).kind !== "const" || depth >= DEPTH) return name
  const id = definition.node.id || NONE
  if (id.type === "ObjectPattern") return destructured(id, definition.node.init || NONE, name)
  return calleeName(files, definition.node.init || NONE, depth + 1) || name
}

/** The name an import binds `local` to: `import { a as local } from "m"` → a (`write` from "bun" → Bun.write). */
const imported = (definition: Definition, local: string): string => {
  const name = nameOf(definition.node.imported) || local
  return qualified(name, nameOf((definition.parent || NONE).source))
}

/** The key a const destructuring binds `local` to: `const { a: local } = from` → a (`write` from Bun → Bun.write). */
const destructured = (pattern: Node, from: Node, local: string): string => {
  for (const property of pattern.properties || []) {
    if (property.type === "Property" && target(property.value) === local) return qualified(nameOf(property.key, property.computed) || local, nameOf(bare(from)))
  }
  return local
}

/** The name a pattern member binds: `local`, or `local = default`'s local. */
const target = (value: Node = NONE): string => {
  const at = bare(value)
  if (at.type === "AssignmentPattern") return nameOf(at.left)
  return nameOf(at)
}

/** How an options argument sets a key: left out, the literal `false`, or anything else (set, or unreadable). */
type Setting = "absent" | "false" | "set"

/** How `options` sets `key`, a later member overriding an earlier one, spreads followed. */
const setting = (files: Bindings, options: Node, key: string): Setting => {
  const at = resolve(files, options)
  if (at === NONE || at.type === "Literal" || (at.type === "Identifier" && at.name === "undefined")) return "absent"
  if (at.type !== "ObjectExpression") return "set"
  let found: Setting = "absent"
  for (const property of at.properties || []) {
    const each = member(files, property, key)
    if (each !== "absent") found = each
  }
  return found
}

/** How one member of an options object sets `key`: a spread is read in turn, a computed key it cannot name is unreadable. */
const member = (files: Bindings, property: Property, key: string): Setting => {
  if (property.type !== "Property") return setting(files, property.argument || NONE, key)
  const name = nameOf(property.key, property.computed)
  if (name === key) return literalFalse(resolve(files, property.value))
  if (name === "") return "set"
  return "absent"
}

/** "false" for the literal `false`, "set" for anything else. */
const literalFalse = (node: Node): Setting => {
  if (node.type === "Literal" && node.value === false) return "false"
  return "set"
}

/** Whether `options` leaves `key` out or sets it to the literal `false`. */
const off = (files: Bindings, options: Node, key: string): boolean => setting(files, options, key) !== "set"

const MKDIR = new Set(["mkdirSync", "mkdir"])
const COPY = new Set(["cpSync", "cp"])
const TEMP = new Set(["mkdtempSync", "mkdtemp", "tmpdir"])

const RECURSIVE =
  "A Kept suite makes no folder with a recursive mkdir, nor with options the rule cannot read: one that runs after the suite's end makes the suite's folder again and nothing removes it. Make each folder parents first without `recursive` (it fails once the suite has ended), or take a fresh one from kept.dir(prefix)."
const PARENTS =
  "A Kept suite writes no file with a call that makes the target's parents (cpSync, Bun.write without `createPath: false`): one that runs after the suite's end makes the suite's folder again and nothing removes it. Copy with copyFileSync, or pass Bun.write `{ createPath: false }`."
const OUTSIDE =
  "A Kept suite makes no folder beside its own (mkdtemp, tmpdir()): the suite's end never removes it. Take a fresh folder from kept.dir(prefix)."
const LOOSE =
  "A test makes no folder straight under tmpdir(): one it forgets stays. Take it from tests/scratch.ts: scratch(prefix), or keptScratch for an e2e suite."

/** The message a call earns; "" for none. */
const refusal = (files: Bindings, call: Node, name: string, kept: boolean): string => {
  const args = call.arguments || []
  if (!kept && name === "tmpdir") return LOOSE
  if (!kept) return ""
  if (MKDIR.has(name) && !off(files, args[1] || NONE, "recursive")) return RECURSIVE
  if (COPY.has(name)) return PARENTS
  if (name === "Bun.write" && setting(files, args[2] || NONE, "createPath") !== "false") return PARENTS
  if (TEMP.has(name)) return OUTSIDE
  return ""
}

/** The file that makes the scratch folders, and so the one file under tests/ that calls tmpdir(). */
const HELPER = /(^|[\\/])tests[\\/]scratch\.ts$/

const keptSuiteFolders = {
  create: (context: Context) => {
    const calls: Array<Node> = []
    return {
      CallExpression: (node: Node) => {
        calls.push(node)
      },
      // A file's Kept may come after its first mkdir, so the verdict waits for the file's end.
      "Program:exit": () => {
        if (HELPER.test(context.filename)) return
        const files = bindings(context)
        const named = calls.map((call) => ({ call, name: calleeName(files, call.callee) }))
        const kept = named.some((each) => each.name === "keptScratch")
        for (const { call, name } of named) {
          const message = refusal(files, call, name, kept)
          if (message !== "") context.report({ node: call, message })
        }
      },
    }
  },
}

export default keptSuiteFolders
