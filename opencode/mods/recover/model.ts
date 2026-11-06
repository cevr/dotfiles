// The handler: return a session whose directory is gone to the newest earlier
// location that still exists (`recoverTarget`), through the contracts.
import { Effect } from "effect"
import { Moved, Present, recoverTarget, Stranded } from "./recover.ts"
import { Directories, Sessions } from "./service.ts"

/**
 * Moves the session out of `current` when that directory is gone and an
 * earlier location still exists. `Present` when `current` exists, `Stranded`
 * when no earlier location does, else `Moved` with where it went.
 */
export const recover = Effect.fn("Recovery.recover")(function* (sessionID: string, current: string) {
  const directories = yield* Directories
  if (yield* directories.exists(current)) return Present
  const sessions = yield* Sessions
  const switches = yield* sessions.switches(sessionID)
  const candidates = new Set(switches.flatMap((item) => [item.location.directory, ...(item.previous ? [item.previous.location.directory] : [])]))
  const existing = new Set<string>()
  for (const directory of candidates) if (directory !== current && (yield* directories.exists(directory))) existing.add(directory)
  const target = recoverTarget(current, switches, (directory) => existing.has(directory))
  if (target === undefined) return Stranded
  yield* sessions.move(sessionID, target.directory)
  return Moved(target)
})
