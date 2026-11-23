import { Glob } from "bun"
import { Effect, Option, Path, Predicate } from "effect"
import { parseSync } from "oxc-parser"
import { ALL_READS, readDeclarations } from "./read-declarations.ts"
import { child, children, field, id, literal, type MaybeNode, type Node, node, nodes, property, str, unwrap } from "./test-reads-ast.ts"

const path = Effect.runSync(Effect.provide(Path.Path, Path.layer))
// Virtual roots let cwd and module paths mix without reading the host's tree.
const REPO = "/checkout"
const CWD = `${REPO}/opencode`
const TEMP = "/scratch"
const FS = new Set(["fs", "fs/promises"])
const FILE = new Set([
  "readFile", "readFileSync", "readFileString", "createReadStream", "stream", "open", "openSync", "copy", "copyFile", "copyFileSync", "cp", "cpSync", "readLink", "readlink", "readlinkSync",
  "access", "accessSync", "exists", "existsSync", "stat", "statSync", "lstat", "lstatSync", "realPath", "realpath", "realpathSync",
])
const DIRECTORY = new Set(["readDirectory", "readdir", "readdirSync", "opendir", "opendirSync"])
const GIT_READS = new Set(["grep", "ls-files", "ls-tree", "show", "diff"])
const WHOLE_TREE = new Set(["**", "**/*", "./**", "../**"])
const SCOPE = new Set(["Program", "BlockStatement", "ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration", "ForOfStatement", "ForInStatement", "ForStatement", "CatchClause"])
const SCRATCH = new Set([
  "tests/read-path.ts:scratchInput", "tests/read-path.ts:externalInput", "tests/read-path.ts:installedInput", "tests/scratch.ts:scratch", "tests/scratch.ts:keptScratch",
])
const MESSAGE = "cannot resolve read path; use a literal file, a literal directory before the computed part, or a scratch root; for an indirect read declare @reads-indirect dir/** or @reads all"
const keyOf = (at: Node) => `${at.type}:${at.start}`
const argsOf = (at: Node) => nodes(field(at, "arguments"))
const opts = (at: MaybeNode, name: string) => child(nodes(field(at, "properties")).find((prop) => (id(child(prop, "key")) ?? literal(child(prop, "key"))) === name), "value")
const within = (dir: string, file: string) => file === dir || file.startsWith(`${dir}/`)

interface Binding {
  readonly name: string
  readonly scope: number
  readonly value?: Node
  readonly imported?: string
  readonly member?: string
}

const importedFrom = (at: Node, dir: string) => {
  const from = literal(child(at, "source"))?.replace(/^node:/, "") ?? ""
  if (from.startsWith(".")) return path.relative(CWD, path.resolve(dir, from))
  return from
}

const variableBindings = (decl: Node, scope: number, immutable: boolean): ReadonlyArray<Binding> => {
  const target = child(decl, "id")
  const name = id(target)
  if (name && !immutable) return [{ name, scope }]
  const value = child(decl, "init")
  if (name) return [{ name, scope, value }]
  if (target?.type !== "ObjectPattern") return []
  return nodes(field(target, "properties")).flatMap((prop) => {
    const member = id(child(prop, "key")) ?? literal(child(prop, "key"))
    const name = id(child(prop, "value"))
    return (name && member && [{ name, scope, value, member }]) || []
  })
}

const bindingsAt = (at: Node, scope: number, dir: string): ReadonlyArray<Binding> => {
  if (at.type === "ImportDeclaration" && field(at, "importKind") !== "type") {
    const from = importedFrom(at, dir)
    return nodes(field(at, "specifiers")).flatMap((spec) => {
      const name = id(child(spec, "local"))
      if (!name || field(spec, "importKind") === "type") return []
      const imported = id(child(spec, "imported")) ?? literal(child(spec, "imported"))
      return [{ name, scope, imported: (imported && `${from}:${imported}`) || from }]
    })
  }
  if (at.type === "VariableDeclaration") {
    const immutable = ["const", "using", "await using"].includes(String(field(at, "kind")))
    return nodes(field(at, "declarations")).flatMap((decl) => variableBindings(decl, scope, immutable))
  }
  return nodes(field(at, "params")).flatMap((param) => {
    const name = id(param)
    return (name && [{ name, scope }]) || []
  })
}

