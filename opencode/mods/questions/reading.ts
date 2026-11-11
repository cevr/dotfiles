// How a TUI plugin follows the open questions over the questions RPC: the
// `open` answer decoded, and the session a `changed` event names. The dock
// reads with these, and so does the herdr reporter (mods/herdr), which shows a
// session idling on open questions as blocked.
import { Option, Schema } from "effect"
import { CHANGED, Open, type Question } from "./question.ts"

/** What `open` answered, when it is an answer. */
export const decodeOpen = Schema.decodeUnknownOption(Open)

const decodeChanged = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal(CHANGED), data: Schema.Struct({ sessionID: Schema.String }) }))

/**
 * The session whose questions changed, when `details` (a TUI event's) is the questions' `changed` event.
 * Every event of every session passes here, a token at a time, so any other type is turned away before the decoder.
 */
export const changedSession = (details: unknown): string | undefined => {
  if (typeof details !== "object" || details === null || (details as { readonly type?: unknown }).type !== CHANGED) return undefined
  return Option.getOrUndefined(Option.map(decodeChanged(details), (changed) => changed.data.sessionID))
}

/** Whether two readings of the open questions say the same: a reading that changed nothing leaves what shows them alone. */
export const sameQuestions = (a: ReadonlyArray<Question>, b: ReadonlyArray<Question>): boolean =>
  a.length === b.length && a.every((question, at) => JSON.stringify(question) === JSON.stringify(b[at]))
