// The family read for a TUI that draws it with Solid: `read` from
// opencode/view.ts, kept in memos and shared by every view that reads it.
//
// Read bare inside a computation, `read` walks every field of every part of
// every message in the family, so a token streamed into one message re-read
// the whole family, again in each computation that reads it (the rows, the
// dock's count, the hints, the queue's marks). Through this reader:
// - each message item's reading is a memo of its own, so a token re-reads its
//   own message alone;
// - each session's transcript and `Session` are memos of their own, so a token
//   in one child rebuilds that child's `Session` and the family keeps every
//   other session's object (and its `messages` array) as it was;
// - the family of a root is one memo, shared by every computation in the
//   process that reads it, and disposed once none reads it.
import { createComputed, createMemo, createRoot, createSignal, getOwner, onCleanup, type Accessor } from "solid-js"
import { Option } from "effect"
import type { Family, Latch, Lifecycle, Message, OwnedRow, Session, Shell } from "../family.ts"
import { familyOf, message, ownedSessionOf, read, sessionOf, shellsBySession, transcript, type Reads, type Transcript } from "../opencode/view.ts"
import { fields, is, list } from "../same.ts"
import { keptMemo } from "./kept.ts"

/**
 * `convert` kept per item: each object item gets one memo, which reads it
 * again only when a field it read changes. A memo lives as long as its item:
 * the host's store drops both together.
 */
export function perItem<T>(convert: (item: unknown) => T): (item: unknown) => T {
  const memos = new WeakMap<object, Accessor<T>>()
  return (item) => {
    if (item === null || typeof item !== "object") return convert(item)
    let memo = memos.get(item)
    if (memo === undefined) {
      // An unowned root: the memo outlives the computation that first read it.
      memo = createRoot(() => createMemo(() => convert(item)))
      memos.set(item, memo)
    }
    return memo()
  }
}

/** The family of `sessionID`, as `read` gives it, read through one cache of message readings. */
export type FamilyReader = <Location>(reads: Reads<Location>, sessionID: string, location?: Location) => Family

const sameList = <T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) => a.length === b.length && a.every((value, index) => value === b[index])
const sameTranscript = (a: Transcript, b: Transcript) => a.model === b.model && sameList<Message>(a.messages, b.messages)
const NONE: ReadonlyArray<Shell> = []

const sameLatch = fields<Latch>({ hold: is(), reason: is(), opensAt: is(), recheckAt: is(), at: is(), cancelledAt: is(), failed: is() })
const sameLifecycle = fields<Lifecycle>({ kind: is(), revision: is(), at: is(), sinceReload: is(), waitingOn: is(), diagnostic: is() })

/**
 * Whether two readings of a session say the same: every field of the
 * `Session` equal, the messages the same array (the transcript memo keeps it
 * while no item changes). A host update to a field the `Session` does not
 * carry (its cost, its tokens) then keeps the family as it was, and nothing
 * that reads it runs. The comparisons are a `Fields` record, so a field added
 * to `Session`, `time`, `Latch` or `Shell` fails typecheck here until it is
 * compared too.
 */
export const sameSession = fields<Session>({
  id: is(),
  parentID: is(),
  title: is(),
  agent: is(),
  model: is(),
  outcome: is(),
  time: fields<Session["time"]>({ created: is(), busy: is(), idle: is(), updated: is() }),
  running: is(),
  wakePending: is(),
  execution: (a, b) => a === b || Boolean(a && b && a.kind === b.kind && a.at === b.at),
  lifecycle: (a, b) => a === b || Boolean(a && b && sameLifecycle(a, b)),
  shells: list(fields<Shell>({ id: is(), command: is(), description: is() })),
  // Absent from both, or present in both and the same.
  latch: (a, b) => a === b || Boolean(a && b && sameLatch(a, b)),
  permissions: list(is()),
  questions: list(is()),
  messages: is(),
})

type Kept<T> = { readonly value: Accessor<T>; readonly dispose: () => void }
export type FollowRows = (
  reads: Reads,
  children: ReadonlyArray<string>,
  publish: (rows: ReadonlyArray<OwnedRow>) => void,
) => () => void
type SessionReader = (id: string, words: Transcript) => Session
type Location = Parameters<Reads["shell"]["list"]>[0]
type Source = (
  reads: Reads, root: string, location: Location, ids: Accessor<ReadonlyArray<string>>,
) => SessionReader

