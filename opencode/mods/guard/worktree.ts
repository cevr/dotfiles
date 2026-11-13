// The guard's worktree rule: `git worktree add` is refused in a checkout Rift
// serves, since a worktree is a full copy of the checkout and a Rift is a
// copy-on-write one (the owner, 2026-11-13: "we don't use git worktrees
// because git worktrees actually copy and I want copy on write"). Rift serves
// a checkout when its file system clones (APFS on the Mac; btrfs, or XFS with
// its reflinks, on Linux), or when a warm source of it exists (the same
// origin), as Ergo's checkouts on the workbox's ext4 home have in
// /workspaces/ergo. The refusal names the replacement: the rift tool's
// `create`, or `workrift create <branch>` on the workbox. `git worktree list`,
// `remove` and `prune` run, so old worktrees can be cleaned up.
//
// The line is read as the destructive rule reads it (verdict.ts
// `placedCommands`): prefixes and assignments, `cd`, chained commands, and the
// script of `sh -c` or `eval`; git's `-C`, `--git-dir` and `--work-tree` move
// the checkout git works on. The checkout and the warm sources are the facts
// from outside, asked of the `Checkouts` contract (service.ts) only for a line
// that adds a worktree.
import { Array as Arr, Option, Schema } from "effect"
import { resolve } from "./path.ts"
import type { Checkout, WarmSource } from "./service.ts"
import { expandWord, type Word } from "./shell-line.ts"
import { GIT_VALUE_OPTIONS, gitSubcommand, type Place, placedCommands } from "./verdict.ts"

/** One `git worktree add` of a line: the command as the refusal names it, and the directory of the checkout git works on. */
export interface WorktreeAdd {
  readonly command: string
  readonly directory: string
}

/** Where git works, as its global options read so far: the directory `-C` moved it to, and any `--work-tree` or `--git-dir`. */
interface GitPlace {
  readonly directory: string
  readonly workTree: Option.Option<string>
  readonly gitDir: Option.Option<string>
}

/** An option's value: the rest of its word after `=`, else the next word when the option takes one. */
const valueOf = (word: Word, option: string, next: Option.Option<Word>): Option.Option<Word> => {
  if (option !== word.text) return Option.some({ ...word, text: word.text.slice(option.length + 1) })
  if (GIT_VALUE_OPTIONS.has(option)) return next
  return Option.none()
}

/** `at` after one option and its value; `-C=dir` is no `-C` to git. */
const moved = (at: GitPlace, option: string, joined: boolean, value: Option.Option<string>): GitPlace => {
  if (option === "-C" && !joined) return { ...at, directory: Option.getOrElse(value, () => at.directory) }
  if (option === "--work-tree") return { ...at, workTree: value }
  if (option === "--git-dir") return { ...at, gitDir: Option.map(value, (path) => path.replace(/\/\.git$/, "")) }
  return at
}

/** `at` after git's global options in `args`, up to the subcommand. */
const gitPlace = (args: ReadonlyArray<Word>, at: GitPlace, home: string): GitPlace =>
  Arr.matchLeft(args, {
    onEmpty: () => at,
    onNonEmpty: (word, tail) => {
      if (!word.text.startsWith("-")) return at
      const option = word.text.replace(/=.*/s, "")
      const joined = option !== word.text
      const value = Option.map(valueOf(word, option, Arr.head(tail)), (each) => resolve(at.directory, expandWord(each, home, at.directory)))
      // An option that takes the next word as its value takes it out of the list.
      const taken = Number(GIT_VALUE_OPTIONS.has(option) && !joined)
      return gitPlace(Arr.drop(tail, taken), moved(at, option, joined, value), home)
    },
  })

/** The checkout git works on: the `--work-tree`, else the `--git-dir`'s checkout, else where `-C` left it. */
const gitDirectory = (args: ReadonlyArray<Word>, runsIn: string, home: string): string => {
  const at = gitPlace(args, { directory: runsIn, workTree: Option.none(), gitDir: Option.none() }, home)
  return Option.getOrElse(Option.orElse(at.workTree, () => at.gitDir), () => at.directory)
}

