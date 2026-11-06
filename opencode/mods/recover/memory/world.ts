// In-memory Sessions and Directories over one plain world, for the model's
// tests: which directories exist, each session's switches, and the moves made.
import { Effect, Layer } from "effect"
import type { Switch } from "../recover.ts"
import { Directories, MoveRefused, Sessions } from "../service.ts"

export interface World {
  readonly directories: Set<string>
  readonly switches: Map<string, ReadonlyArray<Switch>>
  readonly moves: Array<{ readonly sessionID: string; readonly directory: string }>
  /** When set, every move is refused with this message. */
  refuse?: string
}

export const world = (directories: ReadonlyArray<string>, switches: Record<string, ReadonlyArray<Switch>> = {}): World => ({
  directories: new Set(directories),
  switches: new Map(Object.entries(switches)),
  moves: [],
})

export const layer = (w: World) =>
  Layer.mergeAll(
    Layer.succeed(
      Sessions,
      Sessions.of({
        switches: (sessionID) => Effect.succeed(w.switches.get(sessionID) ?? []),
        move: (sessionID, directory) =>
          w.refuse === undefined
            ? Effect.sync(() => void w.moves.push({ sessionID, directory }))
            : Effect.fail(new MoveRefused({ sessionID, directory, message: w.refuse })),
      }),
    ),
    Layer.succeed(Directories, Directories.of({ exists: (directory) => Effect.succeed(w.directories.has(directory)) })),
  )
