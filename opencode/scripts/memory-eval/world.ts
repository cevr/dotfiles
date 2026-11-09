// The fake machine a session works on: the repository's files and its git
// (git.ts), the shell's directory and the few directories around the
// repository, a canned `shell` that answers git, files, package scripts and the
// scenario's own commands, and answers for the distractor tools. Nothing here
// touches a real file or runs a real program.
//
// The shell keeps the parts of a real one that a model checks its work with:
// `&&`, `||` and `;` run as a shell runs them, `$?` is the last exit code,
// `sh -c '…'` runs its command, a heredoc feeds its command, `>` and `>>` write
// a file, and rm, mv, cp, touch, test, sed and wc change or read the files.
import { basename, dirname, join, normalize } from "node:path"
import { DEFAULT_HISTORY, ignored, newRepo, type Repo, runGit, type Tree } from "./git.ts"

export interface Outcome {
  readonly out: string
  readonly code: number
}

export const HOME = "/Users/dev"
/** macOS's per-user temporary directory, as $TMPDIR and mktemp give it. */
const TMPDIR = "/var/folders/qd/s24njbd5/T"
const BIN = "/opt/homebrew/bin"
/** What Homebrew installed on this machine; a scenario's own rules answer for the rest (alembic is in no PATH). */
const PROGRAMS = ["brew", "bun", "gh", "git", "go", "gofmt", "make", "node", "npm", "npx", "pytest", "python3", "rg", "sqlite3", "uv"]
const NOW = "Mon Nov  9 11:20:00 UTC 2026"

export interface World {
  /** The repository's root, absolute. */
  readonly cwd: string
  /** The shell's working directory, absolute; `cd` moves it. */
  dir: string
  /** The repository's working files, keyed by their path from its root. */
  readonly files: Tree
  /** The files as the session found them. */
  readonly original: Readonly<Tree>
  /** Directories outside the repository, absolute, with their entries (`name/` for a directory). */
  readonly outside: Readonly<Record<string, ReadonlyArray<string>>>
  /** Files the session wrote outside the repository (under /tmp, say), by absolute path. */
  readonly elsewhere: Record<string, string>
  /** Directories the session made (mkdir, mktemp -d), absolute: an empty one exists too. */
  readonly made: Set<string>
  branch: string
  /** The branches the session left, most recent last. */
  readonly branches: Array<string>
  readonly repo: Repo
  /** Variables an `export` set earlier in the session. */
  readonly env: Record<string, string>
  /** What a scenario's own commands remember between calls (the database's revision, say). */
  readonly state: Record<string, string>
  /** The last command's exit code, for `$?`. */
  lastCode: number
}

export interface Rule {
  readonly match: RegExp
  /** `stdin` is a heredoc's body, when the command had one. */
  readonly run: (segment: string, world: World, stdin?: string) => Outcome | string
}

/** What a `git status --short` noise line leaves in the files: a local edit, or an untracked file. */
const noiseText = (path: string) => (/\.env/.test(path) ? "API_URL=http://localhost:5173\n" : path.endsWith(".md") ? "# scratch\n" : "local\n")

/**
 * A world on the repository at `cwd`. Each directory between the home directory and the repository lists the next one
 * down, plus what `extra` adds (another checkout beside it, say). `noise` are `git status --short` lines the session did
 * not cause: ` M path` is a local edit of a committed file, `?? path` an untracked file or directory. `history` is the
 * repository's commit subjects, oldest first.
 */
export const newWorld = (
  cwd: string,
  files: Tree,
  branch: string,
  noise: ReadonlyArray<string>,
  extra: Readonly<Record<string, ReadonlyArray<string>>> = {},
  history: ReadonlyArray<string> = DEFAULT_HISTORY,
): World => {
  const outside: Record<string, Array<string>> = { [HOME]: ["Desktop/", "Downloads/", "Library/"], "/tmp": [], [TMPDIR]: [], [BIN]: [...PROGRAMS] }
  for (let child = cwd, parent = dirname(cwd); child !== HOME && parent.startsWith(HOME); child = parent, parent = dirname(parent))
    (outside[parent] ??= []).push(child.slice(parent.length + 1) + "/")
  for (const [dir, entries] of Object.entries(extra)) (outside[dir] ??= []).push(...entries)
  for (const dir of Object.keys(outside)) outside[dir] = [...new Set(outside[dir])].sort()
  const working: Tree = { ...files }
  // What .gitignore covers (a virtualenv, a local database) is in the checkout but never committed.
  const head: Tree = Object.fromEntries(Object.entries(files).filter(([path]) => !ignored(files, path)))
  for (const line of noise) {
    const path = line.slice(3)
    if (line.startsWith(" M")) {
      working[path] ??= noiseText(path)
      head[path] = ""
    } else if (line.startsWith("??")) {
      const file = path.endsWith("/") ? `${path}.marker` : path
      working[file] ??= noiseText(file)
      delete head[file]
    }
  }
  return {
    cwd,
    dir: cwd,
    files: working,
    original: { ...working },
    outside,
    elsewhere: {},
    made: new Set(),
    branch,
    branches: branch === "main" ? [] : ["main"],
    repo: newRepo(head, history),
    env: { PATH: `${BIN}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: "/bin/zsh", USER: "dev", TMPDIR: `${TMPDIR}/` },
    state: {},
    lastCode: 0,
  }
}

/** A command's words, quotes removed: `grep -n "a b" x` → grep, -n, a b, x. */
export const words = (command: string): Array<string> => {
  const out: Array<string> = []
  for (const match of command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(match[1]?.replace(/\\(["\\$`])/g, "$1") ?? match[2] ?? match[3] ?? "")
  return out
}

/** A path made absolute against `base`, with `~` and `$HOME` expanded and no trailing slash. */
export const absolute = (base: string, path: string): string => {
  const expanded = path.trim().replace(/^~(?=\/|$)/, HOME).replace(/^\$\{?HOME\}?(?=\/|$)/, HOME)
  const full = normalize(expanded.startsWith("/") ? expanded : join(base, expanded))
  return full.length > 1 ? full.replace(/\/+$/, "") : full
}

/** An absolute path's key in the repository ("" for its root), or undefined when it is outside. */
const inRepo = (world: World, abs: string): string | undefined =>
  abs === world.cwd ? "" : abs.startsWith(world.cwd + "/") ? abs.slice(world.cwd.length + 1) : undefined

