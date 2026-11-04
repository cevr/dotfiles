/**
 * A cell's top-level functions, classes and imports, kept as source so a new
 * worker can declare them again. A function or class value cannot be cloned,
 * and `toString` loses its types and what it closes over; the cell's own text
 * keeps both, since every top-level name it reads is a global the restore
 * brings back too.
 *
 * - `declarationsOf` parses a cell's original TypeScript with oxc and takes
 *   each top-level `function` and `class` declaration, each `const`, `let` or
 *   `var` bound to a function or class expression, and each import, one
 *   statement per name it binds.
 * - `makeDeclarations` keeps them in the order they ran. The latest cell to
 *   bind a name owns it: a new declaration replaces the old one, and a value a
 *   cell binds by any other means drops it.
 *
 * @module
 */
import { types } from "node:util"
import { parseSync, type Expression, type Node, type Statement } from "oxc-parser"
import type { Json, SnapshotBinding } from "../frame.ts"

/** The key that marks a stored declaration; the codec's clones share it. */
const SOURCE_TAG = "$kernel"

// Taken at load: the snapshot side runs after cells that may have replaced them.
const { apply, getPrototypeOf, defineProperty } = Reflect
const { getOwnPropertyDescriptor, hasOwn, is } = Object
const { isProxy } = types
const ObjectPrototype = Object.prototype
const SafeMap = Map
const { get: mapGet, set: mapSet, has: mapHas } = Map.prototype
const byteLength = Buffer.byteLength
/** A function's own `prototype` object, read from its descriptor. */
const prototypeOf = (fn: unknown): object | undefined => {
  if (typeof fn !== "function" || isProxy(fn)) return undefined
  const descriptor = getOwnPropertyDescriptor(fn, "prototype")
  if (descriptor === undefined || !hasOwn(descriptor, "value")) return undefined
  return typeof descriptor.value === "object" && descriptor.value !== null ? descriptor.value : undefined
}
const KINDS = ["import", "declaration"] as const
const append = <T>(list: T[], item: T) => void defineProperty(list, list.length, { __proto__: null, value: item, writable: true, enumerable: true, configurable: true } as PropertyDescriptor)

/** One top-level statement a new worker runs again. */
export interface Declared {
  /** Imports run first on restore, then declarations. */
  readonly kind: "import" | "declaration"
  /** TypeScript as the cell wrote it; an import is made of the cell's own spans, one name each. */
  readonly code: string
  /** The global it binds; none for a bare `import "x"`. */
  readonly name: string | undefined
  /** A class with private members: its instances cannot be rebuilt from their own properties. */
  readonly sealed: boolean
  /** The globals the transpiler adds for an import, such as `import_node_path`: running it again makes them. */
  readonly helpers: ReadonlyArray<string>
}

/** What a cell wrote around a function or class: parentheses and type assertions. */
const unwrap = (expression: Expression): Expression => {
  let inner = expression
  while (
    inner.type === "ParenthesizedExpression" ||
    inner.type === "TSAsExpression" ||
    inner.type === "TSSatisfiesExpression" ||
    inner.type === "TSNonNullExpression" ||
    inner.type === "TSTypeAssertion"
  )
    inner = inner.expression
  return inner
}

/** Private members and `accessor` fields live in slots no own property shows. */
const isSealed = (node: Node): boolean =>
  (node.type === "ClassDeclaration" || node.type === "ClassExpression") &&
  node.body.body.some((member) => member.type === "AccessorProperty" || ("key" in member && member.key.type === "PrivateIdentifier"))

/** The globals a statement's compiled code declares, other than `name`. */
const helpersOf = (code: string, name: string | undefined, compile: (code: string) => string): ReadonlyArray<string> => {
  try {
    const parsed = parseSync("compiled.js", compile(code), { lang: "js", sourceType: "script" })
    return (parsed.program.body as ReadonlyArray<Statement>).flatMap((node) =>
      node.type === "VariableDeclaration"
        ? node.declarations.flatMap((declarator) => (declarator.id.type === "Identifier" && declarator.id.name !== name ? [declarator.id.name] : []))
        : [],
    )
  } catch {
    return []
  }
}

/**
 * The statements of `source` a new worker runs again; none when it does not
 * parse. `compile` is the cells' own transpile, to name the globals an import adds.
 */
export const declarationsOf = (source: string, compile: (code: string) => string): ReadonlyArray<Declared> => {
  let body: ReadonlyArray<Statement>
  try {
    const parsed = parseSync("cell.ts", source, { lang: "ts", sourceType: "module" })
    if (parsed.errors.length > 0) return []
    body = parsed.program.body as ReadonlyArray<Statement>
  } catch {
    return []
  }
  const text = (node: { readonly start: number; readonly end: number }) => source.slice(node.start, node.end)
  const out: Declared[] = []
  for (const node of body) {
    if (node.type === "ImportDeclaration") {
      if (node.importKind === "type" || node.phase !== null) continue
      const from = `${text(node.source)}${node.attributes.length > 0 ? ` with { ${node.attributes.map(text).join(", ")} }` : ""}`
      const imported = (code: string, name: string | undefined) => out.push({ kind: "import", code, name, sealed: false, helpers: helpersOf(code, name, compile) })
      if (node.specifiers.length === 0) imported(`import ${from}`, undefined)
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") continue
        const clause =
          specifier.type === "ImportSpecifier" ? `{ ${text(specifier)} }` : specifier.type === "ImportNamespaceSpecifier" ? text(specifier) : specifier.local.name
        imported(`import ${clause} from ${from}`, specifier.local.name)
      }
    } else if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id && !node.declare) {
      if (node.type === "FunctionDeclaration" && node.body === null) continue
      out.push({ kind: "declaration", code: text(node), name: node.id.name, sealed: isSealed(node), helpers: [] })
    } else if (node.type === "VariableDeclaration" && !node.declare && (node.kind === "const" || node.kind === "let" || node.kind === "var")) {
      for (const declarator of node.declarations) {
        if (declarator.id.type !== "Identifier" || declarator.init === null) continue
        const init = unwrap(declarator.init)
        if (init.type !== "ArrowFunctionExpression" && init.type !== "FunctionExpression" && init.type !== "ClassExpression") continue
        out.push({ kind: "declaration", code: `${node.kind} ${text(declarator.id)} = ${text(declarator.init)}`, name: declarator.id.name, sealed: isSealed(init), helpers: [] })
      }
    }
  }
  return out
}

