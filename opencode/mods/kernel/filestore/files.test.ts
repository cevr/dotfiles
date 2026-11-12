// The attached files on the local filesystem: the Files laws in a scratch directory.
import { mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { filesLaws } from "../laws.ts"
import * as FileStore from "./files.ts"

/** Each law's own scratch directory, removed when the law's scope closes. */
const world = Effect.map(
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "kernel-files-"))),
    (folder) => Effect.sync(() => rmSync(folder, { recursive: true, force: true })),
  ),
  (folder) => ({
    put: (name: string, bytes: Uint8Array) => Effect.promise(() => writeFile(join(folder, name), bytes)).pipe(Effect.as(join(folder, name))),
    folder,
    missing: join(folder, "missing.png"),
  }),
)

filesLaws("the local filesystem", () => FileStore.layer, world)
