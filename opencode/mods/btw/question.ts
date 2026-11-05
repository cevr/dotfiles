// A side question: what the reader typed after /btw or into the pane's ask
// line, checked; the name its fork takes; and the note the fork's model reads
// before each question (gent's @gent/btw forkQuestionText, without the
// question: the fork admits the note as a hidden synthetic message and the
// question as the reader's own prompt, so its transcript and the pane show
// the bare question).
import { Effect, Schema } from "effect"

/** The longest question the fork is asked, in characters (gent's limit). */
export const MAXIMUM_QUESTION_CHARS = 8000

/** The longest question a fork's name carries before it is cut, in characters. */
export const FORK_NAME_CHARS = 60

/** The question is longer than MAXIMUM_QUESTION_CHARS. */
export class QuestionTooLong extends Schema.TaggedError<QuestionTooLong>()("QuestionTooLong", {
  chars: Schema.Number,
  limit: Schema.Number,
}) {}

/** A follow-up with nothing in it: only the first question may be empty. */
export class QuestionEmpty extends Schema.TaggedError<QuestionEmpty>()("QuestionEmpty", {}) {}

/** The text on one line: each run of whitespace, line breaks included, as one space. */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

/** At most `chars` characters of `text` (by code point), with `…` when it was cut. */
export const cut = (text: string, chars: number): string => {
  const points = [...text]
  return points.length <= chars ? text : `${points.slice(0, chars).join("")}…`
}

/** The question as asked: trimmed, refused when longer than MAXIMUM_QUESTION_CHARS. Empty stays empty. */
export const questionOf = (raw: string): Effect.Effect<string, QuestionTooLong> => {
  const question = raw.trim()
  const chars = [...question].length
  return chars > MAXIMUM_QUESTION_CHARS
    ? Effect.fail(new QuestionTooLong({ chars, limit: MAXIMUM_QUESTION_CHARS }))
    : Effect.succeed(question)
}

/** The fork's name, on one line: it titles the pane and the session. `btw` for a fork asked nothing yet. */
export const forkName = (question: string): string => {
  const text = oneLine(question)
  return text.length === 0 ? "btw" : `btw: ${cut(text, FORK_NAME_CHARS)}`
}

/**
 * What the fork's model reads before each question. The fork copies the
 * session as it is, a request the session is still working on included; a
 * bare question under that request reads as a second user message, and the
 * model takes the session's work as its own. The note says whose history it
 * is and what is asked.
 */
export const forkNote = (mainSessionID: string): string =>
  [
    `A side question, asked in a fork of session ${mainSessionID}. That session keeps running on its own: the conversation above is its history, and a request with no answer above is that session's work, not yours. Do not continue it.`,
    "Answer the question that follows. Change files, run long jobs, or start agents only when the question asks for that.",
  ].join("\n")