/** One session's memos: its transcript, read again only when one of its items changes, and its `Session`. */
function keepSession(
  reads: Reads<unknown>,
  id: string,
  convert: (item: unknown) => Message | undefined,
  session: SessionReader,
): Kept<Session> {
  return createRoot((dispose) => {
    const told = createMemo(() => transcript(reads.session.message.list(id), convert), undefined, { equals: sameTranscript })
    const value = keptMemo(() => session(id, told()), sameSession)
    return { value, dispose }
  })
}

/** `root`'s family as one memo over a memo per session; `dispose` ends them all. */
function keepFamily(reads: Reads<unknown>, root: string, location: unknown, convert: (item: unknown) => Message | undefined, source: Source): Kept<Family> {
  return createRoot((disposeRoot) => {
    const ids = createMemo(() => familyOf(reads, root), undefined, { equals: sameList })
    const session = source(reads, root, location, ids)
    const sessions = new Map<string, Kept<Session>>()
    const value = createMemo((): Family => {
      const wanted = ids()
      const present = new Set(wanted)
      for (const [id, kept] of sessions)
        if (!present.has(id)) {
          kept.dispose()
          sessions.delete(id)
        }
      return {
        root,
        sessions: wanted.map((id) => {
          let kept = sessions.get(id)
          if (kept === undefined) {
            kept = keepSession(reads, id, convert, session)
            sessions.set(id, kept)
          }
          return kept.value()
        }),
      }
    })
    const dispose = () => {
      for (const kept of sessions.values()) kept.dispose()
      sessions.clear()
      disposeRoot()
    }
    return { value, dispose }
  })
}

type Entry = Kept<Family> & { users: number }

/**
 * A family reader over its own caches. Read inside a computation, a family is
 * kept per host data, root and location while any computation reads it; read
 * outside one, it is read once, through the message cache alone.
 */
function cachedReader(source: Source, bare: (reads: Reads, root: string, location: Location, convert: typeof message) => Family): FamilyReader {
  const convert = perItem(message)
  const families = new WeakMap<object, Map<string, Entry>>()
  return (reads, sessionID, location) => {
    const root = reads.session.root(sessionID)
    if (getOwner() === null) return bare(reads, root, location, convert)
    let byKey = families.get(reads)
    if (byKey === undefined) {
      byKey = new Map()
      families.set(reads, byKey)
    }
    const kept = byKey
    const key = location === undefined ? root : `${root}\n${JSON.stringify(location)}`
    let entry = kept.get(key)
    if (entry === undefined) {
      entry = { ...keepFamily(reads, root, location, convert, source), users: 0 }
      kept.set(key, entry)
    }
    const used = entry
    used.users++
    // A computation that runs again lets go and takes it again in the same tick; dispose only once none took it back.
    onCleanup(() => {
      used.users--
      if (used.users === 0)
        queueMicrotask(() => {
          if (used.users !== 0 || kept.get(key) !== used) return
          kept.delete(key)
          used.dispose()
        })
    })
    return used.value()
  }
}

export const readerWithOwner = (follow: FollowRows): FamilyReader => cachedReader((reads, root, location, ids) => {
  const [owned, setOwned] = createSignal(new Map<string, OwnedRow>())
  const native = nativeSource(reads, location)
  createComputed(() => {
    const children = ids().filter((id) => id !== root)
    setOwned(new Map())
    if (children.length === 0) return
    onCleanup(follow(reads, children, (next) => setOwned(new Map(next.map((row) => [row.child, row])))))
  })
  return (id, told) => Option.match(Option.fromUndefinedOr(owned().get(id)), {
    onNone: () => native(id, told),
    onSome: (row) => ownedSessionOf(id, told, reads.session.get(id), row),
  })
}, read)

const nativeSource = (reads: Reads, location: Location): SessionReader => {
  const shells = createMemo(() => shellsBySession(reads.shell.list(location)))
  return (id, told) => sessionOf(reads, id, shells().get(id) ?? NONE, told)
}
const shared = cachedReader((reads, _root, location) => nativeSource(reads, location), read)

/**
 * Host snapshot without an owner. The owner reader uses this same source while
 * no owner answer is available, and doesn't join its facts into owner rows.
 */
export function familyReader(): FamilyReader {
  return shared
}
