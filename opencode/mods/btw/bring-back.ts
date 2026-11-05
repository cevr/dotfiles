// Bringing a fork's answer back into the session it came from: one synthetic
// message on that session (gent's btw.merge, ctrl+s). Gent's merge names the
// fork's messages by id for the model to read with its read_session tool;
// OpenCode has no tool that reads another session, so the message carries the
// question and the answer themselves, the answer cut at ANSWER_CHARS.
import type { Reply } from "./turns.ts"
import { cut, oneLine } from "./question.ts"
import { preview } from "./turns.ts"

/** The most of an answer a bring-back carries, in characters. */
export const ANSWER_CHARS = 8000

/**
 * The bring-back's message id: one per fork reply, so the host admits a
 * repeat as the same message (first admission wins, packages/core/src/
 * session/inbox.ts:175-225) and a later reply brings back again.
 */
export const bringBackID = (replyID: string): string => `msg_btw_${replyID.replace(/^msg_/, "")}`

/** What the session's model reads. */
export const bringBackText = (fork: { readonly sessionID: string; readonly name: string }, reply: Reply): string =>
  [
    `The user brought back an answer from a /btw side question: "${oneLine(fork.name)}" (session ${fork.sessionID}).`,
    "That session began as a copy of this one and ran beside it in the same directory; what it said is not otherwise in this conversation.",
    "",
    "Question:",
    reply.question,
    "",
    "Answer:",
    cut(reply.answer, ANSWER_CHARS),
  ].join("\n")

/** The notice row the transcript draws for it (a synthetic message's description). */
export const bringBackDescription = (reply: Reply): string => `btw · ${preview(reply.question)}`
