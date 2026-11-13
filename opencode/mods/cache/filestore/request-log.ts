// The ledger as a JSONL file, one judged request per line. Every copy of the
// plugin appends to the same file; each line is one small append, so lines do
// not interleave. Each session's newest judged request is a JSON file of its
// own beside it (`last/<sessionID>.json`), written whole to a temporary file
// and renamed over the old one, so a reader never sees half of it.
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { dirname, join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { Kept, LedgerLine } from "../request-log.ts"
import { LedgerUnavailable, RequestLog } from "../service.ts"

/** Where the ledger lives unless the plugin's `dir` option names another directory. */
export const DEFAULT_DIR = join(TuiDirs.dirs().home, ".cache/opencode-cache-ledger")
export const FILE_NAME = "ledger.jsonl"
/** The directory beside the ledger that keeps each session's newest judged request. */
export const LAST_DIR = "last"

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(LedgerLine))
const encodeLine = Schema.encodeSync(Schema.fromJsonString(LedgerLine))
const decodeKept = Schema.decodeUnknownOption(Schema.fromJsonString(Kept))
const encodeKept = Schema.encodeSync(Schema.fromJsonString(Kept))

/** The lines of a ledger file's text that decode, in order. */
export const parse = (text: string): ReadonlyArray<LedgerLine> =>
  text.split("\n").flatMap((raw) => {
    if (raw.trim() === "") return []
    const decoded = decodeLine(raw)
    return decoded._tag === "Some" ? [decoded.value] : []
  })

const unavailable = (error: unknown) => new LedgerUnavailable({ message: error instanceof Error ? error.message : String(error) })

/** A session id is a file name only when it is one plain word: anything else is kept nowhere. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

let writes = 0

/** The ledger at `path`; a missing file reads as empty. */
export const layer = (path: string) => {
  const lastDir = join(dirname(path), LAST_DIR)
  return Layer.succeed(
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
      keep: (sessionID, kept) =>
        SAFE_ID.test(sessionID)
          ? Effect.tryPromise({
              try: async () => {
                await mkdir(lastDir, { recursive: true })
                const file = join(lastDir, `${sessionID}.json`)
                const temporary = `${file}.${process.pid}.${writes++}.tmp`
                await writeFile(temporary, encodeKept(kept))
                await rename(temporary, file)
              },
              catch: unavailable,
            })
          : Effect.void,
      last: (sessionID) =>
        SAFE_ID.test(sessionID)
          ? Effect.tryPromise({
              try: () =>
                readFile(join(lastDir, `${sessionID}.json`), "utf8").catch((error: NodeJS.ErrnoException) =>
                  error.code === "ENOENT" ? undefined : Promise.reject(error),
                ),
              catch: unavailable,
            }).pipe(Effect.map((text) => (text === undefined ? Option.none() : decodeKept(text))))
          : Effect.succeed(Option.none()),
    }),
  )
}
