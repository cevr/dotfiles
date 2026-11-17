// The pool's many small records (priced steps, the limit tally's uses) kept in the plugin's storage as chunks of
// up to CHUNK entries, `<prefix><writer>/<seq>`, instead of one key each: a week of them is ~350k keys on the
// workbox, and reading those at start cost tens of seconds of the event loop. Each process writes under a writer of
// its own, so no key is ever written by two processes or read, changed and written back over another's write; the
// copies of the plugin in one process (one per location) share one store, whose writes take turns.
//
// An entry's identity is what its key was in the old shape (a step's time and session, a use's message): a reader
// keeps the first entry of each identity, so a duplicate (two copies that saw one message, a fold that wrote a chunk
// and stopped before it removed the old keys) counts once, as the old key's overwrite did.
//
// The old shape, one key per entry under `legacy`, is read too, at every first read in a process: a build from
// before still writes it while it runs. The fold rewrites those keys as chunks and removes them, in the background,
// a page at a time: a fold that stops is taken up again by the next process's.
import { Clock, Effect, Option, Random, Schema, Semaphore } from "effect"
import type { Storage } from "./ledger.ts"

/** The most entries one chunk holds. */
export const CHUNK = 200

/**
 * How long a writer appends to one chunk: an entry more than this after the chunk's first goes in a new chunk. So no
 * entry a chunk will ever hold is newer than its first entry's time plus this, which lets another process remove the
 * chunk once that time is past keep, with no race against its writer (the storage has no compare-and-set).
 */
export const SEAL_MS = 24 * 3_600_000

/** How many keys one read of the storage asks for: the most the host answers. */
const READ_PAGE = 1000

/** One kind of record, as its chunks (rows of `R`) and its old keys (a value of `L` each) hold it. */
export interface Kind<A, R, L> {
  /** Where its chunks are kept: `<prefix><writer>/<seq>`. */
  readonly prefix: string
  /** Where the old shape kept one entry per key. */
  readonly legacy: string
  /** How long an entry is kept after its time (ms); one that old is not carried into a chunk. */
  readonly keepMs: number
  readonly identity: (entry: A) => string
  readonly at: (entry: A) => number
  /** One entry of a chunk, and the entry it reads as. */
  readonly row: Schema.Decoder<R>
  readonly toRow: (entry: A) => Schema.Json
  readonly fromRow: (row: R) => A
  /** What an old key held, and the entry it reads as; its key is given past `legacy`. */
  readonly old: Schema.Decoder<L>
  readonly fromOld: (key: string, old: L) => A
}

/** The records of one kind, as one process holds them. */
export interface Store<A> {
  /** Every entry kept, from both shapes, read from the storage the first time; one decoded copy per process. */
  readonly entries: Effect.Effect<ReadonlyArray<A>>
  /** Keeps an entry, unless one of its identity is kept already. A write that fails is lost (logged). */
  readonly append: (entry: A) => Effect.Effect<void>
  /**
   * Forgets every entry of time `through` or before, and removes every chunk that holds, and will hold, only those:
   * this process's by what it wrote, another's once it can change no more (SEAL_MS).
   */
  readonly expire: (through: number) => Effect.Effect<void>
  /** Rewrites the old keys as chunks and removes them; how many old keys it removed. Once per process. */
  readonly fold: Effect.Effect<number>
}

const Chunk = Schema.Struct({ v: Schema.Literal(1), entries: Schema.Array(Schema.Unknown) })
const decodeChunk = Schema.decodeUnknownOption(Chunk)

/** A chunk as this process saw it last. */
interface Seen {
  readonly oldest: number
  readonly newest: number
  readonly own: boolean
}

interface Held<A> {
  readonly byIdentity: Map<string, A>
  /** Each chunk read or written, by key: its oldest and newest entry's times as seen, and whether this process wrote it. */
  readonly chunks: Map<string, Seen>
  /** The old keys read, in order, each with its entry's identity when it decoded. */
  readonly legacy: Array<{ readonly key: string; readonly identity: Option.Option<string> }>
  /** The identities only an old key holds. */
  readonly onlyLegacy: Set<string>
}

