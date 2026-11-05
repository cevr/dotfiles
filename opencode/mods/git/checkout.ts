// A checkout as git reports it: where its branch stands against its upstream,
// and each path that differs from its base with its line counts. The parsers
// read git's machine output (`git status --porcelain=v2 --branch -z`, `git
// diff --numstat -z`); the process/ implementation runs git and hands them
// its output. Ported from gent's @gent/git (apps/tui/src/extensions/git.client.tsx).
import { Schema } from "effect"

/** Where the branch stands. Every name is absent when git names none. */
export const Head = Schema.Struct({
  /** The branch; absent when HEAD is detached. */
  branch: Schema.optionalKey(Schema.String),
  /** The commit HEAD names; absent on an unborn branch. */
  oid: Schema.optionalKey(Schema.String),
  /** The branch's upstream (`origin/main`); absent when it tracks nothing. */
  upstream: Schema.optionalKey(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
})
export type Head = typeof Head.Type

/**
 * One changed path, relative to the checkout's top directory. `status` is one
 * letter: `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied, `T`
 * type changed, `U` unmerged, `?` untracked. `added` and `deleted` are absent
 * for a binary file, and for an untracked one too large or past the read bound.
 */
export const ChangedFile = Schema.Struct({
  path: Schema.String,
  /** The path a rename or copy came from. */
  from: Schema.optionalKey(Schema.String),
  status: Schema.String,
  added: Schema.optionalKey(Schema.Number),
  deleted: Schema.optionalKey(Schema.Number),
})
export type ChangedFile = typeof ChangedFile.Type

/** One read of a checkout: its top directory, its head and every path that differs from its base. */
export const Checkout = Schema.Struct({
  root: Schema.String,
  /** What the changes count against and a review compares with: `HEAD`, or the empty tree on an unborn branch. */
  base: Schema.String,
  head: Head,
  files: Schema.Array(ChangedFile),
})
export type Checkout = typeof Checkout.Type

/** A changed path as `git status` names it, before its line counts. */
export type StatusEntry = Pick<ChangedFile, "path" | "from" | "status">

export interface LineCounts {
  readonly added: number
  readonly deleted: number
}

/** The empty tree of each object format: the base of an unborn branch. */
export const EMPTY_TREE = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
} as const

/** The base a checkout's changes count against: `HEAD`, or the empty tree of `format` when the branch has no commit. */
export const baseOf = (head: Head, format: string): string =>
  head.oid !== undefined ? "HEAD" : format === "sha256" ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1

/** The first `count - 1` space-separated fields, then the rest whole: a path may hold spaces. */
const fields = (record: string, count: number): ReadonlyArray<string> => {
  const out: Array<string> = []
  let rest = record
  while (out.length < count - 1) {
    const space = rest.indexOf(" ")
    if (space < 0) break
    out.push(rest.slice(0, space))
    rest = rest.slice(space + 1)
  }
  out.push(rest)
  return out
}

/** The one letter a changed path shows, from its index and work-tree states (`XY`). */
const statusLetter = (xy: string): string => ["D", "A", "R", "C", "T"].find((letter) => xy.includes(letter)) ?? "M"

/** A name git writes, unless it is empty or the word it writes for none. */
const named = (value: string, absent: string): string | undefined => (value.length > 0 && value !== absent ? value : undefined)

/** One `# branch.*` header folded into the head read so far. */
const withHeader = (head: Head, header: string): Head => {
  const set = (key: "branch" | "oid" | "upstream", value: string | undefined): Head => {
    const next: { -readonly [Key in keyof Head]: Head[Key] } = { ...head }
    if (value === undefined) delete next[key]
    else next[key] = value
    return next
  }
  if (header.startsWith("# branch.oid ")) return set("oid", named(header.slice(13), "(initial)"))
  if (header.startsWith("# branch.head ")) return set("branch", named(header.slice(14), "(detached)"))
  if (header.startsWith("# branch.upstream ")) return set("upstream", named(header.slice(18), ""))
  if (header.startsWith("# branch.ab ")) {
    const [plus = "0", minus = "0"] = header.slice(12).split(" ")
    return { ...head, ahead: Math.abs(Number.parseInt(plus, 10)) || 0, behind: Math.abs(Number.parseInt(minus, 10)) || 0 }
  }
  return head
}

