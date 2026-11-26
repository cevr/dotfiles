// @reads all
// @reads-reason subprocess reads at mods/image/filesystem/files.test.ts: Effect.sync(() => spawnSync(["mktemp", "-d", "-t", "image-files"]).stdout.toString().trim()),
import { describe, expect, test } from "bun:test"
import { spawnSync } from "bun"
import { Context, Effect, Layer } from "effect"
import { imageFilesLaws } from "../laws.ts"
import { ImageFiles } from "../service.ts"
import { layer } from "./files.ts"

/** A scratch folder for the case, removed with it. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => spawnSync(["mktemp", "-d", "-t", "image-files"]).stdout.toString().trim()),
  (dir) => Effect.sync(() => void spawnSync(["rm", "-rf", dir])),
)

imageFilesLaws(
  "the file system",
  Effect.map(scratch, (root) => ({ layer, root })),
)

describe("the file system's ImageFiles", () => {
  test("a folder in place of a file is INVALID_INPUT, a write under a file is WRITE_FAILED", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* scratch
          const files = yield* Layer.build(layer).pipe(Effect.map((built) => Context.get(built, ImageFiles)))
          spawnSync(["mkdir", `${root}/dir.png`])
          const read = yield* Effect.flip(files.read(`${root}/dir.png`))
          expect(read.code).toBe("INVALID_INPUT")
          yield* files.write(`${root}/plain.png`, Uint8Array.of(1))
          const written = yield* Effect.flip(files.write(`${root}/plain.png/under.png`, Uint8Array.of(1)))
          expect(written.code).toBe("WRITE_FAILED")
        }),
      ),
    ))
})
