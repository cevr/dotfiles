// tests/git-repo.ts: a test's temp git repository runs no background gc or maintenance, so a clone
// of it under load never races a lock file git's upkeep removes (batch ar: scripts/upstream.test.ts
// "the upstream reading" failed copying `.git/objects/maintenance.lock`). Every test makes its
// repositories through gitInit and gitClone, which quiet each one; a call in test code that runs
// git's own `init` or `clone` is refused, so no repository is left loud. The guard reads each
// file's syntax tree, so a string that only names a git command (an expected log line) is no site,
// and it reads git's argv with the guard's own reader (mods/guard/verdict.ts), global options and all.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Option, Order, Predicate } from "effect"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type Argument,
  type ArrayExpressionElement,
  type ArrowFunctionExpression,
  type CallExpression,
  type Function,
  type ObjectPropertyKind,
  type ParamPattern,
  parseSync,
  Visitor,
} from "oxc-parser"
import { gitSubcommand } from "../mods/guard/verdict.ts"
import { type GitGlobalOptions, gitGlobalOptions } from "./git-options.ts"
import { gitClone, gitInit, QUIET_GIT } from "./git-repo.ts"
import { scratch } from "./scratch.ts"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

/** What `git config --get` reads for each quiet key in the repository at `dir`. */
const settings = (dir: string) =>
  Object.fromEntries(Object.keys(QUIET_GIT).map((key) => [key, execFileSync("git", ["-C", dir, "config", "--get", key], { encoding: "utf8" }).trim()]))

const QUIET = { "gc.auto": "0", "maintenance.auto": "false" }

/**
 * One word of a git argv as test code writes it: a string literal, a name, a spread of a name, or
 * anything else; in a wrapper's template, also the wrapper's own parameter (`param`, one argument)
 * or rest parameter (`rest`, every argument from there on), by position.
 */
type Item =
  | { readonly kind: "literal" | "name" | "spread"; readonly text: string }
  | { readonly kind: "other" }
  | { readonly kind: "param" | "rest"; readonly index: number }

const OTHER: Item = { kind: "other" }

/** The words of `Bun.spawn({ cmd: [...] })`'s options: its `cmd`. */
const cmdOf = (properties: ReadonlyArray<ObjectPropertyKind>): ReadonlyArray<Item> =>
  properties.flatMap((property) => {
    if (property.type !== "Property" || property.key.type !== "Identifier" || property.key.name !== "cmd") return []
    return items(property.value)
  })

/** The words one argument stands for: an array literal's elements, a spread array's, one word else. */
const items = (node: Argument | ArrayExpressionElement): ReadonlyArray<Item> => {
  if (Predicate.isNull(node)) return [OTHER]
  if (node.type === "ArrayExpression") return node.elements.flatMap(items)
  if (node.type === "ObjectExpression") return cmdOf(node.properties)
  if (node.type === "SpreadElement" && node.argument.type === "ArrayExpression") return items(node.argument)
  if (node.type === "SpreadElement" && node.argument.type === "Identifier") return [{ kind: "spread", text: node.argument.name }]
  if (node.type === "SpreadElement") return [OTHER]
  if (node.type === "Literal" && Predicate.isString(node.value)) return [{ kind: "literal", text: node.value }]
  if (node.type === "Identifier") return [{ kind: "name", text: node.name }]
  return [OTHER]
}

/**
 * How a wrapper turns its call's arguments into git's argv (the words after `git`): a template of
 * words and parameter slots, or `lenient` for a `git` the file calls without defining (an import,
 * `repo.git(…)`), whose leading non-literal arguments (a directory, an env) are taken as its own.
 */
type Template = { readonly kind: "argv"; readonly words: ReadonlyArray<Item> } | { readonly kind: "lenient" }

/** The name a call's callee goes by: `f(…)`, or `x.git(…)`, the one method read as a wrapper. */
const calleeName = (call: CallExpression): Option.Option<string> => {
  const { callee } = call
  if (callee.type === "Identifier") return Option.some(callee.name)
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" && callee.property.name === "git") return Option.some("git")
  return Option.none()
}

