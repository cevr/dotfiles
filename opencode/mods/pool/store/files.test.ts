// The store on disk (NODE_FILES) keeps the login store files laws, each in a fresh scratch directory.
import { Effect } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { slotFilesLaws } from "./files-laws.ts"
import { NODE_FILES } from "./store.ts"

slotFilesLaws(
  "the store on disk",
  Effect.acquireRelease(
    Effect.sync(() => scratch("slot-files-law-")),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ).pipe(Effect.map((dir) => ({ files: NODE_FILES, dir: dir.path }))),
)
