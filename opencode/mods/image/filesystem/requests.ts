// The Requests contract over the file system: a call's request is kept as
// `<folder>/<id>.json` (mode 0600, its folder 0700: the prompt is the
// user's), the runner reads it back and removes it once read.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { fail, invalid } from "../outcome.ts"
import { RequestJson } from "../request.ts"
import { Requests } from "../service.ts"

const encode = Schema.encodeEffect(RequestJson)
const decode = Schema.decodeUnknownEffect(RequestJson)

/** Requests kept in `folder`. */
export const layer = (folder: string) =>
  Layer.succeed(
    Requests,
    Requests.of({
      save: Effect.fn("Requests.save")(function* (id, request) {
        const file = join(folder, `${id}.json`)
        const text = yield* encode(request).pipe(Effect.mapError(() => invalid("The request cannot be written as JSON.")))
        yield* Effect.tryPromise({
          try: () => mkdir(folder, { recursive: true, mode: 0o700 }).then(() => writeFile(file, text, { mode: 0o600 })),
          catch: () => fail("WRITE_FAILED", `Cannot write the request file ${file}.`),
        })
        return file
      }),
      read: (file) =>
        Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: () => invalid(`No request file at ${file}.`) }).pipe(
          Effect.flatMap((text) => decode(text).pipe(Effect.mapError(() => invalid(`${file} is not an image request.`)))),
        ),
      remove: (file) => Effect.promise(() => rm(file, { force: true })),
    }),
  )
