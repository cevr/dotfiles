// The fake machine a session works on: the repository's files, its branch and
// what the session changed, the shell's directory and the few directories
// around the repository, a canned `shell` that answers git, files, package
// scripts and the scenario's own commands, and answers for the distractor
// tools. Nothing here touches a real file or runs a real program.
import { dirname, join, normalize } from "node:path"

export interface Outcome {
  readonly out: string
  readonly code: number
}

export const HOME = "/Users/dev"

export interface World {
  /** The repository's root, absolute. */
  readonly cwd: string
  /** The shell's working directory, absolute; `cd` moves it. */
  dir: string
  /** The repository's files, keyed by their path from its root. */
  readonly files: Record<string, string>
  /** The files as the session found them. */
  readonly original: Readonly<Record<string, string>>
  /** Directories outside the repository, absolute, with their entries (`name/` for a directory). */
  readonly outside: Readonly<Record<string, ReadonlyArray<string>>>
  branch: string
  /** Paths the session edited or wrote. */
  readonly touched: Set<string>
  /** Variables an `export` set earlier in the session. */
  readonly env: Record<string, string>
  /** Untracked or modified paths the session never touched, as `git status --short` shows them. */
  readonly noise: ReadonlyArray<string>
  commits: number
  /** The session's commit subjects, newest first. */
  readonly log: Array<string>
}

export interface Rule {
  readonly match: RegExp
  readonly run: (segment: string, world: World) => Outcome | string
}

/**
 * A world on the repository at `cwd`. Each directory between the home directory and the repository lists the next one
 * down, plus what `extra` adds (another checkout beside it, say).
 */
export const newWorld = (
  cwd: string,
  files: Record<string, string>,
  branch: string,
  noise: ReadonlyArray<string>,
  extra: Readonly<Record<string, ReadonlyArray<string>>> = {},
): World => {
  const outside: Record<string, Array<string>> = { [HOME]: ["Desktop/", "Downloads/", "Library/"] }
  for (let child = cwd, parent = dirname(cwd); child !== HOME && parent.startsWith(HOME); child = parent, parent = dirname(parent))
    (outside[parent] ??= []).push(child.slice(parent.length + 1) + "/")
  for (const [dir, entries] of Object.entries(extra)) (outside[dir] ??= []).push(...entries)
  for (const dir of Object.keys(outside)) outside[dir] = [...new Set(outside[dir])].sort()
  return { cwd, dir: cwd, files: { ...files }, original: files, outside, branch, touched: new Set(), env: {}, noise, commits: 0, log: [] }
}

/** A command's words, quotes removed: `grep -n "a b" x` → grep, -n, a b, x. */
export const words = (command: string): Array<string> => {
  const out: Array<string> = []
  for (const match of command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(match[1] ?? match[2] ?? match[3] ?? "")
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

const isRepoDir = (world: World, rel: string) => rel === "" || Object.keys(world.files).some((file) => file.startsWith(rel + "/"))

/** A directory's entries, one per line, or undefined when there is no such directory. */
const listing = (world: World, abs: string): string | undefined => {
  const rel = inRepo(world, abs)
  if (rel === undefined) return world.outside[abs]?.join("\n")
  if (!isRepoDir(world, rel)) return undefined
  const prefix = rel === "" ? "" : rel + "/"
  const names = new Set<string>()
  for (const path of Object.keys(world.files)) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    names.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/") + 1) : rest)
  }
  return [...names].sort().join("\n")
}

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
const search = (world: World, args: ReadonlyArray<string>): string => {
  const flags = args.filter((arg) => arg.startsWith("-"))
  const rest = args.filter((arg, index) => !arg.startsWith("-") && !(index > 0 && /^-(?:e|g|-glob|-include|t|-type|A|B|C|m)$/.test(args[index - 1]!)))
  const pattern = rest[0] ?? ""
  const regex = regexOf(pattern, flags.some((flag) => /^-\w*i/.test(flag)) ? "i" : "")
  const scope = rest.length > 1 ? rest.slice(1).flatMap((path) => filesUnder(world, path)) : filesUnder(world, ".")
  return scope
    .flatMap((path) => world.files[path]!.split("\n").flatMap((line, index) => (pattern !== "" && regex.test(line) ? [`${shown(world, path)}:${index + 1}:${line}`] : [])))
    .join("\n")
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
      return String(lines.length)
    case "sort":
      return [...lines].sort().join("\n")
    default:
      return text
  }
}

