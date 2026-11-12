import { Array as Arr, Option } from "effect"
import { installedVersions, type Record } from "./record.ts"

/**
 * How many of the record's superseded builds stay on disk, the newest: a TUI on one of them moves
 * onto the installed build, and a rollback that went further back would reinstall from the good
 * build, kept on its own. The record's `previous` list itself stays long: it is only names, and a
 * TUI on any build it lists still moves.
 */
export const PREVIOUS_ON_DISK = 3

/** The name of a build's file in the share directory. */
export const buildName = (version: string): string => `opencode-${version}`

/** Whether a share directory entry is a build (`opencode-<version>`); anything else (`pool-auth`, a loader) never goes. */
export const isBuild = (name: string): boolean => installedVersions([name]).length === 1

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
