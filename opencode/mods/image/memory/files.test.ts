import { Effect } from "effect"
import { imageFilesLaws } from "../laws.ts"
import { disk, layer } from "./files.ts"

imageFilesLaws(
  "the memory store",
  Effect.map(disk([], "/locked"), (world) => ({ layer: layer(world), root: "/scratch" })),
)
