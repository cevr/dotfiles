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
//   `const` holding a literal reaches. Options it cannot read (a parameter, a call,
//   a `let`) are refused.
// - `cpSync`/`cp`: it makes the target's missing parents whatever its options. Copy a
//   file with `copyFileSync`, which makes none.
// - `Bun.write`, unless its options read `createPath: false`: it makes the target's
//   parents by default.
// - `mkdtempSync`/`mkdtemp` and `tmpdir()`: a folder beside the suite's, which its
//   end never removes. Take it from `kept.dir(prefix)`.
// The callee is matched by name, bare (`mkdirSync(…)`) or as a member (`fs.mkdirSync(…)`,
// `fs["mkdirSync"](…)`), through a type assertion, `!` or `?.`, and through a rename:
// an import (`import { mkdtempSync as m }`), a destructuring (`const { tmpdir: t } = os`)
// or a const (`const m = fs.mkdirSync`). keptScratch is followed the same way.
// Not followed: a call through `.call`/`.apply`, a value passed in as a parameter.
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
  readonly declarations?: ReadonlyArray<Declarator>
  readonly imported?: Node
  readonly local?: Node
}

/** An object literal's or pattern's member: `key: value`, or a spread / rest (whose type is not "Property"). */
interface Property {
  readonly type: string
  readonly computed?: boolean
  readonly key?: Node
  readonly value?: Node
  readonly argument?: Node
}

/** `id = init` in a `const`, `let` or `var`. */
interface Declarator {
  readonly id?: Node
  readonly init?: Node | null
}

interface Context {
  readonly filename: string
  readonly report: (report: { readonly node: Node; readonly message: string }) => void
}

/** The stand-in for a missing node: it matches no type. */
const NONE: Node = { type: "" }

const WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ChainExpression"])

/** How many consts a value is followed through before the rule gives up on it (a cycle ends here). */
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

/** What a file declares: its renames (local name → the name it stands for) and its consts. */
interface Scope {
  readonly renames: Map<string, string>
  /** A const's value; `undefined` for a name declared more than once or by `let`/`var`. */
  readonly consts: Map<string, Node | undefined>
}

/** The node a value stands for: a const's identifier is followed to the const's value. */
const resolve = (scope: Scope, node: Node = NONE, depth = 0): Node => {
  const at = bare(node)
  if (at.type !== "Identifier" || depth >= DEPTH) return at
  const init = scope.consts.get(String(at.name))
  return init === undefined ? at : resolve(scope, init, depth + 1)
}

/** The name a call's callee ends in: `f(…)` → f, `a.f(…)` and `a["f"](…)` → f, `Bun.write(…)` → Bun.write; renames followed. */
const calleeName = (scope: Scope, callee: Node = NONE, depth = 0): string => {
  const at = bare(callee)
  if (at.type === "Identifier") {
    const name = String(at.name)
    const renamed = scope.renames.get(name)
    if (renamed !== undefined) return renamed
    const init = scope.consts.get(name)
    return init === undefined || depth >= DEPTH ? name : calleeName(scope, init, depth + 1) || name
  }
  if (at.type !== "MemberExpression") return ""
  const name = nameOf(at.property, at.computed)
  return name === "write" && nameOf(bare(at.object)) === "Bun" ? "Bun.write" : name
}

/** How an options argument sets a key: left out, the literal `false`, or anything else (set, or unreadable). */
type Setting = "absent" | "false" | "set"

/** How `options` sets `key`, a later member overriding an earlier one, spreads followed. */
const setting = (scope: Scope, options: Node | undefined, key: string): Setting => {
  const at = resolve(scope, options)
  if (at === NONE || at.type === "Literal" || (at.type === "Identifier" && at.name === "undefined")) return "absent"
  if (at.type !== "ObjectExpression") return "set"
  let found: Setting = "absent"
  for (const property of at.properties || []) {
    if (property.type !== "Property") {
      const spread = setting(scope, property.argument, key)
      if (spread !== "absent") found = spread
      continue
    }
    const name = nameOf(property.key, property.computed)
    if (name === key) found = isFalse(resolve(scope, property.value)) ? "false" : "set"
    else if (name === "") found = "set"
  }
  return found
}

/** Whether a node is the literal `false`. */
const isFalse = (node: Node): boolean => node.type === "Literal" && node.value === false

/** Whether `options` leaves `key` out or sets it to the literal `false`. */
const off = (scope: Scope, options: Node | undefined, key: string): boolean => setting(scope, options, key) !== "set"

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
const refusal = (scope: Scope, call: Node, name: string, kept: boolean): string => {
  const args = call.arguments || []
  if (!kept) return name === "tmpdir" ? LOOSE : ""
  if (MKDIR.has(name) && !off(scope, args[1], "recursive")) return RECURSIVE
  if (COPY.has(name)) return PARENTS
  if (name === "Bun.write" && setting(scope, args[2], "createPath") !== "false") return PARENTS
  if (TEMP.has(name)) return OUTSIDE
  return ""
}

/** The file that makes the scratch folders, and so the one file under tests/ that calls tmpdir(). */
const HELPER = /(^|[\\/])tests[\\/]scratch\.ts$/

const keptSuiteFolders = {
  create: (context: Context) => {
    const scope: Scope = { renames: new Map(), consts: new Map() }
    const calls: Array<Node> = []
    /** A name a declaration binds: a const keeps its value, anything else (or a second binding) is unreadable. */
    const bind = (name: string, init: Node | undefined) => {
      scope.consts.set(name, scope.consts.has(name) ? undefined : init)
    }
    return {
      ImportSpecifier: (node: Node) => {
        const imported = nameOf(node.imported)
        if (imported !== "") scope.renames.set(nameOf(node.local), imported)
      },
      VariableDeclaration: (node: Node) => {
        for (const each of node.declarations || []) {
          const id = each.id || NONE
          if (id.type === "Identifier") bind(String(id.name), node.kind === "const" ? (each.init ?? undefined) : undefined)
          if (id.type !== "ObjectPattern") continue
          // `const { mkdtempSync: m } = fs`: m is mkdtempSync.
          for (const property of id.properties || []) {
            const key = nameOf(property.key, property.computed)
            const local = bare(property.value)
            if (property.type === "Property" && key !== "" && local.type === "Identifier") scope.renames.set(String(local.name), key)
          }
        }
      },
      CallExpression: (node: Node) => {
        calls.push(node)
      },
      // A file's Kept, its imports and its consts may come after its first mkdir, so the verdict waits for the file's end.
      "Program:exit": () => {
        if (HELPER.test(context.filename)) return
        const named = calls.map((call) => ({ call, name: calleeName(scope, call.callee) }))
        const kept = named.some((each) => each.name === "keptScratch")
        for (const { call, name } of named) {
          const message = refusal(scope, call, name, kept)
          if (message !== "") context.report({ node: call, message })
        }
      },
    }
  },
}

export default keptSuiteFolders