/** One changed-path record; `next` is the record after it, a rename's source path. */
const statusEntry = (record: string, next: string): StatusEntry | undefined => {
  if (record.startsWith("1 ")) {
    const parts = fields(record, 9)
    return { path: parts[8] ?? "", status: statusLetter(parts[1] ?? "") }
  }
  if (record.startsWith("2 ")) {
    const parts = fields(record, 10)
    return { path: parts[9] ?? "", from: next, status: statusLetter(parts[1] ?? "") }
  }
  if (record.startsWith("u ")) return { path: fields(record, 11)[10] ?? "", status: "U" }
  if (record.startsWith("? ")) return { path: record.slice(2), status: "?" }
  return undefined
}

/**
 * `git status --porcelain=v2 --branch -z`: the branch headers, then one
 * record per changed path. With `-z` a path is never quoted and a rename's
 * source path is the next record. Ignored files (`!`) are left out.
 */
export const parseStatus = (output: string): { readonly head: Head; readonly entries: ReadonlyArray<StatusEntry> } => {
  const records = output.split("\0")
  let head: Head = { ahead: 0, behind: 0 }
  const entries: Array<StatusEntry> = []
  let index = 0
  while (index < records.length) {
    const record = records[index] ?? ""
    index += 1
    if (record.startsWith("# ")) {
      head = withHeader(head, record)
      continue
    }
    const entry = statusEntry(record, records[index] ?? "")
    if (entry === undefined) continue
    entries.push(entry)
    // A rename's source path was the next record.
    if (entry.from !== undefined) index += 1
  }
  return { head, entries }
}

/**
 * `git diff --numstat -z`: added and deleted lines per path, keyed by the path
 * a rename lands on. A binary file reads `-` for both and maps to undefined.
 */
export const parseNumstat = (output: string): ReadonlyMap<string, LineCounts | undefined> => {
  const records = output.split("\0")
  const counts = new Map<string, LineCounts | undefined>()
  let index = 0
  while (index < records.length) {
    const record = records[index] ?? ""
    index += 1
    if (record.length === 0) continue
    const [added = "-", deleted = "-", ...rest] = record.split("\t")
    let path = rest.join("\t")
    if (path.length === 0) {
      // A rename: the source and the destination are the next two records.
      path = records[index + 1] ?? ""
      index += 2
    }
    const lines = { added: Number.parseInt(added, 10), deleted: Number.parseInt(deleted, 10) }
    counts.set(path, Number.isFinite(lines.added) && Number.isFinite(lines.deleted) ? lines : undefined)
  }
  return counts
}

/** A changed path with its line counts, when it has any. */
export const withLines = (entry: StatusEntry, lines: LineCounts | undefined): ChangedFile => ({
  ...entry,
  ...(lines === undefined ? {} : { added: lines.added, deleted: lines.deleted }),
})

/** The lines of a text file as git counts them: a last line without a newline counts too. */
export const lineCount = (text: string): number => {
  if (text.length === 0) return 0
  const newlines = text.split("\n").length - 1
  return text.endsWith("\n") ? newlines : newlines + 1
}

/** Every changed file's lines, summed; a file with no counts adds none. */
export const totals = (files: ReadonlyArray<ChangedFile>): LineCounts =>
  files.reduce((sum, file) => ({ added: sum.added + (file.added ?? 0), deleted: sum.deleted + (file.deleted ?? 0) }), { added: 0, deleted: 0 })

/** `main`, `detached @1a2b3c4`, or undefined with no commit and no branch. */
export const branchName = (head: Head): string | undefined =>
  head.branch ?? (head.oid === undefined ? undefined : `detached @${head.oid.slice(0, 7)}`)

/** `↑2 ↓1`, the counts that are not zero; empty when the branch is even with its upstream. */
export const aheadBehind = (head: Head): string =>
  [head.ahead > 0 ? `↑${head.ahead}` : "", head.behind > 0 ? `↓${head.behind}` : ""].filter((part) => part.length > 0).join(" ")

/** `3 files`, `1 file`. */
export const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

/** `+40 −12`, with the minus sign, as the sidebar and the pane write a change. */
export const delta = (lines: LineCounts): string => `+${lines.added} −${lines.deleted}`

/**
 * What the pull request read follows: the checkout's root, branch, upstream
 * and ahead/behind counts. A push, a pull, a fetch or a branch move changes
 * it; an edit does not. Undefined for a detached head and an unborn branch,
 * which have no pull request to ask for.
 */
export const pullRequestKey = (checkout: Checkout): string | undefined =>
  checkout.head.oid === undefined || checkout.head.branch === undefined
    ? undefined
    : [checkout.root, checkout.head.branch, checkout.head.upstream ?? "", checkout.head.ahead, checkout.head.behind].join("\0")

/** The checkout root a pull request key names: its first part (a path holds no NUL). */
export const rootOfKey = (key: string): string => key.split("\0")[0] ?? ""