const builtinModule = (at: Node) => {
  if (at.type !== "CallExpression" || id(child(at, "callee")) !== "require") return ""
  return literal(argsOf(at)[0])?.replace(/^node:/, "") ?? ""
}

const syntaxOf = (program: Node, dir: string) => {
  const entries = new Array<Node>()
  const bindings = new Array<Binding>()
  const scopes = new Map<string, ReadonlyArray<number>>()
  const visit = (at: Node, parent: ReadonlyArray<number>) => {
    const current = (SCOPE.has(at.type) && [...parent, entries.length]) || parent
    scopes.set(keyOf(at), current)
    entries.push(at)
    bindings.push(...bindingsAt(at, current.at(-1) ?? -1, dir))
    for (const each of children(at)) visit(each, current)
  }
  visit(program, [])
  const bindingOf = (at: MaybeNode) => {
    if (!at) return
    const name = id(at)
    for (const scope of (scopes.get(keyOf(at)) ?? []).toReversed()) {
      const binding = bindings.find((item) => item.name === name && item.scope === scope)
      if (binding) return binding
    }
  }
  const symbol = (at: MaybeNode, seen = new Set<string>()): string => {
    if (!at || seen.has(keyOf(at))) return ""
    const binding = bindingOf(at)
    if (binding?.imported) return binding.imported
    if (binding?.value) {
      const base = symbol(unwrap(binding.value), new Set([...seen, keyOf(at)]))
      if (binding.member) return memberSymbol(base, binding.member)
      return base
    }
    if (binding) return ""
    const builtin = builtinModule(at)
    if (builtin) return builtin
    if (at.type === "CallExpression") {
      const callee = child(at, "callee")
      if (property(callee) === "bind") return symbol(child(callee, "object"), seen)
    }
    const member = property(at)
    if (!member) return id(at) ?? ""
    const object = child(at, "object")
    return memberSymbol(symbol(object, seen), member)
  }
  return { entries, bindingOf, symbol }
}

const memberSymbol = (base: string, member: string) => {
  if (base === "fs" && member === "promises") return "fs/promises"
  if (["effect:FileSystem:FileSystem", "effect/FileSystem:FileSystem"].includes(base)) return `fs:${member}`
  if (["effect:Path:Path", "effect/Path:Path"].includes(base)) return `path:${member}`
  return (base && `${base}:${member}`) || ""
}
type Syntax = ReturnType<typeof syntaxOf>

type Address = { readonly prefix: string; readonly tail: boolean } | { readonly glob: string } | { readonly opaque: string }
type Resolved = Option.Option<Address>
type Evaluation = (node: MaybeNode) => Resolved
const fixed = (prefix: string): Resolved => Option.some({ prefix, tail: false })
const computed = (prefix: string): Resolved => Option.some({ prefix, tail: true })
const opaque = (reason: string): Resolved => Option.some({ opaque: reason })
const prefixOf = (at: Resolved) => Option.flatMap(at, (address) => ("prefix" in address && Option.some(address)) || Option.none())
const literalPath = (at: Resolved) => Option.map(Option.filter(prefixOf(at), (address) => !address.tail), ({ prefix }) => prefix)
const temporary = (at: Resolved) => Option.exists(prefixOf(at), ({ prefix }) => within(TEMP, path.resolve(CWD, prefix)))
const pathParts = (parts: ReadonlyArray<Resolved>, separator: string): Resolved => {
  let prefix = ""
  for (const part of parts) {
    const next = prefixOf(part)
    if (Option.isNone(next)) {
      const dir = (separator && prefix) || prefix.slice(0, prefix.lastIndexOf("/") + 1)
      return (dir && computed(dir)) || Option.none()
    }
    if (prefix && next.value.prefix) prefix += separator
    prefix += next.value.prefix
    if (next.value.tail) return computed(prefix)
  }
  return fixed(prefix)
}

