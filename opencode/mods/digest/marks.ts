// The owner's marks on the digest, a stored format of their own beside the event log: `read.jsonl` (each message
// marked read, unread or set aside for Later, and the moment of his first visit) and `names.jsonl` (each project
// renamed). Both are append-only, one line per change, the newest line per key winning, so two servers appending at
// once lose nothing and a restart re-reads the same state.
//
// A line carries its format's version. A line of a version this build does not know is an error the page shows
// ("written by a newer build"), never skipped or written over: the file stays as it is until a build that reads it
// runs. A line that is not JSON of a known shape (a torn last line) is skipped and counted, as in the event log.
//
// Later, exactly: a `later` line stores `returnsAt`, the first 6:00 AM in `digest.timezone` after the moment it was
// written (zone.ts `nextMorning`), computed once. A message is in Later iff its newest line is `later` and the time is
// before `returnsAt`; then it is back, unread. The fold needs no zone.
//
// His first visit (`Since`) is written once, by the page's first load: a message older than it with no mark reads as
// read, so the backlog from before the digest existed is not all unread; a load never marks anything else read.
import { Array as Arr, Match, Option, Result, Schema } from "effect"

/** The version every marks line written now carries. */
export const MARKS_VERSION = 1

export const MARKS = ["read", "unread", "later"] as const
export const MarkKind = Schema.Literals(MARKS)
export type MarkKind = typeof MarkKind.Type

/** One line of `read.jsonl` or `names.jsonl`. */
export const MarkLine = Schema.TaggedUnion({
  /** A message marked: read (opened or swiped), unread, or set aside until `returnsAt`. */
  Mark: { v: Schema.Int, t: Schema.Finite, id: Schema.String, mark: MarkKind, returnsAt: Schema.OptionFromOptionalKey(Schema.Finite) },
  /** His first visit: a message older than it, with no mark, reads as read. */
  Since: { v: Schema.Int, t: Schema.Finite },
  /** A project renamed; an empty name puts its default back. */
  Name: { v: Schema.Int, t: Schema.Finite, project: Schema.String, name: Schema.String },
})
export type MarkLine = typeof MarkLine.Type
export type Mark = Extract<MarkLine, { readonly _tag: "Mark" }>
type NameLine = Extract<MarkLine, { readonly _tag: "Name" }>

/** A mark of message `id` at `t`; `returnsAt` only for `later`. */
export const markOf = (id: string, t: number, mark: MarkKind, returnsAt: Option.Option<number> = Option.none()): MarkLine =>
  MarkLine.cases.Mark.make({ v: MARKS_VERSION, t, id, mark, returnsAt })

/** His first visit, at `t`. */
export const sinceOf = (t: number): MarkLine => MarkLine.cases.Since.make({ v: MARKS_VERSION, t })

/** Project `project` renamed `name` at `t`. */
export const nameOf = (project: string, name: string, t: number): MarkLine => MarkLine.cases.Name.make({ v: MARKS_VERSION, t, project, name })

const encodeOne = Schema.encodeSync(Schema.fromJsonString(MarkLine))
const decodeOne = Schema.decodeUnknownOption(Schema.fromJsonString(MarkLine))
const decodeVersion = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ v: Schema.Finite })))

/** A line as written: one JSON object, no newline. */
export const encodeMark = (line: MarkLine): string => encodeOne(line)

/** A marks file of a version this build cannot read: the page says so and nothing is written over it. */
export class MarksVersion extends Schema.TaggedError<MarksVersion>()("MarksVersion", { message: Schema.String }) {}

/** What a marks file's text reads as: its lines in order, and how many did not decode. */
export interface MarkLines {
  readonly lines: ReadonlyArray<MarkLine>
  readonly bad: number
}

/** The error of a line of another version, if `line` is one. */
const versionError = (line: string, at: number, file: string): Option.Option<MarksVersion> =>
  Option.map(
    Option.filter(decodeVersion(line), (each) => each.v !== MARKS_VERSION),
    (each) =>
      new MarksVersion({
        message: `${file} line ${at + 1} has version ${each.v}; this build reads version ${MARKS_VERSION}. The file is kept as it is: run the build that wrote it, or a newer one.`,
      }),
  )

