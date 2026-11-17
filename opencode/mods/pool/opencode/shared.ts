// The plugin's storage under the prefixes every copy of the pool reads whole at start (a pool's ledger, the limit
// tally's requests), read once and held for all the copies in one process. OpenCode runs a copy of the plugin per
// location on one storage, and each read the same week of priced steps and requests again: ~350k entries on the
// workbox, tens of seconds of the event loop per copy at its load, five copies after a restart. The copies write
// through it, so what one wrote another reads; a write another process made after the first read is not seen
// (each copy holds what it read in memory from then on anyway). Under any other prefix it is the storage itself.
import { Effect, Semaphore } from "effect"
import type { Storage } from "./ledger.ts"

type Page = Effect.Success<ReturnType<Storage["scan"]>>

/** What one prefix holds: its keys in order, and their values. */
interface Held {
  readonly keys: Array<string>
  readonly values: Map<string, unknown>
}

/** How many entries one read of the storage asks for: the most the host answers. */
const READ_PAGE = 1000

/** One turn of the event loop: what is queued on it (a request, a timer) runs before the fiber goes on. */
const toEventLoop = Effect.callback<void>((resume) => {
  const handle = setImmediate(() => resume(Effect.void))
  return Effect.sync(() => clearImmediate(handle))
})

/** The first index in sorted `keys` whose key is greater than `key` (or at least `key` when `inclusive`). */
const indexAfter = (keys: ReadonlyArray<string>, key: string, inclusive: boolean) => {
  let low = 0
  let high = keys.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const at = keys[middle]!
    if (at < key || (!inclusive && at === key)) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * One process's shared storage: `share(storage, prefixes)` is a copy's view of it, holding `prefixes`. Each prefix
 * is read once, by the copy that first scans it, through that copy's storage.
 */
export const make = () => {
  const held = new Map<string, Held>()
  const locks = new Map<string, Semaphore.Semaphore>()
  const lock = (prefix: string) => {
    const found = locks.get(prefix)
    if (found !== undefined) return found
    const made = Semaphore.makeUnsafe(1)
    locks.set(prefix, made)
    return made
  }

  /** The prefix's entries, read from `storage` the first time; a read that fails is not held, and fails the scan. */
  const load = (storage: Storage, prefix: string): Effect.Effect<Held, unknown> =>
    Effect.suspend(() => {
      const found = held.get(prefix)
      if (found !== undefined) return Effect.succeed(found)
      return Effect.gen(function* () {
        const again = held.get(prefix)
        if (again !== undefined) return again
        const keys: Array<string> = []
        const values = new Map<string, unknown>()
        let after: string | undefined
        do {
          const page: Page = yield* storage.scan({ prefix, ...(after === undefined ? {} : { after }), limit: READ_PAGE })
          for (const entry of page.entries) {
            keys.push(entry.key)
            values.set(entry.key, entry.value)
          }
          after = page.next
          // The host's read is synchronous: between pages the event loop serves the rest of the process.
          if (after !== undefined) yield* toEventLoop
        } while (after !== undefined)
        const read: Held = { keys, values }
        held.set(prefix, read)
        yield* Effect.logInfo(`pool storage: read ${prefix} for every copy in this process: ${keys.length} entries`)
        return read
      }).pipe(Semaphore.withPermit(lock(prefix)))
    })

  /** Brings a held key up to a write that went through. */
  const change = (prefix: string, key: string, value: unknown) => {
    const found = held.get(prefix)
    if (found === undefined) return
    const index = indexAfter(found.keys, key, true)
    const present = found.keys[index] === key
    if (value === undefined) {
      if (present) found.keys.splice(index, 1)
      found.values.delete(key)
      return
    }
    if (!present) found.keys.splice(index, 0, key)
    found.values.set(key, value)
  }

  return (storage: Storage, prefixes: ReadonlyArray<string>): Storage => {
    const owner = (key: string) => prefixes.find((prefix) => key.startsWith(prefix))

    /** A write under a held prefix; it waits for a read of the prefix underway, so the read cannot miss it. */
    const written = <E>(key: string, write: Effect.Effect<void, E>, value: unknown) => {
      const prefix = owner(key)
      if (prefix === undefined) return write
      const done = write.pipe(Effect.tap(() => Effect.sync(() => change(prefix, key, value))))
      return held.has(prefix) ? done : done.pipe(Semaphore.withPermit(lock(prefix)))
    }

    return {
      scan: (options) => {
        const prefix = owner(options.prefix)
        if (prefix === undefined) return storage.scan(options)
        return load(storage, prefix).pipe(
          Effect.map(({ keys, values }): Page => {
            const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), READ_PAGE)
            const from =
              options.after === undefined || options.after < options.prefix
                ? indexAfter(keys, options.prefix, true)
                : indexAfter(keys, options.after, false)
            const entries: Array<{ key: string; value: unknown }> = []
            for (let index = from; index < keys.length && entries.length <= limit; index++) {
              const key = keys[index]!
              if (!key.startsWith(options.prefix)) break
              entries.push({ key, value: values.get(key) })
            }
            if (entries.length <= limit) return { entries }
            const page = entries.slice(0, limit)
            return { entries: page, next: page[page.length - 1]!.key }
          }),
        )
      },
      // Held as the storage keeps it: a copy, not the writer's own object.
      set: (key, value) => written(key, storage.set(key, value), structuredClone(value)),
      remove: (key) => written(key, storage.remove(key), undefined),
    }
  }
}