/** A segment's pipeline stages, split on `|` outside quotes. */
const stages = (segment: string): Array<string> => {
  const out: Array<string> = []
  let current = ""
  let quote: string | undefined
  for (const ch of segment) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
    } else if (ch === "'" || ch === '"') quote = ch
    else if (ch === "|") {
      out.push(current.trim())
      current = ""
      continue
    }
    current += ch
  }
  out.push(current.trim())
  return out.filter((stage) => stage !== "")
}

/**
 * A command line split into the commands it runs, on `&&`, `||`, `;` and newlines outside quotes. A pipe stays in its
 * segment. Leading `VAR=value` assignments stay on the segment they prefix.
 */
export const segments = (command: string): Array<string> => {
  const out: Array<string> = []
  let current = ""
  let quote: string | undefined
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
    const two = command.slice(i, i + 2)
    if (two === "&&" || two === "||") {
      out.push(current)
      current = ""
      i++
      continue
    }
    if (ch === ";" || ch === "\n") {
      out.push(current)
      current = ""
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map((part) => part.trim()).filter((part) => part !== "")
}

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
  return segments(command)
    .filter((segment) => /^git\s+commit\b/.test(programOf(segment)))
    .map(commitMessage)
}

const hash = (seed: number) => (0x1a2b3c4 + seed * 7919).toString(16).slice(0, 7)

const statusOf = (world: World): string => {
  const changed = [...world.touched].map((path) => (path in world.original ? ` M ${path}` : `?? ${path}`))
  return [`On branch ${world.branch}`, ...(changed.length + world.noise.length === 0 ? ["nothing to commit, working tree clean"] : ["", ...changed, ...world.noise])].join("\n")
}

