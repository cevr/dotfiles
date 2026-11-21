// The owner's marks on disk, beside the digest's log: `read.jsonl` (marks and his first visit) and `names.jsonl`
// (renames), each line one append (log.ts `appendTo`: one write on a file opened O_APPEND, 0600 in a 0700 folder),
// so two servers marking at once lose nothing. The format is marks.ts's; a file holding a line of a version this
// build does not know fails every read and every write with that file's name and line, and is never written to.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Match } from "effect"
import { decodeMarks, encodeMark, foldMarks, type MarkLine, type Marks, type MarksVersion } from "../marks.ts"
import { DigestUnreadable, type DigestUnwritable } from "../service.ts"
import { appendTo } from "./log.ts"

export const READ_FILE = "read.jsonl"
export const NAMES_FILE = "names.jsonl"

/** The file a line goes in. */
const fileOf = (line: MarkLine): string =>
  Match.valueTags(line, {
    Name: () => NAMES_FILE,
    Mark: () => READ_FILE,
    Since: () => READ_FILE,
  })

/** Whether a read failed because the file is not there. */
const isMissing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"

/** The text of `dir`'s `name`; empty when it does not exist. */
const textOf = (dir: string, name: string) =>
  Effect.tryPromise({ try: () => readFile(join(dir, name), "utf8"), catch: (cause) => cause }).pipe(
    Effect.catchIf(isMissing, () => Effect.succeed("")),
    Effect.mapError((cause) => new DigestUnreadable({ message: `${name}: ${String(cause)}` })),
  )

/** The lines of `dir`'s `name`, or its unknown version. */
const linesOf = (dir: string, name: string) =>
  Effect.flatMap(textOf(dir, name), (text) => Effect.map(Effect.fromResult(decodeMarks(text, name)), (read) => read.lines))

/** The owner's marks in `dir`. */
export interface MarksStore {
  readonly read: Effect.Effect<Marks, MarksVersion | DigestUnreadable>
  /** Append one line, after checking its file is of this build's version. */
  readonly append: (line: MarkLine) => Effect.Effect<void, MarksVersion | DigestUnreadable | DigestUnwritable>
}

export const make = (dir: string): MarksStore => ({
  read: Effect.map(Effect.all([linesOf(dir, READ_FILE), linesOf(dir, NAMES_FILE)], { concurrency: 2 }), ([read, names]) => foldMarks([...read, ...names])),
  append: (line) => linesOf(dir, fileOf(line)).pipe(Effect.andThen(appendTo(dir, fileOf(line), encodeMark(line)))),
})
