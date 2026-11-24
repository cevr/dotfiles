// @reads all
// @reads-reason subprocess reads at mods/orchestrate/filestore/run-files.test.ts: const root = spawnSync(["realpath", held.path], { stdout: "pipe" }).stdout.toString().trim()
// The runs' files on disk, in a scratch directory this test makes and removes: the RunFiles laws (laws.ts) over the
// disk, as memory/run-files.test.ts runs them over memory. A file's time is set with touch, as a writer leaves it.
import { file, spawnSync, write } from "bun"
import { expect, test } from "bun:test"
import { DateTime, Effect, Option } from "effect"
import { headOf } from "../../../../skills/orchestrate/scripts/request.ts"
import { scratch } from "../../../tests/scratch.ts"
import { runFilesLaws } from "../laws.ts"
import { requestHeadOf } from "../tools.ts"
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

const shaOf = (n: number) => n.toString(16).padStart(40, "0")

test("a request's head, as the files read it, is the skill's request.ts headOf", () => {
  for (const text of [`Head: ${shaOf(9)}\n`, "- base 1234567, head commit abcdef01.", "Range 1234567..89abcde, 3 files", "no head here", `head ${shaOf(3).slice(0, 12)} and ${shaOf(4)}`, "base..head: 1111111..2222222"])
    expect({ text, head: requestHeadOf(text) }).toEqual({ text, head: Option.fromNullishOr(headOf(text)) })
})
