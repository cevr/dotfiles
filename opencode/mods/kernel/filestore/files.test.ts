// The attached files on the local filesystem: the Files laws in a scratch directory.
import { mkdtempSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { filesLaws } from "../laws.ts"
import * as FileStore from "./files.ts"

const folder = mkdtempSync(join(tmpdir(), "kernel-files-"))

filesLaws("the local filesystem", () => FileStore.layer, {
  put: (name, bytes) => Effect.promise(() => writeFile(join(folder, name), bytes)).pipe(Effect.as(join(folder, name))),
  folder,
  missing: join(folder, "missing.png"),
})
