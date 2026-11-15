// The spool in files: one folder per Rex session under the root
// (`$XDG_STATE_HOME/rex-show` in the command), holding `spool.json` and the
// copy of the file shown last. A write goes to a temporary file renamed over
// the old one, so the viewer never reads half of it; keeping a new copy drops
// the older copies.
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { Clock, Effect, Layer, Schema } from "effect"
import { Spool, SpoolFailed } from "../service.ts"
import { empty, Spooled } from "../spool.ts"

const SPOOL = "spool.json"
const COPY = "shown-"

const decodeSpooled = Schema.decodeUnknownEffect(Schema.fromJsonString(Spooled))
const encodeSpooled = Schema.encodeEffect(Schema.fromJsonString(Spooled))

/** A session id as a folder name: anything but letters, digits, `.`, `_` and `-` as `_`. */
export const folderOf = (session: string): string => session.replace(/[^A-Za-z0-9._-]/g, "_")

const io = <A>(path: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new SpoolFailed({ path, message: String(cause) }) })

const missing = (cause: unknown) => String(cause).includes("ENOENT")

/** The spool under `root`. */
export const layer = (root: string) =>
  Layer.sync(Spool, () => {
    const folder = (session: string) => join(root, folderOf(session))
    const read = Effect.fn("FileSpool.read")(function* (session: string) {
      const file = join(folder(session), SPOOL)
      const text = yield* Effect.tryPromise({
        try: () => readFile(file, "utf8"),
        catch: (cause) => new SpoolFailed({ path: file, message: String(cause) }),
      }).pipe(Effect.catchIf((failure) => missing(failure.message), () => Effect.succeed("")))
      if (text === "") return empty
      return yield* decodeSpooled(text).pipe(Effect.mapError((error) => new SpoolFailed({ path: file, message: error.message })))
    })
    const write = Effect.fn("FileSpool.write")(function* (session: string, spooled: Spooled) {
      const dir = folder(session)
      const file = join(dir, SPOOL)
      const text = yield* encodeSpooled(spooled).pipe(Effect.mapError((error) => new SpoolFailed({ path: file, message: error.message })))
      const temporary = `${file}.${yield* Clock.currentTimeMillis}.tmp`
      yield* io(dir, () => mkdir(dir, { recursive: true }))
      yield* io(temporary, () => writeFile(temporary, text))
      yield* io(file, () => rename(temporary, file))
    })
    const keep = Effect.fn("FileSpool.keep")(function* (session: string, source: string) {
      const dir = folder(session)
      yield* io(dir, () => mkdir(dir, { recursive: true }))
      const name = `${COPY}${yield* Clock.currentTimeMillis}${extname(source)}`
      const copy = join(dir, name)
      yield* io(source, () => copyFile(source, copy))
      const older = (yield* io(dir, () => readdir(dir))).filter((entry) => entry.startsWith(COPY) && entry !== name)
      yield* Effect.forEach(older, (entry) => io(entry, () => rm(join(dir, entry), { force: true })), { discard: true })
      return copy
    })
    return Spool.of({ read, write, keep })
  })