/** A declaration that ran, with the value it bound. */
export interface Entry extends Declared {
  readonly value: unknown
}

/** The declarations a new worker runs again, in the order they ran. */
export const makeDeclarations = () => {
  let entries: Entry[] = []
  return {
    /**
     * After a cell: what it declared and did bind joins the end; any other name it
     * bound is no longer a declaration. A bare import is kept once the cell ends well.
     * `valueOf` reads a global as the cell left it.
     */
    record: (declared: ReadonlyArray<Declared>, bound: ReadonlyArray<string>, ok: boolean, valueOf: (name: string) => unknown) => {
      const rebound = new Set(bound)
      const latest = new Map<string, Declared>()
      const bare: Declared[] = []
      for (const item of declared) {
        if (item.name === undefined) {
          if (ok && !bare.some((other) => other.code === item.code)) bare.push(item)
          continue
        }
        if (!rebound.has(item.name)) continue
        // An import binds what it imports; a declaration counts only when it left a function or class.
        if (item.kind === "declaration" && typeof valueOf(item.name) !== "function") continue
        latest.delete(item.name)
        latest.set(item.name, item)
      }
      entries = entries.filter((entry) =>
        entry.name === undefined ? !bare.some((item) => item.code === entry.code) : !rebound.has(entry.name),
      )
      for (const item of [...bare, ...latest.values()]) entries.push({ ...item, value: item.name === undefined ? undefined : valueOf(item.name) })
    },
    /** The snapshot's side of the declarations, against the globals as they are now (`snapshotOf`). */
    snapshot: (globals: ReadonlyMap<string, unknown>) => snapshotOf(entries, globals),
  }
}

/** What a snapshot keeps of the declarations. */
export interface DeclarationSnapshot {
  /** Imports first, then declarations, each in the order it ran. */
  readonly bindings: ReadonlyArray<SnapshotBinding>
  /** The names whose value is the one their declaration made, and the globals imports add: their source carries them. */
  readonly carried: ReadonlyMap<string, true>
  /** The prototypes whose instances restore can rebuild, each by its class's name. */
  readonly classes: ReadonlyMap<object, string>
  /** The sources' bytes. */
  readonly bytes: number
}

/**
 * The declarations as stored bindings, and what they carry, with no code a
 * cell wrote run: loops by index, built-ins taken at load, descriptors read.
 * A declared function's instances are rebuilt when every prototype above
 * theirs, up to `Object.prototype`, is a declared function's too, and no class
 * on the way has private members.
 */
const snapshotOf = (entries: ReadonlyArray<Entry>, globals: ReadonlyMap<string, unknown>): DeclarationSnapshot => {
  const bindings: SnapshotBinding[] = []
  const carried = new SafeMap<string, true>()
  const classes = new SafeMap<object, string>()
  const prototypes = new SafeMap<object, Entry>()
  let bytes = 0
  for (let pass = 0; pass < KINDS.length; pass++)
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!
      if (entry.kind !== KINDS[pass]) continue
      append(bindings, { name: entry.name ?? "", value: { [SOURCE_TAG]: "source", kind: entry.kind, code: entry.code } })
      bytes += byteLength(entry.code)
      for (let helper = 0; helper < entry.helpers.length; helper++) apply(mapSet, carried, [entry.helpers[helper], true])
      if (entry.name === undefined || !apply(mapHas, globals, [entry.name]) || !is(apply(mapGet, globals, [entry.name]), entry.value)) continue
      apply(mapSet, carried, [entry.name, true])
      const prototype = entry.kind === "declaration" ? prototypeOf(entry.value) : undefined
      if (prototype !== undefined) apply(mapSet, prototypes, [prototype, entry])
    }
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    const own = prototypeOf(entry.value)
    if (entry.name === undefined || own === undefined || apply(mapGet, prototypes, [own]) !== entry) continue
    let proto: object | null = own
    let rebuilt = true
    while (proto !== null && proto !== ObjectPrototype) {
      const owner = apply(mapGet, prototypes, [proto]) as Entry | undefined
      if (owner === undefined || owner.sealed || isProxy(proto)) {
        rebuilt = false
        break
      }
      proto = getPrototypeOf(proto)
    }
    if (rebuilt) apply(mapSet, classes, [own, entry.name])
  }
  return { bindings, carried, classes, bytes }
}

/** A stored declaration's kind and source; `undefined` for any other stored value. */
export const decodeDeclaration = (stored: Json): { readonly kind: Declared["kind"]; readonly code: string } | undefined => {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return undefined
  const record = stored as { readonly [key: string]: Json }
  const { kind, code } = record
  if (record[SOURCE_TAG] !== "source" || (kind !== "import" && kind !== "declaration") || typeof code !== "string") return undefined
  return { kind, code }
}