/** A wrapper's template with the call's arguments in its slots. */
const fill = (template: Template, args: ReadonlyArray<ReadonlyArray<Item>>): ReadonlyArray<Item> => {
  if (template.kind === "lenient") return Arr.dropWhile(args.flat(), (word) => word.kind !== "literal")
  return template.words.flatMap((word) => {
    if (word.kind === "param") return Option.getOrElse(Arr.get(args, word.index), () => [])
    if (word.kind === "rest") return args.slice(word.index).flat()
    return [word]
  })
}

/**
 * The git argv a call runs, when it runs git: a call to a wrapper fills the wrapper's template; a
 * call that spawns git itself names "git" in its argv (`Bun.spawnSync(["git", …])`,
 * `execFileSync("git", […])`, `run(cwd, "git", …)`), and the words after it are git's.
 */
const argvOf = (call: CallExpression, wrappers: ReadonlyMap<string, Template>): Option.Option<ReadonlyArray<Item>> => {
  const args = call.arguments.map(items)
  const wrapper = Option.flatMap(calleeName(call), (name) => Option.fromNullishOr(wrappers.get(name)))
  if (Option.isSome(wrapper)) return Option.some(fill(wrapper.value, args))
  const flat = args.flat()
  const git = flat.findIndex((word) => word.kind === "literal" && word.text === "git")
  if (git < 0) return Option.none()
  return Option.some(flat.slice(git + 1))
}

/**
 * What git runs for `argv`, read by mods/guard/verdict.ts's reader: its subcommand, none when that
 * word is not written as a literal; and whether an option before it is one the reader does not
 * know, so the subcommand cannot be read at all.
 */
interface ReadArgv {
  readonly subcommand: Option.Option<string>
  readonly unreadable: boolean
}

const readArgv = (argv: ReadonlyArray<Item>): ReadArgv => {
  const words = argv.map((word) => {
    if (word.kind === "literal") return word.text
    return "\u0000"
  })
  const read = gitSubcommand(words)
  if (read.kind === "unreadable") return { subcommand: Option.none(), unreadable: true }
  return { subcommand: Option.filter(Option.some(read.name), (name) => name !== "\u0000" && name !== ""), unreadable: false }
}

/** Whether a call's git argv makes a repository, or cannot be read and so fails closed as one that might. */
const makesRepository = (argv: ReadonlyArray<Item>) => {
  const read = readArgv(argv)
  return read.unreadable || Option.exists(read.subcommand, (name) => MAKES_REPOSITORY.has(name))
}

/** A function a file names: `const f = (…) => …`, `const f = function …`, `function f …`. */
interface Named {
  readonly name: string
  readonly fn: Function | ArrowFunctionExpression
}

/** A file's calls, in source order, and its named functions. */
interface Parsed {
  readonly calls: ReadonlyArray<CallExpression>
  readonly functions: ReadonlyArray<Named>
}

const parse = (file: string, text: string): Parsed => {
  const calls: Array<CallExpression> = []
  const functions: Array<Named> = []
  new Visitor({
    CallExpression: (call) => calls.push(call),
    FunctionDeclaration: (fn) => Arr.forEach(Arr.fromNullishOr(fn.id), (id) => functions.push({ name: id.name, fn })),
    VariableDeclarator: (declarator) => {
      const { id, init } = declarator
      if (id.type !== "Identifier" || Predicate.isNull(init)) return
      if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") functions.push({ name: id.name, fn: init })
    },
  }).visit(parseSync(file, text).program)
  return { calls: Arr.sort(calls, Order.mapInput(Order.Number, (call: CallExpression) => call.start)), functions }
}

/** What a parameter at `index` stands for in a template: its name, and its slot. */
const slotOf = (param: ParamPattern, index: number): ReadonlyArray<readonly [string, Item]> => {
  if (param.type === "Identifier") return [[param.name, { kind: "param", index }]]
  if (param.type === "AssignmentPattern" && param.left.type === "Identifier") return [[param.left.name, { kind: "param", index }]]
  if (param.type === "RestElement" && param.argument.type === "Identifier") return [[param.argument.name, { kind: "rest", index }]]
  return []
}