/** A marks file's text (`file` names it in an error): its lines, or the error of its first line of another version. */
export const decodeMarks = (text: string, file: string): Result.Result<MarkLines, MarksVersion> => {
  const raw = text.split("\n").filter((line) => line.trim() !== "")
  return Option.match(Arr.findFirst(raw.map((line, at) => versionError(line, at, file)).flatMap(Option.toArray), () => true), {
    onSome: (error) => Result.fail(error),
    onNone: () => {
      const lines = raw.flatMap((line) => Option.toArray(decodeOne(line)))
      return Result.succeed({ lines, bad: raw.length - lines.length })
    },
  })
}

/** The owner's marks, folded: each message's newest mark, the projects' names, his first visit. */
export interface Marks {
  readonly marks: ReadonlyMap<string, Mark>
  readonly names: ReadonlyMap<string, string>
  /** His first visit; none before it. */
  readonly since: Option.Option<number>
}

export const NO_MARKS: Marks = { marks: new Map(), names: new Map(), since: Option.none() }

/** Whether `line` is newer than `kept`: a later time, or the same time and the greater line. */
const newer = (line: MarkLine, kept: MarkLine): boolean => line.t > kept.t || (line.t === kept.t && encodeMark(line) > encodeMark(kept))

/** Keep `line` under `key` unless a newer one is kept there. */
const keep = <L extends MarkLine>(map: Map<string, L>, key: string, line: L): void => {
  if (Option.match(Option.fromUndefinedOr(map.get(key)), { onNone: () => true, onSome: (kept) => newer(line, kept) })) map.set(key, line)
}

/** The marks of `lines`, in any order: the newest line per message and per project wins; the earliest visit. */
export const foldMarks = (lines: Iterable<MarkLine>): Marks => {
  const marks = new Map<string, Mark>()
  const names = new Map<string, NameLine>()
  const visits: Array<number> = []
  for (const line of lines)
    Match.valueTags(line, {
      Mark: (mark) => keep(marks, mark.id, mark),
      Name: (name) => keep(names, name.project, name),
      Since: (since) => void visits.push(since.t),
    })
  const named = new Map([...names].flatMap(([project, line]) => Arr.filter([[project, line.name.trim()] as const], ([, name]) => name !== "")))
  return { marks, names: named, since: Option.map(Arr.head(visits), () => Math.min(...visits)) }
}

/** Where a message stands for him at a moment: in the inbox (read or unread), or in Later until it returns. */
export const Standing = Schema.TaggedUnion({
  Inbox: { unread: Schema.Boolean },
  Later: { returnsAt: Schema.Finite },
})
export type Standing = typeof Standing.Type

const inbox = (unread: boolean): Standing => Standing.cases.Inbox.make({ unread })

/** A mark's standing at `now`. */
const markStanding = (mark: Mark, now: number): Standing => {
  if (mark.mark !== "later") return inbox(mark.mark === "unread")
  const back = Option.getOrElse(mark.returnsAt, () => 0)
  if (now < back) return Standing.cases.Later.make({ returnsAt: back })
  return inbox(true)
}

/**
 * A message of time `t` at `now`: in Later while its newest mark is `later` and `now < returnsAt`; otherwise in the
 * inbox, unread when its newest mark is `unread`, or a `later` that has returned, or (with no mark) when it is newer
 * than his first visit (all are unread before it).
 */
export const standing = (marks: Marks, id: string, t: number, now: number): Standing =>
  Option.match(Option.fromUndefinedOr(marks.marks.get(id)), {
    onSome: (mark) => markStanding(mark, now),
    onNone: () => inbox(Option.match(marks.since, { onNone: () => true, onSome: (since) => t > since })),
  })

/** When he last read: his newest read mark, else his first visit. */
export const lastRead = (marks: Marks): Option.Option<number> => {
  const reads = marks.marks
    .values()
    .filter((mark) => mark.mark === "read")
    .map((mark) => mark.t)
    .toArray()
  return Option.orElse(Option.map(Arr.head(reads), () => Math.max(...reads)), () => marks.since)
}
