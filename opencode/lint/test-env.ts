// The repo's own oxlint rules (.oxlintrc.json `jsPlugins`).
//
// `dotfiles/no-module-env-in-tests`: a test file that sets or deletes a
// `process.env` key at module scope changes it for every other test file the
// same `bun test` process loads after it, and never puts it back. Set it in a
// hook or a test and restore it there (beforeAll/afterAll), or pass the value
// to the code under test instead.

interface Node {
  readonly type: string
  readonly parent?: Node | null
  readonly object?: Node
  readonly property?: Node
  readonly name?: string
  readonly left?: Node
  readonly argument?: Node
  readonly operator?: string
}

interface Context {
  readonly report: (report: { readonly node: Node; readonly message: string }) => void
}

const SCOPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "MethodDefinition", "StaticBlock"])

/** `process.env.X` or `process.env[...]`. */
const envKey = (node: Node | undefined): boolean => {
  if (node?.type !== "MemberExpression") return false
  const env = node.object
  return env?.type === "MemberExpression" && env.object?.type === "Identifier" && env.object.name === "process" && env.property?.type === "Identifier" && env.property.name === "env"
}

const atModuleScope = (node: Node): boolean => {
  for (let at = node.parent; at; at = at.parent) if (SCOPES.has(at.type)) return false
  return true
}

const MESSAGE = "A test file sets process.env at module scope, so it leaks into every later test file in the run: set it in beforeAll and restore it in afterAll, or pass the value in."

const noModuleEnvInTests = {
  create: (context: Context) => ({
    AssignmentExpression: (node: Node) => {
      if (envKey(node.left) && atModuleScope(node)) context.report({ node, message: MESSAGE })
    },
    UnaryExpression: (node: Node) => {
      if (node.operator === "delete" && envKey(node.argument) && atModuleScope(node)) context.report({ node, message: MESSAGE })
    },
  }),
}

export default {
  meta: { name: "dotfiles" },
  rules: { "no-module-env-in-tests": noModuleEnvInTests },
}
