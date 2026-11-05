// SideQuestions in the TUI's durable plugin storage (packages/plugin/src/tui/
// context.ts, `Storage.store`): one JSON file of every session's side
// question, keyed by session, kept across restarts and shared live by every
// running TUI. A state that does not decode reads as the initial state. The
// file keeps the SESSIONS_KEPT sessions written last; older ones drop.
import { Effect, Layer, Option, Schema } from "effect"
import { HostFailed, SideQuestions } from "../service.ts"
import { INITIAL, type SideQuestionState, SideQuestionState as StateSchema } from "../side-question.ts"
import { messageOf } from "./forks.ts"

/** The storage key, under the plugin's own namespace. */
export const STORE_KEY = "side-questions"

/** How many sessions' side questions the file keeps. */
export const SESSIONS_KEPT = 200

/** The stored value: each session's side question, oldest write first. */
export interface Stored {
  sessions: Record<string, unknown>
}

export const EMPTY: Stored = { sessions: {} }

/** The storage entry, as `ctx.storage.store` returns it. */
export interface Entry {
  readonly read: () => Stored
  readonly write: (mutation: (draft: Stored) => void) => Promise<void>
}

const decode = Schema.decodeUnknownOption(StateSchema)
const encode = Schema.encodeSync(StateSchema)

/** The session's side question in a stored value. Reactive when `stored` is a Solid store read in a computation. */
export const stateOf = (stored: Stored, sessionID: string): SideQuestionState =>
  Option.getOrElse(decode(stored.sessions[sessionID]), () => INITIAL)

/** The stored value with the session's side question written last; the oldest past SESSIONS_KEPT drop. */
export const put = (draft: Stored, sessionID: string, state: SideQuestionState) => {
  delete draft.sessions[sessionID]
  draft.sessions[sessionID] = encode(state)
  const ids = Object.keys(draft.sessions)
  for (const id of ids.slice(0, Math.max(0, ids.length - SESSIONS_KEPT))) delete draft.sessions[id]
}

export const layer = (entry: Entry) =>
  Layer.succeed(
    SideQuestions,
    SideQuestions.of({
      get: (sessionID) => Effect.sync(() => stateOf(entry.read(), sessionID)),
      set: (sessionID, state) =>
        Effect.tryPromise({
          try: () => entry.write((draft) => put(draft, sessionID, state)),
          catch: (cause) => new HostFailed({ operation: "store", message: messageOf(cause) }),
        }),
    }),
  )
