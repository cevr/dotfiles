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
// The callee is matched by name, bare (`mkdirSync(…)`) or as a member (`fs.mkdirSync(…)`).
//
// lint/kept-scratch.test.ts holds a case for each form, in a Kept file and out of one.

interface Node {
  readonly type: string
  readonly name?: string
  readonly value?: unknown
  readonly computed?: boolean
  readonly key?: Node
  readonly property?: Node
  readonly callee?: Node
  readonly expression?: Node
  readonly arguments?: ReadonlyArray<Node>
  readonly properties?: ReadonlyArray<Node>
}

interface Context {
  readonly report: (report: { readonly node: Node; readonly message: string }) => void
}

const WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ChainExpression"])

/** The node under any type assertion, `!` or optional chain. */
const bare = (node: Node | undefined): Node | undefined => {
  let at = node
  while (at && WRAPPERS.has(at.type)) at = at.expression
  return at
}

/** The name a call's callee ends in: `f(…)` → f, `a.f(…)` and `a["f"](…)` → f. */
const calleeName = (call: Node): string | undefined => {
  const callee = bare(call.callee)
  if (callee?.type === "Identifier") return callee.name
  if (callee?.type !== "MemberExpression") return undefined
  const property = callee.property
  if (!callee.computed && property?.type === "Identifier") return property.name
  if (property?.type === "Literal" && typeof property.value === "string") return property.value
  return undefined
}

/** The name of an object property's key: `recursive:` or `"recursive":`. */
const keyName = (property: Node): string | undefined => {
  const key = property.key
  if (!property.computed && key?.type === "Identifier") return key.name
  if (key?.type === "Literal" && typeof key.value === "string") return key.value
  return undefined
}

/** Whether a mkdir call's options ask for its parents: `{ recursive: <anything but false> }`. */
const recursive = (call: Node): boolean => {
  const options = bare(call.arguments?.[1])
  if (options?.type !== "ObjectExpression") return false
  return (options.properties ?? []).some((property) => {
    if (property.type !== "Property" || keyName(property) !== "recursive") return false
    const value = bare(property.value as Node | undefined)
    return !(value?.type === "Literal" && value.value === false)
  })
}

const MKDIR = new Set(["mkdirSync", "mkdir"])
const TEMP = new Set(["mkdtempSync", "mkdtemp", "tmpdir"])

const RECURSIVE =
  "A Kept suite makes no folder with a recursive mkdir: one that runs after the suite's end makes the suite's folder again and nothing removes it. Make each folder parents first without `recursive` (it fails once the suite has ended), or take a fresh one from kept.dir(prefix)."
const OUTSIDE =
  "A Kept suite makes no folder beside its own (mkdtemp, tmpdir()): the suite's end never removes it. Take a fresh folder from kept.dir(prefix)."

const keptSuiteFolders = {
  create: (context: Context) => {
    const refused: Array<{ readonly node: Node; readonly message: string }> = []
    const kept = { held: false }
    return {
      CallExpression: (node: Node) => {
        const name = calleeName(node)
        if (name === "keptScratch") kept.held = true
        else if (name !== undefined && MKDIR.has(name) && recursive(node)) refused.push({ node, message: RECURSIVE })
        else if (name !== undefined && TEMP.has(name)) refused.push({ node, message: OUTSIDE })
      },
      "Program:exit": () => {
        if (kept.held) for (const each of refused) context.report(each)
      },
    }
  },
}

export default keptSuiteFolders
