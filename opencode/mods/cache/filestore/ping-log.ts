// The keepalive's log as a JSONL file beside the cache ledger, one ping per
// line. Every copy of the plugin appends to the same file; each line is one
// small append, so lines do not interleave.
import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { file } from "bun"
import { Effect, Layer, Option, Schema } from "effect"
import { PingLine } from "../keepalive.ts"
import { LedgerUnavailable, PingLog } from "../service.ts"

/** The file's name, in the ledger's directory. */
export const FILE_NAME = "keepalive.jsonl"

const Line = Schema.fromJsonString(PingLine)
const decodeLine = Schema.decodeUnknownOption(Line)
const encodeLine = Schema.encodeSync(Line)

/** The lines of a log file's text that decode, in order. */
export const parse = (text: string): ReadonlyArray<PingLine> => text.split("\n").flatMap((raw) => Option.toArray(decodeLine(raw)))

/** The log at `path`; a missing file reads as empty. */
export const layer = (path: string) => Layer.succeed(PingLog, make(path))

/** The log at `path`, as the service. */
export const make = (path: string) =>
  PingLog.of({
      append: (line) =>
        Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }), catch: (cause) => new LedgerUnavailable({ message: String(cause) }) }).pipe(
          Effect.andThen(Effect.tryPromise({ try: () => appendFile(path, `${encodeLine(line)}\n`), catch: (cause) => new LedgerUnavailable({ message: String(cause) }) })),
        ),
      read: Effect.tryPromise({ try: () => file(path).exists(), catch: (cause) => new LedgerUnavailable({ message: String(cause) }) }).pipe(
        Effect.flatMap((exists) => {
          if (!exists) return Effect.succeed("")
          return Effect.tryPromise({ try: () => file(path).text(), catch: (cause) => new LedgerUnavailable({ message: String(cause) }) })
        }),
        Effect.map(parse),
      ),
  })
