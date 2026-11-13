// `dotfiles/tui-clock-only`: in the folders our TUI plugins live in (the
// override in .oxlintrc.json), time is read and timers are set only through
// decider/tui-clock.ts (`now`, `after`, `every`), the clock a simulated TUI
// (sim-tui/) holds. A raw read or timer there runs on the wall clock, so a
// seed of a simulated test that reaches it is not replayable.
//
// Refused: `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout` and
// `clearInterval` by name (bare or on `globalThis`, `window`, `global`,
// `self`), `Date.now`, `performance.now`, `Bun.sleep`,
// `Bun.nanoseconds`, `process.hrtime`, and `new Date()` with no argument.
// lint/tui-clock.test.ts holds a case for each.

interface Node {
  readonly type: string
  readonly object?: Node
  readonly property?: Node
  readonly computed?: boolean
  readonly name?: string
  readonly value?: unknown
  readonly callee?: Node
  readonly arguments?: ReadonlyArray<Node>
  readonly parent?: Node
}

interface Context {
  readonly report: (input: { readonly node: Node; readonly message: string }) => void
}

const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval"])
const GLOBALS = new Set(["globalThis", "window", "global", "self"])
/** `object.property` reads of a clock. */
const CLOCKS: ReadonlyArray<readonly [string, string]> = [
  ["Date", "now"],
  ["performance", "now"],
  ["Bun", "sleep"],
  ["Bun", "nanoseconds"],
  ["process", "hrtime"],
]

/** A node that names nothing: what `nameOf` reads when there is no node. */
const NOTHING: Node = { type: "" }

const nameOf = (node: Node = NOTHING, computed = false): string => {
  if (!computed && node.type === "Identifier") return String(node.name)
  // A string literal is the one value its own String() is.
  if (node.type === "Literal" && String(node.value) === node.value) return String(node.value)
  return ""
}

const MESSAGE =
  "A TUI plugin reads time and sets timers through decider/tui-clock.ts (now, once, every), the clock a simulated TUI holds: a raw timer or clock here runs on the wall clock."

/** The member's `object.property` names, when both are plain. */
const member = (node: Node) => [nameOf(node.object), nameOf(node.property, node.computed)] as const

const tuiClockOnly = {
  create: (context: Context) => ({
    Identifier: (node: Node) => {
      if (!TIMERS.has(String(node.name))) return
      const parent = node.parent
      // A property name (`x.setTimeout`, `{ setTimeout: … }`) is not the global, unless the object is the global object.
      if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) {
        if (GLOBALS.has(nameOf(parent.object))) context.report({ node, message: MESSAGE })
        return
      }
      if (parent?.type === "Property" || parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition") return
      if (parent?.type === "ImportSpecifier" || parent?.type === "ExportSpecifier") return
      context.report({ node, message: MESSAGE })
    },
    MemberExpression: (node: Node) => {
      const [object, property] = member(node)
      if (CLOCKS.some(([o, p]) => o === object && p === property)) context.report({ node, message: MESSAGE })
    },
    NewExpression: (node: Node) => {
      if (nameOf(node.callee) === "Date" && (node.arguments ?? []).length === 0) context.report({ node, message: MESSAGE })
    },
  }),
}

export default tuiClockOnly
