// tests/git-repo.ts: a test's temp git repository runs no background gc or maintenance, so a clone
// of it under load never races a lock file git's upkeep removes (batch ar: scripts/upstream.test.ts
// "the upstream reading" failed copying `.git/objects/maintenance.lock`). Every test makes its
// repositories through gitInit and gitClone, which quiet each one; a call in test code that runs
// git's own `init` or `clone` is refused, so no repository is left loud. The guard reads each
// file's syntax tree, so a string that only names a git command (an expected log line) is no site.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Option, Predicate } from "effect"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Argument, type ArrayExpressionElement, type CallExpression, type Function, type ArrowFunctionExpression, type ParamPattern, parseSync, Visitor } from "oxc-parser"
import { gitClone, gitInit, QUIET_GIT } from "./git-repo.ts"
import { scratch } from "./scratch.ts"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

/** What `git config --get` reads for each quiet key in the repository at `dir`. */
const settings = (dir: string) =>
  Object.fromEntries(Object.keys(QUIET_GIT).map((key) => [key, execFileSync("git", ["-C", dir, "config", "--get", key], { encoding: "utf8" }).trim()]))

const QUIET = { "gc.auto": "0", "maintenance.auto": "false" }

/** One argument of a call, flattened through array literals and spreads: a string literal, a name, or anything else. */
interface Item {
  readonly kind: "literal" | "name" | "other"
  readonly text: string
}

const OTHER: Item = { kind: "other", text: "" }

const items = (node: Argument | ArrayExpressionElement): ReadonlyArray<Item> => {
  if (Predicate.isNull(node)) return [OTHER]
  if (node.type === "ArrayExpression") return node.elements.flatMap(items)
  if (node.type === "SpreadElement") return items(node.argument)
  if (node.type === "Literal" && Predicate.isString(node.value)) return [{ kind: "literal", text: node.value }]
  if (node.type === "Identifier") return [{ kind: "name", text: node.name }]
  return [OTHER]
}

const isOption = (item: Item) => item.kind === "literal" && item.text.startsWith("-")

/** Git's options before its subcommand that take the next argument as their value. */
const VALUED = new Set(["-c", "-C"])

/** `list` past git's leading options: `-q`, and `-c x`, `-C dir` with their values. */
const pastOptions = (list: ReadonlyArray<Item>): ReadonlyArray<Item> =>
  Option.match(Arr.head(list), {
    onNone: () => list,
    onSome: (first) => {
      if (!isOption(first)) return list
      return pastOptions(list.slice(1 + Number(VALUED.has(first.text))))
    },
  })

/**
 * What a call runs as git's subcommand, when it runs git:
 * - a call that spawns git names "git" in its argv (`Bun.spawnSync(["git", "-C", dir, ...args])`,
 *   `sh(dir, env, "git", "init")`), and the subcommand comes right after it and its options;
 * - a call to a git wrapper (`git(dir, "init")`) names the wrapper's own arguments first (a
 *   directory, an env), so its subcommand is its first literal that is no option or option value.
 * None when the call runs no git; a name or other item when the subcommand is not written there
 * (a wrapper forwarding its own arguments).
 */
const subcommand = (call: CallExpression, wrappers: ReadonlySet<string>): Option.Option<Item> => {
  const list = call.arguments.flatMap(items)
  if (call.callee.type === "Identifier" && wrappers.has(call.callee.name)) {
    const values = new Set(list.flatMap((each, index) => Arr.filter([index + 1], () => each.kind === "literal" && VALUED.has(each.text))))
    return Option.orElse(
      Arr.findFirst(list, (each, index) => each.kind === "literal" && !isOption(each) && !values.has(index)),
      () => Option.some(OTHER),
    )
  }
  const git = list.findIndex((each) => each.kind === "literal" && each.text === "git")
  if (git < 0) return Option.none()
  return Option.orElse(Arr.head(pastOptions(list.slice(git + 1))), () => Option.some(OTHER))
}

/** A function a file names: `const f = (…) => …`, `const f = function …`, `function f …`. */
interface Named {
  readonly name: string
  readonly fn: Function | ArrowFunctionExpression
}

/** A file's calls and named functions. */
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
  return { calls, functions }
}

/** The names a parameter binds directly: itself, a rest parameter's, a defaulted one's. */
const paramName = (param: ParamPattern): ReadonlyArray<string> => {
  if (param.type === "Identifier") return [param.name]
  if (param.type === "RestElement" && param.argument.type === "Identifier") return [param.argument.name]
  if (param.type === "AssignmentPattern" && param.left.type === "Identifier") return [param.left.name]
  return []
}

/**
 * The file's git wrappers: `git`, and each function with a call in it that runs git (spawns it, or
 * calls a wrapper) on a subcommand the function was handed, not one written there. Found to a
 * fixpoint, so `at = (...args) => git(dir, ...args)` counts once `git` does.
 */
const gitWrappers = ({ calls, functions }: Parsed): ReadonlySet<string> => {
  const grow = (known: ReadonlySet<string>): ReadonlySet<string> => {
    const found = functions.filter(({ fn }) => {
      const own = new Set(fn.params.flatMap(paramName))
      return calls.some(
        (call) =>
          call.start >= fn.start &&
          call.end <= fn.end &&
          Option.exists(subcommand(call, known), (sub) => sub.kind !== "literal") &&
          call.arguments.flatMap(items).some((each) => each.kind === "name" && own.has(each.text)),
      )
    })
    const next = new Set([...known, ...found.map(({ name }) => name)])
    if (next.size === known.size) return known
    return grow(next)
  }
  return grow(new Set(["git"]))
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
      .filter((call) => Option.exists(subcommand(call, wrappers), (sub) => sub.kind === "literal" && MAKES_REPOSITORY.has(sub.text)))
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
  "git(root, \"init\", \"-q\")",
  "sh(dir, \"init\", \"-q\", \"-b\", \"dev\")",
  "run(root, \"git\", \"clone\", \"-q\", origin, \"other\")",
  "run(root, [\"git\", \"-C\", root, \"clone\", origin])",
  "at(\"init\", \"-q\", \"-b\", \"main\")",
  "execFileSync(\"git\", [\"init\", \"-q\", work])",
  "run(source, \"rift\", \"init\", \"--here\")",
  "git(dir, \"commit\", \"-q\", \"-m\", \"init\")",
  "git(dir, \"-c\", \"init.defaultBranch=main\", \"commit\")",
  "commit(dir, \"init\")",
  "const action = { action: \"init\", repository }",
  "expect(logged(\"init\", \"/nonexistent/loop-probe-x/repo.git\")).toEqual([\"ionice -c3\", `git clone ${lowered}`])",
  "expect(log).toEqual([\"git clone x\", \"git init y\"])",
].join("\n")

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
    expect(rawSites("sample.ts", SAMPLE).map((site) => Number(site.split(":")[0]))).toEqual([7, 8, 9, 10, 11, 12])
  })

  test("no test file makes a repository with a raw git init or clone: each goes through gitInit or gitClone", () => {
    const raw = testFiles()
      .filter((file) => !HELPERS.includes(file))
      .flatMap((file) => rawSites(file, readFileSync(join(ROOT, file), "utf8")).map((site) => `${file}:${site}`))
    expect(raw).toEqual([])
  })
})
