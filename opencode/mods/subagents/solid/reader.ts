// The family read for a TUI that draws it with Solid: `read` from
// opencode/view.ts, with each message item's reading kept in a memo of its
// own. Read inside a computation, `read` alone walks every field of every
// part of every message in the family, so a token streamed into one message
// re-read the whole family, again in each computation that reads it (the
// rows, the dock's count, the hints, the queue's marks). Through this reader
// the computation tracks one memo per item, and a token re-reads its own
// message alone.
import { createMemo, createRoot, type Accessor } from "solid-js"
import type { Family } from "../family.ts"
import { message, read, type Reads } from "../opencode/view.ts"

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

/** A family reader with a cache of its own; a TUI plugin makes one and reads every family through it. */
export function familyReader(): FamilyReader {
  const convert = perItem(message)
  return (reads, sessionID, location) => read(reads, sessionID, location, convert)
}
