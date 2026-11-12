import { Array as Arr, Option, Schema } from "effect"

/**
 * One build as the record names it: its version, the command that runs it, and the dotfiles and
 * fork commits it was built from.
 */
export const Build = Schema.Struct({
  version: Schema.String,
  command: Schema.NonEmptyArray(Schema.String),
  dotfiles: Schema.String,
  fork: Schema.String,
})
export interface Build extends Schema.Schema.Type<typeof Build> {}

/**
 * OpenCode's record of the installed build, `<XDG state>/opencode/installed.json`. The fork reads
 * `version`, `command` and `previous` (`@opencode/util/installed-build`): an open TUI moves onto the
 * installed build only from a build listed in `previous`, and a client of such a build starts the
 * service on the installed build. The update adds what it needs and the fork ignores: the commits
 * the build came from, and `good`, the last build that passed a health check after its restart.
 */
export const Record = Schema.Struct({
  version: Schema.String,
  command: Schema.NonEmptyArray(Schema.String),
  previous: Schema.optionalKey(Schema.Array(Schema.String)),
  dotfiles: Schema.optionalKey(Schema.String),
  fork: Schema.optionalKey(Schema.String),
  good: Schema.optionalKey(Build),
})
export interface Record extends Schema.Schema.Type<typeof Record> {}

const RecordJson = Schema.fromJsonString(Record, { space: 2 })
const decodeRecord = Schema.decodeUnknownOption(RecordJson)
const encodeRecord = Schema.encodeSync(RecordJson)

/** The record in a file's text; none for text that is not one. */
export const parseRecord = (text: string): Option.Option<Record> => decodeRecord(text)

/** The record as the file holds it. */
export const recordText = (record: Record): string => `${encodeRecord(record)}\n`

/** How many superseded builds the record keeps. */
export const PREVIOUS_KEPT = 200

/** The versions of the builds a `share` directory holds, from their names (`opencode-<version>`). */
export const installedVersions = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  names.flatMap((name) => Option.toArray(Option.fromNullishOr(/^opencode-(\d+\.\d+\.\d+.*)$/.exec(name)?.[1])))

/**
 * The record once `build` is installed over `last`. `previous` keeps the last record's builds and
 * every build still installed beside this one: builds of one release carry no order among
 * themselves, so this list is what says which are older. `good` stays the last proven build: the
 * new one is proven only by its health check (`proven`).
 */
export const nextRecord = (last: Option.Option<Record>, build: Build, installed: ReadonlyArray<string>): Record => {
  const earlier = Option.match(last, {
    onNone: () => Arr.empty<string>(),
    onSome: (record) => [...(record.previous ?? Arr.empty<string>()), record.version],
  })
  const previous = Arr.dedupe([...earlier, ...installedVersions(installed)]).filter((version) => version !== build.version)
  const base: Record = { version: build.version, command: build.command, previous: previous.slice(-PREVIOUS_KEPT), dotfiles: build.dotfiles, fork: build.fork }
  return Option.match(Option.flatMap(last, goodOf), { onNone: () => base, onSome: (good) => ({ ...base, good }) })
}

/** The record's last proven build. */
export const goodOf = (record: Record): Option.Option<Build> => Option.fromNullishOr(record.good)

/** The build the record installs, when it names its commits. */
export const buildOf = (record: Record): Option.Option<Build> =>
  Option.all({ dotfiles: Option.fromNullishOr(record.dotfiles), fork: Option.fromNullishOr(record.fork) }).pipe(
    Option.map((commits) => ({ version: record.version, command: record.command, ...commits })),
  )

/** The record once its build passed the health check: it is the good build now. */
export const proven = (record: Record): Record =>
  Option.match(buildOf(record), { onNone: () => record, onSome: (good) => ({ ...record, good }) })

/**
 * The record that rolls back to the last good build: that build installed again, the failed one
 * listed as superseded so every TUI on it follows. None when there is no good build, or the good
 * build is the one that failed.
 */
export const rolledBack = (record: Record): Option.Option<Record> =>
  goodOf(record).pipe(
    Option.filter((good) => good.version !== record.version),
    Option.map((good) => nextRecord(Option.some(record), good, Arr.empty())),
  )
