// Processes held in memory: the process table a test names, or a table that
// cannot be read.
import { Effect, Layer } from "effect"
import type { ProcessInfo } from "../kill.ts"
import { Processes, ProcessesUnreadable } from "../service.ts"

/** The processes running, or `"unreadable"` for a `ps` that fails. */
export type World = ReadonlyArray<ProcessInfo> | "unreadable"

export const layer = (world: World) =>
  Layer.succeed(
    Processes,
    Processes.of({
      list: () => (world === "unreadable" ? Effect.fail(new ProcessesUnreadable({ message: "ps exited 1" })) : Effect.succeed(world)),
    }),
  )