/**
 * `fn`'s template, when a call in it runs git on a subcommand its parameters hand it: the first
 * such call's argv, each parameter (or a spread of one) put back as its slot. A call whose
 * subcommand is written there (`commitTo = (remote, …) => git(dir, "clone", …, remote)`) makes
 * no wrapper: that call is the site, judged where it stands.
 */
const templateOf = (fn: Function | ArrowFunctionExpression, calls: ReadonlyArray<CallExpression>, known: ReadonlyMap<string, Template>): Option.Option<Template> => {
  const slots = new Map(fn.params.flatMap(slotOf))
  const slot = (word: Item): Option.Option<Item> => {
    if (word.kind !== "name" && word.kind !== "spread") return Option.none()
    return Option.fromNullishOr(slots.get(word.text))
  }
  return Arr.findFirst(
    calls.filter((call) => call.start >= fn.start && call.end <= fn.end),
    (call) =>
      Option.flatMap(
        Option.filter(argvOf(call, known), (argv) => !readArgv(argv).unreadable && Option.isNone(readArgv(argv).subcommand) && argv.some((word) => Option.isSome(slot(word)))),
        (argv): Option.Option<Template> => Option.some({ kind: "argv", words: argv.map((word) => Option.getOrElse(slot(word), () => word)) }),
      ),
  )
}

/**
 * The file's git wrappers and their templates, found to a fixpoint, so `at = (...args) =>
 * git(dir, ...args)` counts once `git` does. A `git` the file calls but does not define is lenient.
 */
const gitWrappers = ({ calls, functions }: Parsed): ReadonlyMap<string, Template> => {
  const grow = (known: ReadonlyMap<string, Template>): ReadonlyMap<string, Template> => {
    const found = functions.flatMap(({ name, fn }) => Arr.filter(Option.toArray(templateOf(fn, calls, known)).map((template) => [name, template] as const), () => !known.has(name)))
    if (found.length === 0) return known
    return grow(new Map([...known, ...found]))
  }
  const defined = functions.some(({ name }) => name === "git")
  return grow(new Map(Arr.filter([["git", { kind: "lenient" } as const] as const], () => !defined)))
}

/** Git's subcommands that make a repository. */
const MAKES_REPOSITORY = new Set(["init", "clone"])

/** The file that runs `git init` and `git clone` for the tests, and its test, whose samples are raw on purpose. */
const HELPERS = ["tests/git-repo.ts", "tests/git-repo.test.ts"]

/** Each call in `text` that runs git's own init or clone, as `line: code`. */
const rawSites = (file: string, text: string): ReadonlyArray<string> => {
  const parsed = parse(file, text)
  const wrappers = gitWrappers(parsed)
  const lines = text.split("\n")
  return Arr.dedupe(
    parsed.calls
      .filter((call) => Option.exists(argvOf(call, wrappers), makesRepository))
      .map((call) => text.slice(0, call.start).split("\n").length),
  ).map((line) => `${line}: ${Option.getOrElse(Arr.get(lines, line - 1), () => "").trim()}`)
}

/** Every test file, and every file under tests/ (fixtures and helpers the tests run). */
const testFiles = () =>
  [...new Set(["**/*.test.ts", "tests/**/*.ts"].flatMap((glob) => [...new Bun.Glob(glob).scanSync({ cwd: ROOT })]))].filter((file) => !file.includes("node_modules/")).sort()

