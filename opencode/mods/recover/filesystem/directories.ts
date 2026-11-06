// Directories over the TUI process's filesystem. The TUI and the server it
// drives share one machine here, as `daily` runs them.
import { statSync } from "node:fs"
import { Effect, Layer } from "effect"
import { Directories } from "../service.ts"

export const layer = Layer.succeed(
  Directories,
  Directories.of({
    exists: (directory) => Effect.sync(() => statSync(directory, { throwIfNoEntry: false })?.isDirectory() ?? false),
  }),
)
