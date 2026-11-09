// The fake repository's git: three trees (HEAD, the index, the working files)
// and a history of commits, so `git status`, `git diff`, `git commit`, `git
// reset` and `git log` agree with each other the way a real repository's do.
// Round 3's git answered from one "touched" set: a commit never cleaned the
// status, a diff printed a placeholder hunk, and Haiku 5.5 stopped trusting
// the shell. Nothing here touches a real repository.
import { relative } from "node:path"
import type { Outcome, World } from "./world.ts"
import { absolute, words } from "./world.ts"

export type Tree = Record<string, string>

export interface Commit {
  readonly hash: string
  readonly message: string
  readonly tree: Tree
  readonly date: string
}

export interface Repo {
  head: Tree
  index: Tree
  /** HEAD's ancestry, newest first; the first is HEAD. */
  commits: Array<Commit>
  /** Every commit ever made, by hash, with its ancestry: a reset to a commit the branch left still finds it. */
  readonly objects: Map<string, ReadonlyArray<Commit>>
  /** Where HEAD has been, newest first, as `git reflog` shows it. */
  readonly reflog: Array<{ readonly hash: string; readonly action: string }>
  readonly stash: Array<{ readonly index: Tree; readonly files: Tree; readonly message: string }>
}

const sha = (text: string) => new Bun.CryptoHasher("sha1").update(text).digest("hex")
const short = (hash: string) => hash.slice(0, 7)
const subjectOf = (message: string) => message.split("\n")[0]!.trim()

/** The base history every session starts on, oldest first. */
export const DEFAULT_HISTORY: ReadonlyArray<string> = ["feat: add order export", "chore: bump deps", "fix: handle empty cart"]

/** A commit on `parent` with `tree`; its hash follows from both, so the same history gives the same hashes. */
const commitOf = (parent: string, message: string, tree: Tree, date: string): Commit => ({
  hash: sha(`${parent}\n${message}\n${JSON.stringify(Object.entries(tree).sort())}`),
  message,
  tree: { ...tree },
  date,
})

const DATES = ["Mon Nov 3 10:12:44 2026 +0000", "Wed Nov 5 16:40:02 2026 +0000", "Fri Nov 7 09:05:31 2026 +0000"]
const NOW = "Mon Nov 9 11:20:00 2026 +0000"

/** A repository whose HEAD and index are `head`, with `history` (oldest first) behind it. */
export const newRepo = (head: Tree, history: ReadonlyArray<string> = DEFAULT_HISTORY): Repo => {
  const commits: Array<Commit> = []
  const objects = new Map<string, ReadonlyArray<Commit>>()
  let parent = ""
  history.forEach((message, index) => {
    const commit = commitOf(parent, message, head, DATES[index % DATES.length]!)
    commits.unshift(commit)
    objects.set(commit.hash, [...commits])
    parent = commit.hash
  })
  const tip = commits[0]!
  return { head: { ...head }, index: { ...head }, commits, objects, reflog: [{ hash: tip.hash, action: `commit: ${subjectOf(tip.message)}` }], stash: [] }
}

/** HEAD moves to `ancestry[0]`; the reflog records why. */
const moveHead = (repo: Repo, ancestry: ReadonlyArray<Commit>, action: string) => {
  repo.commits = [...ancestry]
  repo.objects.set(ancestry[0]!.hash, [...ancestry])
  repo.reflog.unshift({ hash: ancestry[0]!.hash, action })
}

