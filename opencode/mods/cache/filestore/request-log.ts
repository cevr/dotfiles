// The ledger as a JSONL file, one judged request per line. Every copy of the
// plugin appends to the same file; each line is one small append, so lines do
// not interleave.
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { LedgerLine } from "../request-log.ts"
import { LedgerUnavailable, RequestLog } from "../service.ts"

/** Where the ledger lives unless the plugin's `dir` option names another directory. */
export const DEFAULT_DIR = join(homedir(), ".cache/opencode-cache-ledger")
export const FILE_NAME = "ledger.jsonl"

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(LedgerLine))
const encodeLine = Schema.encodeSync(Schema.fromJsonString(LedgerLine))

/** The lines of a ledger file's text that decode, in order. */
export const parse = (text: string): ReadonlyArray<LedgerLine> =>
  text.split("\n").flatMap((raw) => {
    if (raw.trim() === "") return []
    const decoded = decodeLine(raw)
    return decoded._tag === "Some" ? [decoded.value] : []
  })

const unavailable = (error: unknown) => new LedgerUnavailable({ message: error instanceof Error ? error.message : String(error) })

/** The ledger at `path`; a missing file reads as empty. */
export const layer = (path: string) =>
  Layer.succeed(
    RequestLog,
    RequestLog.of({
      append: (line) =>
        Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true })
            await appendFile(path, `${encodeLine(line)}\n`)
          },
          catch: unavailable,
        }),
      read: Effect.tryPromise({
        try: () => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "" : Promise.reject(error))),
        catch: unavailable,
      }).pipe(Effect.map(parse)),
    }),
  )
