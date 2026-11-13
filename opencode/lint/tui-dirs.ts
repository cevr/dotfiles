// `dotfiles/tui-dirs-only`: in mods/ and cmd/ (the override in .oxlintrc.json),
// the host's directories are read only through decider/tui-dirs.ts (`dirs()`),
// the source a simulated host (sim-tui/) points into its scratch. A raw read
// there takes this machine's own home or XDG dir, so a simulated run can read
// or write the owner's files.
//
// Not read: the three programs a pool peer runs over SSH (mods/pool/ssh/
// push.ts, report.ts, lease.ts). They run on the peer, by themselves (they
// import nothing, so a peer needs only Bun), and read the peer's own HOME.
//
// Refused: a call of `homedir` (bare, or `os.homedir()` on any object), and a
// read of `HOME` or any `XDG_*` variable from `process.env` or `Bun.env`, by
// dot, by string key, or by destructuring. lint/tui-dirs.test.ts holds a case
// for each.

interface Node {
  readonly type: string
  readonly object?: Node
  readonly property?: Node
  readonly computed?: boolean
  readonly name?: string
  readonly value?: unknown
  readonly callee?: Node
  readonly key?: Node
  readonly id?: Node
  readonly init?: Node
  readonly properties?: ReadonlyArray<Node>
}

interface Context {
  readonly report: (input: { readonly node: Node; readonly message: string }) => void
}

/** A node that names nothing: what `nameOf` reads when there is no node. */
const NOTHING: Node = { type: "" }

const nameOf = (node: Node = NOTHING, computed = false): string => {
  if (!computed && node.type === "Identifier") return String(node.name)
  // A string literal is the one value its own String() is.
  if (node.type === "Literal" && String(node.value) === node.value) return String(node.value)
  return ""
}

/** A host-dir variable: HOME or an XDG base dir. */
const isDirVariable = (name: string) => name === "HOME" || name.startsWith("XDG_")

/** `process.env` or `Bun.env`. */
const isEnv = (node: Node = NOTHING) =>
  node.type === "MemberExpression" && ["process", "Bun"].includes(nameOf(node.object)) && nameOf(node.property, node.computed) === "env"

const MESSAGE =
  "A TUI plugin reads HOME and the XDG dirs through decider/tui-dirs.ts (dirs()), the source a simulated TUI points into its scratch: a raw homedir() or env read here takes this machine's own dirs."

const tuiDirsOnly = {
  create: (context: Context) => ({
    CallExpression: (node: Node) => {
      const callee = node.callee ?? NOTHING
      // A member call names its property; a bare call, its callee.
      const name = nameOf(callee.property, callee.computed) || nameOf(callee)
      // `{ homedir: … }.homedir()` names an object's own method, not the host's.
      if (name !== "homedir" || callee.object?.type === "ObjectExpression") return
      context.report({ node, message: MESSAGE })
    },
    MemberExpression: (node: Node) => {
      if (isEnv(node.object) && isDirVariable(nameOf(node.property, node.computed))) context.report({ node, message: MESSAGE })
    },
    VariableDeclarator: (node: Node) => {
      if (!isEnv(node.init ?? NOTHING) || node.id?.type !== "ObjectPattern") return
      for (const property of node.id.properties ?? [])
        if (property.type === "Property" && isDirVariable(nameOf(property.key, property.computed))) context.report({ node: property, message: MESSAGE })
    },
  }),
}

export default tuiDirsOnly
