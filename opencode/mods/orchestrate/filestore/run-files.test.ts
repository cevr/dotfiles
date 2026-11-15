// The runs' files on disk, in a scratch directory this test makes and removes: the RunFiles laws (laws.ts) over the
// disk, as memory/run-files.test.ts runs them over memory. A file's time is set with touch, as a writer leaves it.
import { file, spawnSync, write } from "bun"
import { DateTime, Effect, Option } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { runFilesLaws } from "../laws.ts"
import * as FileRunFiles from "./run-files.ts"

runFilesLaws(
  "the disk's RunFiles",
  Effect.gen(function* () {
    const held = yield* Effect.acquireRelease(
      Effect.sync(() => scratch("run-files-")),
      (dir) => Effect.sync(() => dir[Symbol.dispose]()),
    )
    const root = spawnSync(["realpath", held.path], { stdout: "pipe" }).stdout.toString().trim()
    return {
      layer: FileRunFiles.layer,
      root,
      put: (path: string, text: string, when: number) =>
        Effect.promise(() => write(path, text, { createPath: true })).pipe(
          Effect.andThen(() => Effect.sync(() => spawnSync(["touch", "-d", DateTime.formatIso(DateTime.makeUnsafe(when)).replace(/\.\d+Z$/, "Z"), path]))),
          Effect.asVoid,
        ),
      read: (path: string) => Effect.option(Effect.tryPromise(() => file(path).text())),
      // A file where the write needs a directory.
      unwritable: Effect.as(
        Effect.promise(() => write(`${root}/blocked`, "a file, not a dir")),
        Option.some(`${root}/blocked/x/batch.md`),
      ),
    }
  }),
)
