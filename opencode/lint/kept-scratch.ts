// `dotfiles/kept-suite-folders`: an e2e suite that holds a Kept (tests/scratch.ts's
// keptScratch) makes its folders through the Kept, so its end removes them all and
// nothing is made again after it.
//
// In a file that calls keptScratch, these are refused, at any depth:
// - a recursive `mkdirSync`/`mkdir` (`recursive:` anything but a literal `false`):
//   it makes every missing parent, so one that runs after the suite's end makes
//   the suite's folder again, and nothing removes it. Make each folder parents
//   first without `recursive` (it fails with ENOENT once the suite has ended),
//   or take a fresh one from `kept.dir(prefix)`.
// - `mkdtempSync`/`mkdtemp` and `tmpdir()`: a folder beside the suite's, which its
//   end never removes. Take it from `kept.dir(prefix)`.
// The callee is matched by name, bare (`mkdirSync(…)`) or as a member (`fs.mkdirSync(…)`,
// `fs["mkdirSync"](…)`), through a type assertion, `!` or `?.`.
//
// lint/test-env.test.ts holds a case for each form, in a Kept file and out of one.

interface Node {
  readonly type: string
  readonly name?: string
  readonly value?: unknown
  readonly computed?: boolean
  readonly property?: Node
  readonly callee?: Node
  readonly expression?: Node
  readonly arguments?: ReadonlyArray<Node>
  readonly properties?: ReadonlyArray<Property>
}

/** An object literal's member: `key: value`, or a spread (whose type is not "Property"). */
interface Property {
  readonly type: string
  readonly computed?: boolean
  readonly key?: Node
  readonly value?: Node
}

interface Context {
  readonly report: (report: { readonly node: Node; readonly message: string }) => void
}

/** The stand-in for a missing node: it matches no type. */
const NONE: Node = { type: "" }

const WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ChainExpression"])

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

/** The name a call's callee ends in: `f(…)` → f, `a.f(…)` and `a["f"](…)` → f. */
const calleeName = (call: Node): string => {
  const callee = bare(call.callee)
  if (callee.type === "Identifier") return nameOf(callee)
  if (callee.type === "MemberExpression") return nameOf(callee.property, callee.computed)
  return ""
}

/** Whether a property's value is the literal `false`. */
const isFalse = (value: Node = NONE): boolean => {
  const at = bare(value)
  return at.type === "Literal" && at.value === false
}

/** Whether a mkdir call's options ask for its parents: `{ recursive: <anything but false> }`. */
const recursive = (call: Node): boolean => {
  const options = bare((call.arguments || [])[1])
  if (options.type !== "ObjectExpression") return false
  return (options.properties || []).some((property) => property.type === "Property" && nameOf(property.key, property.computed) === "recursive" && !isFalse(property.value))
}

const MKDIR = new Set(["mkdirSync", "mkdir"])
const TEMP = new Set(["mkdtempSync", "mkdtemp", "tmpdir"])

const RECURSIVE =
  "A Kept suite makes no folder with a recursive mkdir: one that runs after the suite's end makes the suite's folder again and nothing removes it. Make each folder parents first without `recursive` (it fails once the suite has ended), or take a fresh one from kept.dir(prefix)."
const OUTSIDE =
  "A Kept suite makes no folder beside its own (mkdtemp, tmpdir()): the suite's end never removes it. Take a fresh folder from kept.dir(prefix)."

/** The message a call earns in a Kept file; "" for none. */
const refusal = (call: Node, name: string): string => {
  if (MKDIR.has(name) && recursive(call)) return RECURSIVE
  if (TEMP.has(name)) return OUTSIDE
  return ""
}

const keptSuiteFolders = {
  create: (context: Context) => {
    const refused: Array<{ readonly node: Node; readonly message: string }> = []
    const kept = { held: false }
    return {
      CallExpression: (node: Node) => {
        const name = calleeName(node)
        if (name === "keptScratch") kept.held = true
        const message = refusal(node, name)
        if (message !== "") refused.push({ node, message })
      },
      // A file's Kept may come after its first mkdir, so the verdict waits for the file's end.
      "Program:exit": () => {
        if (kept.held) for (const each of refused) context.report(each)
      },
    }
  },
}

export default keptSuiteFolders
