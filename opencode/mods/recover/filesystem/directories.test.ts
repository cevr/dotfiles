import { afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { directoriesLaws } from "../laws.ts"
import { layer } from "./directories.ts"

const root = mkdtempSync(join(tmpdir(), "recover-dirs-"))
writeFileSync(join(root, "file.txt"), "")
afterAll(() => rmSync(root, { recursive: true, force: true }))

directoriesLaws("the filesystem", () => ({
  layer,
  directory: root,
  file: join(root, "file.txt"),
  missing: join(root, "gone"),
}))
