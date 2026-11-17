// The ImageFiles contract over the file system: an image a request names is
// read whole once its type (by extension) and size (at most MAX_IMAGE_BYTES)
// pass; an output is written after its folder is made.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect, Layer, Option } from "effect"
import { fail, invalid } from "../outcome.ts"
import { MAX_IMAGE_BYTES, media } from "../request.ts"
import { ImageFiles, type Part } from "../service.ts"

const MIB = 1024 * 1024

const reason = (cause: unknown) => {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

export const layer = Layer.succeed(
  ImageFiles,
  ImageFiles.of({
    read: Effect.fn("ImageFiles.read")(function* (path: string) {
      const type = yield* Option.match(media(path), {
        onNone: () => Effect.fail(invalid(`Unsupported image type: ${path} (use png/jpg/jpeg/webp/gif).`)),
        onSome: Effect.succeed,
      })
      const size = yield* Effect.tryPromise({ try: () => stat(path), catch: (cause) => invalid(`Cannot read ${path}: ${reason(cause)}`) })
      if (!size.isFile()) return yield* Effect.fail(invalid(`Cannot read ${path}: not a file`))
      if (size.size > MAX_IMAGE_BYTES) return yield* Effect.fail(invalid(`${path} is ${Math.ceil(size.size / MIB)} MiB; an image may be at most ${MAX_IMAGE_BYTES / MIB} MiB.`))
      const data = yield* Effect.tryPromise({ try: () => readFile(path), catch: (cause) => invalid(`Cannot read ${path}: ${reason(cause)}`) })
      return { data: new Uint8Array(data), media: type } satisfies Part
    }),
    write: (path, data) =>
      Effect.tryPromise({
        try: () => mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, data)),
        catch: (cause) => fail("WRITE_FAILED", `Cannot write ${path}: ${reason(cause)}`),
      }),
  }),
)
