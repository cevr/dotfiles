import { Array as Arr, Option } from "effect"
import type { Record } from "./record.ts"

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
 * The name daily copies a build to before it renames it to `buildName`: `<build name>.<pid>`. It
 * never parses as a build (`buildVersion`), so a prune never takes a copy in flight.
 */
export const stagingName = (version: string, pid: number): string => `${buildName(version)}.${pid}`

/**
 * The one name grammar of a build file, as daily names it (`pin.ts` `versionOf`): `opencode-`, a
 * release version (`X.Y.Z`, with any prerelease), `-prime.` and the fork commit's first eight hex.
 */
const BUILD_NAME = /^opencode-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-prime\.[0-9a-f]{8})$/

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

/**
 * The share directory entries a prune deletes: the builds (e) outside the kept set (`keptOf`). With
 * the running executables unread (`running` none), none: a build a process runs must never go.
 */
export const prunable = (names: ReadonlyArray<string>, record: Record, running: Option.Option<ReadonlyArray<string>>): ReadonlyArray<string> =>
  Option.match(running, {
    onNone: () => Arr.empty<string>(),
    onSome: (paths) => {
      const kept = keptOf(record, paths)
      return names.filter((name) => isBuild(name) && !kept.has(name))
    },
  })
