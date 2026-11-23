// `dotfiles/chrome-mock-keychain`: every argument list that starts a Chrome
// with its DevTools protocol (`--remote-debugging-port…`, `--remote-debugging-
// pipe`, `--remote-debugging-address…`) or headless (`--headless…`) passes
// `--use-mock-keychain` and `--password-store=basic`. Without them Chrome reads
// its Safe Storage key from the login keychain at startup, and for a Chrome not
// on that item's access list (Chrome for Testing, a new Chromium build) macOS
// puts a keychain dialog on the owner's screen at each launch. The guard
// (mods/guard/chrome.ts) refuses such a launch from a shell line or a scratch
// script; this rule holds the repository's own launchers (mods/rex's browser,
// scripts/chrome.ts) to it.
//
// A list's flags are its string literals, the first part of each template
// literal, and the literals of a top-level `const NAME = [...]` of the same
// file it spreads (`[...KEYCHAIN_FLAGS, "--headless"]`). A flag built at run
// time is not read. lint/chrome-keychain.test.ts holds a case for each form.

interface Node {
  readonly type: string
  readonly parent?: Node
  readonly value?: unknown
  readonly name?: string
  /** An array's elements; a hole (`[a, , b]`) is no node at all, which `present` drops. */
  readonly elements?: ReadonlyArray<Node>
  readonly quasis?: ReadonlyArray<{ readonly value: { readonly cooked?: string } }>
  readonly argument?: Node
  readonly body?: ReadonlyArray<Node>
  readonly declaration?: Node
  readonly declarations?: ReadonlyArray<Node>
  readonly id?: Node
  readonly init?: Node
}

/** Whether an element is a node, not a hole. */
const present = (node: Node): boolean => Boolean(node)

interface Context {
  readonly report: (input: { readonly node: Node; readonly message: string }) => void
}

/** The flags that keep a Chrome off the login keychain: the mock keychain (macOS) and the plain password store (Linux). */
const KEYCHAIN_FLAGS = ["--use-mock-keychain", "--password-store=basic"]

const MESSAGE =
  "A Chrome started with its DevTools protocol or headless passes --use-mock-keychain and --password-store=basic: without them it reads the login keychain, and macOS puts a keychain dialog on the owner's screen at each launch. Add both flags to the list (or start Chrome with scripts/chrome.ts)."

/** A node that holds nothing: what the rule reads where there is no node. */
const NOTHING: Node = { type: "" }

/** Whether a flag opens Chrome's DevTools protocol or runs it headless. */
const opens = (flag: string) => flag.startsWith("--remote-debugging-") || flag.startsWith("--headless")

/** The text an element starts with: a string literal's value, a template's first part; "" for anything else. */
const headOf = (node: Node): string => {
  if (node.type === "Literal" && String(node.value) === node.value) return node.value
  if (node.type === "TemplateLiteral") return String(node.quasis?.[0]?.value.cooked ?? "")
  return ""
}

/** The program a node lies in. */
const programOf = (node: Node): Node => {
  let at = node
  while (at.type !== "Program" && at.parent) at = at.parent
  return at
}

/** The statement a top-level statement declares: an export's declaration, else itself. */
const declared = (statement: Node): Node => {
  if (statement.type === "ExportNamedDeclaration") return statement.declaration ?? NOTHING
  return statement
}

/** The elements of the array literal a top-level `const name = [...]` of `program` binds, exported or not. */
const boundElements = (program: Node, name: string): ReadonlyArray<Node> =>
  (program.body ?? [])
    .map(declared)
    .filter((statement) => statement.type === "VariableDeclaration")
    .flatMap((declaration) => declaration.declarations ?? [])
    .filter((declarator) => declarator.id?.name === name && declarator.init?.type === "ArrayExpression")
    .flatMap((declarator) => (declarator.init?.elements ?? []).filter(present))

/** The flags an array literal holds: its literals, and those of a same-file `const` list it spreads. */
const flagsOf = (array: Node): ReadonlyArray<string> =>
  (array.elements ?? []).filter(present).flatMap((element) => {
    if (element.type === "SpreadElement" && element.argument?.type === "Identifier")
      return boundElements(programOf(array), String(element.argument.name)).map(headOf)
    return [headOf(element)]
  })

const chromeMockKeychain = {
  create: (context: Context) => ({
    ArrayExpression: (node: Node) => {
      const flags = flagsOf(node)
      if (flags.some(opens) && !KEYCHAIN_FLAGS.every((flag) => flags.includes(flag))) context.report({ node, message: MESSAGE })
    },
  }),
}

export default chromeMockKeychain