/** Whether `.gitignore` at the root ignores `path`: a name anywhere, a `dir/`, or a `*` pattern on the file's name. */
export const ignored = (files: Readonly<Tree>, path: string): boolean =>
  (files[".gitignore"] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .some((pattern) => {
      const bare = pattern.replace(/^\//, "")
      if (bare.endsWith("/")) return path.startsWith(bare) || path.includes(`/${bare}`)
      if (/[*?]/.test(bare)) return new Bun.Glob(bare).match(path.split("/").at(-1)!) || new Bun.Glob(bare).match(path)
      return path === bare || path.startsWith(bare + "/") || path.split("/").includes(bare)
    })

// ---------------------------------------------------------------- diff

type Op = { readonly kind: " " | "-" | "+"; readonly line: string }

const linesOf = (text: string | undefined) => (text === undefined || text === "" ? [] : text.replace(/\n$/, "").split("\n"))

/** The line edits from `a` to `b`, by longest common subsequence (the files here are small). */
const ops = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<Op> => {
  const n = a.length
  const m = b.length
  const table = Array.from({ length: n + 1 }, () => Array.from<number>({ length: m + 1 }).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  const out: Array<Op> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", line: a[i]! })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) out.push({ kind: "-", line: a[i++]! })
    else out.push({ kind: "+", line: b[j++]! })
  }
  while (i < n) out.push({ kind: "-", line: a[i++]! })
  while (j < m) out.push({ kind: "+", line: b[j++]! })
  return out
}

export interface FileDiff {
  readonly path: string
  readonly status: "A" | "D" | "M"
  readonly added: number
  readonly removed: number
  readonly text: string
}

/** The unified diff of one file, three lines of context, as `git diff` prints it. */
export const fileDiff = (path: string, before: string | undefined, after: string | undefined): FileDiff => {
  const all = ops(linesOf(before), linesOf(after))
  const status = before === undefined ? "A" : after === undefined ? "D" : "M"
  const header = [
    `diff --git a/${path} b/${path}`,
    ...(status === "A" ? ["new file mode 100644"] : status === "D" ? ["deleted file mode 100644"] : []),
    `index ${short(sha(before ?? ""))}..${short(sha(after ?? ""))}${status === "M" ? " 100644" : ""}`,
    `--- ${before === undefined ? "/dev/null" : `a/${path}`}`,
    `+++ ${after === undefined ? "/dev/null" : `b/${path}`}`,
  ]
  const hunks: Array<string> = []
  const changed = all.flatMap((op, index) => (op.kind === " " ? [] : [index]))
  let at = 0
  while (at < changed.length) {
    const start = Math.max(0, changed[at]! - 3)
    let end = Math.min(all.length, changed[at]! + 4)
    while (at + 1 < changed.length && changed[at + 1]! - 3 <= end) end = Math.min(all.length, changed[++at]! + 4)
    at++
    const slice = all.slice(start, end)
    const oldStart = all.slice(0, start).filter((op) => op.kind !== "+").length
    const newStart = all.slice(0, start).filter((op) => op.kind !== "-").length
    const oldCount = slice.filter((op) => op.kind !== "+").length
    const newCount = slice.filter((op) => op.kind !== "-").length
    hunks.push(`@@ -${oldCount === 0 ? oldStart : oldStart + 1},${oldCount} +${newCount === 0 ? newStart : newStart + 1},${newCount} @@`, ...slice.map((op) => op.kind + op.line))
  }
  return {
    path,
    status,
    added: all.filter((op) => op.kind === "+").length,
    removed: all.filter((op) => op.kind === "-").length,
    text: [...header, ...hunks].join("\n"),
  }
}

/** Every file that differs between two trees, by path. */
export const treeDiff = (before: Tree, after: Tree, only?: (path: string) => boolean): Array<FileDiff> =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((path) => (only === undefined || only(path)) && before[path] !== after[path])
    .map((path) => fileDiff(path, before[path], after[path]))

const statLines = (diffs: ReadonlyArray<FileDiff>): string => {
  if (diffs.length === 0) return ""
  const width = Math.max(...diffs.map((diff) => diff.path.length))
  const digits = Math.max(...diffs.map((diff) => String(diff.added + diff.removed).length))
  const added = diffs.reduce((n, diff) => n + diff.added, 0)
  const removed = diffs.reduce((n, diff) => n + diff.removed, 0)
  return [
    ...diffs.map((diff) => ` ${diff.path.padEnd(width)} | ${String(diff.added + diff.removed).padStart(digits)} ${"+".repeat(Math.min(diff.added, 40))}${"-".repeat(Math.min(diff.removed, 40))}`),
    summaryLine(diffs.length, added, removed),
  ].join("\n")
}

const summaryLine = (files: number, added: number, removed: number) =>
  ` ${files} file${files === 1 ? "" : "s"} changed${added > 0 || removed === 0 ? `, ${added} insertion${added === 1 ? "" : "s"}(+)` : ""}${removed > 0 ? `, ${removed} deletion${removed === 1 ? "" : "s"}(-)` : ""}`

// ---------------------------------------------------------------- paths

/** A path as git shows it from the shell's directory. */
const shownFrom = (world: World, path: string) => relative(world.dir, `${world.cwd}/${path}`) || "."

/** The repository paths a pathspec names, read against `dir`: a file, a directory or a glob. */
const matchSpec = (world: World, dir: string, spec: string, paths: ReadonlyArray<string>): Array<string> => {
  const abs = absolute(dir, spec.replace(/^:\(top\)|^:\//, world.cwd + "/"))
  if (abs !== world.cwd && !abs.startsWith(world.cwd + "/")) return []
  const rel = abs === world.cwd ? "" : abs.slice(world.cwd.length + 1)
  if (/[*?[]/.test(rel)) {
    const glob = new Bun.Glob(rel)
    return paths.filter((path) => glob.match(path))
  }
  return paths.filter((path) => rel === "" || path === rel || path.startsWith(rel + "/"))
}

const fail = (out: string, code = 1): Outcome => ({ out, code })
const ok = (out: string): Outcome => ({ out, code: 0 })

/**
 * The commit a revision names, as its ancestry (the commit first): HEAD, @, HEAD@{n}, a hash prefix, the branch or
 * main, each with ~N and ^ steps.
 */
const resolve = (world: World, rev: string): ReadonlyArray<Commit> | undefined => {
  const repo = world.repo
  const match = rev.match(/^(HEAD@\{\d+\}|@\{\d+\}|HEAD|@|[\w./-]+?)((?:[~^]\d*)*)$/)
  if (match === null) return undefined
  const base = match[1]!
  const logged = base.match(/@\{(\d+)\}$/)
  let ancestry: ReadonlyArray<Commit> | undefined
  if (logged !== null) ancestry = repo.objects.get(repo.reflog[Number(logged[1])]?.hash ?? "")
  else if (base === "HEAD" || base === "@" || base === world.branch) ancestry = repo.commits
  else if (["main", "master", "origin/main", "origin/HEAD"].includes(base)) ancestry = repo.objects.get(repo.reflog.at(-1)!.hash)
  else if (/^[0-9a-f]{4,40}$/.test(base)) ancestry = [...repo.objects.entries()].find(([hash]) => hash.startsWith(base))?.[1]
  if (ancestry === undefined) return undefined
  let at = 0
  for (const step of match[2]!.matchAll(/([~^])(\d*)/g)) at += step[2] === "" ? 1 : Number(step[2])
  return at < ancestry.length ? ancestry.slice(at) : undefined
}

const unknownRev = (rev: string) => fail(`fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`, 128)

// ---------------------------------------------------------------- status

interface Entry {
  readonly path: string
  readonly x: string
  readonly y: string
}

/** Each changed path's two status letters, untracked files folded into their highest untracked directory. */
const entries = (world: World): Array<Entry> => {
  const { head, index } = world.repo
  const files = world.files
  const out: Array<Entry> = []
  const untracked = new Set<string>()
  for (const path of [...new Set([...Object.keys(head), ...Object.keys(index), ...Object.keys(files)])].sort()) {
    const inIndex = path in index
    const x = path in head ? (inIndex ? (head[path] === index[path] ? " " : "M") : "D") : inIndex ? "A" : ""
    if (!inIndex && !(path in head)) {
      if (ignored(files, path)) continue
      // Untracked: shown as its highest directory that holds no tracked file.
      const parts = path.split("/")
      let shown = path
      for (let depth = 1; depth < parts.length; depth++) {
        const dir = parts.slice(0, depth).join("/")
        if (!Object.keys(index).some((tracked) => tracked.startsWith(dir + "/"))) {
          shown = dir + "/"
          break
        }
      }
      untracked.add(shown)
      continue
    }
    const y = inIndex ? (path in files ? (files[path] === index[path] ? " " : "M") : "D") : path in files ? "" : " "
    if (x === " " && y === " ") continue
    if (x === "D" && path in files) {
      out.push({ path, x: "D", y: " " })
      untracked.add(path)
      continue
    }
    out.push({ path, x, y: y === "" ? " " : y })
  }
  return [...out, ...[...untracked].sort().map((path) => ({ path, x: "?", y: "?" }))]
}

const LONG_NAMES: Record<string, string> = { M: "modified:   ", A: "new file:   ", D: "deleted:    " }

const status = (world: World, args: ReadonlyArray<string>): Outcome => {
  const list = entries(world)
  const porcelain = args.some((arg) => arg === "--porcelain" || arg.startsWith("--porcelain="))
  if (porcelain || args.some((arg) => arg === "-s" || arg === "--short" || /^-s[b]?$|^-bs$/.test(arg))) {
    const branch = args.some((arg) => arg === "-b" || arg === "--branch" || arg === "-sb" || arg === "-bs") ? [`## ${world.branch}`] : []
    return ok([...branch, ...list.map((entry) => `${entry.x}${entry.y} ${porcelain ? entry.path : shownFrom(world, entry.path)}${entry.path.endsWith("/") && !porcelain && !shownFrom(world, entry.path).endsWith("/") ? "/" : ""}`)].join("\n"))
  }
  const staged = list.filter((entry) => entry.x !== " " && entry.x !== "?")
  const unstaged = list.filter((entry) => entry.y !== " " && entry.y !== "?")
  const untracked = list.filter((entry) => entry.x === "?")
  const out = [`On branch ${world.branch}`]
  if (staged.length > 0) out.push("Changes to be committed:", '  (use "git restore --staged <file>..." to unstage)', ...staged.map((e) => `\t${LONG_NAMES[e.x]}${shownFrom(world, e.path)}`), "")
  if (unstaged.length > 0)
    out.push("Changes not staged for commit:", '  (use "git add <file>..." to update what will be committed)', '  (use "git restore <file>..." to discard changes in working directory)', ...unstaged.map((e) => `\t${LONG_NAMES[e.y]}${shownFrom(world, e.path)}`), "")
  if (untracked.length > 0) out.push("Untracked files:", '  (use "git add <file>..." to include in what will be committed)', ...untracked.map((e) => `\t${shownFrom(world, e.path)}${e.path.endsWith("/") ? "/" : ""}`), "")
  if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) out.push("nothing to commit, working tree clean")
  else if (staged.length === 0) out.push(unstaged.length > 0 ? 'no changes added to commit (use "git add" and/or "git commit -a")' : 'nothing added to commit but untracked files present (use "git add" to track)')
  return ok(out.join("\n").replace(/\n+$/, ""))
}

// ---------------------------------------------------------------- commands

/** `git add`: each pathspec's working files into the index, a removed file as a staged deletion. */
const add = (world: World, args: ReadonlyArray<string>): Outcome => {
  const { index } = world.repo
  const flags = args.filter((arg) => arg.startsWith("-") && arg !== "--")
  const specs = args.filter((arg) => !arg.startsWith("-"))
  const known = [...new Set([...Object.keys(index), ...Object.keys(world.files)])]
  const update = flags.some((flag) => ["-u", "--update"].includes(flag))
  const all = (update || flags.some((flag) => ["-A", "--all"].includes(flag))) && specs.length === 0
  if (!all && specs.length === 0) return ok("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?")
  const force = flags.some((flag) => flag === "-f" || flag === "--force")
  const chosen = new Set<string>()
  for (const spec of all ? ["."] : specs) {
    const hits = matchSpec(world, all ? world.cwd : world.dir, spec, known)
    if (hits.length === 0) return fail(`fatal: pathspec '${spec}' did not match any files`, 128)
    // An ignored untracked file goes in only with -f; named on its own, git refuses.
    const kept = force ? hits : hits.filter((hit) => hit in index || !ignored(world.files, hit))
    if (kept.length === 0) return fail(`The following paths are ignored by one of your .gitignore files:\n${spec}\nhint: Use -f if you really want to add them.\nhint: Turn this message off by running\nhint: "git config advice.addIgnoredFile false"`, 1)
    for (const hit of kept) chosen.add(hit)
  }
  for (const path of chosen) {
    if (update && !(path in index)) continue
    if (path in world.files) index[path] = world.files[path]!
    else delete index[path]
  }
  return ok("")
}

const rm = (world: World, args: ReadonlyArray<string>): Outcome => {
  const cached = args.includes("--cached")
  const recursive = args.some((arg) => /^-\w*r/.test(arg))
  const specs = args.filter((arg) => !arg.startsWith("-"))
  const out: Array<string> = []
  for (const spec of specs) {
    const hits = matchSpec(world, world.dir, spec, Object.keys(world.repo.index))
    if (hits.length === 0) return fail(`fatal: pathspec '${spec}' did not match any files`, 128)
    // A directory, not a glob: its files go only with -r.
    const named = absolute(world.dir, spec).slice(world.cwd.length + 1)
    if (!recursive && !/[*?[]/.test(spec) && hits.some((hit) => hit !== named)) return fail(`fatal: not removing '${spec}' recursively without -r`, 128)
    for (const hit of hits) {
      delete world.repo.index[hit]
      if (!cached) delete world.files[hit]
      out.push(`rm '${hit}'`)
    }
  }
  return ok(out.join("\n"))
}

/** `git restore` and `git checkout -- paths`: files from the index (or a source), or the index from HEAD. */
const restore = (world: World, args: ReadonlyArray<string>): Outcome => {
  const staged = args.includes("--staged") || args.includes("-S")
  const worktree = args.includes("--worktree") || args.includes("-W") || !staged
  const sourceArg = args.find((arg) => arg.startsWith("--source="))?.slice(9) ?? (args.includes("-s") ? args[args.indexOf("-s") + 1] : undefined) ?? (args.includes("--source") ? args[args.indexOf("--source") + 1] : undefined)
  const specs = args.filter((arg, index) => !arg.startsWith("-") && !["-s", "--source"].includes(args[index - 1] ?? ""))
  if (specs.length === 0) return fail("fatal: you must specify path(s) to restore", 128)
  let source: Tree | undefined
  if (sourceArg !== undefined) {
    const found = resolve(world, sourceArg)
    if (found === undefined) return fail(`fatal: could not resolve ${sourceArg}`, 128)
    source = found[0]!.tree
  }
  const { head, index } = world.repo
  for (const spec of specs) {
    const known = [...new Set([...Object.keys(head), ...Object.keys(index), ...Object.keys(world.files)])]
    const hits = matchSpec(world, world.dir, spec, known)
    if (hits.length === 0) return fail(`error: pathspec '${spec}' did not match any file(s) known to git`, 1)
    for (const path of hits) {
      if (staged) {
        const from = source ?? head
        if (path in from) index[path] = from[path]!
        else delete index[path]
      }
      if (worktree) {
        const from = source ?? index
        if (path in from) world.files[path] = from[path]!
        else if (path in head || path in index || source !== undefined) delete world.files[path]
      }
    }
  }
  return ok("")
}

const commitMessageOf = (args: ReadonlyArray<string>, stdin: string | undefined): string | undefined => {
  const messages: Array<string> = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "-m" || arg === "--message") messages.push(args[++i] ?? "")
    else if (arg.startsWith("--message=")) messages.push(arg.slice(10))
    else if (/^-[a-zA-Z]*m$/.test(arg) && !arg.startsWith("--")) messages.push(args[++i] ?? "")
    else if (/^-[a-zA-Z]*m./.test(arg) && !arg.startsWith("--")) messages.push(arg.slice(arg.indexOf("m") + 1))
    else if (arg === "-F" || arg === "--file") messages.push(args[++i] === "-" ? (stdin ?? "") : "")
    else if (arg === "--file=-") messages.push(stdin ?? "")
  }
  if (messages.length === 0) return undefined
  // `-m "$(cat <<'EOF' ... EOF)"`: the heredoc's body is the message.
  return messages
    .map((message) => {
      const heredoc = message.match(/^\$\(cat\s+<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\s*\)$/)
      return (heredoc === null ? message : heredoc[2]!).trim()
    })
    .join("\n\n")
}

const commit = (world: World, args: ReadonlyArray<string>, stdin: string | undefined): Outcome => {
  const repo = world.repo
  const flags = args.filter((arg) => arg.startsWith("-"))
  const all = flags.some((flag) => flag === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(flag))
  const amend = flags.includes("--amend")
  const allowEmpty = flags.includes("--allow-empty")
  if (all) for (const path of Object.keys(repo.index)) if (path in world.files) repo.index[path] = world.files[path]!; else delete repo.index[path]
  const parent = amend ? repo.commits[1] : repo.commits[0]
  const parentTree = parent?.tree ?? {}
  const diffs = treeDiff(parentTree, repo.index)
  if (!amend && !allowEmpty && treeDiff(repo.head, repo.index).length === 0) {
    const st = status(world, []).out.replace(/^On branch .*\n?/, "")
    return fail(`On branch ${world.branch}\n${st.trim() === "" ? "nothing to commit, working tree clean" : st}`)
  }
  const given = commitMessageOf(args, stdin)
  const message = given ?? (amend ? repo.commits[0]!.message : undefined)
  if (message === undefined || message.trim() === "")
    return fail(given === undefined ? "error: There was a problem with the editor 'vi'.\nPlease supply the message using either -m or -F option." : "Aborting commit due to empty commit message.")
  const next = commitOf(parent?.hash ?? "", message, repo.index, NOW)
  moveHead(repo, [next, ...repo.commits.slice(amend ? 1 : 0)], `commit${amend ? " (amend)" : ""}: ${subjectOf(message)}`)
  repo.head = { ...repo.index }
  const added = diffs.reduce((n, diff) => n + diff.added, 0)
  const removed = diffs.reduce((n, diff) => n + diff.removed, 0)
  const modes = diffs.flatMap((diff) => (diff.status === "A" ? [` create mode 100644 ${diff.path}`] : diff.status === "D" ? [` delete mode 100644 ${diff.path}`] : []))
  return ok([`[${world.branch} ${short(next.hash)}] ${subjectOf(message)}`, ...(amend ? [` Date: ${NOW}`] : []), summaryLine(diffs.length, added, removed), ...modes].join("\n"))
}

const reset = (world: World, args: ReadonlyArray<string>): Outcome => {
  const repo = world.repo
  const mode = args.find((arg) => ["--soft", "--mixed", "--hard"].includes(arg)) ?? "--mixed"
  const rest = args.filter((arg) => !arg.startsWith("-"))
  const dash = args.indexOf("--")
  const rev = rest[0] !== undefined && resolve(world, rest[0]) !== undefined && (dash === -1 || args.indexOf(rest[0]) < dash) ? rest[0] : undefined
  const specs = rest.filter((arg) => arg !== rev)
  if (specs.length > 0) {
    // `git reset [HEAD] -- paths`: unstage.
    const tree = rev === undefined ? repo.head : resolve(world, rev)![0]!.tree
    for (const spec of specs)
      for (const path of matchSpec(world, world.dir, spec, [...new Set([...Object.keys(tree), ...Object.keys(repo.index)])])) {
        if (path in tree) repo.index[path] = tree[path]!
        else delete repo.index[path]
      }
    const unstaged = entries(world).filter((entry) => entry.y === "M" || entry.y === "D")
    return ok(unstaged.length === 0 ? "" : ["Unstaged changes after reset:", ...unstaged.map((entry) => `${entry.y}\t${entry.path}`)].join("\n"))
  }
  if (rest[0] !== undefined && rev === undefined) return unknownRev(rest[0])
  const target = rev === undefined ? repo.commits : resolve(world, rev)!
  // Tracked before the reset: a hard reset removes such a file when the new HEAD lacks it; untracked files stay.
  const tracked = new Set([...Object.keys(repo.head), ...Object.keys(repo.index)])
  moveHead(repo, target, `reset: moving to ${rev ?? "HEAD"}`)
  repo.head = { ...repo.commits[0]!.tree }
  if (mode !== "--soft") repo.index = { ...repo.head }
  if (mode === "--hard") {
    for (const path of Object.keys(world.files)) if (tracked.has(path) && !(path in repo.head)) delete world.files[path]
    Object.assign(world.files, repo.head)
    return ok(`HEAD is now at ${short(repo.commits[0]!.hash)} ${subjectOf(repo.commits[0]!.message)}`)
  }
  const unstaged = entries(world).filter((entry) => entry.y === "M" || entry.y === "D")
  return ok(unstaged.length === 0 ? "" : ["Unstaged changes after reset:", ...unstaged.map((entry) => `${entry.y}\t${entry.path}`)].join("\n"))
}

const diffCommand = (world: World, args: ReadonlyArray<string>): Outcome => {
  const repo = world.repo
  const cached = args.includes("--cached") || args.includes("--staged")
  const dash = args.indexOf("--")
  const plain = args.filter((arg, index) => !arg.startsWith("-") && (dash === -1 || index < dash))
  const revs: Array<string> = []
  const specs: Array<string> = dash === -1 ? [] : args.slice(dash + 1)
  for (const arg of plain) {
    const range = arg.match(/^(.+?)\.\.\.?(.*)$/)
    if (range !== null && resolve(world, range[1]!) !== undefined) revs.push(range[1]!, range[2] || "HEAD")
    else if (resolve(world, arg) !== undefined) revs.push(arg)
    else specs.push(arg)
  }
  for (const rev of revs) if (resolve(world, rev) === undefined) return unknownRev(rev)
  const treeAt = (rev: string) => resolve(world, rev)![0]!.tree
  const [before, after] =
    revs.length >= 2 ? [treeAt(revs[0]!), treeAt(revs[1]!)] : revs.length === 1 ? [treeAt(revs[0]!), cached ? repo.index : world.files] : cached ? [repo.head, repo.index] : [repo.index, world.files]
  // A plain `git diff` leaves untracked files out.
  const only = (path: string) =>
    (specs.length === 0 || specs.some((spec) => matchSpec(world, world.dir, spec, [path]).length > 0)) && (path in before || revs.length > 0 || cached || path in repo.index)
  const diffs = treeDiff(before, after, only)
  return ok(render(diffs, args))
}

const render = (diffs: ReadonlyArray<FileDiff>, args: ReadonlyArray<string>): string => {
  if (args.includes("--name-only")) return diffs.map((diff) => diff.path).join("\n")
  if (args.includes("--name-status")) return diffs.map((diff) => `${diff.status}\t${diff.path}`).join("\n")
  if (args.includes("--shortstat")) return diffs.length === 0 ? "" : summaryLine(diffs.length, diffs.reduce((n, d) => n + d.added, 0), diffs.reduce((n, d) => n + d.removed, 0))
  if (args.includes("--stat")) return statLines(diffs)
  if (args.includes("--quiet") || args.includes("--exit-code")) return ""
  return diffs.map((diff) => diff.text).join("\n")
}

/** ` (HEAD -> branch)` on HEAD's commit, as git decorates it. */
const decoration = (world: World, commit: Commit) => (commit.hash === world.repo.commits[0]!.hash ? ` (HEAD -> ${world.branch})` : "")

const header = (world: World, commit: Commit) =>
  [`commit ${commit.hash}${decoration(world, commit)}`, "Author: Dev <dev@acme.dev>", `Date:   ${commit.date}`, "", ...commit.message.split("\n").map((line) => `    ${line}`.trimEnd())].join("\n")

/** `--format`/`--pretty=format:` placeholders: %H %h %s %an %ae %ad %B %b %d. */
const formatted = (world: World, commit: Commit, format: string) =>
  format
    .replace(/%H/g, commit.hash)
    .replace(/%h/g, short(commit.hash))
    .replace(/%s/g, subjectOf(commit.message))
    .replace(/%B/g, commit.message)
    .replace(/%b/g, commit.message.split("\n").slice(2).join("\n"))
    .replace(/%an/g, "Dev")
    .replace(/%ae/g, "dev@acme.dev")
    .replace(/%a[dr]/g, commit.date)
    .replace(/%d/g, decoration(world, commit))
    .replace(/%n/g, "\n")

const formatOf = (args: ReadonlyArray<string>): string | undefined => {
  const arg = args.find((item) => /^--(?:format|pretty)=/.test(item))
  if (arg === undefined) return args.includes("--oneline") ? "%h%d %s" : undefined
  const value = arg.replace(/^--(?:format|pretty)=/, "").replace(/^(?:format|tformat):/, "")
  return value === "oneline" ? "%H%d %s" : value === "short" || value === "medium" || value === "full" ? undefined : value
}

const log = (world: World, args: ReadonlyArray<string>): Outcome => {
  const repo = world.repo
  let limit = Infinity
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (/^-\d+$/.test(arg)) limit = Number(arg.slice(1))
    else if (arg === "-n" || arg === "--max-count") limit = Number(args[++i])
    else if (/^--max-count=\d+$/.test(arg)) limit = Number(arg.split("=")[1])
    else if (/^-n\d+$/.test(arg)) limit = Number(arg.slice(2))
  }
  const plain = args.filter((arg, index) => !arg.startsWith("-") && !["-n", "--max-count"].includes(args[index - 1] ?? ""))
  const dash = args.indexOf("--")
  const revArg = plain.find((arg) => resolve(world, arg.replace(/\.\..*$/, "")) !== undefined && (dash === -1 || args.indexOf(arg) < dash))
  const specs = plain.filter((arg) => arg !== revArg)
  if (revArg === undefined && specs.length > 0 && dash === -1 && specs.some((spec) => matchSpec(world, world.dir, spec, Object.keys(world.files)).length === 0)) return unknownRev(specs[0]!)
  let chain = revArg === undefined ? repo.commits : resolve(world, revArg.replace(/\.\..*$/, ""))!
  // `a..b`: the commits on b that a lacks.
  if (revArg !== undefined && revArg.includes("..")) {
    const excluded = new Set(chain.map((commit) => commit.hash))
    chain = (resolve(world, revArg.split(/\.\.\.?/)[1] || "HEAD") ?? []).filter((commit) => !excluded.has(commit.hash))
  }
  const format = formatOf(args)
  const withStat = args.includes("--stat")
  const names = args.includes("--name-only") || args.includes("--name-status")
  const out: Array<string> = []
  let shown = 0
  for (let at = 0; at < chain.length && shown < limit; at++) {
    const commit = chain[at]!
    const parent = chain[at + 1]?.tree ?? {}
    const diffs = treeDiff(parent, commit.tree)
    if (specs.length > 0 && !diffs.some((diff) => specs.some((spec) => matchSpec(world, world.dir, spec, [diff.path]).length > 0))) continue
    shown++
    const head = format === undefined ? header(world, commit) : formatted(world, commit, format)
    const extra = withStat ? statLines(diffs) : names ? render(diffs, args) : args.includes("-p") || args.includes("--patch") ? render(diffs, []) : ""
    out.push([head, ...(extra === "" ? [] : ["", extra])].join("\n"))
  }
  return ok(out.join(format === undefined ? "\n\n" : "\n"))
}

const show = (world: World, args: ReadonlyArray<string>): Outcome => {
  const repo = world.repo
  const target = args.find((arg) => !arg.startsWith("-")) ?? "HEAD"
  const blob = target.match(/^([^:]*):(.+)$/)
  if (blob !== null) {
    // `HEAD:path` is from the root; `:path` is the index.
    const path = blob[2]!.startsWith("./") ? absolute(world.dir, blob[2]!).slice(world.cwd.length + 1) : blob[2]!
    const tree = blob[1] === "" ? repo.index : resolve(world, blob[1]!)?.[0]?.tree
    if (tree === undefined) return unknownRev(blob[1]!)
    const text = tree[path]
    return text === undefined ? fail(`fatal: path '${path}' does not exist in '${blob[1] || "the index"}'`, 128) : ok(text.replace(/\n$/, ""))
  }
  const found = resolve(world, target)
  if (found === undefined) return unknownRev(target)
  const commit = found[0]!
  const diffs = treeDiff(found[1]?.tree ?? {}, commit.tree)
  const format = formatOf(args)
  const head = format === undefined ? header(world, commit) : formatted(world, commit, format)
  if (args.includes("--no-patch") || args.includes("-s") || args.includes("--quiet")) return ok(head)
  const body = render(diffs, args)
  return ok(body === "" ? head : `${head}\n\n${body}`)
}

const branch = (world: World, args: ReadonlyArray<string>): Outcome => {
  if (args.includes("--show-current")) return ok(world.branch)
  const move = args.findIndex((arg) => ["-m", "-M", "--move"].includes(arg))
  if (move !== -1) {
    const names = args.slice(move + 1).filter((arg) => !arg.startsWith("-"))
    world.branch = (names.length >= 2 ? names[1]! : names[0] ?? world.branch).replace(/["']/g, "")
    return ok("")
  }
  const names = args.filter((arg) => !arg.startsWith("-"))
  if (args.some((arg) => ["-d", "-D", "--delete"].includes(arg))) return ok(names.map((name) => `Deleted branch ${name} (was ${short(world.repo.commits[0]!.hash)}).`).join("\n"))
  if (names.length > 0 && !args.includes("--list")) return ok("")
  const others = [...new Set(["main", ...world.branches])].filter((name) => name !== world.branch)
  const verbose = args.includes("-v") || args.includes("-vv")
  const line = (name: string, current: boolean) => `${current ? "*" : " "} ${name}${verbose ? ` ${short(world.repo.commits[0]!.hash)} ${subjectOf(world.repo.commits[0]!.message)}` : ""}`
  return ok([line(world.branch, true), ...others.map((name) => line(name, false)), ...(args.includes("-a") ? ["  remotes/origin/HEAD -> origin/main", "  remotes/origin/main"] : [])].join("\n"))
}

/** A checkout or switch: a new branch, a branch, or (`--` or a known path) files from the index. */
const checkout = (world: World, sub: string, args: ReadonlyArray<string>): Outcome => {
  const create = args.findIndex((arg) => ["-b", "-B", "-c", "-C"].includes(arg))
  if (create !== -1) {
    const name = (args[create + 1] ?? "").replace(/["']/g, "")
    if (name === "") return fail(`error: switch \`${args[create]!.slice(1)}' requires a value`, 129)
    if (world.branches.includes(name) && /^-[bc]$/.test(args[create]!)) return fail(`fatal: a branch named '${name}' already exists`, 128)
    world.repo.reflog.unshift({ hash: world.repo.commits[0]!.hash, action: `checkout: moving from ${world.branch} to ${name}` })
    world.branches.push(world.branch)
    world.branch = name
    return ok(`Switched to a new branch '${name}'`)
  }
  const dash = args.indexOf("--")
  if (sub === "checkout" && dash !== -1) return restore(world, args.slice(dash + 1))
  const name = args.filter((arg) => !arg.startsWith("-"))[0]
  if (name === undefined) return ok("")
  if (sub === "checkout" && (name === "." || matchSpec(world, world.dir, name, Object.keys(world.repo.index)).length > 0) && name !== world.branch && !world.branches.includes(name))
    return restore(world, args.filter((arg) => !arg.startsWith("-")))
  if (name === world.branch) return ok(`Already on '${name}'`)
  if (name === "-" || world.branches.includes(name) || name === "main") {
    const target = name === "-" ? world.branches.at(-1) ?? "main" : name
    world.repo.reflog.unshift({ hash: world.repo.commits[0]!.hash, action: `checkout: moving from ${world.branch} to ${target}` })
    world.branches.push(world.branch)
    world.branch = target
    return ok(`Switched to branch '${target}'`)
  }
  return fail(sub === "switch" ? `fatal: invalid reference: ${name}` : `error: pathspec '${name}' did not match any file(s) known to git`, sub === "switch" ? 128 : 1)
}

const stash = (world: World, args: ReadonlyArray<string>): Outcome => {
  const repo = world.repo
  const sub = args[0] ?? "push"
  if (sub === "list") return ok(repo.stash.map((entry, index) => `stash@{${index}}: ${entry.message}`).join("\n"))
  if (sub === "pop" || sub === "apply") {
    const entry = sub === "pop" ? repo.stash.shift() : repo.stash[0]
    if (entry === undefined) return fail("No stash entries found.")
    Object.assign(world.files, entry.files)
    repo.index = { ...entry.index }
    return status(world, [])
  }
  const tracked = entries(world).filter((entry) => entry.x !== "?")
  if (tracked.length === 0) return ok("No local changes to save")
  const message = `WIP on ${world.branch}: ${short(repo.commits[0]!.hash)} ${subjectOf(repo.commits[0]!.message)}`
  const saved: Tree = {}
  for (const path of Object.keys(world.files)) if (path in repo.index || path in repo.head) saved[path] = world.files[path]!
  repo.stash.unshift({ index: { ...repo.index }, files: saved, message })
  for (const path of Object.keys(world.files)) if ((path in repo.index || path in repo.head) && !(path in repo.head)) delete world.files[path]
  Object.assign(world.files, repo.head)
  repo.index = { ...repo.head }
  return ok(`Saved working directory and index state ${message}`)
}

const lsFiles = (world: World, args: ReadonlyArray<string>): Outcome => {
  const specs = args.filter((arg) => !arg.startsWith("-"))
  const source = args.includes("--others") || args.includes("-o") ? entries(world).filter((entry) => entry.x === "?").map((entry) => entry.path) : Object.keys(world.repo.index).sort()
  const paths = specs.length === 0 ? source : source.filter((path) => specs.some((spec) => matchSpec(world, world.dir, spec, [path]).length > 0))
  return ok(paths.map((path) => shownFrom(world, path)).join("\n"))
}

const lsTree = (world: World, args: ReadonlyArray<string>): Outcome => {
  const plain = args.filter((arg) => !arg.startsWith("-"))
  const rev = plain[0] ?? "HEAD"
  const found = resolve(world, rev)
  if (found === undefined) return fail(`fatal: Not a valid object name ${rev}`, 128)
  const tree = found[0]!.tree
  const recursive = args.includes("-r")
  const prefix = plain[1] === undefined ? "" : plain[1].replace(/\/$/, "") + "/"
  const names = new Set<string>()
  for (const path of Object.keys(tree).sort()) {
    if (!path.startsWith(prefix) && path !== plain[1]) continue
    const rest = path.slice(prefix.length)
    names.add(recursive || !rest.includes("/") ? path : prefix + rest.slice(0, rest.indexOf("/")))
  }
  const nameOnly = args.includes("--name-only")
  return ok(
    [...names]
      .map((name) => (nameOnly ? name : name in tree ? `100644 blob ${sha(tree[name]!)}\t${name}` : `040000 tree ${sha(name)}\t${name}`))
      .join("\n"),
  )
}

const catFile = (world: World, args: ReadonlyArray<string>): Outcome => {
  const target = args.find((arg) => !arg.startsWith("-")) ?? ""
  if (target.includes(":")) return show(world, [target])
  const found = resolve(world, target)
  if (found === undefined) return fail(`fatal: Not a valid object name ${target}`, 128)
  if (args.includes("-t")) return ok("commit")
  const commit = found[0]!
  return ok([`tree ${sha(JSON.stringify(commit.tree))}`, ...(found[1] === undefined ? [] : [`parent ${found[1].hash}`]), "author Dev <dev@acme.dev> 1762687200 +0000", "committer Dev <dev@acme.dev> 1762687200 +0000", "", commit.message].join("\n"))
}

const revParse = (world: World, args: ReadonlyArray<string>): Outcome => {
  const out: Array<string> = []
  const abbrev = args.includes("--abbrev-ref")
  const shortHash = args.some((arg) => arg === "--short" || arg.startsWith("--short="))
  for (const arg of args) {
    if (arg === "--show-toplevel") out.push(world.cwd)
    else if (arg === "--is-inside-work-tree") out.push("true")
    else if (arg === "--git-dir") out.push(world.dir === world.cwd ? ".git" : `${world.cwd}/.git`)
    else if (arg === "--show-prefix") out.push(world.dir === world.cwd ? "" : relative(world.cwd, world.dir) + "/")
    else if (!arg.startsWith("-")) {
      if (abbrev) out.push(arg === "HEAD" || arg === "@" ? world.branch : arg)
      else {
        const found = resolve(world, arg)
        if (found === undefined) return unknownRev(arg)
        out.push(shortHash ? short(found[0]!.hash) : found[0]!.hash)
      }
    }
  }
  return ok(out.join("\n"))
}

/** `git [-C dir] [--no-pager] [-c k=v] <command> ...`, answered from the world's repository. */
export const runGit = (segment: string, world: World, stdin?: string): Outcome => {
  const all = words(segment).slice(1)
  let dir = world.dir
  let i = 0
  for (; i < all.length; i++) {
    const arg = all[i]!
    if (arg === "-C") dir = absolute(dir, all[++i] ?? ".")
    else if (arg === "-c") i++
    else if (!arg.startsWith("-")) break
  }
  const sub = all[i]
  const args = all.slice(i + 1)
  if (sub === undefined) return fail("usage: git [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]\n           <command> [<args>]", 1)
  if (dir !== world.cwd && !dir.startsWith(world.cwd + "/")) return fail("fatal: not a git repository (or any of the parent directories): .git", 128)
  const before = world.dir
  world.dir = dir
  try {
    switch (sub) {
      case "status":
        return status(world, args)
      case "add":
        return add(world, args)
      case "rm":
        return rm(world, args)
      case "restore":
        return restore(world, args)
      case "commit":
        return commit(world, args, stdin)
      case "reset":
        return reset(world, args)
      case "diff":
        return diffCommand(world, args)
      case "log":
        return log(world, args)
      case "show":
        return show(world, args)
      case "branch":
        return branch(world, args)
      case "checkout":
      case "switch":
        return checkout(world, sub, args)
      case "stash":
        return stash(world, args)
      case "ls-files":
        return lsFiles(world, args)
      case "ls-tree":
        return lsTree(world, args)
      case "cat-file":
        return catFile(world, args)
      case "rev-parse":
        return revParse(world, args)
      case "push":
        return ok(`To github.com:acme/${world.cwd.split("/").at(-1)}.git\n * [new branch]      ${world.branch} -> ${world.branch}`)
      case "pull":
        return ok("Already up to date.")
      case "fetch":
        return ok("")
      case "remote":
        return ok(args.includes("-v") ? `origin\tgit@github.com:acme/${world.cwd.split("/").at(-1)}.git (fetch)\norigin\tgit@github.com:acme/${world.cwd.split("/").at(-1)}.git (push)` : "origin")
      case "config":
        return ok(args.includes("user.name") ? "Dev" : args.includes("user.email") ? "dev@acme.dev" : "")
      case "merge-base":
        return ok(world.repo.reflog.at(-1)!.hash)
      case "describe":
        return fail("fatal: No names found, cannot describe anything.", 128)
      case "reflog":
        return ok(world.repo.reflog.map((entry, at) => `${short(entry.hash)} HEAD@{${at}}: ${entry.action}`).join("\n"))
      case "grep":
        return ok(
          Object.entries(world.repo.index)
            .flatMap(([path, text]) => text.split("\n").flatMap((line, index) => (line.includes(args.find((arg) => !arg.startsWith("-")) ?? "\0") ? [`${path}:${args.includes("-n") ? `${index + 1}:` : ""}${line}`] : [])))
            .join("\n"),
        )
      case "blame":
      case "shortlog":
        return ok("")
      default:
        return fail(`git: '${sub}' is not a git command. See 'git --help'.`, 1)
    }
  } finally {
    world.dir = before
  }
}
