// What a workspace inherited from the checkout it was copied from, and what is its own. A workspace is a
// copy-on-write copy of a checkout (its base, or the workspace it was made on) taken with that checkout's
// uncommitted changes and untracked files: on the Mac, tools rewrite claude/settings.json, codex/config.toml
// and skills/.system/** in the base. One definition serves every reader:
//
//   an entry of the workspace's `git status` is INHERITED only when, read now, the source's own `git status`
//   lists the same path with the same status code, the path is the same (mode and blob, or absent) at both
//   HEADs, and the file on disk is the same in both (same type, executable bit and bytes, or missing in both).
//   Every other entry is the workspace's OWN: a change to a file the source has clean, a change judged
//   against a HEAD the source does not share, a rename or a conflict, and every entry when the source cannot
//   be read or is not known. In doubt, a change is the workspace's own: counting it costs a question, missing
//   it costs work.
//
// The source is read at the question, not recorded at the create: a fresh workspace restores its copies at
// once (`settle`), so a record would only ever describe workspaces made before it existed, which have none;
// a read now never names as the source's a change the source no longer holds.
//
// - `ownEntries`: the land's "uncommitted" refusal, a removal's unsaved work and the lost-lane list read only
//   the own entries.
// - `unitTree`: a receipt's tree is the tracked files as they are on disk with each inherited one at its
//   HEAD version, so restoring an inherited file (by hand, or `settle`) leaves a receipt current.
// - `settle`: a create, before any agent runs in the new workspace, restores every inherited tracked file to
//   HEAD (the bytes live on in the checkout it was copied from) and records that checkout
//   (`rift.copiedFrom`), where the others find it. It leaves untracked files, and never runs in a base.
import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync, type Stats } from "node:fs"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { RiftFailed } from "../service.ts"
import { commands } from "./command.ts"

/** The workspace's Git config key naming the checkout it was copied from, set by `settle` at its create. */
export const COPIED_FROM = "rift.copiedFrom"

/** Pathspecs are file names, never patterns: an inherited file named `*` is that file alone. */
const LITERAL = { GIT_LITERAL_PATHSPECS: "1" }

/** One `git status --porcelain=v1 -z` entry: its line (`XY path`) and its file. */
export interface StatusEntry {
  readonly line: string
  readonly file: string
}

/** The entries of `git status --porcelain=v1 -z`; a rename or copy's source field is skipped. */
export const statusEntries = (output: string): ReadonlyArray<StatusEntry> => {
  const fields = output.split("\0").filter((field) => field !== "")
  const entries: Array<StatusEntry> = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    entries.push({ line: field, file: field.slice(3) })
    if (field[0] === "R" || field[0] === "C") index++
  }
  return entries
}

/** A file's entry in a tree as `git ls-tree -r -z` prints it: `<mode> <type> <oid>\t<path>`; its mode and oid by path. */
export const treeEntries = (output: string): ReadonlyMap<string, string> =>
  new Map(
    output.split("\0").flatMap((field) => {
      const tab = field.indexOf("\t")
      const [mode, , oid] = field.slice(0, tab).split(" ")
      return [[field.slice(tab + 1), `${mode} ${oid}`] satisfies [string, string]].filter(() => tab > 0)
    }),
  )

const lstat = Option.liftThrowable((file: string): Stats => lstatSync(file))
const bytesEqual = Option.liftThrowable((left: string, right: string) => readFileSync(left).equals(readFileSync(right)))
const linksEqual = Option.liftThrowable((left: string, right: string) => readlinkSync(left) === readlinkSync(right))

/** The same kind of file (`S_IFMT`) with the same executable bits: what Git's mode reads of a file. */
const sameMode = (a: Stats, b: Stats): boolean => (a.mode & 0o170000) === (b.mode & 0o170000) && (a.mode & 0o111) === (b.mode & 0o111)

/**
 * Whether `file` is the same on disk under both roots: missing in both; or the same kind, executable bits and
 * bytes (a symbolic link: the same target). A folder, a file that cannot be read, anything else: never the same.
 */
export const sameOnDisk = (left: string, right: string): boolean =>
  Option.match(lstat(left), {
    onNone: () => Option.isNone(lstat(right)),
    onSome: (a) =>
      Option.exists(lstat(right), (b) => {
        if (!sameMode(a, b)) return false
        if (a.isSymbolicLink()) return Option.getOrElse(linksEqual(left, right), () => false)
        return a.isFile() && Option.getOrElse(bytesEqual(left, right), () => false)
      }),
  })

