// ImageFiles in memory: files by path in a Ref, with the same rules as the
// file system's (type by extension, the size limit, WRITE_FAILED under a
// read-only prefix), for the model's tests and the laws.
import { Effect, HashMap, Layer, Option, Ref } from "effect"
import { fail, invalid } from "../outcome.ts"
import { MAX_IMAGE_BYTES, media } from "../request.ts"
import { ImageFiles } from "../service.ts"

export interface Disk {
  readonly files: Ref.Ref<HashMap.HashMap<string, Uint8Array>>
  /** Paths under this prefix refuse writes. */
  readonly readOnly: string
}

export const disk = (seed: ReadonlyArray<readonly [string, Uint8Array]>, readOnly: string) =>
  Effect.map(Ref.make(HashMap.fromIterable(seed)), (files): Disk => ({ files, readOnly }))

export const layer = (world: Disk) =>
  Layer.succeed(
    ImageFiles,
    ImageFiles.of({
      read: Effect.fn("ImageFiles.read")(function* (path: string) {
        const type = yield* Effect.fromOption(media(path), () => invalid(`Unsupported image type: ${path} (use png/jpg/jpeg/webp/gif).`))
        const data = yield* Effect.fromOption(HashMap.get(yield* Ref.get(world.files), path), () => invalid(`Cannot read ${path}: not found`))
        if (data.length > MAX_IMAGE_BYTES) return yield* Effect.fail(invalid(`${path} is too large`))
        return { data, media: type }
      }),
      write: (path, data) => {
        if (world.readOnly.length > 0 && path.startsWith(world.readOnly)) return Effect.fail(fail("WRITE_FAILED", `Cannot write ${path}: read-only`))
        return Ref.update(world.files, HashMap.set(path, data))
      },
    }),
  )

/** The file at `path`, if one was written or seeded. */
export const file = (world: Disk, path: string) => Effect.map(Ref.get(world.files), (files): Option.Option<Uint8Array> => HashMap.get(files, path))