/** A path as the repository keys it, read against `base` (the shell's directory by default); undefined outside it. */
export const repoPath = (world: World, path: string, base: string = world.dir): string | undefined => inRepo(world, absolute(base, path))

const isRepoDir = (world: World, rel: string) =>
  rel === "" || world.made.has(`${world.cwd}/${rel}`) || Object.keys(world.files).some((file) => file.startsWith(rel + "/"))

/** The entries directly under `abs` among absolute paths: `name` for a path, `name/` for one below it. */
const childrenOf = (abs: string, paths: Iterable<string>, dirs: Iterable<string>): Array<string> => {
  const names: Array<string> = []
  for (const path of paths) if (path.startsWith(abs + "/")) names.push(path.slice(abs.length + 1).includes("/") ? path.slice(abs.length + 1).split("/")[0]! + "/" : path.slice(abs.length + 1))
  for (const dir of dirs) if (dir.startsWith(abs + "/")) names.push(dir.slice(abs.length + 1).split("/")[0]! + "/")
  return names
}

/** A directory's entries, or undefined when there is no such directory. */
const entriesOf = (world: World, abs: string): Array<string> | undefined => {
  const rel = inRepo(world, abs)
  if (rel === undefined) {
    const found = [...(world.outside[abs] ?? []), ...childrenOf(abs, Object.keys(world.elsewhere), world.made)]
    return world.outside[abs] === undefined && !world.made.has(abs) && found.length === 0 ? undefined : [...new Set(found)].sort()
  }
  if (!isRepoDir(world, rel)) return undefined
  const prefix = rel === "" ? "" : rel + "/"
  const names = new Set<string>(childrenOf(abs, [], world.made))
  for (const path of Object.keys(world.files)) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    names.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/") + 1) : rest)
  }
  return [...names].sort()
}

const listing = (world: World, abs: string): string | undefined => entriesOf(world, abs)?.filter((name) => !name.startsWith(".")).join("\n")

/** A repository path as the shell shows it from its directory: relative below it, absolute elsewhere. */
const shown = (world: World, rel: string): string => {
  const abs = rel === "" ? world.cwd : `${world.cwd}/${rel}`
  return abs.startsWith(world.dir + "/") ? abs.slice(world.dir.length + 1) : abs
}

/** The repository files under `path` (a file, a directory or a glob, read against the shell's directory). */
const filesUnder = (world: World, path: string): Array<string> => {
  const abs = absolute(world.dir, path)
  if (/[*?[{]/.test(path)) {
    const rel = inRepo(world, abs)
    if (rel === undefined) return []
    const glob = new Bun.Glob(rel)
    return Object.keys(world.files).filter((file) => glob.match(file))
  }
  const rel = inRepo(world, abs)
  if (rel === undefined) return world.cwd.startsWith(abs + "/") ? Object.keys(world.files) : []
  return Object.keys(world.files).filter((file) => rel === "" || file === rel || file.startsWith(rel + "/"))
}

const regexOf = (pattern: string, flags: string): RegExp => {
  try {
    return new RegExp(pattern, flags)
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
  }
}

/** `grep`/`rg` over the repository: `path:line:text` for each match. */
const search = (world: World, args: ReadonlyArray<string>): Outcome => {
  const flags = args.filter((arg) => arg.startsWith("-"))
  const rest = args.filter((arg, index) => !arg.startsWith("-") && !(index > 0 && /^-(?:e|g|-glob|-include|t|-type|A|B|C|m)$/.test(args[index - 1]!)))
  const pattern = rest[0] ?? ""
  const regex = regexOf(pattern, flags.some((flag) => /^-\w*i/.test(flag)) ? "i" : "")
  const scope = rest.length > 1 ? rest.slice(1).flatMap((path) => filesUnder(world, path)) : filesUnder(world, ".")
  const hits = scope.flatMap((path) => world.files[path]!.split("\n").flatMap((line, index) => (pattern !== "" && regex.test(line) ? [`${shown(world, path)}:${index + 1}:${line}`] : [])))
  // grep exits 1 when nothing matched.
  return { out: hits.join("\n"), code: hits.length === 0 ? 1 : 0 }
}

/** A pipeline stage after the first: grep, head, tail, wc and the like over the text so far. */
const filter = (text: string, stage: string): string => {
  const [program, ...args] = words(stage)
  const lines = text === "" ? [] : text.split("\n")
  const count = () => {
    const n = args.find((arg) => /^-?\d+$/.test(arg)) ?? args[args.indexOf("-n") + 1]
    return Math.abs(Number(n ?? 10)) || 10
  }
  switch (program) {
    case "grep":
    case "rg": {
      const flags = args.filter((arg) => arg.startsWith("-"))
      const pattern = args.find((arg) => !arg.startsWith("-")) ?? ""
      const regex = regexOf(pattern, flags.some((flag) => /^-\w*i/.test(flag)) ? "i" : "")
      const invert = flags.some((flag) => /^-\w*v/.test(flag))
      return lines.filter((line) => regex.test(line) !== invert).join("\n")
    }
    case "head":
      return lines.slice(0, count()).join("\n")
    case "tail":
      return lines.slice(-count()).join("\n")
    case "wc":
      return String(lines.length).padStart(8)
    case "sort":
      return [...lines].sort().join("\n")
    case "cat":
    case "less":
      return text
    case "sed":
      return sedText(text, args).text
    default:
      return text
  }
}

/** Indexes of quoted characters in `text`, so the parsers below skip what a quote protects. */
const quotedMask = (text: string): Array<boolean> => {
  const mask: Array<boolean> = []
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== undefined) {
      mask.push(true)
      if (ch === quote) quote = undefined
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) {
        mask.push(true)
        i++
      }
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    mask.push(quote !== undefined)
  }
  return mask
}

/** A segment's pipeline stages, split on `|` outside quotes (not `||`, which segments take). */
const stages = (segment: string): Array<string> => {
  const mask = quotedMask(segment)
  const out: Array<string> = []
  let current = ""
  for (let i = 0; i < segment.length; i++) {
    if (!mask[i] && segment[i] === "|") {
      out.push(current.trim())
      current = ""
      continue
    }
    current += segment[i]
  }
  out.push(current.trim())
  return out.filter((stage) => stage !== "")
}

export interface Part {
  readonly text: string
  /** The operator before it: run on success (&&), on failure (||), or always (; or a newline). */
  readonly op: "&&" | "||" | ";"
}