const template = (at: Node, read: Evaluation) => {
  const expressions = nodes(field(at, "expressions"))
  const parts = nodes(field(at, "quasis")).flatMap((quasi, index) => {
    const value = field(quasi, "value")
    const text = (Predicate.isObject(value) && "cooked" in value && str(value.cooked)) || ""
    if (index === expressions.length) return [fixed(text)]
    return [fixed(text), read(expressions[index])]
  })
  return pathParts(parts, "")
}

const moduleConstant = (imported: string, loadSource: (file: string) => string) => {
  const [from = "", name = ""] = imported.split(":")
  if (!name || !/\.tsx?$/.test(from)) return
  const text = loadSource(from)
  if (!text) return
  for (const item of parseSync(from, text).program.body) {
    if (item.type !== "ExportNamedDeclaration" || item.declaration?.type !== "VariableDeclaration" || item.declaration.kind !== "const") continue
    for (const decl of item.declaration.declarations)
      if (decl.id.type === "Identifier" && decl.id.name === name) return literal(node(decl.init))
  }
}

const platformPath = (called: string, callee: MaybeNode, args: ReadonlyArray<Node>, read: Evaluation): Resolved => {
  if (called === "Bun:resolveSync" || called === "bun:resolveSync") {
    const pkg = literal(args[0]) ?? ""
    if (/^(?:@[^./]+\/)?[\w-]/.test(pkg) && !pkg.startsWith("@dotfiles/") && Option.isSome(literalPath(read(args[1])))) return fixed(TEMP)
  }
  if (called === "fs:mkdtempSync" || called === "fs/promises:mkdtemp") {
    if (temporary(read(args[0]))) return fixed(TEMP)
  }
  if (called === "fs:makeTempDirectoryScoped" || called === "fs:makeTempDirectory") {
    const directory = opts(args[0], "directory")
    if (!directory || temporary(read(directory))) return fixed(TEMP)
  }
  if (property(callee) === "dir" && temporary(read(child(callee, "object")))) return fixed(TEMP)
  return Option.none()
}

const composedPath = (called: string, args: ReadonlyArray<Node>, read: Evaluation) => {
  const parts = args.map(read)
  if (called === "path:join") return pathParts(parts, "/")
  const absolute = parts.findLastIndex((part) => Option.exists(prefixOf(part), ({ prefix }) => path.isAbsolute(prefix)))
  return pathParts(parts.slice(Math.max(0, absolute)), "/")
}

const callPath = (called: string, callee: MaybeNode, args: ReadonlyArray<Node>, read: Evaluation): Resolved => {
  if (called === "process:cwd") return fixed(CWD)
  if (called === "os:tmpdir" || SCRATCH.has(called)) return fixed(TEMP)
  if (called === "tests/read-path.ts:matchingInput")
    return Option.map(literalPath(read(args[0])), (glob) => ({ glob }))
  if (["url:fileURLToPath", "fs:realpathSync", "fs:realPath", "path:fromFileUrl"].includes(called)) return read(args[0])
  if (called === "effect:Effect:gen") {
    const returns = nodes(field(child(args[0], "body"), "body")).filter((statement) => statement.type === "ReturnStatement")
    if (returns.length === 1) return read(child(returns[0], "argument"))
  }
  if (called === "URL") {
    const target = literal(args[0])
    if (Predicate.isString(target)) return Option.flatMap(literalPath(read(args[1])), (base) => fixed(path.resolve(path.dirname(base), target)))
  }
  if (called === "path:dirname") return Option.flatMap(literalPath(read(args[0])), (target) => fixed(path.dirname(target)))
  if (["path:join", "path:resolve"].includes(called)) return composedPath(called, args, read)
  return platformPath(called, callee, args, read)
}

const memberPath = (at: Node, absolute: string, read: Evaluation): Resolved => {
  const object = child(at, "object")
  const member = property(at)
  if (object?.type === "MetaProperty") {
    if (member === "dir") return fixed(path.dirname(absolute))
    if (member === "url" || member === "path") return fixed(absolute)
  }
  if (member === "path" && temporary(read(object))) return fixed(TEMP)
  return Option.none()
}

