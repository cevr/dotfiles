import { Effect } from "effect"
import { slotFilesLaws } from "../store/files-laws.ts"
import * as MemorySlots from "./slots.ts"

slotFilesLaws(
  "memory slots",
  Effect.sync(() => ({ files: MemorySlots.make().files, dir: "/law/store" })),
)