/**
 * A change to a file HEAD holds, in the index or on disk (modified, deleted, type changed): one a restore to HEAD
 * undoes. Not an untracked (`??`) or ignored (`!!`) file, a staged addition, rename or copy, or a conflict.
 */
const ofHead = (entry: StatusEntry): boolean => /^[ MDT][ MDT]$/.test(entry.line.slice(0, 2))

/** An entry that can be the source's: a change to a file of HEAD (`ofHead`) or an untracked file; never a staged addition, rename, copy or conflict. */
const comparable = (entry: StatusEntry): boolean => ofHead(entry) || entry.line.startsWith("?? ")

/** A directory as the file system names it; none when it does not exist. */
const real = Option.liftThrowable((directory: string) => realpathSync(directory))

/** `from` when it is a Git checkout other than `path` itself: a checkout is never its own source. */
const otherCheckout = (path: string, from: string): Option.Option<string> =>
  Option.filter(real(from), (at) => existsSync(join(at, ".git")) && Option.exists(real(path), (self) => self !== at))

/** The checkout a workspace under `<dir>/.work/<repo>/` or `<dir>/.rifts/<repo>/` was made from: `<dir>/<repo>` (work's layout). */
export const hintedBase = (path: string): Option.Option<string> =>
  Option.map(Option.fromNullishOr(/^(.*?)\/\.(?:work|rifts)\/([^/]+)\/[^/]+/.exec(path)), (match) => `${match[1]}/${match[2]}`)