const identifierPath = (binding: ReturnType<Syntax["bindingOf"]>, loadSource: (file: string) => string, read: Evaluation): Resolved => {
  const imported = moduleConstant(binding?.imported ?? "", loadSource)
  if (Predicate.isString(imported)) return fixed(imported)
  if (binding?.member === "path" && temporary(read(binding.value))) return fixed(TEMP)
  if (binding?.member) return Option.none()
  return read(binding?.value)
}

const evaluate = (file: string, syntax: Syntax, loadSource: (file: string) => string): Evaluation => {
  const absolute = path.resolve(CWD, file)
  const valueOf = (expr: MaybeNode, seen = new Set<string>()): Resolved => {
    const at = unwrap(expr)
    if (!at || seen.has(keyOf(at))) return Option.none()
    const val = literal(at)
    if (Predicate.isString(val)) return fixed(val)
    const again: Evaluation = (value) => valueOf(value, new Set([...seen, keyOf(at)]))
    if (at.type === "Identifier") return identifierPath(syntax.bindingOf(at), loadSource, again)
    if (at.type === "MemberExpression") return memberPath(at, absolute, again)
    if (at.type === "TemplateLiteral") return template(at, again)
    if (at.type === "BinaryExpression" && field(at, "operator") === "+") return pathParts([again(child(at, "left")), again(child(at, "right"))], "")
    if (at.type === "CallExpression" || at.type === "NewExpression") {
      const callee = child(at, "callee")
      return callPath(syntax.symbol(callee), callee, argsOf(at), again)
    }
    return Option.none()
  }
  return valueOf
}

