// The memory files the simulated tests use keep the RunFiles laws (laws.ts) the disk's adapter keeps.
import { Effect, Option } from "effect"
import { runFilesLaws } from "../laws.ts"
import * as MemoryRunFiles from "./run-files.ts"

runFilesLaws(
  "the memory RunFiles",
  Effect.sync(() => {
    const files: MemoryRunFiles.Files = new Map()
    return {
      layer: MemoryRunFiles.layer(files),
      root: "/memory",
      put: (path: string, text: string, when: number) => Effect.sync(() => void files.set(path, { text, at: when })),
      read: (path: string) => Effect.sync(() => Option.map(Option.fromUndefinedOr(files.get(path)), (each) => each.text)),
      // Memory takes every path.
      unwritable: Effect.succeed(Option.none<string>()),
    }
  }),
)