/** Git over child processes, with `env` added (a test's scratch HOME). */
export const inheritance = (env: Readonly<Record<string, string>> = {}) => {
  const { run, spawn } = commands(env)
  const git = (path: string, ...args: ReadonlyArray<string>) => run(["git", "-C", path, ...args], path, LITERAL)

  /**
   * The checkout `path` is in, by its top level: every step below reads and names files from there (status
   * names them from the top level, a pathspec from the directory it runs in), so a folder inside it (a script's
   * cwd) reads as the checkout itself.
   */
  const top = (path: string) => Effect.map(git(path, "rev-parse", "--show-toplevel"), (out) => out.trim())

  /** The checkout's status entries, from its top level `root`, untracked files one by one. */
  const statusAt = (root: string) => Effect.map(git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"), statusEntries)

  /** The mode and blob of each of `files` at HEAD in `root`; a file HEAD lacks is absent. */
  const headOf = (root: string, files: ReadonlyArray<string>) => Effect.map(git(root, "ls-tree", "-r", "-z", "--full-tree", "HEAD", "--", ...files), treeEntries)

  /**
   * The files of `entries` (the workspace `root`'s status) that are inherited from `source`, by the rule in this
   * file's header. Anything of the source that cannot be read leaves none inherited.
   */
  const inheritedOf = (root: string, source: string, entries: ReadonlyArray<StatusEntry>) =>
    Effect.gen(function* () {
      const theirs = new Map((yield* statusAt(source)).map((entry) => [entry.file, entry.line] as const))
      const candidates = entries.flatMap((entry) => [entry.file].filter(() => comparable(entry) && theirs.get(entry.file) === entry.line))
      if (candidates.length === 0) return new Set<string>()
      const [mine, base] = [yield* headOf(root, candidates), yield* headOf(source, candidates)]
      return new Set(candidates.filter((file) => mine.get(file) === base.get(file) && sameOnDisk(join(root, file), join(source, file))))
    }).pipe(Effect.catch(() => Effect.succeed(new Set<string>())))

  /** The checkout `root` (a top level) was copied from (`copiedFrom`). */
  const copiedFromAt = (root: string, base: Option.Option<string>) =>
    spawn(["git", "-C", root, "config", "--local", "--get", COPIED_FROM], root).pipe(
      Effect.map((ran) =>
        Option.liftPredicate(ran.stdout.trim(), (named) => ran.code === 0 && named !== "").pipe(
          Option.orElse(() => base),
          Option.orElse(() => hintedBase(root)),
          Option.flatMap((at) => otherCheckout(root, at)),
        ),
      ),
    )

  /** The entries of the workspace `root` (a top level) that are inherited from the checkout it was copied from; none when that is unknown. */
  const inheritedAt = (root: string, base: Option.Option<string>, entries: ReadonlyArray<StatusEntry>) =>
    Effect.flatMap(copiedFromAt(root, base), (source) =>
      Option.match(source, { onNone: () => Effect.succeed(new Set<string>()), onSome: (from) => inheritedOf(root, from, entries) }),
    )

  /** The status entries of the checkout `path` is in, its files named from its top level. */
  const status = (path: string) => Effect.flatMap(top(path), statusAt)

  /**
   * The checkout `path` is in was copied from: the one its create recorded (`rift.copiedFrom`), else, for a
   * workspace made before the record, `base` when the caller knows it, else the base beside its folder
   * (`hintedBase`); none for a base, or when none of them is a checkout other than it.
   */
  const copiedFrom = (path: string, base?: string) => Effect.flatMap(top(path), (root) => copiedFromAt(root, Option.fromUndefinedOr(base)))

  /** The own entries (the header's rule) of the checkout `path` is in, its files named from its top level; `base` stands in for an unrecorded source. */
  const ownEntries = (path: string, base?: string) =>
    Effect.gen(function* () {
      const root = yield* top(path)
      const entries = yield* statusAt(root)
      const inherited = yield* inheritedAt(root, Option.fromUndefinedOr(base), entries)
      return entries.filter((entry) => !inherited.has(entry.file))
    })

  /** The own entries' status lines (`ownEntries`). */
  const ownLines = (path: string, base?: string) => Effect.map(ownEntries(path, base), (entries) => entries.map((entry) => entry.line))

  /** The inherited tracked files of the workspace `root`, that a restore to HEAD undoes. */
  const inheritedTracked = (root: string, base: Option.Option<string>) =>
    Effect.gen(function* () {
      const entries = yield* statusAt(root)
      const inherited = yield* inheritedAt(root, base, entries)
      return entries.flatMap((entry) => [entry.file].filter(() => ofHead(entry) && inherited.has(entry.file)))
    })

  /**
   * The tree a receipt names for the checkout `path` is in: its tracked files as they are on disk, each one
   * inherited from the checkout it was copied from at its HEAD version; built in a scratch copy of its index,
   * so its own index is untouched.
   */
  const unitTree = Effect.fn("Inherited.unitTree")(function* (path: string) {
    const root = yield* top(path)
    const index = (yield* git(root, "rev-parse", "--path-format=absolute", "--git-path", "index")).trim()
    const scratch = `${index}.rift-receipt`
    const at = { ...LITERAL, GIT_INDEX_FILE: scratch }
    const files = yield* inheritedTracked(root, Option.none())
    return yield* Effect.acquireUseRelease(
      Effect.try({ try: () => copyFileSync(index, scratch), catch: (cause) => new RiftFailed({ operation: "copy index", message: String(cause) }) }),
      () =>
        run(["git", "-C", root, "add", "-u"], root, at).pipe(
          Effect.andThen(Effect.when(run(["git", "-C", root, "reset", "-q", "HEAD", "--", ...files], root, at), Effect.succeed(files.length > 0))),
          Effect.andThen(run(["git", "-C", root, "write-tree"], root, at)),
          Effect.map((out) => out.trim()),
        ),
      () => Effect.sync(() => rmSync(scratch, { force: true })),
    )
  })

  /**
   * A new workspace's first step, before any agent runs in it: records `from`, the checkout it was copied from
   * (`rift.copiedFrom`), and restores to HEAD each tracked file it inherited from there (the header's rule);
   * answers those files. Untracked files stay. A workspace that is `from` itself (a base) is left untouched.
   */
  const settle = Effect.fn("Inherited.settle")(function* (path: string, from: string) {
    const root = yield* top(path)
    const source = otherCheckout(root, from)
    if (Option.isNone(source)) return []
    yield* git(root, "config", "--local", COPIED_FROM, source.value)
    const files = yield* inheritedTracked(root, source)
    if (files.length > 0) yield* git(root, "restore", "--source=HEAD", "--staged", "--worktree", "--", ...files)
    return files
  })

  return { status, copiedFrom, ownEntries, ownLines, unitTree, settle }
}