/** A command line split into the commands it runs, with the operator before each. */
export const parts = (command: string): Array<Part> => {
  const out: Array<Part> = []
  let current = ""
  let op: Part["op"] = ";"
  let quote: string | undefined
  let depth = 0
  const push = (next: Part["op"]) => {
    if (current.trim() !== "") out.push({ text: current.trim(), op })
    current = ""
    op = next
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote !== undefined) {
      current += ch
      if (ch === quote) quote = undefined
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i]!
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    // A command substitution stays one segment; a subshell's commands split like any others (runSegment drops its parentheses).
    if (ch === "$" && command[i + 1] === "(") depth++
    else if (ch === "(" && depth > 0) depth++
    else if (ch === ")" && depth > 0) depth--
    const two = command.slice(i, i + 2)
    if (depth === 0 && (two === "&&" || two === "||")) {
      push(two)
      i++
      continue
    }
    if (depth === 0 && (ch === ";" || ch === "\n")) {
      push(";")
      continue
    }
    current += ch
  }
  push(";")
  return out
}

/**
 * A command line split into the commands it runs, on `&&`, `||`, `;` and newlines outside quotes. A pipe stays in its
 * segment. Leading `VAR=value` assignments stay on the segment they prefix.
 */
export const segments = (command: string): Array<string> => parts(command).map((part) => part.text)

/** A command's segments, with the command of each `sh -c '…'` (or `bash -lc "…"`) split in its place, as the shell runs it. */
export const unwrapped = (command: string): Array<string> =>
  segments(command).flatMap((segment) => {
    const inner = wrapped(programOf(segment))
    return inner === undefined ? [segment] : unwrapped(inner)
  })

/** A segment without its leading `VAR=value` assignments: the program and its arguments. */
export const programOf = (segment: string): string => segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "")

