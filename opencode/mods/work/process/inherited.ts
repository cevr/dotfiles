// What a workspace inherited from the checkout it was copied from, and what is its own. A workspace is a
// copy-on-write copy of a checkout (its base, or the workspace it was made on) taken with that checkout's
// uncommitted changes and untracked files: on the Mac, tools rewrite claude/settings.json, codex/config.toml
// and skills/.system/** in the base. One definition serves every reader:
//
//   an entry of the workspace's `git status` is INHERITED when its file reads the same (same bytes, or
//   missing in both) in the workspace and in the checkout it was copied from, as that checkout stands now;
//   every other entry is the workspace's OWN.
//
// - `ownEntries`: the land's "uncommitted" refusal, a removal's unsaved work and the lost-lane list read only
//   the own entries.
// - `unitTree`: a receipt's tree is the tracked files as they are on disk with each inherited one at its
//   HEAD version, so restoring an inherited file (by hand, or `settle`) leaves a receipt current.
// - `settle`: a create, before any agent runs in the new workspace, restores every inherited tracked file to
//   HEAD (the bytes live on in the checkout it was copied from) and records that checkout
//   (`rift.copiedFrom`), where `unitTree` finds it. It leaves untracked files, and never runs in a base.
import { copyFileSync, existsSync, readFileSync, realpathSync, rmSync } from "node:fs"
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

/** Whether `file` reads the same under both roots: missing in both, or the same bytes. */
export const same = (left: string, right: string): boolean => {
  const [a, b] = [existsSync(left), existsSync(right)]
  if (!a || !b) return a === b
  // An unreadable file (a folder, no permission) is never the same.
  return Option.getOrElse(readBoth(left, right), () => false)
}

const readBoth = Option.liftThrowable((left: string, right: string) => readFileSync(left).equals(readFileSync(right)))

/**
 * A change to a file HEAD holds, in the index or on disk (modified, deleted, type changed): one a restore to HEAD
 * undoes. Not an untracked (`??`) or ignored (`!!`) file, a staged addition, rename or copy, or a conflict.
 */
const ofHead = (entry: StatusEntry): boolean => /^[ MDT][ MDT]$/.test(entry.line.slice(0, 2))

/** Whether `entry` of the workspace at `path` reads the same in `from`, the checkout it was copied from. */
export const isInherited = (path: string, from: string, entry: StatusEntry): boolean => same(join(path, entry.file), join(from, entry.file))

/** The entries of `path` that are its own: none reads the same in `from`. With no `from`, every entry. */
export const ownEntries = (path: string, from: Option.Option<string>, entries: ReadonlyArray<StatusEntry>): ReadonlyArray<StatusEntry> =>
  Option.match(from, { onNone: () => entries, onSome: (at) => entries.filter((entry) => !isInherited(path, at, entry)) })

/** The tracked entries of `path` inherited from `from`. */
const inheritedTracked = (path: string, from: string, entries: ReadonlyArray<StatusEntry>): ReadonlyArray<string> =>
  entries.flatMap((entry) => [entry.file].filter(() => ofHead(entry) && isInherited(path, from, entry)))

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

  /** The workspace's status entries, untracked files one by one, `.rift` left out. */
  const status = (path: string) =>
    Effect.map(git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":(exclude).rift"), statusEntries)

  /**
   * The checkout `path` was copied from: the one its create recorded (`rift.copiedFrom`), else, for a workspace
   * made before the record, `base` when the caller knows it, else the base beside its folder (`hintedBase`);
   * none for a base, or when none of them is a checkout other than `path`.
   */
  const copiedFrom = (path: string, base?: string) =>
    spawn(["git", "-C", path, "config", "--local", "--get", COPIED_FROM], path).pipe(
      Effect.map((ran) =>
        Option.liftPredicate(ran.stdout.trim(), (named) => ran.code === 0 && named !== "").pipe(
          Option.orElse(() => Option.fromUndefinedOr(base)),
          Option.orElse(() => hintedBase(path)),
          Option.flatMap((at) => otherCheckout(path, at)),
        ),
      ),
    )

  /** The workspace's own status lines (`ownEntries`), against the checkout it was copied from (`copiedFrom`). */
  const ownLines = (path: string, base?: string) =>
    Effect.gen(function* () {
      return ownEntries(path, yield* copiedFrom(path, base), yield* status(path)).map((entry) => entry.line)
    })

  /**
   * The tree a receipt names for the checkout at `path`: its tracked files as they are on disk, each one
   * inherited from the checkout it was copied from at its HEAD version; built in a scratch copy of its index,
   * so its own index is untouched.
   */
  const unitTree = Effect.fn("Inherited.unitTree")(function* (path: string) {
    const index = (yield* git(path, "rev-parse", "--path-format=absolute", "--git-path", "index")).trim()
    const scratch = `${index}.rift-receipt`
    const at = { ...LITERAL, GIT_INDEX_FILE: scratch }
    const files = yield* Option.match(yield* copiedFrom(path), {
      onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
      onSome: (source) => Effect.map(status(path), (entries) => inheritedTracked(path, source, entries)),
    })
    return yield* Effect.acquireUseRelease(
      Effect.try({ try: () => copyFileSync(index, scratch), catch: (cause) => new RiftFailed({ operation: "copy index", message: String(cause) }) }),
      () =>
        run(["git", "-C", path, "add", "-u"], path, at).pipe(
          Effect.andThen(Effect.when(run(["git", "-C", path, "reset", "-q", "HEAD", "--", ...files], path, at), Effect.succeed(files.length > 0))),
          Effect.andThen(run(["git", "-C", path, "write-tree"], path, at)),
          Effect.map((out) => out.trim()),
        ),
      () => Effect.sync(() => rmSync(scratch, { force: true })),
    )
  })

  /**
   * A new workspace's first step, before any agent runs in it: records `from`, the checkout it was copied from
   * (`rift.copiedFrom`), and restores to HEAD each tracked file it inherited from there (same bytes now);
   * answers those files. Untracked files stay. A `path` that is `from` itself (a base) is left untouched.
   */
  const settle = Effect.fn("Inherited.settle")(function* (path: string, from: string) {
    const source = otherCheckout(path, from)
    if (Option.isNone(source)) return []
    yield* git(path, "config", "--local", COPIED_FROM, source.value)
    const files = inheritedTracked(path, source.value, yield* status(path))
    if (files.length > 0) yield* git(path, "restore", "--source=HEAD", "--staged", "--worktree", "--", ...files)
    return files
  })

  return { status, copiedFrom, ownLines, unitTree, settle }
}
