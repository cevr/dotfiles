// The programs on a scratch PATH: one directory holding an executable file
// for each program the law names, and nothing else.
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { programsLaws } from "../laws.ts"
import * as PathPrograms from "./programs.ts"

const scratch = Effect.acquireRelease(
  Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "git-programs-")))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

programsLaws("PATH's Programs", (names) =>
  Effect.gen(function* () {
    const bin = yield* scratch
    for (const name of names) {
      writeFileSync(join(bin, name), "#!/bin/sh\n")
      chmodSync(join(bin, name), 0o755)
    }
    return PathPrograms.layer({ PATH: bin })
  }),
)