/** Test code with each shape the guard must judge: its wrappers first, then one call a line. */
const SAMPLE = [
  "const git = (dir: string, ...args: ReadonlyArray<string>) => Bun.spawnSync([\"git\", \"-C\", dir, ...args])",
  "const sh = (dir: string, ...args: ReadonlyArray<string>) => Bun.spawnSync([\"git\", \"-C\", dir, ...args], { env: GIT_ENV })",
  "const run = (cwd: string, ...argv: ReadonlyArray<string>) => Bun.spawnSync([...argv], { cwd })",
  "const at = (...args: ReadonlyArray<string>) => git(repository, ...args)",
  "const logged = (...argv: ReadonlyArray<string>) => run(dir, \"workrift\", ...argv)",
  "const commit = (dir: string, message: string) => git(dir, \"commit\", \"-q\", \"-m\", message)",
  "const gx = (cwd: string, ...args: ReadonlyArray<string>) => Bun.spawnSync([\"git\", ...args], { cwd })",
  "git(root, \"init\", \"-q\")",
  "sh(dir, \"init\", \"-q\", \"-b\", \"dev\")",
  "run(root, \"git\", \"clone\", \"-q\", origin, \"other\")",
  "run(root, [\"git\", \"-C\", root, \"clone\", origin])",
  "at(\"init\", \"-q\", \"-b\", \"main\")",
  "execFileSync(\"git\", [\"init\", \"-q\", work])",
  "gx(\"/nonexistent/loop-probe-x\", \"clone\", source)",
  "Bun.spawnSync([\"git\", \"--git-dir\", `${root}/dotfiles.git`, \"init\", \"--bare\"])",
  "Bun.spawnSync({ cmd: [\"git\", \"--work-tree\", root, \"init\", root] })",
  "run(source, \"rift\", \"init\", \"--here\")",
  "git(dir, \"commit\", \"-q\", \"-m\", \"init\")",
  "git(dir, \"-c\", \"init.defaultBranch=main\", \"commit\")",
  "commit(dir, \"init\")",
  "Bun.spawnSync([\"git\", \"-C\", \"init\", \"status\"])",
  "const action = { action: \"init\", repository }",
  "expect(logged(\"init\", \"/nonexistent/loop-probe-x/repo.git\")).toEqual([\"ionice -c3\", `git clone ${lowered}`])",
  "expect(log).toEqual([\"git clone x\", \"git init y\"])",
  "const commitTo = (remote: string, branch: string) => git(scratch, \"clone\", \"--branch\", branch, remote, \".\")",
  "commitTo(upstream, \"dev\")",
  "Bun.spawnSync([\"git\", \"--attr-source\", \"HEAD\", \"init\", dir])",
  "Bun.spawnSync([\"git\", \"--not-a-git-option\", \"status\"])",
  "Bun.spawnSync([\"git\", \"--attr-source\", \"init\", \"status\"])",
].join("\n")

/** A seeded generator (mulberry32), so a failing case names its seed and replays. */
const generator = (seed: number) => {
  const state = { value: seed >>> 0 }
  const next = () => {
    state.value = (state.value + 0x6d2b79f5) >>> 0
    const mixed = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value)
    const spread = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((spread ^ (spread >>> 14)) >>> 0) / 4294967296
  }
  const pick = <A,>(list: ReadonlyArray<A>): A => Option.getOrThrow(Arr.get(list, Math.floor(next() * list.length)))
  return { pick, count: (below: number) => Math.floor(next() * below) }
}

/** Running the installed git for its options (tests/git-options.ts), then 400 cases: a loaded machine gets room. */
const PROBE_MS = 60_000

/** Options git does not know, which a reader cannot read past: a case with one before the subcommand is a site whatever follows. */
const UNKNOWN_OPTIONS = ["--not-a-git-option", "-Z", "--not-a-git-option=init"]

/** Words a case puts where a value, a subcommand's argument or a wrapper's leading argument goes; the decoys are git's own subcommand names. */
const WORDS = ["init", "clone", "/nonexistent/loop-probe-x", "core.pager=cat", "-q"]

/** The subcommands a case runs: the two that make a repository, and others. */
const SUBCOMMANDS = ["init", "clone", "status", "commit", "fetch", "rev-parse"]

/** A generated case: test code with one call that runs git, and whether git's subcommand there makes a repository (or cannot be read). */
interface Case {
  readonly code: string
  readonly makes: boolean
}

const quoted = (words: ReadonlyArray<string>) => words.map((word) => JSON.stringify(word)).join(", ")

/**
 * A case with the installed git's global options in any order (each valued one with its value as
 * the next word or after `=`), now and then one git does not know, then a subcommand and its
 * arguments, in one of the call shapes test code writes. The options come from git itself
 * (tests/git-options.ts), not from the reader's tables, so an option the tables lack is generated.
 */
