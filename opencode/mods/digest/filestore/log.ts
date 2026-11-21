// The digest's log on disk: `<dir>/events-YYYY-MM.jsonl`, one line per fact, the month of the fact's time (UTC).
// Several OpenCode servers on one host may append at once, so a line is one `write` on a file opened O_APPEND:
// the kernel puts each whole line at the end, and two writers never interleave inside one (a line is at most
// 4,096 bytes plus its newline).
//
// A line is never joined to a torn one. A crash mid-write, or a short write on a full disk, leaves the file ending
// without its newline; the next append then starts with a newline of its own, so the torn piece is a line by itself,
// which the reader skips and counts, and the new line reads whole. A short write fails its append (the relay or the
// caller tries again) and ends its piece with a newline when it can, so success is never reported for half a line.
//
// The log is the owner's: its folder is 0700 and its files 0600, a looser one tightened at its next append.
import { chmod, mkdir, open, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { DigestLog, encodeLine } from "../event.ts"
import { DigestLines, DigestUnreadable, DigestUnwritable } from "../service.ts"

/** The name of the month file a line of time `t` goes in. */
const monthOf = (t: number): string => `events-${new Date(t).toISOString().slice(0, 7)}.jsonl`

/** The month file a line of time `t` goes in. */
export const fileOf = (dir: string, t: number): string => join(dir, monthOf(t))

const MONTH = /^events-\d{4}-\d{2}\.jsonl$/
const NEWLINE = 10
const DIR_MODE = 0o700
const FILE_MODE = 0o600

const bytes = new TextEncoder()

/** An open log file as one append sees it: its last byte (none when empty), and one write at its end. */
export interface Sink {
  readonly lastByte: Effect.Effect<Option.Option<number>, DigestUnwritable>
  /** Write `bytes` at the end; the count written, which may be short. */
  readonly write: (bytes: Uint8Array) => Effect.Effect<number, DigestUnwritable>
}

const unwritable = (cause: unknown) => new DigestUnwritable({ message: String(cause) })

/**
 * Append `line` and its newline as one write, after a newline of its own when the file ends mid-line. A short write
 * ends its piece with a newline (best effort) and fails: the piece is one bad line, never joined to the next.
 */
export const writeLine = (sink: Sink, line: string) =>
  Effect.gen(function* () {
    const last = yield* sink.lastByte
    const lead = Option.match(Option.filter(last, (byte) => byte !== NEWLINE), { onNone: () => "", onSome: () => "\n" })
    const whole = bytes.encode(`${lead}${line}\n`)
    const written = yield* sink.write(whole)
    if (written >= whole.length) return
    yield* Effect.ignore(sink.write(bytes.encode("\n")))
    return yield* Effect.fail(new DigestUnwritable({ message: `a short write: ${written} of ${whole.length} bytes; the piece is ended and counted bad` }))
  })

/** `path` opened to append and read, created 0600 and tightened to it, as a sink, closed with the scope. */
const sinkOf = (path: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({ try: () => open(path, "a+", FILE_MODE), catch: unwritable }),
    (handle) => Effect.promise(() => handle.close()),
  ).pipe(
    Effect.tap((handle) => Effect.tryPromise({ try: () => handle.chmod(FILE_MODE), catch: unwritable })),
    Effect.map(
      (handle): Sink => ({
        lastByte: Effect.gen(function* () {
          const { size } = yield* Effect.tryPromise({ try: () => handle.stat(), catch: unwritable })
          if (size === 0) return Option.none<number>()
          const one = new Uint8Array(1)
          yield* Effect.tryPromise({ try: () => handle.read(one, 0, 1, size - 1), catch: unwritable })
          return Option.fromUndefinedOr(one[0])
        }),
        write: (chunk) => Effect.tryPromise({ try: () => handle.write(chunk).then((done) => done.bytesWritten), catch: unwritable }),
      }),
    ),
  )

/** `dir`, made 0700 or tightened to it. */
const ownDir = (dir: string) =>
  Effect.tryPromise({ try: () => mkdir(dir, { recursive: true, mode: DIR_MODE }).then(() => chmod(dir, DIR_MODE)), catch: unwritable })

/** The month files of `dir`, oldest first; none when it does not exist yet. */
const monthsOf = (dir: string) =>
  readdir(dir).then(
    (names) => names.filter((name) => MONTH.test(name)).toSorted(),
    (): ReadonlyArray<string> => [],
  )

/**
 * Append `line` to the file `name` in `dir` as one write (`writeLine`), the folder made 0700 and the file 0600:
 * the log's month files, and the owner's marks beside them (marks.ts).
 */
export const appendTo = (dir: string, name: string, line: string) =>
  ownDir(dir).pipe(Effect.andThen(Effect.scoped(Effect.flatMap(sinkOf(join(dir, name)), (sink) => writeLine(sink, line)))))

/** The log in `dir`, made on the first write. */
export const make = (dir: string) =>
  DigestLines.of({
    append: (line, t) => appendTo(dir, monthOf(t), line),
    read: Effect.tryPromise({ try: () => monthsOf(dir), catch: (cause) => new DigestUnreadable({ message: String(cause) }) }).pipe(
      Effect.flatMap((names) =>
        Effect.forEach(names, (name) => Effect.tryPromise({ try: () => readFile(join(dir, name), "utf8"), catch: (cause) => new DigestUnreadable({ message: String(cause) }) })),
      ),
      Effect.map((texts) => texts.join("\n")),
    ),
  })

export const layer = (dir: string) => Layer.succeed(DigestLines, make(dir))

/**
 * A writer's log straight onto the file log in `dir`, for a process with no digest plugin to send to (the update's
 * handoff, which outlives the server it restarts). A line that cannot be written is logged and dropped: it never
 * fails the writer.
 */
export const writer = (dir: string) =>
  Layer.succeed(
    DigestLog,
    DigestLog.of({
      append: (event) =>
        make(dir)
          .append(encodeLine(event), event.t)
          .pipe(Effect.catch((failure) => Effect.logWarning("digest: a line was not written", { reason: failure.message }))),
    }),
  )