/** The `-m` message of a `git commit`, first one only; empty when there is none. */
export const commitMessage = (segment: string): string => {
  const match = segment.match(/(?:-m|--message)(?:\s+|=)("((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/) ?? segment.match(/-\w*m\s+("((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/)
  if (match === null) return ""
  return (match[2] ?? match[3] ?? match[4] ?? "").trim()
}

/** Whether a segment stages or commits everything rather than files by path. */
export const stagesAll = (segment: string): boolean => {
  const program = programOf(segment)
  const tokens = program.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "''").split(/\s+/)
  if (/^git\s+commit\b/.test(program)) return tokens.some((token) => token === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(token))
  if (/^git\s+add\b/.test(program)) return tokens.some((token) => ["-A", "--all", "-u", "--update", ".", "./", "*", ":/"].includes(token))
  return false
}

/** The message of each commit a shell command makes: a heredoc's first line, else the first `-m`. */
export const commitMessages = (command: string): Array<string> => {
  if (!/git\s+commit\b/.test(command)) return []
  const heredoc = command.match(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n\s*([^\n]*)/)
  if (heredoc !== null) return [heredoc[2]!.trim()]
  return unwrapped(command)
    .filter((segment) => /^git\s+commit\b/.test(programOf(segment)))
    .map(commitMessage)
}

/** The package.json nearest above the shell's directory inside the repository, and its directory. */
const packageOf = (world: World): { readonly dir: string; readonly scripts: Record<string, string> } | undefined => {
  for (let rel = inRepo(world, world.dir); rel !== undefined; rel = rel === "" ? undefined : rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "") {
    const text = world.files[rel === "" ? "package.json" : `${rel}/package.json`]
    if (text !== undefined) return { dir: rel, scripts: (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {} }
  }
  return undefined
}

// ---------------------------------------------------------------- files

/** A file's text at `path` (in the repository or written elsewhere this session), or undefined. */
export const fileAt = (world: World, path: string): string | undefined => {
  const abs = absolute(world.dir, path)
  const rel = inRepo(world, abs)
  return rel === undefined ? world.elsewhere[abs] : world.files[rel]
}

const isDir = (world: World, path: string): boolean => entriesOf(world, absolute(world.dir, path)) !== undefined

export const writeAt = (world: World, path: string, text: string): void => {
  const abs = absolute(world.dir, path)
  const rel = inRepo(world, abs)
  if (rel === undefined) world.elsewhere[abs] = text
  else world.files[rel] = text
}

/** The files under `path`, as [relative-to-path, text] pairs, for a recursive copy or move. */
const treeAt = (world: World, path: string): Array<[string, string]> => {
  const abs = absolute(world.dir, path)
  const rel = inRepo(world, abs)
  if (rel === undefined) return Object.entries(world.elsewhere).filter(([key]) => key.startsWith(abs + "/")).map(([key, text]) => [key.slice(abs.length + 1), text])
  return Object.entries(world.files).filter(([key]) => rel === "" || key.startsWith(rel + "/")).map(([key, text]) => [rel === "" ? key : key.slice(rel.length + 1), text])
}

const removeAt = (world: World, path: string, recursive: boolean): string | undefined => {
  const abs = absolute(world.dir, path)
  const rel = inRepo(world, abs)
  if (rel === "") return `rm: "${path}" may not be removed`
  if (fileAt(world, path) !== undefined) {
    if (rel === undefined) delete world.elsewhere[abs]
    else delete world.files[rel]
    return undefined
  }
  if (!isDir(world, path)) return `rm: ${path}: No such file or directory`
  if (!recursive) return `rm: ${path}: is a directory`
  if (rel === undefined) {
    for (const key of Object.keys(world.elsewhere)) if (key.startsWith(abs + "/")) delete world.elsewhere[key]
  } else for (const key of Object.keys(world.files)) if (key.startsWith(rel + "/")) delete world.files[key]
  for (const dir of world.made) if (dir === abs || dir.startsWith(abs + "/")) world.made.delete(dir)
  return undefined
}

const rmCommand = (segment: string, world: World): Outcome => {
  const args = words(segment).slice(1)
  const flags = args.filter((arg) => /^-[a-zA-Z]+$/.test(arg)).join("")
  const force = flags.includes("f")
  const recursive = /[rR]/.test(flags)
  const errors: Array<string> = []
  for (const path of args.filter((arg) => !/^-[a-zA-Z]+$/.test(arg) && arg !== "--")) {
    for (const target of /[*?]/.test(path) ? filesUnder(world, path).map((rel) => `${world.cwd}/${rel}`) : [path]) {
      const error = removeAt(world, target, recursive)
      if (error !== undefined && !(force && /No such file/.test(error))) errors.push(error)
    }
  }
  return { out: errors.join("\n"), code: errors.length === 0 ? 0 : 1 }
}

/** `cp` and `mv`: a file to a file or into a directory, a directory with -r (or always, for mv). */
const copyCommand = (segment: string, world: World, move: boolean): Outcome => {
  const args = words(segment).slice(1)
  const recursive = args.some((arg) => /^-\w*[rRa]/.test(arg))
  const paths = args.filter((arg) => !arg.startsWith("-"))
  const program = move ? "mv" : "cp"
  if (paths.length < 2) return { out: `usage: ${program} source target`, code: 64 }
  const target = paths.at(-1)!
  for (const source of paths.slice(0, -1)) {
    const text = fileAt(world, source)
    const into = isDir(world, target) ? `${target.replace(/\/$/, "")}/${basename(source)}` : target
    if (text !== undefined) {
      writeAt(world, into, text)
      if (move) removeAt(world, source, false)
      continue
    }
    if (!isDir(world, source)) return { out: `${program}: ${source}: No such file or directory`, code: 1 }
    if (!move && !recursive) return { out: `cp: ${source} is a directory (not copied).`, code: 1 }
    for (const [rel, body] of treeAt(world, source)) writeAt(world, `${into}/${rel}`, body)
    if (move) removeAt(world, source, true)
  }
  return { out: "", code: 0 }
}

/** `test` and `[ … ]`: -f, -d, -e, -s, -z, -n, = and !=, with ! in front. */
const testCommand = (segment: string, world: World): Outcome => {
  let args = words(segment).slice(1)
  if (args.at(-1) === "]") args = args.slice(0, -1)
  let negate = false
  if (args[0] === "!") {
    negate = true
    args = args.slice(1)
  }
  const expand = (value: string) => value.replace(/\$\{?(\w+)\}?/g, (_, name: string) => (name === "HOME" ? HOME : world.env[name] ?? ""))
  let result = false
  const [a, b, c] = args
  if (a === "-f") result = fileAt(world, b ?? "") !== undefined
  else if (a === "-d") result = isDir(world, b ?? "")
  else if (a === "-e") result = fileAt(world, b ?? "") !== undefined || isDir(world, b ?? "")
  else if (a === "-s") result = (fileAt(world, b ?? "") ?? "") !== ""
  else if (a === "-z") result = expand(b ?? "") === ""
  else if (a === "-n") result = expand(b ?? "") !== ""
  else if (b === "=" || b === "==") result = expand(a ?? "") === expand(c ?? "")
  else if (b === "!=") result = expand(a ?? "") !== expand(c ?? "")
  else result = a !== undefined && expand(a) !== ""
  return { out: "", code: result !== negate ? 0 : 1 }
}

/** A sed script's commands over `text`: `s/a/b/flags`, `Np`, `N,Mp`, `N,$p`, `Nd`; -n prints only what p prints. */
const sedText = (text: string, args: ReadonlyArray<string>): { readonly text: string; readonly files: Array<string>; readonly inPlace: boolean } => {
  let quiet = false
  let inPlace = false
  let extended = false
  const scripts: Array<string> = []
  const rest: Array<string> = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "-n") quiet = true
    else if (arg === "-E" || arg === "-r") extended = true
    else if (arg === "-e") scripts.push(args[++i] ?? "")
    else if (arg === "-i") {
      inPlace = true
      // BSD sed's `-i ''` or `-i .bak`: the suffix is its own word.
      if (args[i + 1] === "" || /^\.\w+$/.test(args[i + 1] ?? "")) i++
    } else if (arg.startsWith("-i")) inPlace = true
    else if (/^-[nE]+$/.test(arg)) {
      quiet ||= arg.includes("n")
      extended ||= arg.includes("E")
    }
    else rest.push(arg)
  }
  if (scripts.length === 0 && rest.length > 0) scripts.push(rest.shift()!)
  const lines = text.replace(/\n$/, "").split("\n")
  const out: Array<string> = []
  const commands = scripts.flatMap((script) => script.split(/;\s*|\n/)).filter((command) => command.trim() !== "")
  const toJs = (pattern: string) => (extended ? pattern : pattern.replace(/\\([()+?|{}])/g, "$1"))
  lines.forEach((line, index) => {
    let current = line
    let deleted = false
    for (const command of commands) {
      const n = index + 1
      const range = command.match(/^(\d+|\$)?(?:,(\d+|\$))?([pd])$/)
      if (range !== null) {
        const from = range[1] === undefined ? 1 : range[1] === "$" ? lines.length : Number(range[1])
        const to = range[2] === undefined ? (range[1] === undefined ? lines.length : from) : range[2] === "$" ? lines.length : Number(range[2])
        if (n >= from && n <= to) {
          if (range[3] === "p") out.push(current)
          else deleted = true
        }
        continue
      }
      const sub = command.match(/^s(.)(.*?)\1(.*?)\1([gip0-9]*)$/)
      if (sub !== null) {
        const regex = regexOf(toJs(sub[2]!), (sub[4]!.includes("g") ? "g" : "") + (sub[4]!.includes("i") ? "i" : ""))
        const replaced = current.replace(regex, sub[3]!.replace(/\\(\d)/g, "$$$1").replace(/(^|[^\\])&/g, "$1$$&").replace(/\\&/g, "&"))
        if (replaced !== current && sub[4]!.includes("p")) out.push(replaced)
        current = replaced
      }
    }
    if (!quiet && !deleted) out.push(current)
  })
  return { text: out.join("\n"), files: rest, inPlace }
}

const sedCommand = (segment: string, world: World, stdin?: string): Outcome => {
  const args = words(segment).slice(1)
  const probe = sedText("", args)
  if (probe.files.length === 0) return { out: sedText(stdin ?? "", args).text, code: 0 }
  const out: Array<string> = []
  for (const path of probe.files) {
    const text = fileAt(world, path)
    if (text === undefined) return { out: `sed: ${path}: No such file or directory`, code: 1 }
    const result = sedText(text, args)
    if (result.inPlace) writeAt(world, path, result.text + (text.endsWith("\n") ? "\n" : ""))
    else out.push(result.text)
  }
  return { out: out.join("\n"), code: 0 }
}

/** `ls`, with -l for the long form and -a for dot entries. */
const lsCommand = (segment: string, world: World): Outcome => {
  const args = words(segment).slice(1)
  const flags = args.filter((arg) => arg.startsWith("-")).join("")
  const long = flags.includes("l")
  const dots = /a|A/.test(flags)
  const paths = args.filter((arg) => !arg.startsWith("-"))
  // Files named on the line come first, one per line, then each directory's listing.
  const files: Array<string> = []
  const outputs: Array<string> = []
  const row = (name: string, text: string | undefined) =>
    `${text === undefined ? "drwxr-xr-x" : "-rw-r--r--"}  1 dev  staff  ${String(text === undefined ? 128 : text.length).padStart(5)} Nov  9 10:12 ${name.replace(/\/$/, "")}`
  for (const path of paths.length === 0 ? ["."] : paths) {
    const text = fileAt(world, path)
    if (text !== undefined) {
      files.push(long ? row(path, text) : path)
      continue
    }
    const abs = absolute(world.dir, path)
    const found = entriesOf(world, abs)
    if (found === undefined) return { out: `ls: ${path}: No such file or directory`, code: 1 }
    const names = [...(dots ? [".", "..", ...(abs === world.cwd ? [".git/"] : [])] : []), ...found.filter((name) => dots || !name.startsWith("."))]
    const body = long
      ? [`total ${names.length * 8}`, ...names.map((name) => row(name, name.endsWith("/") || name === "." || name === ".." ? undefined : fileAt(world, `${abs}/${name}`) ?? ""))].join("\n")
      : names.join("\n")
    outputs.push(paths.length > 1 ? `${path}:\n${body}` : body)
  }
  return { out: [...(files.length === 0 ? [] : [files.join("\n")]), ...outputs].join("\n\n"), code: 0 }
}

const catCommand = (segment: string, world: World, stdin?: string): Outcome => {
  const [program = "cat", ...args] = words(segment)
  const paths = args.filter((arg, index) => !arg.startsWith("-") && !/^\d+$/.test(arg) && !(index > 0 && args[index - 1] === "-n") && !arg.startsWith("{"))
  if (paths.length === 0 || (paths.length === 1 && paths[0] === "-")) return { out: /^(?:head|tail)/.test(program) ? filter(stdin ?? "", segment) : stdin ?? "", code: 0 }
  const texts: Array<string> = []
  for (const path of paths) {
    const text = fileAt(world, path)
    if (text === undefined) return { out: [...texts, `${program}: ${path}: ${isDir(world, path) ? "Is a directory" : "No such file or directory"}`].join("\n"), code: 1 }
    texts.push(text.replace(/\n$/, ""))
  }
  const text = texts.join("\n")
  if (/^(?:head|tail)$/.test(program)) return { out: filter(text, `${program} ${args.join(" ")}`), code: 0 }
  if (program === "nl" || args.includes("-n")) return { out: text.split("\n").map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join("\n"), code: 0 }
  return { out: text, code: 0 }
}

const wcCommand = (segment: string, world: World, stdin?: string): Outcome => {
  const args = words(segment).slice(1)
  const paths = args.filter((arg) => !arg.startsWith("-"))
  const count = (text: string) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0))
  if (paths.length === 0) return { out: String(count(stdin ?? "")).padStart(8), code: 0 }
  const rows: Array<string> = []
  for (const path of paths) {
    const text = fileAt(world, path)
    if (text === undefined) return { out: `wc: ${path}: open: No such file or directory`, code: 1 }
    rows.push(`${String(count(text)).padStart(8)} ${path}`)
  }
  if (paths.length > 1) rows.push(`${String(paths.reduce((n, path) => n + count(fileAt(world, path)!), 0)).padStart(8)} total`)
  return { out: rows.join("\n"), code: 0 }
}