/** Each `git worktree add` of `line`, in order, with the checkout git works on. */
export const worktreeAdds = (line: string, place: Place): ReadonlyArray<WorktreeAdd> =>
  placedCommands(line, resolve("/", place.cwd), place.home).flatMap(({ head, args, command, runsIn }) => {
    if (head !== "git") return []
    const sub = gitSubcommand(args.map((word) => word.text))
    if (sub.kind !== "command" || sub.name !== "worktree") return []
    const action = Arr.findFirst(sub.rest, (text) => !text.startsWith("-"))
    if (!Option.contains(action, "add")) return []
    return [{ command, directory: gitDirectory(args, runsIn, place.home) }]
  })

/** The file systems whose files Rift clones, as `mount` names them. */
export const CLONING_FILESYSTEMS: ReadonlySet<string> = new Set(["apfs", "btrfs", "xfs"])

/** Whether Rift clones files on `filesystem`. */
export const clones = (filesystem: string): boolean => CLONING_FILESYSTEMS.has(filesystem.toLowerCase())

/** An origin URL as host and path, so an SSH and an HTTPS URL of one repository match (workrift's `normalized_origin`). */
export const normalizedOrigin = (url: string): string =>
  url
    .trim()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(":", "/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")

/** Rift serves the checkout because its file system clones. */
export const Clones = Schema.TaggedStruct("Clones", { filesystem: Schema.String })
/** Rift serves the checkout because a warm source of it exists: the checkout itself, or one of the same origin. */
export const HasWarmSource = Schema.TaggedStruct("HasWarmSource", { source: Schema.String })
/** Why Rift serves a checkout. */
export const RiftHome = Schema.Union([Clones, HasWarmSource])
export type RiftHome = typeof RiftHome.Type

/** Whether two origins name one repository; false when either is none. */
const sameOrigin = (a: Option.Option<string>, b: Option.Option<string>): boolean =>
  Option.getOrElse(
    Option.zipWith(a, b, (left, right) => normalizedOrigin(left) === normalizedOrigin(right)),
    () => false,
  )

/** The warm source of `checkout` among `sources`: the checkout itself, else one with the same origin. */
export const warmSourceOf = (checkout: Checkout, sources: ReadonlyArray<WarmSource>): Option.Option<string> =>
  Option.map(
    Arr.findFirst(sources, (source) => source.path === checkout.root || sameOrigin(source.origin, checkout.origin)),
    (source) => source.path,
  )

/** Why Rift serves `checkout`, given the warm sources; none when it does not. */
export const riftHome = (checkout: Checkout, sources: ReadonlyArray<WarmSource>): Option.Option<RiftHome> => {
  if (clones(checkout.filesystem)) return Option.some(Clones.make({ filesystem: checkout.filesystem }))
  return Option.map(warmSourceOf(checkout, sources), (source): RiftHome => HasWarmSource.make({ source }))
}

/** The reason, in the refusal's words. */
const whyServed = (checkout: Checkout, home: RiftHome): string => {
  if (home._tag === "Clones") return `its file system, ${home.filesystem}, clones`
  if (home.source === checkout.root) return "it is a Rift warm source"
  return `its warm source is ${home.source}`
}

/** Why the guard refuses a worktree in `checkout`, and what to run instead. */
export const worktreeReason = (add: WorktreeAdd, checkout: Checkout, home: RiftHome): string =>
  `\`${add.command}\` makes a full copy of ${checkout.root}, and Rift makes a copy-on-write one here (${whyServed(checkout, home)}): ` +
  'make a Rift instead with the rift tool (`{ action: "create", branch }`), or `workrift create <branch>` on the workbox; ' +
  "`git worktree list`, `remove` and `prune` still run for the old worktrees"

/** A `git worktree add` the guard refuses, with the words the model reads. */
export class FullCopy extends Schema.TaggedError<FullCopy>()("FullCopy", {
  command: Schema.String,
  reason: Schema.String,
}) {}

/** What the model reads of the refusal. */
export const worktreeMessage = (reason: string): string => `guard-worktree: ${reason}.`
