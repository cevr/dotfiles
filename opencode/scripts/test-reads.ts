import { Effect, Option, Path, Predicate } from "effect"
import { parseSync } from "oxc-parser"
import { ALL_READS, alternatives, readDeclarations, readReasons } from "./read-declarations.ts"
import { child, children, field, id, literal, type MaybeNode, type Node, node, nodes, property, str, unwrap } from "./test-reads-ast.ts"
import { entryRegions, exportedAliases, moduleReferences, type Reference, regionOf, regionsOf } from "./test-reads-modules.ts"

const path = Effect.runSync(Effect.provide(Path.Path, Path.layer))
// Virtual roots let cwd and module paths mix without reading the host's tree.
const REPO = "/checkout"
const CWD = `${REPO}/opencode`
const TEMP = "/scratch"
const EXTERNAL = "/external-checked-input"
/** Virtual address for a resolution known to belong to a locked installed package. */
export const INSTALLED_MODULE = "/installed-dependency"
const FS = new Set(["fs", "fs/promises"])
const FILE = new Set([
  "readFile", "readFileSync", "readFileString", "createReadStream", "stream", "open", "openSync", "copy", "copyFile", "copyFileSync", "cp", "cpSync", "readLink", "readlink", "readlinkSync",
  "access", "accessSync", "exists", "existsSync", "stat", "statSync", "lstat", "lstatSync", "realPath", "realpath", "realpathSync",
])
const DIRECTORY = new Set(["readDirectory", "readdir", "readdirSync", "opendir", "opendirSync"])
const GIT_READS = new Set(["grep", "ls-files", "ls-tree", "show", "diff"])
const WHOLE_TREE = new Set(["**", "**/*", "./**", "../**"])
const SCOPE = new Set(["Program", "BlockStatement", "ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration", "ForOfStatement", "ForInStatement", "ForStatement", "CatchClause"])
const ERASED_SYNTAX = new Set([
  "TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSTypeAnnotation", "TSTypeParameterDeclaration",
  "TSTypeParameterInstantiation", "TSTypeQuery", "TSImportType",
])
const SCRATCH = new Set([
  "tests/read-path.ts:scratchInput", "tests/read-path.ts:installedInput", "tests/scratch.ts:scratch", "tests/scratch.ts:keptScratch",
])
const MESSAGE = "cannot prove the read stays in scope; use a literal path or matchingInput with a declared scope; otherwise declare @reads all and name the opaque site in @reads-reason"
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
  const bindings = new Map<number, Map<string, Binding>>()
  const scopes = new Map<string, ReadonlyArray<number>>()
  const visit = (at: Node, parent: ReadonlyArray<number>) => {
    if (ERASED_SYNTAX.has(at.type)) return
    const current = (SCOPE.has(at.type) && [...parent, entries.length]) || parent
    scopes.set(keyOf(at), current)
    entries.push(at)
    const scope = current.at(-1) ?? -1
    const own = bindings.get(scope) ?? new Map<string, Binding>()
    for (const binding of bindingsAt(at, scope, dir)) if (!own.has(binding.name)) own.set(binding.name, binding)
    bindings.set(scope, own)
    for (const each of children(at)) visit(each, current)
  }
  visit(program, [])
  const bindingOf = (at: MaybeNode) => {
    if (!at) return
    const name = id(at)
    if (!name) return
    for (const scope of (scopes.get(keyOf(at)) ?? []).toReversed()) {
      const binding = bindings.get(scope)?.get(name)
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

type Address = { readonly prefix: string; readonly tail: boolean } | { readonly choices: ReadonlyArray<string> } | { readonly glob: string; readonly bounded: boolean } | { readonly opaque: string }
type Resolved = Option.Option<Address>
type Evaluation = (node: MaybeNode) => Resolved
const fixed = (prefix: string): Resolved => Option.some({ prefix, tail: false })
const computed = (prefix: string): Resolved => Option.some({ prefix, tail: true })
const opaque = (reason: string): Resolved => Option.some({ opaque: reason })
const prefixOf = (at: Resolved) => Option.flatMap(at, (address) => ("prefix" in address && Option.some(address)) || Option.none())
const literalPath = (at: Resolved) => Option.map(Option.filter(prefixOf(at), (address) => !address.tail), ({ prefix }) => prefix)
const temporary = (at: Resolved) => Option.exists(literalPath(at), (prefix) => within(TEMP, path.resolve(CWD, prefix)))
const choicesOf = (at: Resolved): ReadonlyArray<string> =>
  Option.match(at, { onNone: () => [], onSome: (address) => ("choices" in address && address.choices) || Option.toArray(literalPath(at)) })
const choice = (paths: ReadonlyArray<string>): Resolved => {
  const distinct = [...new Set(paths)]
  if (distinct.length === 0 || distinct.length > 32) return Option.none()
  if (distinct.length === 1) return fixed(distinct.join(""))
  return Option.some({ choices: distinct })
}
const combinations = (parts: ReadonlyArray<Resolved>) => {
  let rows: ReadonlyArray<ReadonlyArray<string>> = [[]]
  for (const item of parts) {
    const paths = choicesOf(item)
    if (paths.length === 0 || rows.length * paths.length > 32) return []
    rows = rows.flatMap((set) => paths.map((file) => [...set, file]))
  }
  return rows
}
const pathParts = (parts: ReadonlyArray<Resolved>, separator: string): Resolved => {
  if (parts.some((part) => Option.exists(part, (address) => "choices" in address)))
    return choice(combinations(parts).map((set) => set.join(separator)))
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
  const finite = combinations(parts)
  if (finite.length > 0) return choice(finite.map((each) => (called === "path:join" && path.join(...each)) || path.resolve(CWD, ...each)))
  if (called === "path:join") return pathParts(parts, "/")
  const absolute = parts.findLastIndex((part) => Option.exists(prefixOf(part), ({ prefix }) => path.isAbsolute(prefix)))
  return pathParts(parts.slice(Math.max(0, absolute)), "/")
}

const callPath = (called: string, callee: MaybeNode, args: ReadonlyArray<Node>, read: Evaluation): Resolved => {
  if (called === "process:cwd") return fixed(CWD)
  if (called === "os:tmpdir" || SCRATCH.has(called)) return fixed(TEMP)
  if (called === "tests/read-path.ts:externalInput") return fixed(EXTERNAL)
  if (called === "tests/read-path.ts:matchingInput") {
    const target = literalPath(read(args[1] ?? args[0]))
    if (Option.isSome(target)) return fixed(path.resolve(CWD, target.value))
    return Option.map(literalPath(read(args[0])), (glob) => ({ glob, bounded: true }))
  }
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

const resolveCandidates = (args: ReadonlyArray<Node>, read: Evaluation, loadSource: Source, resolvePackage: ResolvePackage) =>
  combinations([read(args[0]), read(args[1])]).map(([name = "", dir = ""]) => {
    const cwd = path.resolve(CWD, dir)
    const local = name.startsWith(".") || path.isAbsolute(name)
    const from = path.relative(CWD, path.join(cwd, "resolver.ts"))
    const request = (path.isAbsolute(name) && `./${path.relative(cwd, name)}`) || name
    const found = resolvePackage(request, from) || (local && modulePath(name, cwd, loadSource)) || ""
    return { name, found, files: (local && modulePaths(name, cwd)) || [] }
  })

const RESOLVE_SYNC = new Set(["bun:resolveSync", "Bun:resolveSync"])
const evaluate = (file: string, syntax: Syntax, loadSource: Source, resolvePackage: ResolvePackage): Evaluation => {
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
    if (at.type === "ConditionalExpression") {
      const yes = choicesOf(again(child(at, "consequent")))
      const no = choicesOf(again(child(at, "alternate")))
      return (yes.length > 0 && no.length > 0 && choice([...yes, ...no])) || Option.none()
    }
    if (at.type === "BinaryExpression" && field(at, "operator") === "+") return pathParts([again(child(at, "left")), again(child(at, "right"))], "")
    if (at.type === "CallExpression" || at.type === "NewExpression") {
      const callee = child(at, "callee")
      const called = syntax.symbol(callee)
      const args = argsOf(at)
      if (RESOLVE_SYNC.has(called)) {
        const candidates = resolveCandidates(args, again, loadSource, resolvePackage)
        if (candidates.some(({ found }) => !found)) return Option.none()
        return choice(candidates.map(({ found }) => path.resolve(CWD, found)))
      }
      return callPath(called, callee, args, again)
    }
    return Option.none()
  }
  return valueOf
}

const patternOf = (input: Address, cwd: string, listing: boolean): Option.Option<string> => {
  if ("opaque" in input) return Option.none()
  if ("glob" in input) return Option.some(input.glob)
  if ("choices" in input) {
    const parts = input.choices.map((prefix) => patternOf({ prefix, tail: false }, cwd, listing))
    if (parts.some(Option.isNone)) return Option.none()
    return Option.some(parts.flatMap(Option.toArray).filter(Boolean).join(",").replace(/.*,.*$/, "{$&}"))
  }
  const at = path.resolve(cwd, input.prefix)
  if (input.tail) return Option.none()
  if (at === INSTALLED_MODULE || at === EXTERNAL) return Option.some("")
  if (within(TEMP, at)) return Option.some("")
  if (listing && (at === CWD || at === REPO)) return Option.none()
  if (!input.tail && !listing && (at === CWD || at === REPO)) return Option.some("")
  if (!within(REPO, at)) return Option.none()
  const rel = path.relative(CWD, at) || "."
  if (listing) return Option.some(`${rel}/**`)
  return Option.some(rel)
}

const wholeTree = (pattern: string): boolean => WHOLE_TREE.has(pattern) || alternatives(pattern).some(wholeTree)
const indirectDirectory = (pattern: string) => {
  const directory = pattern.replace(/^\.\.\//, "")
  return /^(?:[\w.-]+\/)+\*\*$/.test(directory) && directory.split("/").every((part) => part !== "." && part !== "..")
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

// sleep accepts only durations. This ps form names only columns, never a file (other ps flags can).
const psQuery = (args: ReadonlyArray<Node>) => {
  const [first, second, third, fourth] = args.map(literal)
  return (args.length === 2 && (first === "-p" || (first === "-axo" && /^[a-z=, ]+$/.test(second ?? "")))) ||
    (args.length === 5 && first === "-ww" && second === "-o" && third === "command=" && fourth === "-p")
}

const noFileOperands = (command: string, args: ReadonlyArray<Node>) =>
  command === "sleep" || (command === "ps" && psQuery(args)) ||
  (command === "uname" && args.length === 1 && literal(args[0]) === "-s")

const childDirectory = (command: string, dashC: number, args: ReadonlyArray<Node>, directory: MaybeNode, evaluate: Evaluation) => {
  const override = (command === "git" && dashC >= 0 && args[dashC + 1]) || directory
  return (override && evaluate(override)) || fixed(CWD)
}

const childReads = (at: Node, program: string, args: ReadonlyArray<Node>, directory: MaybeNode, evaluate: Evaluation, record: ReadSite) => {
  const command = program.replace(/^(?:\/usr)?\/bin\//, "")
  if (noFileOperands(command, args)) return
  if (command === "cat" && args.length === 1 && temporary(evaluate(args[0]))) return
  if (!["git", "grep", "rg", "cat"].includes(command)) return record(at, opaque("subprocess reads"))
  if (args.some((arg) => !Predicate.isString(literal(arg)))) return record(at, opaque("nonliteral subprocess arguments"))
  const dashC = args.map(literal).indexOf("-C")
  const from = (dashC >= 0 && dashC + 2) || 0
  const sub = literal(args[from])
  if (command === "git" && sub && !GIT_READS.has(sub)) {
    if (["rev-parse", "branch", "version", "--version"].includes(sub)) return
    return record(at, opaque("Git command or object reads"))
  }
  const cwd = childDirectory(command, dashC, args, directory, evaluate)
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

const MODULE_DATA = /\.(?:json|toml|txt|md)$/
// These adapters keep process/scratch housekeeping separate from the caller's inputs.
// Their read and spawn entrypoints are modeled at the call (including unknown argv).
const CHECKED_HELPERS = new Set(["tests/scratch.ts", "tests/read-path.ts", "tests/owned.ts", "tests/scratch-child.ts", "tests/lint-fixture.ts"])
const BOUNDED_PROCESS = new Set([
  "tests/scratch-child.ts", "tests/scratch-child.ts:spawnScratchGitSync", "tests/scratch-child.ts:spawnScratchShell", "tests/owned.ts:ownedScratchShell",
  "tests/scratch-child.ts:scratchBunJUnitSync",
  "tests/scratch-child.ts:spawnCheckoutShellSync",
  "tests/scratch-child.ts:checkoutShellFixtureCommand",
  "tests/scratch-child.ts:spawnScratchZshSync",
  "tests/scratch-child.ts:scratchPtyCommand",
  "tests/scratch-child.ts:scratchPtyEnv",
  "tests/scratch-child.ts:spawnScratchProgram",
  "tests/scratch-child.ts:runScratchTool",
  "tests/scratch-child.ts:spawnScratchShellFileSync",
  "tests/scratch-child.ts:spawnScratchShellFile",
  "tests/scratch-child.ts:installedGitManual",
  "tests/scratch-child.ts:scratchGitVersion",
  "tests/scratch-child.ts:scratchArchive",
  "tests/scratch-child.ts:scratchHostConfig",
  "tests/scratch-child.ts:checkoutBlob",
  "tests/scratch-child.ts:initScratchGit",
  "tests/scratch-child.ts:cloneScratchGit",
  "tests/scratch-child.ts:detachedCheckoutBun",
  "tests/scratch-child.ts:checkoutBunCommand",
  "tests/scratch-child.ts:spawnCheckoutBun",
  "tests/scratch-child.ts:spawnCheckoutBunSync",
  "tests/scratch-child.ts:checkoutBun",
  "tests/owned.ts:ownedCheckoutBun",
  "tests/scratch-child.ts:forkServiceCommand",
  "tests/scratch-child.ts:forkProcessCommand",
  "tests/scratch-child.ts:forkFixture",
  "tests/scratch-child.ts:spawnForkFixture",
  "tests/scratch-child.ts:importForkCredentials",
  "tests/owned.ts:ownedForkFixture",
  "tests/lint-fixture.ts", "tests/lint-fixture.ts:lintFixture", "tests/lint-fixture.ts:lintCheckoutFixture",
])
const LINT_FIXTURE = new Set(["tests/lint-fixture.ts:lintFixture", "tests/lint-fixture.ts:lintCheckoutFixture"])
const DETACHED_CHECKOUT_BUN = "tests/scratch-child.ts:detachedCheckoutBun"
const CHECKOUT_BUN = new Set([
  DETACHED_CHECKOUT_BUN, "tests/scratch-child.ts:checkoutBun", "tests/scratch-child.ts:checkoutBunCommand",
  "tests/scratch-child.ts:spawnCheckoutBun", "tests/owned.ts:ownedCheckoutBun",
  "tests/scratch-child.ts:spawnCheckoutBunSync",
])
const workspacePackage = (specifier: string) => specifier.startsWith("@dotfiles/")

const executableImport = (at: Node) => {
  if (field(at, "importKind") === "type" || field(at, "exportKind") === "type") return false
  const specifiers = nodes(field(at, "specifiers"))
  return !specifiers.length || specifiers.some((spec) => field(spec, "importKind") !== "type" && field(spec, "exportKind") !== "type")
}

const dynamicMember = (at: MaybeNode, symbol: Syntax["symbol"]) => {
  if (at?.type !== "MemberExpression" || !field(at, "computed") || property(at)) return false
  const module = symbol(child(at, "object"))
  return FS.has(module) || ["Bun", "bun", "child_process", "effect:FileSystem:FileSystem", "effect/FileSystem:FileSystem"].includes(module)
}

const scenarioArg = (called: string, args: ReadonlyArray<Node>) => {
  if (called !== "tests/owned.ts:owned" || args[0]?.type !== "ArrayExpression") return ""
  const argv = nodes(field(args[0], "elements")).map(literal)
  const [program, launcher, command, entry] = argv
  if (argv.length !== 4 || program !== "bunx" || launcher !== "opencode-drive" || command !== "run") return ""
  return (entry?.startsWith("scenarios/") && entry.endsWith(".ts") && entry) || ""
}

const ownedArgv = (called: string, args: ReadonlyArray<Node>) =>
  (called === "tests/owned.ts:owned" && args[0]?.type === "ArrayExpression" && nodes(field(args[0], "elements"))) || []

const ownedEntry = (called: string, args: ReadonlyArray<Node>, evaluate: Evaluation) => {
  const argv = ownedArgv(called, args)
  if (argv.length !== 2 || literal(argv[0]) !== "bun") return ""
  const cwd = opts(args[1], "cwd")
  if (cwd && !Option.exists(literalPath(evaluate(cwd)), (dir) => path.resolve(CWD, dir) === CWD)) return ""
  const entry = literal(argv[1]) ?? ""
  if (!/^(?:[\w.-]+\/)+[\w.-]+\.[cm]?[jt]sx?$/.test(entry)) return ""
  const normalized = path.relative(CWD, path.resolve(CWD, entry))
  return (!normalized.startsWith("../") && normalized) || ""
}

const ownedEnvironmentOnly = (called: string, args: ReadonlyArray<Node>) => {
  const argv = ownedArgv(called, args)
  return argv.length === 1 && literal(argv[0]) === "/usr/bin/env"
}

const checkoutBunEntry = (called: string, args: ReadonlyArray<Node>, evaluate: Evaluation) => {
  if (!CHECKOUT_BUN.has(called)) return ""
  return Option.getOrElse(literalPath(evaluate(args[0])), () => "")
}

const objectProperties = (at: MaybeNode) =>
  nodes(field(at, "properties"))
const literalObject = (at: MaybeNode) => {
  if (at?.type !== "ObjectExpression") return false
  const keys = new Set<string>()
  for (const item of objectProperties(at)) {
    const key = id(child(item, "key")) ?? literal(child(item, "key"))
    if (item.type !== "Property" || field(item, "computed") || field(item, "kind") !== "init" || !key || key === "__proto__" || keys.has(key)) return false
    keys.add(key)
  }
  return true
}

const checkoutBunInputs = (at: Node, inputs: MaybeNode, evaluate: Evaluation, record: ReadSite) => {
  if (!literalObject(inputs)) return record(at, opaque("computed checkout fixture inputs"))
  const checkout = opts(inputs, "checkout")
  if (!checkout) return
  if (!literalObject(checkout)) return record(at, opaque("computed checkout fixture operands"))
  for (const item of objectProperties(checkout)) record(at, evaluate(child(item, "value")))
}

const argvHelperRead = (at: Node, called: string, args: ReadonlyArray<Node>, evaluate: Evaluation, record: ReadSite) => {
  if (ownedEnvironmentOnly(called, args)) return
  const module = ownedEntry(called, args, evaluate)
  if (module) {
    record(at, fixed(module))
    return record(at, fixed("bun.plugins/config"))
  }
  const scenario = scenarioArg(called, args)
  const cwd = opts(args[1], "cwd")
  const root = Option.getOrElse(literalPath(evaluate(cwd)), () => "")
  if (scenario && (!cwd || (root && path.resolve(CWD, root) === CWD))) {
    record(at, fixed(scenario))
    return record(at, fixed("bunx.plugins/config"))
  }
  return record(at, opaque("subprocess helper reads"))
}

const processRead = (at: Node, called: string, args: ReadonlyArray<Node>, evaluate: Evaluation, record: ReadSite) => {
  if (LINT_FIXTURE.has(called)) {
    record(at, fixed("lint/test-env.ts"))
    if (called === "tests/lint-fixture.ts:lintCheckoutFixture") {
      record(at, fixed(".oxlintrc.json"))
      record(at, Option.map(literalPath(evaluate(args[0])), (glob) => ({ glob, bounded: true })))
    }
    return
  }
  if (called === "tests/scratch-child.ts:spawnCheckoutShellSync") return record(at, evaluate(args[1]))
  if (called === "tests/scratch-child.ts:checkoutShellFixtureCommand") return record(at, evaluate(args[0]))
  if (called === "tests/scratch-child.ts:checkoutBlob") {
    if (!Option.exists(literalPath(evaluate(args[0])), (sha) => /^[a-f0-9]{40}$/.test(sha))) return record(at, opaque("nonliteral Git revision"))
    return record(at, evaluate(args[1]))
  }
  if (EXEC_SHELL.has(called)) return record(at, opaque("shell reads"))
  if (ARGV_HELPER.has(called)) return argvHelperRead(at, called, args, evaluate, record)
  if (BUN_SPAWN.has(called)) {
    const command = opts(args[0], "cmd") ?? args[0]
    if (command?.type !== "ArrayExpression") return record(at, opaque("nonliteral subprocess argv"))
    const argv = nodes(field(command, "elements"))
    return childReads(at, literal(argv[0]) ?? "", argv.slice(1), opts(args[1] ?? args[0], "cwd"), evaluate, record)
  }
  if (CHILD_SPAWN.has(called)) {
    if (args[1]?.type !== "ArrayExpression") return record(at, opaque("nonliteral subprocess argv"))
    return childReads(at, literal(args[0]) ?? "", nodes(field(args[1], "elements")), opts(args[2], "cwd"), evaluate, record)
  }
}

const callRead = (at: Node, syntax: Syntax, evaluate: Evaluation, record: ReadSite) => {
  const callee = child(at, "callee")
  const called = syntax.symbol(callee)
  const args = argsOf(at)
  if (called === "Bun:mmap" || called === "bun:mmap") return record(at, evaluate(args[0]))
  if (called === "@opencode-tui/test/fixture/app.ts:createAppFixture")
    return record(at, opaque("native TUI plugin loader reads"))
  if (dynamicMember(callee, syntax.symbol)) return record(at, opaque("computed filesystem or process method"))
  if (called === "eval" || called === "Function") return record(at, opaque("evaluated program reads"))
  if (called === "tests/read-path.ts:matchingInput") return record(at, evaluate(at))
  if (called === "tests/read-path.ts:readInputText") return record(at, callPath("tests/read-path.ts:matchingInput", callee, args, evaluate))
  if (called === "tests/read-path.ts:resolveRuntimeInput")
    return record(at, Option.map(literalPath(evaluate(args[0])), (glob) => ({ glob, bounded: true })))
  if (filesystemCall(called)) {
    const [, method = ""] = called.split(":")
    const recursive = ["cp", "cpSync"].includes(method) && field(opts(args[2], "recursive"), "value") === true
    return record(at, evaluate(args[0]), CWD, DIRECTORY.has(method) || method === "copy" || recursive)
  }
  if (CHECKOUT_BUN.has(called)) {
    const entry = checkoutBunEntry(called, args, evaluate)
    if (!entry) return record(at, opaque("nonliteral checkout entry"))
    record(at, fixed(entry))
    if (called !== DETACHED_CHECKOUT_BUN) checkoutBunInputs(at, args[1], evaluate, record)
    return record(at, fixed("bun.plugins/config"))
  }
  processRead(at, called, args, evaluate, record)
  globRead(at, syntax, evaluate, record)
}

export interface ReadCheck {
  readonly patterns: ReadonlyArray<string>
  /** Parts of the selection that are enforced at runtime rather than proved as literal paths. */
  readonly bounded: ReadonlyArray<string>
  readonly indirect: ReadonlyArray<{ readonly line: number; readonly reason: string }>
  readonly classification: "static" | "declared" | "unknown"
  readonly issues: ReadonlyArray<{ readonly line: number; readonly message: string }>
}

const parserFailure = (messages: ReadonlyArray<string>): ReadCheck =>
  ({ patterns: [], bounded: [], indirect: [], classification: "unknown", issues: messages.map((message) => ({ line: 1, message })) })

const checkSite = (at: Node, syntax: Syntax, valueOf: Evaluation, record: ReadSite) => {
  if (at.type === "TaggedTemplateExpression") return shellRead(at, syntax, record)
  if (at.type === "CallExpression") return callRead(at, syntax, valueOf, record)
  if (at.type === "NewExpression" && syntax.symbol(child(at, "callee")) === "Function") return record(at, opaque("evaluated program reads"))
}

const readClassification = (unknown: boolean, count: number): ReadCheck["classification"] => {
  if (unknown) return "unknown"
  if (count > 0) return "declared"
  return "static"
}

interface Site {
  readonly file: string
  readonly line: number
  readonly region: string
  readonly result: Resolved
  readonly cwd: string
  readonly listing: boolean
}

type Source = (file: string) => string
type ResolvePackage = (specifier: string, from: string) => string
const LOCAL_MODULE = new Set(["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"])
const modulePaths = (specifier: string, dir: string) => {
  const base = path.relative(CWD, path.resolve(dir, specifier))
  const stem = base.replace(/\.[cm]?jsx?$/, "")
  if (/\.[cm]?tsx?$/.test(base)) return [base]
  if (stem !== base) return [base, `${stem}.ts`, `${stem}.tsx`]
  return [base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js", "/package.json"].map((suffix) => base + suffix)]
}

const modulePath = (specifier: string, dir: string, loadSource: Source) => modulePaths(specifier, dir).find(loadSource) ?? ""

const moduleEdge = (at: Node, current: string, dir: string, loadSource: Source, resolvePackage: ResolvePackage, record: ReadSite) => {
  if (!LOCAL_MODULE.has(at.type) || !executableImport(at)) return ""
  const specifier = literal(child(at, "source")) ?? ""
  if (MODULE_DATA.test(specifier)) return ""
  if (!specifier.startsWith(".") && !workspacePackage(specifier)) return ""
  const next = (specifier.startsWith(".") && modulePath(specifier, dir, loadSource)) || resolvePackage(specifier, current)
  if (next === INSTALLED_MODULE) return ""
  if (next) {
    // The legacy import walk only knows opencode/ files. Keep an actual
    // sibling import, and its edges back into opencode/, as inputs here.
    if (next.startsWith("../") || current.startsWith("../")) record(at, fixed(next))
    return next
  }
  record(at, opaque(`unresolved helper ${specifier}`))
  return ""
}

const resolutionAt = (at: Node, syntax: Syntax, read: Evaluation, loadSource: Source, resolvePackage: ResolvePackage, record: ReadSite) => {
  const called = syntax.symbol(child(at, "callee"))
  if (at.type !== "CallExpression" || !RESOLVE_SYNC.has(called)) return
  const operands = resolveCandidates(argsOf(at), read, loadSource, resolvePackage)
  if (operands.length === 0) return record(at, opaque("computed module resolver reads"))
  for (const { name, found, files } of operands) {
    if (!found) {
      record(at, opaque(`unresolved resolver candidate ${name}`))
      continue
    }
    for (const file of new Set([found, ...files])) record(at, fixed(file))
  }
}

const graph = () => ({
  imports: new Map<string, Reference[]>(),
  symbols: new Map<string, Set<string>>(),
  dynamics: new Map<string, Reference[]>(),
  initializers: new Set<string>(),
  deferred: new Set<string>(),
})
type Graph = ReturnType<typeof graph>

const referenceAt = (graph: Graph, at: Node, next: string) => {
  if (!next) return
  graph.initializers.add(next)
  if (at.type === "ImportDeclaration" && CHECKED_HELPERS.has(next)) return
  for (const { local, target } of moduleReferences(at, next))
    graph.imports.set(local, [...(graph.imports.get(local) ?? []), target])
}

const importedCandidate = (name: string, dir: string, current: string, load: Source, resolvePackage: ResolvePackage) => {
    const local = name.startsWith(".") || path.isAbsolute(name)
    const request = (path.isAbsolute(name) && `./${path.relative(dir, name)}`) || name
    const next = resolvePackage(request, current) || (local && modulePath(name, dir, load))
    const files = (local && modulePaths(name, dir)) || []
    return { local, next, files }
}

const importedModule = (at: Node, target: Node, name: string, dir: string, current: string, load: Source, resolvePackage: ResolvePackage, record: ReadSite) => {
  const location = path.resolve(dir, name)
  if (location === INSTALLED_MODULE || location === EXTERNAL) return ""
  if (within(TEMP, location)) {
    record(at, opaque("generated module reads"))
    return ""
  }
  if (MODULE_DATA.test(name)) {
    record(at, fixed(name), dir)
    return ""
  }
  const { local, next, files } = importedCandidate(name, dir, current, load, resolvePackage)
  if (next === INSTALLED_MODULE) return ""
  if (!next) {
    // Like an installed static import, a literal package need not have source here.
    if (!literal(target) || local || workspacePackage(name)) record(at, opaque(`unresolved loaded module ${name}`))
    return ""
  }
  for (const file of new Set([next, ...files])) record(at, fixed(file))
  return next
}

const dynamicTarget = (at: Node, syntax: Syntax) =>
  (at.type === "ImportExpression" && child(at, "source")) ||
  (at.type === "CallExpression" && syntax.symbol(child(at, "callee")) === "require" && argsOf(at)[0])

const dynamicModuleAt = (graph: Graph, at: Node, region: string, current: string, syntax: Syntax, read: Evaluation, load: Source, resolvePackage: ResolvePackage, record: ReadSite) => {
  const target = dynamicTarget(at, syntax)
  if (!target) return
  const candidates = choicesOf(read(target))
  if (candidates.length === 0) return record(at, opaque("dynamically loaded module"))
  const dir = path.dirname(path.resolve(CWD, current))
  for (const name of candidates) {
    const next = importedModule(at, target, name, dir, current, load, resolvePackage, record)
    if (next) graph.dynamics.set(region, [...(graph.dynamics.get(region) ?? []), { file: next, symbol: "*" }])
  }
}

const entrypointAt = (graph: Graph, at: Node, region: string, syntax: Syntax, evaluate: Evaluation) => {
  if (at.type !== "CallExpression") return
  const called = syntax.symbol(child(at, "callee"))
  const args = argsOf(at)
  if (LINT_FIXTURE.has(called)) {
    graph.dynamics.set(region, [...(graph.dynamics.get(region) ?? []), { file: "lint/test-env.ts", symbol: "*" }])
    return
  }
  const module = ownedEntry(called, args, evaluate) || checkoutBunEntry(called, args, evaluate)
  if (module) graph.dynamics.set(region, [...(graph.dynamics.get(region) ?? []), { file: module, symbol: "@main" }])
}

const memberNames = new Set(["MemberExpression", "Property", "MethodDefinition", "PropertyDefinition"])
const symbolAt = (graph: Graph, at: Node, region: string, nonReferences: ReadonlySet<string>, syntax: Syntax) => {
  const symbol = id(at)
  if (!symbol || nonReferences.has(keyOf(at))) return
  const binding = syntax.bindingOf(at)
  // Local values are analyzed where they are defined; their names do not also
  // call an unrelated, same-named top-level export.
  if (binding && binding.scope !== 0) return
  const names = graph.symbols.get(region) ?? new Set<string>()
  names.add(symbol)
  graph.symbols.set(region, names)
}


const escapedProcess = (at: Node, syntax: Syntax, signatures: ReadonlySet<string>, calls: ReadonlySet<string>) =>
  id(at) && !signatures.has(keyOf(at)) && !calls.has(keyOf(at)) &&
  (["tests/owned.ts", "tests/owned.ts:owned"].includes(syntax.symbol(at)) || BOUNDED_PROCESS.has(syntax.symbol(at)))

const nonReferencesOf = (entries: ReadonlyArray<Node>) => new Set(entries.flatMap((at) => {
  const specifiers = nodes(field(at, "specifiers")).flatMap(children).map(keyOf)
  const declaration = ["ClassDeclaration", "FunctionDeclaration", "VariableDeclarator"].includes(at.type) && child(at, "id")
  const nonReferences = (declaration && [...specifiers, keyOf(declaration)]) || specifiers
  if (!memberNames.has(at.type) || field(at, "computed") || field(at, "shorthand")) return nonReferences
  const key = child(at, "property") ?? child(at, "key")
  return (key && [...nonReferences, keyOf(key)]) || nonReferences
}))

const inspect = (file: string, source: string, loadSource: Source, resolvePackage: ResolvePackage) => {
  const parsed = parseSync(file, source, { sourceType: "module" })
  const program = node(parsed.program)
  const errors = parsed.errors.map(({ message }) => message)
  if (!program) errors.push("source did not produce a syntax tree")
  const sites = new Array<Site>()
  const refs = graph()
  if (!program || errors.length > 0) return { sites, ...refs, errors, comments: [] }
  const fileDir = path.dirname(path.resolve(CWD, file))
  const syntax = syntaxOf(program, fileDir)
  const valueOf = evaluate(file, syntax, loadSource, resolvePackage)
  const regions = [...entryRegions(syntax.entries), ...regionsOf(program, syntax.symbol)]
  const signatures = nonReferencesOf(syntax.entries)
  const calls = new Set(syntax.entries.flatMap((at) => {
    const callee = child(at, "callee")
    return (at.type === "CallExpression" && callee && [keyOf(callee)]) || []
  }))
  for (const { symbol } of regions) if (symbol !== "@main") refs.deferred.add(symbol)
  const record: ReadSite = (at, result, cwd = CWD, listing = false) => {
    sites.push({ file, line: source.slice(0, at.start).split("\n").length, region: regionOf(regions, at), result, cwd, listing })
  }
  for (const at of syntax.entries) {
    const region = regionOf(regions, at)
    symbolAt(refs, at, region, signatures, syntax)
    referenceAt(refs, at, moduleEdge(at, file, fileDir, loadSource, resolvePackage, record))
    dynamicModuleAt(refs, at, region, file, syntax, valueOf, loadSource, resolvePackage, record)
    entrypointAt(refs, at, region, syntax, valueOf)
    if (escapedProcess(at, syntax, signatures, calls)) record(at, opaque("escaped subprocess helper"))
    resolutionAt(at, syntax, valueOf, loadSource, resolvePackage, record)
    checkSite(at, syntax, valueOf, record)
  }
  for (const { original, alias } of exportedAliases(program)) {
    refs.symbols.set(alias, new Set([...(refs.symbols.get(alias) ?? []), original]))
    refs.deferred.add(alias)
  }
  return { sites, ...refs, errors, comments: parsed.comments.map(({ start, end }) => source.slice(start, end)) }
}

type Inspection = ReturnType<typeof inspect>
const referencesOf = (file: string, symbol: string, summary: Inspection): ReadonlyArray<Reference> => {
  if (symbol === "*") {
    const owned = [...summary.deferred, ...summary.imports.keys()].flatMap((name) => (name !== "*" && [{ file, symbol: name }]) || [])
    return [{ file, symbol: "" }, ...owned, ...(summary.imports.get("*") ?? [])]
  }
  const refs = [...(summary.dynamics.get(symbol) ?? [])]
  if (!symbol) {
    for (const next of summary.initializers) refs.push({ file: next, symbol: "" })
  } else {
    refs.push({ file, symbol: "" }, ...(summary.imports.get(symbol) ?? []), ...(summary.imports.get("*") ?? []))
  }
  for (const name of summary.symbols.get(symbol) ?? []) {
    if (summary.deferred.has(name)) refs.push({ file, symbol: name })
    refs.push(...(summary.imports.get(name) ?? []))
  }
  return refs
}

const allSites = (file: string, root: Inspection, examine: (file: string) => Inspection) => {
  const seen = new Set<string>()
  const queue = new Map<string, Reference>()
  const add = (reference: Reference) => queue.set(`${reference.file}\0${reference.symbol}`, reference)
  add({ file, symbol: "" })
  const sites = new Set<Site>()
  for (const [key, reference] of queue) {
    if (seen.has(key)) continue
    seen.add(key)
    const summary = (reference.file === file && root) || examine(reference.file)
    for (const next of referencesOf(reference.file, reference.symbol, summary)) add(next)
    for (const site of summary.sites) if (site.region === reference.symbol) sites.add(site)
    if (reference.file !== file && !reference.symbol && summary.errors.length > 0)
      sites.add({ file: reference.file, line: 1, region: "", result: opaque("unparsed helper"), cwd: CWD, listing: false })
  }
  return [...sites]
}

const unknownReason = (result: Resolved) =>
  Option.getOrElse(Option.flatMap(result, (address) => ("opaque" in address && Option.some(address.opaque)) || Option.none()), () => "computed read")

const patternParts = (pattern: string): ReadonlyArray<string> => {
  const parts = alternatives(pattern)
  return (parts.length > 0 && parts.flatMap(patternParts)) || [pattern]
}

const checkScope = (pattern: string, declarations: ReturnType<typeof readDeclarations>) => {
  const indirect = indirectDirectory(pattern)
  if (declarations.some((each) => each.pattern === pattern && each.indirect === indirect)) return ""
  return `declare @reads${(indirect && "-indirect") || ""} ${pattern}`
}

const siteReport = (file: string, sites: ReadonlyArray<Site>, declarations: ReturnType<typeof readDeclarations>, hasAll: boolean) => {
  const found = new Set<string>()
  const bounded = new Set<string>()
  const issues = new Array<ReadCheck["issues"][number]>()
  const indirect = new Array<ReadCheck["indirect"][number]>()
  for (const site of sites) {
    const needed = Option.flatMap(site.result, (address) => patternOf(address, site.cwd, site.listing))
    const origin = (site.file !== file && ` (${site.file}:${site.line})`) || ""
    const at = (site.file === file && site.line) || 1
    if (Option.isNone(needed)) {
      const reason = `${unknownReason(site.result)}${origin}`
      indirect.push({ line: at, reason })
      if (!hasAll) issues.push({ line: at, message: `${MESSAGE}: ${reason}` })
      continue
    }
    if (!needed.value) continue
    found.add(needed.value)
    if (!Option.exists(site.result, (a) => "glob" in a && a.bounded)) continue
    for (const scope of patternParts(needed.value)) {
      bounded.add(scope)
      const fix = !hasAll && checkScope(scope, declarations)
      if (fix) issues.push({ line: at, message: `${fix}${origin}` })
    }
  }
  return { found, bounded, issues, indirect }
}

const reasonFor = (annotation: string, site: ReadCheck["indirect"][number], file: string) => {
  const [, kind = site.reason, owner = file] = /^(.*?) \((.+):\d+\)$/.exec(site.reason) ?? []
  const prefix = `${kind} at ${owner}: `
  return annotation.startsWith(prefix) && annotation.length > prefix.length
}

const unsupportedDeclarations = (declarations: ReturnType<typeof readDeclarations>, bounded: ReadonlySet<string>) =>
  declarations.flatMap(({ indirect, pattern }) => {
    if (indirect && !indirectDirectory(pattern)) return ["@reads-indirect must name a directory ending in /**; for an unknown scope use @reads all"]
    if (!indirect && pattern === ALL_READS) return []
    if (bounded.has(pattern)) return []
    return [`remove unsupported @reads${(indirect && "-indirect") || ""} ${pattern}: no read site needs that scope`]
  })

const report = (file: string, source: string, comments: ReadonlyArray<string>, sites: ReadonlyArray<Site>): ReadCheck => {
  const declarations = comments.flatMap(readDeclarations)
  const reasons = comments.flatMap(readReasons)
  const declared = declarations.map(({ pattern }) => pattern)
  const hasAll = declared.includes(ALL_READS)
  const { found, bounded, issues, indirect } = siteReport(file, sites, declarations, hasAll)
  const issue = (message: string) => issues.push({ line: 1, message })
  if (hasAll && indirect.length === 0) issue("remove @reads all: no opaque read remains; declare the exact inputs instead")
  if (hasAll && indirect.length > 0 && !reasons.some((reason) => indirect.some((site) => reasonFor(reason, site, file))))
    issue("add @reads-reason <reported kind> at <file>: <opaque operation>")
  if (readDeclarations(source).some(({ pattern, indirect }) => !declarations.some((each) => each.pattern === pattern && each.indirect === indirect)))
    issue("@reads declarations must be source comments, not text in a string")
  if (declared.some(wholeTree)) issue("@reads must name the input or use @reads all for an opaque read")
  for (const message of unsupportedDeclarations(declarations, bounded)) issue(message)
  return { patterns: [...found].toSorted(), bounded: [...bounded].toSorted(), indirect, issues, classification: readClassification(indirect.length > 0, bounded.size) }
}

export const readInputChecker = (loadSource: Source, resolvePackage: ResolvePackage = () => "") => {
  const modules = new Map<string, Inspection>()
  const examine = (file: string) => {
    const cached = modules.get(file)
    if (cached) return cached
    const next = inspect(file, loadSource(file), loadSource, resolvePackage)
    modules.set(file, next)
    return next
  }
  return (file: string, source: string): ReadCheck => {
    const root = inspect(file, source, loadSource, resolvePackage)
    if (root.errors.length > 0) return parserFailure(root.errors)
    return report(file, source, root.comments, allSites(file, root, examine))
  }
}

export const checkReadInputs = (file: string, source: string, loadSource: Source = () => ""): ReadCheck =>
  readInputChecker(loadSource)(file, source)