const regexGlob = /[*?[\]{]/
const patternOf = (input: Address, cwd: string, listing: boolean): Option.Option<string> => {
  if ("opaque" in input) return Option.none()
  if ("glob" in input) return Option.some(input.glob)
  const at = path.resolve(cwd, input.prefix)
  if (within(TEMP, at)) return Option.some("")
  if (!input.tail && !listing && (at === CWD || at === REPO)) return Option.some("")
  if (!within(REPO, at) || (input.tail && [CWD, REPO].includes(at))) return Option.none()
  const rel = path.relative(CWD, at) || "."
  if (input.tail || listing) return Option.some(`${rel}/**`)
  return Option.some(rel)
}

const alternatives = (glob: string) => {
  if (!glob.startsWith("{") || !glob.endsWith("}")) return []
  const parts = new Array<string>()
  let start = 1
  let depth = 0
  for (let index = start; index < glob.length - 1; index++) {
    const character = glob[index]
    if (character === "{") depth++
    if (character === "}") depth--
    if (depth < 0) return []
    if (depth === 0 && character === ",") {
      parts.push(glob.slice(start, index))
      start = index + 1
    }
  }
  if (parts.length === 0 || depth !== 0) return []
  return [...parts, glob.slice(start, -1)]
}
const wholeTree = (pattern: string): boolean => WHOLE_TREE.has(pattern) || alternatives(pattern).some(wholeTree)
const indirectDirectory = (pattern: string) => {
  const directory = pattern.replace(/^\.\.\//, "")
  return /^(?:[\w.-]+\/)+\*\*$/.test(directory) && directory.split("/").every((part) => part !== "." && part !== "..")
}
const covers = (declared: ReadonlyArray<string>, needed: string): boolean => {
  if (wholeTree(needed)) return false
  if (declared.includes(needed) || declared.some((glob) => alternatives(glob).includes(needed))) return true
  const union = alternatives(needed)
  if (union.length > 0) return union.every((part) => covers(declared, part))
  if (!regexGlob.test(needed)) return declared.some((glob) => new Glob(glob).match(needed))
  const parts = needed.split("/")
  const stable = parts.slice(0, parts.findIndex((segment) => regexGlob.test(segment))).join("/")
  return declared.some((glob) => glob.endsWith("/**") && within(glob.slice(0, -3), stable))
}

type ReadSite = (at: Node, input: Resolved, cwd?: string, listing?: boolean) => void
const gitReads = (at: Node, args: ReadonlyArray<Node>, cwd: string, from: number, evaluate: Evaluation, record: ReadSite) => {
  const words = args.map(literal)
  if (words[from] === "show") {
    const [object = ""] = words.slice(from + 1)
    const name = object.match(/^[a-zA-Z0-9_.@~^/-]+:(.+)$/)?.[1]
    if (name && words.length === from + 2) return record(at, fixed(name), (name.startsWith("./") && cwd) || REPO)
    return record(at, opaque("Git command or object reads"))
  }
  const divider = words.indexOf("--")
  if (divider >= 0 && args[divider + 1])
    for (const argument of args.slice(divider + 1)) record(at, evaluate(argument), cwd)
  else record(at, computed(cwd))
}

const childReads = (at: Node, program: string, args: ReadonlyArray<Node>, directory: MaybeNode, evaluate: Evaluation, record: ReadSite) => {
  const command = path.basename(program)
  if (!["git", "grep", "rg", "cat"].includes(command)) return record(at, opaque("subprocess reads"))
  if (args.some((arg) => !Predicate.isString(literal(arg)))) return record(at, opaque("nonliteral subprocess arguments"))
  const dashC = args.map(literal).indexOf("-C")
  const from = (dashC >= 0 && dashC + 2) || 0
  const sub = literal(args[from])
  if (command === "git" && sub && !GIT_READS.has(sub)) {
    if (["rev-parse", "branch", "version", "--version"].includes(sub)) return
    return record(at, opaque("Git command or object reads"))
  }
  const override = (command === "git" && dashC >= 0 && args[dashC + 1]) || directory
  const cwd = (override && evaluate(override)) || fixed(CWD)
  if (temporary(cwd) && command === "git") return
  const base = literalPath(cwd)
  if (Option.isNone(base)) return record(at, Option.none())
  const dir = path.resolve(CWD, base.value)
  if (command === "git") return gitReads(at, args, dir, from, evaluate, record)
  if (args.some((argument) => literal(argument)?.startsWith("-"))) return record(at, opaque("subprocess options"))
  const operands = args.slice(Number(command !== "cat"))
  if (operands.length === 0) return record(at, opaque("implicit subprocess inputs"))
  for (const file of operands) record(at, evaluate(file), dir)
}

const shellRead = (at: Node, syntax: Syntax, record: ReadSite) => {
  if (["bun:$", "Bun:$"].includes(syntax.symbol(child(at, "tag")))) record(at, opaque("shell reads"))
}

const globRead = (at: Node, syntax: Syntax, evaluate: Evaluation, record: ReadSite) => {
  const callee = child(at, "callee")
  if (!["scan", "scanSync"].includes(property(callee) ?? "")) return
  const instance = unwrap(child(callee, "object"))
  const declared = syntax.bindingOf(instance)?.value ?? instance
  if (declared?.type !== "NewExpression" || !["bun:Glob", "Bun:Glob"].includes(syntax.symbol(child(declared, "callee")))) return
  const [arg] = argsOf(at)
  const explicit = opts(arg, "cwd")
  const implicit = (!arg || arg.type === "ObjectExpression") && !explicit
  const cwd = (implicit && fixed(CWD)) || evaluate(explicit ?? arg)
  if (temporary(cwd)) return
  const base = literalPath(cwd)
  if (Option.isNone(base)) return record(at, Option.none())
  record(at, evaluate(argsOf(declared)[0]), path.resolve(CWD, base.value))
}

const filesystemCall = (called: string) => {
  const [module = "", method = ""] = called.split(":")
  return (FS.has(module) && (FILE.has(method) || DIRECTORY.has(method))) || ["Bun:file", "bun:file"].includes(called)
}

const BUN_SPAWN = new Set(["bun:spawn", "bun:spawnSync", "Bun:spawn", "Bun:spawnSync"])
const CHILD_SPAWN = new Set(["child_process:spawn", "child_process:spawnSync", "child_process:execFile", "child_process:execFileSync", "effect/process:ChildProcess:make"])
const EXEC_SHELL = new Set(["child_process:exec", "child_process:execSync"])
const ARGV_HELPER = new Set(["tests/owned.ts:owned", "tests/reconnect/host.ts:run"])

// Executable workspace modules are opaque. Do not infer purity from the
// absence of a known filesystem API: an unused-looking import can run code,
// and a forwarding module can hide an arbitrary helper.
const MODULE_DATA = /\.json$/
const CHECKED_HELPERS = new Set(["tests/scratch.ts", "tests/read-path.ts"])
const workspacePackage = (specifier: string) => specifier.startsWith("@dotfiles/")

const importedHelper = (at: Node, dir: string, record: ReadSite) => {
  if (field(at, "importKind") === "type") return
  const specifier = literal(child(at, "source"))
  if (!specifier) return
  const specifiers = nodes(field(at, "specifiers"))
  if (specifiers.length > 0 && specifiers.every((spec) => field(spec, "importKind") === "type")) return
  if (workspacePackage(specifier)) return record(at, opaque(`imported workspace package ${specifier}`))
  if (!specifier.startsWith(".")) return
  const file = importedFrom(at, dir)
  if (!MODULE_DATA.test(file) && !CHECKED_HELPERS.has(file)) record(at, opaque(`imported helper ${file}`))
}

const dynamicMember = (at: MaybeNode, symbol: Syntax["symbol"]) => {
  if (at?.type !== "MemberExpression" || !field(at, "computed") || property(at)) return false
  const module = symbol(child(at, "object"))
  return FS.has(module) || ["Bun", "bun", "child_process", "effect:FileSystem:FileSystem", "effect/FileSystem:FileSystem"].includes(module)
}

const processRead = (at: Node, called: string, args: ReadonlyArray<Node>, evaluate: Evaluation, record: ReadSite) => {
  if (EXEC_SHELL.has(called)) return record(at, opaque("shell reads"))
  if (ARGV_HELPER.has(called)) return record(at, opaque("subprocess helper reads"))
  if (BUN_SPAWN.has(called)) {
    const argv = nodes(field(opts(args[0], "cmd") ?? args[0], "elements"))
    return childReads(at, literal(argv[0]) ?? "", argv.slice(1), opts(args[1] ?? args[0], "cwd"), evaluate, record)
  }
  if (CHILD_SPAWN.has(called))
    return childReads(at, literal(args[0]) ?? "", nodes(field(args[1], "elements")), opts(args[2], "cwd"), evaluate, record)
}

const callRead = (at: Node, syntax: Syntax, evaluate: Evaluation, record: ReadSite) => {
  const callee = child(at, "callee")
  const called = syntax.symbol(callee)
  const args = argsOf(at)
  if (dynamicMember(callee, syntax.symbol)) return record(at, opaque("computed filesystem or process method"))
  if (called === "eval" || called === "Function") return record(at, opaque("evaluated program reads"))
  if (called === "require") {
    const name = literal(args[0])
    if (!name || /^[./]/.test(name) || workspacePackage(name)) return record(at, opaque("dynamically required module"))
  }
  if (called === "tests/read-path.ts:matchingInput") return record(at, evaluate(at))
  if (filesystemCall(called)) {
    const [, method = ""] = called.split(":")
    const recursive = ["cp", "cpSync"].includes(method) && field(opts(args[2], "recursive"), "value") === true
    return record(at, evaluate(args[0]), CWD, DIRECTORY.has(method) || method === "copy" || recursive)
  }
  processRead(at, called, args, evaluate, record)
  globRead(at, syntax, evaluate, record)
}

export interface ReadCheck {
  readonly patterns: ReadonlyArray<string>
  readonly indirect: ReadonlyArray<{ readonly line: number; readonly reason: string }>
  readonly classification: "static" | "declared" | "unknown"
  readonly issues: ReadonlyArray<{ readonly line: number; readonly message: string }>
}

const declarationsAt = (source: string, parsed: ReturnType<typeof parseSync>) =>
  parsed.comments.flatMap(({ start, end }) => readDeclarations(source.slice(start, end)))

const parserFailure = (messages: ReadonlyArray<string>): ReadCheck =>
  ({ patterns: [], indirect: [], classification: "unknown", issues: messages.map((message) => ({ line: 1, message })) })

const checkSite = (at: Node, fileDir: string, syntax: Syntax, valueOf: Evaluation, record: ReadSite) => {
  if (at.type === "ImportDeclaration") return importedHelper(at, fileDir, record)
  if (at.type === "TaggedTemplateExpression") return shellRead(at, syntax, record)
  if (at.type === "CallExpression") return callRead(at, syntax, valueOf, record)
  if (at.type === "NewExpression" && syntax.symbol(child(at, "callee")) === "Function") return record(at, opaque("evaluated program reads"))
  if (at.type !== "ImportExpression") return
  const target = child(at, "source")
  const name = literal(target)
  if (!Predicate.isString(name) || name.startsWith(".") || name.startsWith("/")) record(at, valueOf(target), fileDir)
  if (!Predicate.isString(name)) record(at, opaque("dynamically loaded module"))
  else if ((/^[./]/.test(name) && !MODULE_DATA.test(name)) || workspacePackage(name)) record(at, opaque("dynamically loaded helper"))
}

const readClassification = (unknown: boolean, count: number): ReadCheck["classification"] => {
  if (unknown) return "unknown"
  if (count > 0) return "declared"
  return "static"
}

export const checkReadInputs = (file: string, source: string, loadSource: (file: string) => string = () => ""): ReadCheck => {
  const parsed = parseSync(file, source, { sourceType: "module" })
  if (parsed.errors.length > 0) return parserFailure(parsed.errors.map(({ message }) => message))
  const program = node(parsed.program)
  if (!program) return parserFailure(["source did not produce a syntax tree"])
  const fileDir = path.dirname(path.resolve(CWD, file))
  const syntax = syntaxOf(program, fileDir)
  const valueOf = evaluate(file, syntax, loadSource)
  const found = new Set<string>()
  const issues = new Array<ReadCheck["issues"][number]>()
  const indirect = new Array<ReadCheck["indirect"][number]>()
  const declarations = declarationsAt(source, parsed)
  const declared = declarations.map(({ pattern }) => pattern)
  const hasAll = declared.includes(ALL_READS)
  const hasScope = declarations.some(({ indirect, pattern }) => indirect && indirectDirectory(pattern))
  const lineOf = (at: Node) => source.slice(0, at.start).split("\n").length
  const issue = (at: Node, message: string) => issues.push({ line: lineOf(at), message })
  const record: ReadSite = (at, input, cwd = CWD, listing = false) => {
    const needed = Option.flatMap(input, (address) => patternOf(address, cwd, listing))
    if (Option.isNone(needed)) {
      const reason = Option.getOrElse(Option.flatMap(input, (address) => ("opaque" in address && Option.some(address.opaque)) || Option.none()), () => "computed read")
      indirect.push({ line: lineOf(at), reason })
      if (!hasAll && !hasScope) issue(at, `${MESSAGE}: ${reason}`)
      return
    }
    if (!needed.value) return
    found.add(needed.value)
    if (!hasAll && !covers(declared, needed.value)) issue(at, `declare @reads ${needed.value}`)
  }
  if (readDeclarations(source).some(({ pattern, indirect }) => !declarations.some((each) => each.pattern === pattern && each.indirect === indirect)))
    issue(program, "@reads declarations must be source comments, not text in a string")
  if (declared.some(wholeTree)) issue(program, "@reads must name the input or use @reads all for an opaque read")
  if (declarations.some(({ indirect, pattern }) => indirect && !indirectDirectory(pattern)))
    issue(program, "@reads-indirect must name a directory ending in /**; for an unknown scope use @reads all")
  for (const at of syntax.entries) checkSite(at, fileDir, syntax, valueOf, record)
  return { patterns: [...found].toSorted(), indirect, issues, classification: readClassification(hasAll || (indirect.length > 0 && !hasScope), indirect.length) }
}
