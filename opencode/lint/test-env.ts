// The repo's own oxlint rules (.oxlintrc.json `jsPlugins`).
//
// `dotfiles/no-module-env-in-tests`: a test file that writes the environment
// while it is loaded changes it for every other test file the same `bun test`
// process loads after it, and never puts it back. Set it in a hook or a test
// and restore it there (beforeAll/afterAll), or pass the value to the code
// under test instead.
//
// "While it is loaded" is module scope, a static class block or field, an
// IIFE, and the body of a `describe` callback (which runs at collection,
// before any hook), at any depth of nested describes. Any other function, a
// hook or test body, or a class field defers the write, so it is left alone.
// A write is any of: `=` and the compound operators, `++`/`--`, `delete`, a
// destructuring target (with a default or a rest), replacing `process.env`
// itself (the spread form `process.env = { ...process.env, X }`), and
// `Object.assign`, `Object.defineProperty`, `Object.defineProperties`,
// `Reflect.set`, `Reflect.defineProperty` and `Reflect.deleteProperty` on it,
// through a type assertion, `!`, `satisfies` or `?.` as well. The environment
// is `process.env` or `Bun.env` (the same object), by dot or by string key.
// An alias (`const env = process.env; env.X = …`) is not followed.
//
// lint/test-env.test.ts holds a case for each of these, so removing any one's
// handling turns a case red.

interface Node {
  readonly type: string
  readonly parent?: Node | null
  readonly object?: Node
  readonly property?: Node
  readonly computed?: boolean
  readonly name?: string
  readonly value?: unknown
  readonly left?: Node
  readonly right?: Node
  readonly argument?: Node | null
  readonly expression?: Node
  readonly operator?: string
  readonly callee?: Node
  readonly arguments?: ReadonlyArray<Node>
  readonly properties?: ReadonlyArray<Node>
  readonly elements?: ReadonlyArray<Node | null>
  readonly static?: boolean
}

interface Context {
  readonly report: (report: { readonly node: Node; readonly message: string }) => void
}

// oxlint's tree keeps no node for parentheses, so `(process.env).X` needs no entry.
const WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ChainExpression"])

/** The node under any type assertion, `!` or optional chain. */
const bare = (node: Node | null | undefined): Node | undefined => {
  let at = node ?? undefined
  while (at && WRAPPERS.has(at.type)) at = at.expression
  return at
}

/** The name of a member's property: `a.b`, `a["b"]`. */
const propertyName = (node: Node): string | undefined => {
  const property = node.property
  if (!property) return undefined
  if (!node.computed && property.type === "Identifier") return property.name
  if (property.type === "Literal" && typeof property.value === "string") return property.value
  return undefined
}

const isMember = (node: Node | undefined, object: string, property: string): boolean =>
  node?.type === "MemberExpression" && bare(node.object)?.type === "Identifier" && bare(node.object)?.name === object && propertyName(node) === property

/** `process.env` or `Bun.env`. */
const isEnv = (node: Node | null | undefined): boolean => {
  const at = bare(node)
  return isMember(at, "process", "env") || isMember(at, "Bun", "env")
}

/** `process.env.X` or `process.env[...]`. */
const isEnvKey = (node: Node | null | undefined): boolean => {
  const at = bare(node)
  return at?.type === "MemberExpression" && isEnv(at.object)
}

/** Whether an assignment target writes the environment: the object, a key of it, or either inside a destructuring pattern. */
const writesEnv = (target: Node | null | undefined): boolean => {
  const at = bare(target)
  if (!at) return false
  if (isEnv(at) || isEnvKey(at)) return true
  switch (at.type) {
    case "ObjectPattern":
      return (at.properties ?? []).some((property) => writesEnv(property.type === "RestElement" ? property.argument : property.value as Node | undefined))
    case "ArrayPattern":
      return (at.elements ?? []).some((element) => writesEnv(element))
    case "AssignmentPattern":
      return writesEnv(at.left)
    case "RestElement":
      return writesEnv(at.argument)
    default:
      return false
  }
}

/** The calls whose first argument they write: `Object.assign(process.env, …)` and the like. */
const WRITERS: ReadonlyArray<readonly [string, string]> = [
  ["Object", "assign"],
  ["Object", "defineProperty"],
  ["Object", "defineProperties"],
  ["Reflect", "set"],
  ["Reflect", "defineProperty"],
  ["Reflect", "deleteProperty"],
]

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"])

/** The identifier a call's callee starts from: `describe`, `describe.each(…)`, `describe.skip`. */
const calleeRoot = (callee: Node | undefined): string | undefined => {
  let at = bare(callee)
  while (at && (at.type === "MemberExpression" || at.type === "CallExpression")) at = bare(at.type === "MemberExpression" ? at.object : at.callee)
  return at?.type === "Identifier" ? at.name : undefined
}

/**
 * A function whose body runs where it stands: one called on the spot (an
 * IIFE), or one passed to `describe(…)`, which bun runs when it collects the
 * file, so its body is module scope in effect.
 */
const runsInPlace = (fn: Node): boolean => {
  const call = fn.parent
  return call?.type === "CallExpression" && (bare(call.callee) === fn || calleeRoot(call.callee) === "describe")
}

/** Whether the node runs when the file is loaded: at module scope, or in a describe body or an IIFE, with no other function between. */
const runsAtLoad = (node: Node): boolean => {
  for (let at = node.parent; at; at = at.parent) {
    if (FUNCTIONS.has(at.type) && !runsInPlace(at)) return false
    // A class field's initializer runs per instance, later; a static one runs with the class.
    if (at.type === "PropertyDefinition" && !at.static) return false
  }
  return true
}

const MESSAGE =
  "A test file writes process.env while it loads (module scope or a describe body), so it leaks into every later test file in the run: set it in beforeAll and restore it in afterAll, or pass the value in."

const noModuleEnvInTests = {
  create: (context: Context) => {
    const check = (node: Node, writes: boolean) => {
      if (writes && runsAtLoad(node)) context.report({ node, message: MESSAGE })
    }
    return {
      AssignmentExpression: (node: Node) => check(node, writesEnv(node.left)),
      UpdateExpression: (node: Node) => check(node, isEnvKey(node.argument)),
      UnaryExpression: (node: Node) => check(node, node.operator === "delete" && isEnvKey(node.argument)),
      CallExpression: (node: Node) => {
        const callee = bare(node.callee)
        check(node, WRITERS.some(([object, method]) => isMember(callee, object, method)) && isEnv(node.arguments?.[0]))
      },
    }
  },
}

export default {
  meta: { name: "dotfiles" },
  rules: { "no-module-env-in-tests": noModuleEnvInTests },
}