const generate = (random: ReturnType<typeof generator>, git: GitGlobalOptions): Case => {
  const option = () => {
    const valued = random.pick(git.valued)
    const value = random.pick(WORDS)
    // Only a long option takes its value after `=` in the same word.
    const joined = Arr.filter([[`${valued}=${value}`]], () => valued.startsWith("--"))
    return random.pick([[random.pick(git.passing)], [valued, value], ...joined, [random.pick(UNKNOWN_OPTIONS)]])
  }
  const globals = Array.from({ length: random.count(4) }, option).flat()
  const unknown = globals.some((word) => UNKNOWN_OPTIONS.includes(word))
  const sub = random.pick(SUBCOMMANDS)
  const after = Array.from({ length: random.count(3) }, () => random.pick(WORDS))
  const argv = [...globals, sub, ...after]
  const lead = random.pick(["\"/nonexistent/loop-probe-x\"", "\"init\"", "dir"])
  const forms = [
    `Bun.spawnSync([${quoted(["git", ...argv])}])`,
    `execFileSync("git", [${quoted(argv)}])`,
    `const run = (cwd: string, ...words: ReadonlyArray<string>) => Bun.spawnSync([...words], { cwd })\nrun(${lead}, ${quoted(["git", ...argv])})`,
    `const gx = (cwd: string, ...args: ReadonlyArray<string>) => Bun.spawnSync(["git", ...args], { cwd })\ngx(${lead}, ${quoted(argv)})`,
    `const git = (dir: string, ...args: ReadonlyArray<string>) => Bun.spawnSync(["git", "-C", dir, ...args])\ngit(${lead}, ${quoted(argv)})`,
    `const named = (sub: string, target: string) => Bun.spawnSync(["git", ${[...globals.map((word) => JSON.stringify(word)), "sub", "target"].join(", ")}])\nnamed(${JSON.stringify(sub)}, ${lead})`,
    `const gx = (cwd: string, ...args: ReadonlyArray<string>) => Bun.spawnSync(["git", ...args], { cwd })\nconst at = (...args: ReadonlyArray<string>) => gx(dir, ...args)\nat(${quoted(argv)})`,
  ]
  return { code: random.pick(forms), makes: unknown || MAKES_REPOSITORY.has(sub) }
}

describe("a test's temp git repository", () => {
  test("gitInit makes a quiet work tree and a quiet bare repository, and gitClone a quiet clone", () => {
    using dir = scratch("git-repo-")
    const work = join(dir.path, "work")
    const bare = join(dir.path, "bare.git")
    const clone = join(dir.path, "clone")
    gitInit(work, ["-q", "-b", "main"])
    gitInit(bare, ["-q", "--bare"])
    gitClone(bare, clone, ["-q"])
    expect({ work: settings(work), bare: settings(bare), clone: settings(clone) }).toEqual({ work: QUIET, bare: QUIET, clone: QUIET })
  })

  test("a call that runs git's init or clone is a site, through any wrapper; a command string in an expectation, a rift init or a commit message is not", () => {
    expect(rawSites("sample.ts", SAMPLE).map((site) => Number(site.split(":")[0]))).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 25, 27, 28])
  })

  test(
    "over generated git argv with the installed git's options in every call shape, a call is a site exactly when git's subcommand is init or clone, or an option before it is unknown",
    () => {
      const git = gitGlobalOptions()
      for (const seed of Arr.range(1, 400)) {
        const { code, makes } = generate(generator(seed), git)
        expect({ seed, code, site: rawSites("case.ts", code).length > 0 }).toEqual({ seed, code, site: makes })
      }
    },
    PROBE_MS,
  )

  test("no test file makes a repository with a raw git init or clone: each goes through gitInit or gitClone", () => {
    const raw = testFiles()
      .filter((file) => !HELPERS.includes(file))
      .flatMap((file) => rawSites(file, readFileSync(join(ROOT, file), "utf8")).map((site) => `${file}:${site}`))
    expect(raw).toEqual([])
  })
})
