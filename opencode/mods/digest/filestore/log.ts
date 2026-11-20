// The digest's log on disk: `<dir>/events-YYYY-MM.jsonl`, one line per fact, the month of the fact's time (UTC).
// Several OpenCode servers on one host may append at once, so a line is one `write` on a file opened O_APPEND:
// the kernel puts each whole line at the end, and two writers never interleave inside one (a line is at most
// 4,096 bytes plus its newline). A torn last line, from a crash mid-write, is a line the reader skips and counts.
import { mkdir, open, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { DigestLog, encodeLine } from "../event.ts"
import { DigestLines, DigestUnreadable, DigestUnwritable } from "../service.ts"

/** The month file a line of time `t` goes in. */
export const fileOf = (dir: string, t: number): string => join(dir, `events-${new Date(t).toISOString().slice(0, 7)}.jsonl`)

const MONTH = /^events-\d{4}-\d{2}\.jsonl$/

const bytes = new TextEncoder()

/** Append `line` and its newline to `path` as one write on a file opened O_APPEND. */
const appendOne = (path: string, line: string) =>
  open(path, "a").then((handle) => handle.write(bytes.encode(`${line}\n`)).finally(() => handle.close()))

/** The month files of `dir`, oldest first; none when it does not exist yet. */
const monthsOf = (dir: string) =>
  readdir(dir).then(
    (names) => names.filter((name) => MONTH.test(name)).toSorted(),
    (): ReadonlyArray<string> => [],
  )

/** The log in `dir`, made on the first write. */
export const make = (dir: string) =>
  DigestLines.of({
    append: (line, t) =>
      Effect.tryPromise({
        try: () => mkdir(dir, { recursive: true }).then(() => appendOne(fileOf(dir, t), line)),
        catch: (cause) => new DigestUnwritable({ message: String(cause) }),
      }).pipe(Effect.asVoid),
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
