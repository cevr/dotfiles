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
import { createMemo, createRoot, getOwner, onCleanup, type Accessor } from "solid-js"
import type { Family, Message, Session, Shell } from "../family.ts"
import { familyOf, message, read, sessionOf, shellsBySession, transcript, type Reads, type Transcript } from "../opencode/view.ts"

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

type Kept<T> = { readonly value: Accessor<T>; readonly dispose: () => void }

/** One session's memos: its transcript, read again only when one of its items changes, and its `Session`. */
function keepSession(
  reads: Reads<unknown>,
  id: string,
  shells: Accessor<ReadonlyMap<string, ReadonlyArray<Shell>>>,
  convert: (item: unknown) => Message | undefined,
): Kept<Session> {
  return createRoot((dispose) => {
    const told = createMemo(() => transcript(reads.session.message.list(id), convert), undefined, { equals: sameTranscript })
    const value = createMemo(() => sessionOf(reads, id, shells().get(id) ?? NONE, told()))
    return { value, dispose }
  })
}

/** `root`'s family as one memo over a memo per session; `dispose` ends them all. */
function keepFamily(reads: Reads<unknown>, root: string, location: unknown, convert: (item: unknown) => Message | undefined): Kept<Family> {
  return createRoot((disposeRoot) => {
    const shells = createMemo(() => shellsBySession(reads.shell.list(location)))
    const ids = createMemo(() => familyOf(reads, root), undefined, { equals: sameList })
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
            kept = keepSession(reads, id, shells, convert)
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
function reader(): FamilyReader {
  const convert = perItem(message)
  const families = new WeakMap<object, Map<string, Entry>>()
  return (reads, sessionID, location) => {
    const root = reads.session.root(sessionID)
    if (getOwner() === null) return read(reads, sessionID, location, convert)
    let byKey = families.get(reads)
    if (byKey === undefined) {
      byKey = new Map()
      families.set(reads, byKey)
    }
    const kept = byKey
    const key = location === undefined ? root : `${root}\n${JSON.stringify(location)}`
    let entry = kept.get(key)
    if (entry === undefined) {
      entry = { ...keepFamily(reads, root, location, convert), users: 0 }
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

const shared = reader()

/**
 * The process's family reader: every TUI plugin that reads a family (Prime's
 * rows, dock and hints, the queue's sidebar) reads it through this one, so a
 * family is read once per update however many views show it.
 */
export function familyReader(): FamilyReader {
  return shared
}
