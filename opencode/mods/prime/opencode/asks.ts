// The Host's side channel of prompts (tui/host.ts asks): each session's user
// messages read apart from its transcript window, newest first, a page at a time
// (`message.list` with `type: "user"`; the server lists them by its own order on
// an index of type and sequence). A session's first page is read the first time
// its view leaves the bottom, a page more only when the pin needs a prompt older
// than the pages read, at most one read in flight per session; never per frame.
// Only the prompt's id, time and first 200 characters are kept (ask.ts promptOf).
// A read that fails ends the session's reading: the pin then knows only the
// loaded window, as before the side channel, until the server reconnects.
import type { Plugin } from "@opencode/plugin/tui"
import { Option } from "effect"
import { createSignal } from "solid-js"
import { EMPTY_INDEX, promptOf, withLoaded, withPage, type AskIndex, type Written } from "../ask.ts"

/** Prompts a read takes: the size of the client's own first page of a transcript. */
export const ASK_PAGE = 20

export function asks(context: Plugin.Context) {
  const [indexes, setIndexes] = createSignal<ReadonlyMap<string, AskIndex>>(new Map())
  const reading = new Set<string>()
  const index = (sessionID: string) => Option.getOrElse(Option.fromUndefinedOr(indexes().get(sessionID)), () => EMPTY_INDEX)
  const put = (sessionID: string, next: AskIndex) => {
    if (next === index(sessionID)) return
    setIndexes((all) => new Map(all).set(sessionID, next))
  }
  // A server back from a restart may hold prompts the reads missed: each session reads again on demand.
  const unconnected = context.data.on("server.connected", () => {
    reading.clear()
    setIndexes(new Map())
  })
  const read = (sessionID: string) => {
    const at = index(sessionID)
    if (reading.has(sessionID) || (at.read && Option.isNone(at.next))) return
    reading.add(sessionID)
    const list = context.client.message.list
    // Before the first page there is no cursor: the newest prompts; after it, the page the cursor names.
    const page = Option.match(at.next, {
      onNone: () => list({ sessionID, type: "user", order: "desc", limit: ASK_PAGE }),
      onSome: (cursor) => list({ sessionID, type: "user", cursor, limit: ASK_PAGE }),
    })
    void page
      .then(
        (found) => {
          const prompts = found.data.flatMap((message) => Option.toArray(promptOf(message)))
          put(sessionID, withPage(index(sessionID), prompts, Option.fromNullishOr(found.cursor.next)))
        },
        () => put(sessionID, { ...index(sessionID), read: true, next: Option.none() }),
      )
      .finally(() => reading.delete(sessionID))
  }
  return {
    index,
    read,
    learn: (sessionID: string, loaded: ReadonlyArray<Written>) => put(sessionID, withLoaded(index(sessionID), loaded)),
    stop: unconnected,
  }
}