/** The package.json nearest above the shell's directory inside the repository, and its directory. */
const packageOf = (world: World): { readonly dir: string; readonly scripts: Record<string, string> } | undefined => {
  for (let rel = inRepo(world, world.dir); rel !== undefined; rel = rel === "" ? undefined : rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "") {
    const text = world.files[rel === "" ? "package.json" : `${rel}/package.json`]
    if (text !== undefined) return { dir: rel, scripts: (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {} }
  }
  return undefined
}

/** Commands every machine answers the same way: cd, git, files, package scripts, the usual small programs. */
export const COMMON: ReadonlyArray<Rule> = [
  { match: /^cd\b/, run: (segment, world) => {
      const target = absolute(world.dir, words(segment)[1] ?? HOME)
      const rel = inRepo(world, target)
      if (rel === undefined ? world.outside[target] === undefined : !isRepoDir(world, rel)) return { out: `cd: no such file or directory: ${words(segment)[1]}`, code: 1 }
      world.dir = target
      return ""
    } },
  { match: /^export\s+/, run: (segment, world) => {
      for (const [, name, value] of segment.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g)) world.env[name!] = value!.replace(/^["']|["']$/g, "")
      return ""
    } },
  { match: /^git\s+status\b/, run: (_, world) => statusOf(world) },
  { match: /^git\s+(?:checkout\s+-b|switch\s+-c|checkout\s+-B|switch\s+-C)\s+(\S+)/, run: (segment, world) => {
      world.branch = segment.match(/(?:-b|-c|-B|-C)\s+(\S+)/)![1]!.replace(/["']/g, "")
      return `Switched to a new branch '${world.branch}'`
    } },
  { match: /^git\s+branch\s+(?:-m|-M|--move)\s+/, run: (segment, world) => {
      const names = segment.replace(/^git\s+branch\s+(?:-m|-M|--move)\s+/, "").split(/\s+/).filter(Boolean)
      world.branch = (names.length >= 2 ? names[1]! : names[0]!).replace(/["']/g, "")
      return ""
    } },
  { match: /^git\s+branch\s+(?!-)(\S+)/, run: () => "" },
  { match: /^git\s+branch\b/, run: (_, world) => `* ${world.branch}\n  main` },
  { match: /^git\s+(?:checkout|switch)\s+\S+/, run: (segment, world) => {
      const name = segment.split(/\s+/).at(-1)!
      if (name === "--" || segment.includes(" -- ") || repoPath(world, name) !== undefined && repoPath(world, name)! in world.files) return ""
      world.branch = name
      return `Switched to branch '${name}'`
    } },
  { match: /^git\s+add\b/, run: () => "" },
  { match: /^git\s+commit\b/, run: (segment, world) => {
      world.commits += 1
      const message = commitMessage(segment) || "(message from editor)"
      world.log.unshift(message.split("\n")[0]!)
      const count = Math.max(1, world.touched.size)
      return `[${world.branch} ${hash(world.commits)}] ${message.split("\n")[0]}\n ${count} file${count === 1 ? "" : "s"} changed, ${4 * count} insertions(+), ${2 * count} deletions(-)`
    } },
  { match: /^git\s+(?:diff|show)\b/, run: (_, world) =>
      [...world.touched].map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ (the session's edit) @@`).join("\n") },
  { match: /^git\s+log\b/, run: (_, world) =>
      [...world.log, "fix: handle empty cart", "chore: bump deps", "feat: add order export"]
        .map((subject, index) => `${hash(world.commits - index + 40)}${index === 0 ? ` (HEAD -> ${world.branch})` : ""} ${subject}`)
        .join("\n") },
  { match: /^git\s+push\b/, run: (_, world) => `To github.com:acme/repo.git\n * [new branch]      ${world.branch} -> ${world.branch}` },
  { match: /^git\s+(?:restore|reset|rm|stash|fetch|pull|remote|rev-parse|config)\b/, run: (segment, world) =>
      /rev-parse.*--abbrev-ref/.test(segment) ? world.branch : /rev-parse.*--show-toplevel/.test(segment) ? world.cwd : "" },
  { match: /^(?:cat|head|tail|less|bat|sed|awk|nl)\s+/, run: (segment, world) => {
      const args = words(segment).slice(1)
      const paths = args.filter((arg, index) => !arg.startsWith("-") && !/^\d+$/.test(arg) && !(index > 0 && args[index - 1] === "-n") && !/^\d+,\d+p$|^\{/.test(arg))
      const found = paths.map((path) => repoPath(world, path)).filter((path): path is string => path !== undefined && path in world.files)
      if (found.length === 0) return { out: `${words(segment)[0]}: ${paths.at(-1) ?? ""}: No such file or directory`, code: 1 }
      const text = found.map((path) => world.files[path]!).join("\n")
      return /^(?:head|tail)/.test(segment) ? filter(text, `${words(segment)[0]} ${args.join(" ")}`) : text
    } },
  { match: /^ls\b/, run: (segment, world) => {
      const path = words(segment).slice(1).find((word) => !word.startsWith("-")) ?? "."
      const rel = repoPath(world, path)
      if (rel !== undefined && rel in world.files) return path
      return listing(world, absolute(world.dir, path)) ?? { out: `ls: ${path}: No such file or directory`, code: 1 }
    } },
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
      segment.replace(/^(?:echo|printf)\s*/, "").replace(/^["']|["']$/g, "").replace(/\$\{?HOME\}?/g, HOME).replace(/\$\{?(\w+)\}?/g, (_, name: string) => world.env[name] ?? "") },
  { match: /^(?:which|command\s+-v)\s+(\S+)/, run: (segment) => `/opt/homebrew/bin/${segment.split(/\s+/).at(-1)}` },
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

/** The shell's answer to a whole command line: each segment in turn, stopping at the first that fails. */
export const runShell = (command: string, world: World, rules: ReadonlyArray<Rule>): Outcome => {
  const outputs: Array<string> = []
  let code = 0
  for (const whole of segments(command)) {
    // Redirections of stderr or to /dev/null change nothing here; a pipeline's later stages filter the first one's output.
    const [segment = "", ...later] = stages(whole.replace(/\s\d?>&\d\b|\s(?:\d|&)?>>?\s*\/dev\/null\b/g, ""))
    const program = programOf(segment)
    const rule = rules.find((candidate) => candidate.match.test(segment) || candidate.match.test(program)) ?? COMMON.find((candidate) => candidate.match.test(program))
    const result = rule === undefined ? "" : rule.run(segment, world)
    const first = typeof result === "string" ? { out: result, code: 0 } : result
    const outcome = { out: later.reduce(filter, first.out), code: first.code }
    if (outcome.out !== "") outputs.push(outcome.out)
    code = outcome.code
    if (code !== 0) break
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
      world.touched.add(path)
      return { out: "Edit applied successfully.", code: 0 }
    }
    case "write": {
      if (path === undefined) return { out: `Refused: ${given} is outside the project`, code: 1 }
      const existed = path in world.files
      world.files[path] = String(input["content"] ?? "")
      world.touched.add(path)
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
