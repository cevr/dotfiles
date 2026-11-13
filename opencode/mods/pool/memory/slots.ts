// A login store's files and lock held in memory (store.ts `SlotFiles`), as the
// simulated world keeps them: every holder of the store (each `StoreSource`, in
// any process) reads and writes the same files and takes the same lock. A test
// puts a sign-in in a slot as the store's own sign-in writes it, holds the lock
// as another process would, and makes the next writes fail.
import { Effect, Option } from "effect"
import type { SlotFiles } from "../store/store.ts"

/** A missing file or directory, as the disk names it. */
const missing = (path: string) => ({ code: "ENOENT", message: `no such file: ${path}` })

/** The parent of `path`, and its last part. */
const split = (path: string) => {
  const at = path.lastIndexOf("/")
  return { dir: path.slice(0, Math.max(0, at)), name: path.slice(at + 1) }
}

export const make = () => {
  const files = new Map<string, string>()
  const locks = new Set<string>()
  const faults = { writes: 0, failed: 0 }

  const slots: SlotFiles = {
    names: (path) =>
      Effect.suspend(() => {
        const names = [...files.keys()].flatMap((file) => Option.toArray(Option.liftPredicate(split(file), (parts) => parts.dir === path)).map((parts) => parts.name))
        if (names.length === 0) return Effect.fail(missing(path))
        return Effect.succeed(names)
      }),
    read: (path) => Effect.fromOption(Option.fromNullishOr(files.get(path))).pipe(Effect.mapError(() => missing(path))),
    write: (path, content) =>
      Effect.suspend(() => {
        if (faults.writes > 0) {
          faults.writes -= 1
          faults.failed += 1
          return Effect.fail({ code: "EIO", message: `the write of ${path} failed` })
        }
        files.set(path, content)
        return Effect.void
      }),
    tryLock: (dir) =>
      Effect.sync(() => {
        if (locks.has(dir)) return Option.none()
        locks.add(dir)
        return Option.some(Effect.sync(() => void locks.delete(dir)))
      }),
  }

  return {
    files: slots,
    /** The file at `path` now; none when it holds nothing. */
    get: (path: string) => Option.fromNullishOr(files.get(path)),
    /** `content` at `path`, as a sign-in or another writer puts it there. */
    put: (path: string, content: string) => void files.set(path, content),
    /** Another process takes the store's lock at `dir`: until the returned release, every try finds it held. */
    hold: (dir: string) => {
      locks.add(dir)
      return () => void locks.delete(dir)
    },
    /** The next `count` writes fail and leave their files as they were. */
    failWrites: (count: number) => {
      faults.writes = count
    },
    /** How many writes failed so far. */
    failed: () => faults.failed,
  }
}

export type MemorySlots = ReturnType<typeof make>
