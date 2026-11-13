// A host's memory files held in memory (cmd/memory/server.ts `Files`), as the
// simulated world keeps them: every copy of the plugin, in any server, and the
// CLI that opens one path open the same SQLite database, built as the disk's
// store builds its file (sqlite/store.ts `open`, in memory), so the NoteStore
// laws hold on it (files.test.ts). The databases live as long as the scope
// `make` runs in, the host's disk: a plugin's restart closes none. A test
// makes the next writes fail.
import { Effect, Layer, Option, Scope } from "effect"
import { MemoryStoreFailed, NoteStore } from "../service.ts"
import * as SqliteStore from "../sqlite/store.ts"

export const make = Effect.gen(function* () {
  const disk = yield* Effect.scope
  const open = new Map<string, NoteStore["Service"]>()
  const faults = { writes: 0, failed: 0 }

  /** `write`, unless a fault is due: then the write fails and leaves the file as it was. */
  const written = <A>(path: string, write: Effect.Effect<A, MemoryStoreFailed>) =>
    Effect.suspend(() => {
      if (faults.writes === 0) return write
      faults.writes -= 1
      faults.failed += 1
      return Effect.fail(new MemoryStoreFailed({ message: `the write to ${path} failed` }))
    })

  /** The database at `path`, opened the first time a path is asked for. */
  const storeAt = (path: string) =>
    Option.match(Option.fromNullishOr(open.get(path)), {
      onSome: Effect.succeed,
      onNone: () =>
        SqliteStore.open(":memory:").pipe(
          Scope.provide(disk),
          Effect.map((db) => {
            const store = SqliteStore.make(db)
            const held = NoteStore.of({
              ...store,
              add: (draft) => written(path, store.add(draft)),
              put: (note) => written(path, store.put(note)),
              remove: (id) => written(path, store.remove(id)),
              read: (ids, reading, now) => written(path, store.read(ids, reading, now)),
              keepDigest: (sessionID, text, now) => written(path, store.keepDigest(sessionID, text, now)),
            })
            open.set(path, held)
            return held
          }),
        ),
    })

  return {
    /** The store on the file at `path`. */
    files: (path: string): Layer.Layer<NoteStore, MemoryStoreFailed> => Layer.effect(NoteStore, storeAt(path)),
    /** The next `count` writes fail, to any file. */
    fail: (count: number) => {
      faults.writes += count
    },
    /** How many writes failed so far. */
    failed: () => faults.failed,
    /** The paths opened so far. */
    paths: (): ReadonlyArray<string> => [...open.keys()],
  }
})

export type MemoryFiles = Effect.Success<typeof make>