/** Every entry under `prefix`, page by page; the event loop runs between pages (the host's read blocks it). */
const scanAll = Effect.fn("PoolChunks.scan")(function* (storage: Storage, prefix: string) {
  const entries: Array<{ readonly key: string; readonly value: unknown }> = []
  let page = yield* storage.scan({ prefix, limit: READ_PAGE })
  for (;;) {
    entries.push(...page.entries)
    const next = Option.fromNullishOr(page.next)
    if (Option.isNone(next)) return entries
    yield* Effect.yieldNow
    page = yield* storage.scan({ prefix, after: next.value, limit: READ_PAGE })
  }
})

/** One kind's store over `storage`; a process makes one of each kind, for every copy of the plugin in it (records.ts). */
export const open = <A, R, L>(storage: Storage, kind: Kind<A, R, L>): Store<A> => {
  const decodeRow = Schema.decodeUnknownOption(kind.row)
  const decodeOld = Schema.decodeUnknownOption(kind.old)
  const lock = Semaphore.makeUnsafe(1)
  let held = Option.none<Held<A>>()
  let writer = Option.none<string>()
  let seq = 0
  /** The chunk appends go to, and what it holds. */
  let current = Option.none<{ readonly key: string; readonly opened: number; readonly entries: Array<A> }>()
  let folded = false

  const read = Effect.gen(function* () {
    const found: Held<A> = { byIdentity: new Map(), chunks: new Map(), legacy: [], onlyLegacy: new Set() }
    for (const { key, value } of yield* scanAll(storage, kind.prefix)) {
      const chunk = decodeChunk(value)
      if (Option.isNone(chunk)) continue
      let oldest = Number.POSITIVE_INFINITY
      let newest = Number.NEGATIVE_INFINITY
      for (const row of chunk.value.entries)
        Option.map(Option.map(decodeRow(row), kind.fromRow), (entry) => {
          const identity = kind.identity(entry)
          oldest = Math.min(oldest, kind.at(entry))
          newest = Math.max(newest, kind.at(entry))
          if (!found.byIdentity.has(identity)) found.byIdentity.set(identity, entry)
        })
      found.chunks.set(key, { oldest, newest, own: false })
    }
    for (const { key, value } of yield* scanAll(storage, kind.legacy)) {
      const entry = Option.map(decodeOld(value), (old) => kind.fromOld(key.slice(kind.legacy.length), old))
      const identity = Option.map(entry, kind.identity)
      found.legacy.push({ key, identity })
      Option.map(entry, (decoded) => {
        const id = kind.identity(decoded)
        if (found.byIdentity.has(id)) return
        found.byIdentity.set(id, decoded)
        found.onlyLegacy.add(id)
      })
    }
    held = Option.some(found)
    yield* Effect.logInfo(
      `pool storage: read ${kind.prefix} (${found.chunks.size} chunks) and ${kind.legacy} (${found.legacy.length} old keys): ${found.byIdentity.size} entries`,
    )
    return found
  }).pipe(Effect.catchCause((cause) => Effect.as(Effect.logWarning(`pool storage: ${kind.prefix} not read: ${cause}`), emptyHeld<A>())))

  /** What the store holds, read the first time; run holding the lock. */
  const load = Effect.suspend(() => Option.match(held, { onSome: Effect.succeed, onNone: () => read }))

  const writerOf = Effect.gen(function* () {
    if (Option.isSome(writer)) return writer.value
    const at = yield* Clock.currentTimeMillis
    const random = yield* Random.nextIntBetween(0, 0xffffff)
    const made = `${at.toString(36)}-${random.toString(16).padStart(6, "0")}`
    writer = Option.some(made)
    return made
  })

  /** A new chunk's key under this process's writer. */
  const nextKey = Effect.map(writerOf, (name) => `${kind.prefix}${name}/${String(seq++).padStart(6, "0")}`)

  /** Writes `entries` as the chunk `key`, and holds it so. */
  const write = (found: Held<A>, key: string, entries: ReadonlyArray<A>) =>
    storage.set(key, { v: 1, entries: entries.map(kind.toRow) }).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          found.chunks.set(key, { oldest: Math.min(...entries.map(kind.at)), newest: Math.max(...entries.map(kind.at)), own: true }),
        ),
      ),
    )

  const append = (entry: A) =>
    Effect.gen(function* () {
      const found = yield* load
      const identity = kind.identity(entry)
      if (found.byIdentity.has(identity)) return
      found.byIdentity.set(identity, entry)
      // A full chunk, or one opened more than SEAL_MS before this entry, is never written again.
      const open = Option.filter(current, (chunk) => chunk.entries.length < CHUNK && kind.at(entry) - chunk.opened < SEAL_MS)
      const target = yield* Option.match(open, {
        onSome: Effect.succeed,
        onNone: () => Effect.map(nextKey, (key) => ({ key, opened: kind.at(entry), entries: new Array<A>() })),
      })
      target.entries.push(entry)
      current = Option.some(target)
      yield* write(found, target.key, target.entries)
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning(`pool storage: an entry under ${kind.prefix} was not written: ${cause}`)),
      Semaphore.withPermit(lock),
    )

  const expire = (through: number) =>
    Effect.gen(function* () {
      const found = yield* load
      for (const [identity, entry] of [...found.byIdentity]) if (kind.at(entry) <= through) found.byIdentity.delete(identity)
      for (const [key, chunk] of [...found.chunks])
        if (removable(chunk, through)) {
          yield* storage.remove(key)
          found.chunks.delete(key)
          if (Option.exists(current, (open) => open.key === key)) current = Option.none()
        }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning(`pool storage: chunks under ${kind.prefix} not expired: ${cause}`)),
      Semaphore.withPermit(lock),
    )

  /** One page of old keys rewritten as a chunk, then removed; how many keys it removed. */
  const foldPage = (found: Held<A>, page: ReadonlyArray<Held<A>["legacy"][number]>, now: number) =>
    Effect.gen(function* () {
      const carried = page.flatMap(({ identity }) =>
        Option.toArray(
          Option.flatMap(
            Option.filter(identity, (id) => found.onlyLegacy.has(id)),
            (id) => Option.filter(Option.fromNullishOr(found.byIdentity.get(id)), (entry) => now - kind.at(entry) < kind.keepMs),
          ),
        ),
      )
      if (carried.length > 0) yield* write(found, yield* nextKey, carried)
      for (const { identity } of page)
        Option.map(identity, (id) => {
          if (!found.onlyLegacy.delete(id)) return
          // An old entry past keep is not carried: it goes with its key.
          if (!carried.some((entry) => kind.identity(entry) === id)) found.byIdentity.delete(id)
        })
      for (const { key } of page) yield* storage.remove(key)
      return page.length
    }).pipe(Semaphore.withPermit(lock))

  const fold = Effect.gen(function* () {
    if (folded) return 0
    folded = true
    const found = yield* Semaphore.withPermit(lock, load)
    const pending = found.legacy.splice(0)
    const now = yield* Clock.currentTimeMillis
    const started = yield* Clock.currentTimeMillis
    let removed = 0
    for (let from = 0; from < pending.length; from += CHUNK) {
      removed += yield* foldPage(found, pending.slice(from, from + CHUNK), now)
      yield* Effect.yieldNow
    }
    if (removed > 0)
      yield* Effect.logInfo(`pool storage: folded ${removed} old keys under ${kind.legacy} into chunks in ${(yield* Clock.currentTimeMillis) - started} ms`)
    return removed
  }).pipe(Effect.catchCause((cause) => Effect.as(Effect.logWarning(`pool storage: the fold of ${kind.legacy} stopped: ${cause}`), 0)))

  return {
    entries: Effect.map(Semaphore.withPermit(lock, load), (found) => [...found.byIdentity.values()]),
    append,
    expire,
    fold,
  }
}

/**
 * Whether every entry the chunk holds, or will ever hold, is of time `through` or before. This process's own chunk
 * holds what it wrote. Another process may still append to its chunk after this one read it, but only entries newer
 * than the chunk's first by less than SEAL_MS: once that time is past too, the chunk can change no more. (A fold's
 * chunk is never appended to, so its newest entry would do, but nothing tells a fold's chunk from another; it just
 * goes up to a day later.)
 */
const removable = (chunk: Seen, through: number) => chunk.newest <= through && (chunk.own || chunk.oldest + SEAL_MS <= through)

const emptyHeld = <A>(): Held<A> => ({ byIdentity: new Map(), chunks: new Map(), legacy: [], onlyLegacy: new Set() })
