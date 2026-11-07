// How a TUI plugin follows the open questions over the questions RPC: the
// `open` answer decoded, and the session a `changed` event names. The dock
// reads with these, and so does the herdr reporter (mods/herdr), which shows a
// session idling on open questions as blocked.
import { Option, Schema } from "effect"
import { CHANGED, Open } from "./question.ts"

/** What `open` answered, when it is an answer. */
export const decodeOpen = Schema.decodeUnknownOption(Open)

const decodeChanged = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal(CHANGED), data: Schema.Struct({ sessionID: Schema.String }) }))

/** The session whose questions changed, when `details` (a TUI event's) is the questions' `changed` event. */
export const changedSession = (details: unknown): string | undefined =>
  Option.getOrUndefined(Option.map(decodeChanged(details), (changed) => changed.data.sessionID))
