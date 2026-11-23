// ScriptFiles over a scratch directory this test makes and removes: a script,
// a missing path, a directory, a file it may not read and one larger than the
// rule reads.
import { spawnSync, write } from "bun"
import { Effect } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { scriptFilesLaws } from "../laws.ts"
import * as FilesystemScriptFiles from "./script-files.ts"

const TEXT = 'const chrome = Bun.spawn(["chromium", "--headless"])\n'

scriptFilesLaws("the filesystem ScriptFiles", () =>
  Effect.gen(function* () {
    const held = yield* Effect.acquireRelease(
      Effect.sync(() => scratch("guard-script-files-")),
      (dir) => Effect.sync(() => dir[Symbol.dispose]()),
    )
    const dir = held.path
    yield* Effect.promise(() => write(`${dir}/probe.ts`, TEXT))
    yield* Effect.promise(() => write(`${dir}/folder.ts/.keep`, "", { createPath: true }))
    yield* Effect.promise(() => write(`${dir}/locked.ts`, TEXT))
    spawnSync(["chmod", "000", `${dir}/locked.ts`])
    yield* Effect.promise(() => write(`${dir}/large.ts`, "x".repeat(FilesystemScriptFiles.MAX_BYTES + 1)))
    return {
      layer: FilesystemScriptFiles.layer,
      script: `${dir}/probe.ts`,
      text: TEXT,
      none: [`${dir}/missing.ts`, `${dir}/folder.ts`, `${dir}/locked.ts`, `${dir}/large.ts`],
    }
  }),
)
