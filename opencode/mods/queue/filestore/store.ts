// Each session's queue as a JSON file, `<dir>/<sessionID>.json`, written to a
// temporary file beside it and renamed over it, so a reader never sees half a
// queue. No file is an empty queue; a file that does not parse or decode is
// unreadable, and the next write replaces it.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { EMPTY, Snapshot } from "../queue.ts"
import { QueueStore, QueueUnreadable, QueueUnwritable } from "../service.ts"

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot))
const encode = Schema.encodeEffect(Schema.fromJsonString(Snapshot))

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const isNotFound = (cause: unknown) => typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

/** The file for a session; a session id never leaves `dir`. */
export const fileOf = (dir: string, sessionID: string) => join(dir, `${encodeURIComponent(sessionID)}.json`)

let written = 0

export const layer = (dir: string) =>
  Layer.succeed(QueueStore, {
    read: (sessionID) => {
      const file = fileOf(dir, sessionID)
      return Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: (cause) => cause }).pipe(
        Effect.catch((cause) => (isNotFound(cause) ? Effect.succeed(undefined) : Effect.fail(new QueueUnreadable({ message: `${file}: ${messageOf(cause)}` })))),
        Effect.flatMap((text) =>
          text === undefined ? Effect.succeed(EMPTY) : decode(text).pipe(Effect.mapError((error) => new QueueUnreadable({ message: `${file}: ${error.message}` }))),
        ),
        Effect.withSpan("QueueStore.read"),
      )
    },
    write: (sessionID, snapshot) => {
      const file = fileOf(dir, sessionID)
      const staged = `${file}.${process.pid}.${++written}`
      return encode(snapshot).pipe(
        Effect.mapError((error) => new QueueUnwritable({ message: error.message })),
        Effect.flatMap((text) =>
          Effect.tryPromise({
            try: async () => {
              await mkdir(dir, { recursive: true })
              await writeFile(staged, `${text}\n`)
              await rename(staged, file)
            },
            catch: (cause) => new QueueUnwritable({ message: `${file}: ${messageOf(cause)}` }),
          }),
        ),
        Effect.withSpan("QueueStore.write"),
      )
    },
    remove: (sessionID) => {
      const file = fileOf(dir, sessionID)
      return Effect.tryPromise({ try: () => rm(file, { force: true }), catch: (cause) => new QueueUnwritable({ message: `${file}: ${messageOf(cause)}` }) })
    },
  })
