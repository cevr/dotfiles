import { Array as Arr, Option } from "effect"
import type { Record } from "./record.ts"
import { buildOfTree, makingTree, namedBy } from "./trees.ts"

/**
 * How many of the record's superseded builds stay on disk, the newest: a TUI on one of them moves
 * onto the installed build, and a rollback that went further back would reinstall from the good
 * build, kept on its own. The record's `previous` list itself stays long: it is only names, and a
 * TUI on any build it lists still moves.
 */
export const PREVIOUS_ON_DISK = 3

/** The name of a build's file in the share directory. */
export const buildName = (version: string): string => `opencode-${version}`

/**
 * The name daily copies a build to before it renames it to `buildName`: `<build name>.copy-<pid>`. It
 * never parses as a build (`buildVersion`), so a prune never takes a copy in flight: `copy-` is no hex,
 * where a bare pid of eight digits would read as a dotfiles commit after a build of the old format.
 * Copies an older daily left (`<build name>.<pid>`) do not parse either: a pid has at most seven digits.
 */
export const stagingName = (version: string, pid: number): string => `${buildName(version)}.copy-${pid}`

/**
 * The one name grammar of a build file, as daily names it (`pin.ts` `versionOf`): `opencode-`, a
 * release version (`X.Y.Z`, with any prerelease), `-prime.`, the fork commit's first eight hex and
 * then `.` and the dotfiles commit's first eight hex. A build of the old format, from before the
 * version named the dotfiles commit, ends at the fork's eight; it is still a build, kept and pruned
 * by the same rule.
 */
const BUILD_NAME = /^opencode-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-prime\.[0-9a-f]{8}(?:\.[0-9a-f]{8})?)$/

/** The version of a share directory entry that is a build; none for anything else (a copy in flight, `pool-auth`, a loader). */
export const buildVersion = (name: string): Option.Option<string> => Option.fromNullishOr(BUILD_NAME.exec(name)?.[1])

/** Whether a share directory entry is a build (`buildVersion`); anything else never goes. */
export const isBuild = (name: string): boolean => Option.isSome(buildVersion(name))

/**
 * How recently changed a build must not be for a prune to take it: a defense behind the builds
 * lock, so a build some writer put there without the lock is never deleted while it may be new.
 */
export const FRESH_MS = 10 * 60 * 1000

/** Whether a file last changed (`changed`, its newer of mtime and ctime) within `FRESH_MS` of `now`, or after it. */
export const isFresh = (changed: number, now: number, freshMs: number = FRESH_MS): boolean => changed > now - freshMs

/** The last path component of a file path, with Linux's ` (deleted)` mark of an unlinked executable dropped. */
export const baseName = (path: string): string => path.replace(/ \(deleted\)$/, "").split("/").at(-1) ?? path

/**
 * The share directory entries a prune keeps:
 * - (a) the installed build;
 * - (b) the staged build;
 * - (c) the newest `PREVIOUS_ON_DISK` of the record's superseded builds, and the recorded good build;
 * - (d) the executable of every running process (`running`, by path).
 * By its version, and by the file its command runs.
 */
export const keptOf = (record: Record, running: ReadonlyArray<string>): ReadonlySet<string> => {
  const builds = [Option.some({ version: record.version, command: record.command }), Option.fromNullishOr(record.staged), Option.fromNullishOr(record.good)]
  const recorded = Arr.getSomes(builds).flatMap((build) => [buildName(build.version), baseName(build.command[0])])
  const previous = (record.previous ?? Arr.empty<string>()).slice(-PREVIOUS_ON_DISK).map(buildName)
  return new Set([...recorded, ...previous, ...running.map(baseName)])
}

/** What runs on the host, as a prune reads it: each process's executable by path, and each one's whole command line. */
export interface Running {
  readonly executables: ReadonlyArray<string>
  readonly commands: ReadonlyArray<string>
}

/**
 * Whether a share directory entry is a tree (`trees.ts`) a prune deletes: the tree of a build outside
 * the kept set, whether or not that build is still on disk, that no running process's command line
 * names (`trees.ts` `namedBy`: a wake job runs a script inside it); or a tree in the making a make that
 * stopped left (`trees.ts` `makingName`), which nothing loads.
 */
const prunableTree = (name: string, kept: ReadonlySet<string>, commands: ReadonlyArray<string>): boolean => {
  if (Option.isSome(makingTree(name))) return true
  return Option.match(Option.filter(buildOfTree(name), isBuild), {
    onNone: () => false,
    onSome: (build) => !kept.has(build) && !commands.some((command) => namedBy(name, command)),
  })
}

/**
 * The share directory entries a prune deletes: the builds (e) outside the kept set (`keptOf`), and
 * their trees with them (`prunableTree`). With what runs unread (`running` none), none: a build or
 * a tree a process runs must never go.
 */
export const prunable = (names: ReadonlyArray<string>, record: Record, running: Option.Option<Running>): ReadonlyArray<string> =>
  Option.match(running, {
    onNone: () => Arr.empty<string>(),
    onSome: (now) => {
      const kept = keptOf(record, now.executables)
      return names.filter((name) => (isBuild(name) && !kept.has(name)) || prunableTree(name, kept, now.commands))
    },
  })
