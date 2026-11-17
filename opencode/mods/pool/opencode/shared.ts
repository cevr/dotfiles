// The plugin's storage under the prefixes every copy of the pool reads whole at start (a pool's ledger, the limit
// tally's requests), read once and held for all the copies in one process. OpenCode runs a copy of the plugin per
// location on one storage, and each read the same week of priced steps and requests again: ~350k entries on the
// workbox, tens of seconds of the event loop per copy at its load, five copies after a restart. The copies write
// through it, so what one wrote another reads; a write another process made after the first read is not seen
// (each copy holds what it read in memory from then on anyway). Under any other prefix it is the storage itself.
import { Effect, Option, Schema, Semaphore } from "effect"
import type { Storage } from "./ledger.ts"

type Page = Effect.Success<ReturnType<Storage["scan"]>>
type Entry = Page["entries"][number]

/** What one prefix holds: its keys in order, and their values. */
interface Held {
  readonly keys: Array<string>
  readonly values: Map<string, unknown>
}

/** A write as the held copy takes it in: the key's new value, or none for its removal. */
type Change = Option.Option<Schema.Json>

/** How many entries one read of the storage asks for: the most the host answers. */
const READ_PAGE = 1000

/** The first index in sorted `keys` whose key is at least `key`. */
const indexFrom = (keys: ReadonlyArray<string>, key: string) => {
  let low = 0
  let high = keys.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (keys[middle]! < key) low = middle + 1
    else high = middle
  }
  return low
}

/** The first index in sorted `keys` past `key`. */
const indexPast = (keys: ReadonlyArray<string>, key: string) => {
  const index = indexFrom(keys, key)
  return index + Number(keys[index] === key)
}

/** Up to `limit` entries of `held` under `prefix` from `from` on, and the key to go on after when more follow. */
const pageOf = ({ keys, values }: Held, prefix: string, from: number, limit: number): Page => {
  const entries: Array<Entry> = []
  for (let index = from; index < keys.length && entries.length <= limit; index++) {
    const key = keys[index]!
    if (!key.startsWith(prefix)) break
    entries.push({ key, value: values.get(key) })
  }
  if (entries.length <= limit) return { entries }
  const page = entries.slice(0, limit)
  return { entries: page, next: page[page.length - 1]!.key }
}

/**
 * One process's shared storage: `share(storage, prefixes)` is a copy's view of it, holding `prefixes`. Each prefix
 * is read once, by the copy that first scans it, through that copy's storage.
 */
export const make = () => {
  const held = new Map<string, Held>()
  const locks = new Map<string, Semaphore.Semaphore>()
  const lock = (prefix: string) =>
    Option.getOrElse(Option.fromNullishOr(locks.get(prefix)), () => {
      const made = Semaphore.makeUnsafe(1)
      locks.set(prefix, made)
      return made
    })
  const heldOf = (prefix: string) => Option.fromNullishOr(held.get(prefix))

  /** Every entry under `prefix` in `storage`, page by page; the event loop runs between pages (the host's read blocks it). */
  const readAll = Effect.fn("PoolShared.read")(function* (storage: Storage, prefix: string) {
    const read: Held = { keys: [], values: new Map() }
    let page: Page = yield* storage.scan({ prefix, limit: READ_PAGE })
    for (;;) {
      for (const entry of page.entries) {
        read.keys.push(entry.key)
        read.values.set(entry.key, entry.value)
      }
      const next = Option.fromNullishOr(page.next)
      if (Option.isNone(next)) break
      yield* Effect.yieldNow
      page = yield* storage.scan({ prefix, after: next.value, limit: READ_PAGE })
    }
    held.set(prefix, read)
    yield* Effect.logInfo(`pool storage: read ${prefix} for every copy in this process: ${read.keys.length} entries`)
    return read
  })

  /** The prefix's entries, read from `storage` the first time; a read that fails is not held, and fails the scan. */
  const load = (storage: Storage, prefix: string): Effect.Effect<Held, unknown> =>
    Option.match(heldOf(prefix), {
      onSome: Effect.succeed,
      onNone: () =>
        Effect.suspend(() => Option.match(heldOf(prefix), { onSome: Effect.succeed, onNone: () => readAll(storage, prefix) })).pipe(
          Semaphore.withPermit(lock(prefix)),
        ),
    })

  /** Brings a held key up to a write that went through. */
  const apply = (found: Held, key: string, change: Change) => {
    const index = indexFrom(found.keys, key)
    const present = found.keys[index] === key
    Option.match(change, {
      onNone: () => {
        if (present) found.keys.splice(index, 1)
        found.values.delete(key)
      },
      onSome: (value) => {
        if (!present) found.keys.splice(index, 0, key)
        found.values.set(key, value)
      },
    })
  }

  return (storage: Storage, prefixes: ReadonlyArray<string>): Storage => {
    const owner = (key: string) => Option.fromNullishOr(prefixes.find((prefix) => key.startsWith(prefix)))

    /** A write under a held prefix; it waits for a read of the prefix underway, so the read cannot miss it. */
    const written = <E>(key: string, write: Effect.Effect<void, E>, change: Change) =>
      Option.match(owner(key), {
        onNone: () => write,
        onSome: (prefix) => {
          const done = Effect.tap(write, () => Effect.sync(() => Option.map(heldOf(prefix), (found) => apply(found, key, change))))
          return Option.match(heldOf(prefix), { onSome: () => done, onNone: () => Semaphore.withPermit(lock(prefix), done) })
        },
      })

    return {
      scan: (options) =>
        Option.match(owner(options.prefix), {
          onNone: () => storage.scan(options),
          onSome: (prefix) =>
            Effect.map(load(storage, prefix), (found) => {
              const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), READ_PAGE)
              const after = Option.filter(Option.fromNullishOr(options.after), (key) => key >= options.prefix)
              const from = Option.match(after, { onNone: () => indexFrom(found.keys, options.prefix), onSome: (key) => indexPast(found.keys, key) })
              return pageOf(found, options.prefix, from, limit)
            }),
        }),
      // Held as the storage keeps it: a copy, not the writer's own object.
      set: (key, value) => written(key, storage.set(key, value), Option.some(structuredClone(value))),
      remove: (key) => written(key, storage.remove(key), Option.none()),
    }
  }
}