const STDLIB = new Set(
  "sys os json re pathlib sqlite3 subprocess datetime textwrap ast inspect importlib collections itertools functools typing glob shutil tempfile io time math string uuid decimal hashlib base64 configparser pprint traceback dataclasses enum argparse csv random unittest".split(" "),
)

/**
 * A little of Python, enough for a model's checks: `--version`, a script's imports (a third-party module outside the
 * project's environment raises ModuleNotFoundError, as it would), and the `print` calls of literal strings and of a
 * few well-known values. What it cannot evaluate prints nothing, as a script with no print does.
 */
const python = (segment: string, world: World, stdin?: string): Outcome => {
  const program = programOf(segment)
  const inEnv = /^uv\s+run\b/.test(program) || world.env["VIRTUAL_ENV"] !== undefined || program.startsWith(".venv/bin/")
  const args = words(program.replace(/^uv\s+run\s+/, "")).slice(1)
  if (args.includes("--version") || args.includes("-V")) return { out: "Python 3.12.7", code: 0 }
  const script = args.indexOf("-c") !== -1 ? args[args.indexOf("-c") + 1] ?? "" : args[0] === "-" || args.length === 0 ? stdin ?? "" : fileAt(world, args[0]!)
  if (script === undefined) return { out: `${args[0] === "-m" ? `/opt/homebrew/bin/python3: No module named ${args[1]}` : `python3: can't open file '${absolute(world.dir, args[0]!)}': [Errno 2] No such file or directory`}`, code: args[0] === "-m" ? 1 : 2 }
  const imported = [...script.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)].map((match) => (match[1] ?? match[2]!).split(".")[0]!)
  // The project's own package imports its dependencies.
  const missing = imported.map((name) => (name === "app" || name === "tests" ? "sqlalchemy" : name)).find((name) => !STDLIB.has(name))
  if (missing !== undefined && !inEnv)
    return { out: `Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nModuleNotFoundError: No module named '${missing}'`, code: 1 }
  const known: Record<string, string> = { "sys.version": "3.12.7 (main, Oct  1 2026, 08:30:21) [Clang 17.0.0 (clang-1700.0.13.3)]", "sys.executable": inEnv ? `${world.cwd}/.venv/bin/python3` : `${BIN}/python3`, "os.getcwd()": world.dir }
  const printed = [...script.matchAll(/print\(\s*(?:(f?)(["'])((?:(?!\2).)*)\2|([\w.()]+))\s*\)/g)].flatMap((match) =>
    match[3] !== undefined ? (match[1] === "f" && match[3].includes("{") ? [] : [match[3]]) : known[match[4]!] === undefined ? [] : [known[match[4]!]!],
  )
  return { out: printed.join("\n"), code: 0 }
}

/** Commands every machine answers the same way: cd, git, files, package scripts, the usual small programs. */
export const COMMON: ReadonlyArray<Rule> = [
  { match: /^cd\b/, run: (segment, world) => {
      const target = absolute(world.dir, words(segment)[1] ?? HOME)
      if (entriesOf(world, target) === undefined) return { out: `cd: no such file or directory: ${words(segment)[1]}`, code: 1 }
      world.dir = target
      return ""
    } },
  { match: /^export\s+/, run: (segment, world) => {
      for (const [, name, value] of segment.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g)) world.env[name!] = value!.replace(/^["']|["']$/g, "")
      return ""
    } },
  { match: /^git\b/, run: (segment, world, stdin) => runGit(segment, world, stdin) },
  { match: /^(?:cat|head|tail|less|bat|nl)\b/, run: catCommand },
  { match: /^sed\b/, run: sedCommand },
  { match: /^awk\s+/, run: (segment, world) => {
      const path = words(segment).at(-1) ?? ""
      const text = fileAt(world, path)
      return text === undefined ? { out: `awk: can't open file ${path}`, code: 2 } : text.replace(/\n$/, "")
    } },
  { match: /^ls\b/, run: lsCommand },
  { match: /^rm\b/, run: rmCommand },
  { match: /^cp\b/, run: (segment, world) => copyCommand(segment, world, false) },
  { match: /^mv\b/, run: (segment, world) => copyCommand(segment, world, true) },
  { match: /^mkdir\b/, run: (segment, world) => {
      const args = words(segment).slice(1)
      const parents = args.includes("-p")
      for (const path of args.filter((arg) => !arg.startsWith("-"))) {
        const abs = absolute(world.dir, path)
        if (fileAt(world, path) !== undefined || (isDir(world, path) && !parents)) return { out: `mkdir: ${path}: File exists`, code: 1 }
        if (!parents && !isDir(world, dirname(abs))) return { out: `mkdir: ${path}: No such file or directory`, code: 1 }
        for (let dir = abs; dir !== "/" && !isDir(world, dir); dir = dirname(dir)) world.made.add(dir)
      }
      return ""
    } },
  { match: /^mktemp\b/, run: (segment, world) => {
      const path = `${TMPDIR}/tmp.${(Object.keys(world.elsewhere).length + world.made.size).toString(36).padStart(4, "0")}Xq7Lk2`
      if (/\s-d\b/.test(segment)) world.made.add(path)
      else world.elsewhere[path] = ""
      return path
    } },
  { match: /^date\b/, run: (segment) => (/\+%s/.test(segment) ? "1762687200" : /\+/.test(segment) ? "2026-11-09 11:20:00" : NOW) },
  { match: /^(?:env|printenv)\b/, run: (segment, world) => {
      const name = words(segment)[1]
      if (name !== undefined) return world.env[name] === undefined ? { out: "", code: 1 } : world.env[name]!
      return Object.entries({ HOME, PWD: world.dir, ...world.env }).map(([key, value]) => `${key}=${value}`).join("\n")
    } },
  { match: /^uname\b/, run: (segment) => (/-a/.test(segment) ? "Darwin dev-mbp 25.1.0 Darwin Kernel Version 25.1.0 arm64" : /-m/.test(segment) ? "arm64" : "Darwin") },
  { match: /^(?:whoami|id\s+-un)\b/, run: () => "dev" },
  { match: /^touch\b/, run: (segment, world) => {
      for (const path of words(segment).slice(1).filter((arg) => !arg.startsWith("-"))) if (fileAt(world, path) === undefined) writeAt(world, path, "")
      return ""
    } },
  { match: /^(?:test\b|\[\s)/, run: testCommand },
  { match: /^wc\b/, run: wcCommand },
  { match: /^(?:uv\s+run\s+)?(?:\.venv\/bin\/)?python3?\b(?!\s+-m\s+pytest)/, run: python },
  { match: /^true\b/, run: () => "" },
  { match: /^false\b/, run: () => ({ out: "", code: 1 }) },
  { match: /^find\b/, run: (segment, world) => {
      const args = words(segment).slice(1)
      const root = args[0] !== undefined && !args[0].startsWith("-") ? args[0] : "."
      const rootAbs = absolute(world.dir, root)
      const names = args.flatMap((arg, index) => (/^-i?name$/.test(args[index - 1] ?? "") ? [new Bun.Glob(arg)] : []))
      const matches = (path: string) => names.length === 0 || names.some((glob) => glob.match(path.replace(/\/$/, "").split("/").at(-1)!))
      const show = (abs: string) => (abs === rootAbs ? root : `${root.replace(/\/$/, "")}${abs.slice(rootAbs.length)}`)
      const outsideHits = Object.entries(world.outside).flatMap(([dir, entries]) =>
        dir === rootAbs || dir.startsWith(rootAbs + "/") ? entries.map((entry) => `${dir}/${entry.replace(/\/$/, "")}`).filter((abs) => inRepo(world, abs) === undefined && matches(abs)) : [],
      )
      const repoHits = filesUnder(world, root).map((file) => `${world.cwd}/${file}`).filter(matches)
      return [...outsideHits, ...repoHits].map(show).join("\n")
    } },
  { match: /^(?:rg|grep)\b/, run: (segment, world) => search(world, words(segment).slice(1)) },
  { match: /^pwd\b/, run: (_, world) => world.dir },
  { match: /^(?:echo|printf)\b/, run: (segment, world) =>
      segment
        .replace(/^(?:echo|printf)\s*(?:-[ne]+\s+)?/, "")
        .replace(/^["']|["']$/g, "")
        .replace(/\$\?/g, String(world.lastCode))
        .replace(/\$\{?HOME\}?/g, HOME)
        .replace(/\$\{?PWD\}?/g, world.dir)
        .replace(/\$\{?(\w+)\}?/g, (_, name: string) => world.env[name] ?? "")
        .replace(/\\n/g, "\n") },
  { match: /^(?:which|command\s+-v|type)\s+\S+/, run: (segment, world) => {
      const names = words(segment.replace(/^command\s+-v/, "which")).slice(1).filter((arg) => !arg.startsWith("-"))
      const builtin = new Set(["cd", "echo", "export", "test", "pwd", "printf", "true", "false"])
      const system = new Set(["ls", "cat", "rm", "mv", "cp", "mkdir", "sed", "awk", "grep", "find", "head", "tail", "wc", "sort", "touch", "date", "env", "sh", "bash", "zsh", "curl", "tar", "diff", "xargs", "tee", "mktemp", "uname", "python3"])
      let missing = false
      const out = names.map((name) => {
        if (world.outside[BIN]!.includes(name)) return `${BIN}/${name}`
        if (builtin.has(name)) return `${name}: shell built-in command`
        if (system.has(name)) return `/usr/bin/${name}`
        missing = true
        return `${name} not found`
      })
      return { out: out.join("\n"), code: missing ? 1 : 0 }
    } },
  { match: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?\S+/, run: (segment, world) => {
      const [tool, ...rest] = words(programOf(segment))
      const name = rest[0] === "run" ? rest[1] : rest[0]
      if (name === undefined || ["install", "i", "add", "ci", "x", "exec"].includes(name)) return ""
      if (tool === "bun" && rest[0] === "test") return { out: "bun test v1.3.2\nerror: 0 test files matching **{.test,.spec,_test_,_spec_}.{js,ts,jsx,tsx}", code: 1 }
      const pkg = packageOf(world)
      if (pkg === undefined) return { out: `${tool}: no package.json found in ${world.dir} or any parent inside the repository`, code: 1 }
      const script = pkg.scripts[name]
      if (script === undefined) return { out: `error: Script not found "${name}"`, code: 1 }
      return `$ ${script}`
    } },
]

// ---------------------------------------------------------------- the shell

/** A command line with each heredoc's body taken out: the line refers to body `n` as `<<__HEREDOC_n__`. */
const heredocs = (command: string): { readonly line: string; readonly bodies: Array<string> } => {
  const bodies: Array<string> = []
  let line = ""
  const pending: Array<string> = []
  // The quote state is kept as the line is read, so a quote inside a body (it's) does not leak past it.
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        line += ch
        i++
        line += command[i]
        continue
      }
      line += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      line += ch
      continue
    }
    if (command.startsWith("<<", i) && command[i + 2] !== "<") {
      const marker = command.slice(i).match(/^<<-?\s*(['"]?)(\w+)\1/)
      if (marker !== null) {
        pending.push(marker[2]!)
        line += `<<__HEREDOC_${bodies.length + pending.length - 1}__`
        i += marker[0].length - 1
        continue
      }
    }
    if (ch === "\n" && pending.length > 0) {
      const lines = command.slice(i + 1).split("\n")
      let used = 0
      for (const tag of pending) {
        const end = lines.findIndex((text, index) => index >= used && text.trim() === tag)
        const stop = end === -1 ? lines.length : end
        bodies.push(lines.slice(used, stop).join("\n") + "\n")
        used = stop + 1
      }
      pending.length = 0
      i += lines.slice(0, used).join("\n").length + (used > 0 ? 1 : 0)
      line += "\n"
      continue
    }
    line += command[i]
  }
  return { line, bodies }
}

/** A stage's output redirection (`> file`, `>> file`) taken out of it; stderr redirections and /dev/null dropped. */
const redirection = (stage: string): { readonly stage: string; readonly to?: string; readonly append: boolean } => {
  let text = stage.replace(/\s\d?>&\d\b|\s(?:\d|&)?>>?\s*\/dev\/null\b|\s2>>?\s*\S+/g, "")
  const mask = quotedMask(text)
  for (let i = 0; i < text.length; i++) {
    if (mask[i] || text[i] !== ">") continue
    const match = text.slice(i).match(/^(>>?)\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/)
    if (match === null) continue
    const target = match[2]!.replace(/^["']|["']$/g, "")
    text = (text.slice(0, i).replace(/\d$/, "") + text.slice(i + match[0].length)).replace(/\s+/g, " ").trim()
    return { stage: text, to: target, append: match[1] === ">>" }
  }
  return { stage: text, append: false }
}

/** `sh -c '…'`, `bash -lc "…"` and the like: the command they run. */
const wrapped = (program: string): string | undefined => {
  const match = program.match(/^(?:\/bin\/)?(?:ba|z)?sh\s+(?:-\w*c\w*)\s+([\s\S]+)$/)
  if (match === null) return undefined
  return words(match[1]!)[0]
}

/** Each `$(…)` outside single quotes replaced by what its command prints, as the shell does before it runs a line. */
const substitute = (segment: string, world: World, rules: ReadonlyArray<Rule>, bodies: ReadonlyArray<string>): string => {
  let out = ""
  let quote: string | undefined
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (quote === "'" ? ch === "'" : quote === '"' ? ch === '"' : ch === "'" || ch === '"') quote = quote === undefined ? ch : undefined
    if (quote !== "'" && segment.startsWith("$(", i)) {
      let depth = 0
      let end = i + 1
      for (; end < segment.length; end++) {
        if (segment[end] === "(") depth++
        else if (segment[end] === ")" && --depth === 0) break
      }
      // The inner command may name a heredoc the whole line's reading took out.
      const inner = segment.slice(i + 2, end).replace(/<<__HEREDOC_(\d+)__/g, (_, n: string) => `<<__EOF__\n${bodies[Number(n)] ?? ""}__EOF__\n`)
      const printed = runShell(inner, world, rules).out.replace(/^\(no output\)$|\n?\(exit \d+\)$/, "").replace(/\n+$/, "")
      out += quote === '"' ? printed.replace(/(["\\$`])/g, "\\$1") : printed
      i = end
      continue
    }
    out += ch
  }
  return out
}

/** zsh's globbing of an unquoted word with * or ?: the paths it matches, or zsh's error when none does. */
const globbed = (segment: string, world: World): { readonly segment: string } | { readonly error: string } => {
  let out = ""
  let last = 0
  for (const match of segment.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+/g)) {
    const token = match[0]
    if (!/[*?]/.test(token) || /["'$=`\\]/.test(token) || match.index === 0) continue
    const pattern = new Bun.Glob(absolute(world.dir, token))
    const candidates = new Set<string>([...Object.keys(world.elsewhere), ...world.made])
    for (const file of Object.keys(world.files)) for (let path = `${world.cwd}/${file}`; path.startsWith(world.cwd + "/"); path = dirname(path)) candidates.add(path)
    for (const [dir, names] of Object.entries(world.outside)) for (const name of names) candidates.add(`${dir}/${name.replace(/\/$/, "")}`)
    const hits = [...candidates].filter((path) => pattern.match(path)).sort()
    if (hits.length === 0) return { error: `zsh: no matches found: ${token}` }
    const shownHits = hits.map((path) => (token.startsWith("/") || token.startsWith("~") ? path : path.startsWith(world.dir + "/") ? path.slice(world.dir.length + 1) : path))
    out += segment.slice(last, match.index) + shownHits.join(" ")
    last = match.index + token.length
  }
  return { segment: out + segment.slice(last) }
}

/** One segment, its pipeline and its redirection, answered. */
const runSegment = (given: string, world: World, rules: ReadonlyArray<Rule>, bodies: ReadonlyArray<string>): Outcome => {
  // The parentheses of a subshell `(a; b)`, split across its segments.
  const opens = (given.match(/(?<!\$)\(/g) ?? []).length
  const closes = (given.match(/\)/g) ?? []).length
  const bare = given.replace(opens > closes ? /^\(\s*/ : /^(?!)/, "").replace(closes > opens ? /\s*\)$/ : /^(?!)/, "")
  const expanded = globbed(substitute(bare, world, rules, bodies), world)
  if ("error" in expanded) return { out: expanded.error, code: 1 }
  const whole = expanded.segment
  const [first = "", ...later] = stages(whole)
  const { stage: redirected, to, append } = redirection(first)
  const marker = redirected.match(/\s*<<__HEREDOC_(\d+)__/)
  const stdin = marker === null ? undefined : bodies[Number(marker[1])]
  const segment = marker === null ? redirected : redirected.replace(marker[0], "")
  const program = programOf(segment)
  const inner = wrapped(program)
  let answered: Outcome
  if (inner !== undefined) answered = runShell(inner, world, rules)
  else {
    const rule = rules.find((candidate) => candidate.match.test(segment) || candidate.match.test(program)) ?? COMMON.find((candidate) => candidate.match.test(program))
    const result = rule === undefined ? "" : rule.run(segment, world, stdin)
    answered = typeof result === "string" ? { out: result, code: 0 } : result
  }
  // `(no output)` and `(exit N)` are the whole line's words, never a wrapped command's.
  if (inner !== undefined) answered = { out: answered.out.replace(/^\(no output\)$|\n?\(exit \d+\)$/, ""), code: answered.code }
  const outcome = { out: later.reduce(filter, answered.out), code: answered.code }
  if (to === undefined) return outcome
  const previous = append ? fileAt(world, to) ?? "" : ""
  writeAt(world, to, previous + (outcome.out === "" ? "" : outcome.out.replace(/\n?$/, "\n")))
  return { out: "", code: outcome.code }
}

/** The shell's answer to a whole command line: each segment as its operator says (&&, ||, ;), with `$?` kept. */
export const runShell = (command: string, world: World, rules: ReadonlyArray<Rule>): Outcome => {
  const { line, bodies } = heredocs(command)
  const outputs: Array<string> = []
  let code = 0
  for (const part of parts(line)) {
    if ((part.op === "&&" && code !== 0) || (part.op === "||" && code === 0)) continue
    const outcome = runSegment(part.text, world, rules, bodies)
    if (outcome.out !== "") outputs.push(outcome.out)
    code = outcome.code
    world.lastCode = code
  }
  const text = outputs.join("\n")
  return { out: text === "" ? (code === 0 ? "(no output)" : `(exit ${code})`) : code === 0 ? text : `${text}\n(exit ${code})`, code }
}

const numbered = (text: string) => text.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n")

/** The answer to a distractor tool's call; their paths read against the repository's root. */
export const runDistractor = (name: string, input: Record<string, unknown>, world: World): Outcome => {
  const given = typeof input["path"] === "string" ? input["path"] : "."
  const abs = absolute(world.cwd, given)
  const path = inRepo(world, abs)
  switch (name) {
    case "read": {
      if (path !== undefined && path in world.files) return { out: numbered(world.files[path]!), code: 0 }
      const dir = listing(world, abs)
      return dir === undefined ? { out: `File not found: ${given}`, code: 1 } : { out: dir, code: 0 }
    }
    case "edit": {
      const text = path === undefined ? undefined : world.files[path]
      const oldString = String(input["oldString"] ?? "")
      if (path === undefined || text === undefined) return { out: `File not found: ${given}`, code: 1 }
      if (!text.includes(oldString)) return { out: "oldString not found in the file", code: 1 }
      world.files[path] = input["replaceAll"] === true ? text.split(oldString).join(String(input["newString"])) : text.replace(oldString, String(input["newString"]))
      return { out: "Edit applied successfully.", code: 0 }
    }
    case "write": {
      if (path === undefined) return { out: `Refused: ${given} is outside the project`, code: 1 }
      const existed = path in world.files
      world.files[path] = String(input["content"] ?? "")
      return { out: `${existed ? "Wrote" : "Created"} file successfully: ${path}`, code: 0 }
    }
    case "grep": {
      const pattern = String(input["pattern"] ?? "")
      const regex = input["literal"] === true ? regexOf(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "") : regexOf(pattern, "")
      const include = typeof input["include"] === "string" ? new Bun.Glob(input["include"]) : undefined
      const lines = Object.entries(world.files)
        .filter(([file]) => path === undefined || path === "" || file === path || file.startsWith(path + "/"))
        .filter(([file]) => include === undefined || include.match(file.split("/").at(-1)!) || include.match(file))
        .flatMap(([file, text]) => text.split("\n").flatMap((line, index) => (regex.test(line) ? [`${file}:\n  Line ${index + 1}: ${line}`] : [])))
      return { out: lines.length === 0 ? "No matches found" : `Found ${lines.length} matches\n${lines.join("\n")}`, code: 0 }
    }
    case "glob": {
      const glob = new Bun.Glob(String(input["pattern"] ?? "**/*"))
      const prefix = path === undefined || path === "" ? "" : path + "/"
      const found = Object.keys(world.files).filter((file) => file.startsWith(prefix) && glob.match(file.slice(prefix.length)))
      return { out: found.length === 0 ? "No files found" : found.join("\n"), code: 0 }
    }
    case "webfetch":
    case "websearch":
      return { out: "No results: this machine is offline.", code: 1 }
    case "todowrite":
      return { out: "Todos updated.", code: 0 }
    case "question":
      return { out: "The user is away from the keyboard; go on with your best judgment.", code: 1 }
    case "subagent":
      return { out: "Subagents are unavailable in this session; do the task yourself.", code: 1 }
    case "skill":
      return { out: "Skill loaded; nothing in it applies to this task.", code: 0 }
    default:
      return { out: `Unknown tool: ${name}`, code: 1 }
  }
}
