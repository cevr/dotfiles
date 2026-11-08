// The message that carries answers to the agent: every answer the owner gave
// a session in one submit goes as one message, so the agent reads the whole
// picture in one turn. The model reads the text: each question, its
// assumption, the answer, and whether they differ, so it needs no lookup; one
// line at the end says what to revise. One answer reads as it always has. A
// question dismissed in the same submit is named after the answers as
// `q3 dismissed: your assumption stands`. The
// transcript draws the description as one notice line,
// `answered · <question> → <answer>`. The metadata names the source and keeps
// the answers' fields for anything that reads the transcript.
import { matches, type Question } from "./question.ts"

/** A question and the answer the owner gave it. */
export interface Answered {
  readonly question: Question
  readonly answer: string
  /** Dismissed beside the answers: named in the message, not answered. */
  readonly dismissed?: boolean
}

export interface Letter {
  readonly text: string
  readonly description: string
  readonly metadata: {
    readonly source: "questions"
    /** The ids of the questions dismissed beside the answers, when there are any. */
    readonly dismissed?: ReadonlyArray<string>
    readonly answers: ReadonlyArray<{
      readonly id: string
      readonly question: string
      readonly header?: string
      readonly assume: string
      readonly answer: string
      readonly matches: boolean
    }>
  }
}

/** The text on one line, at most `max` characters, `…` where it was cut. */
export const excerpt = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  const chars = [...flat]
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`
}

/** How much of the question the transcript's line keeps. */
export const LINE_QUESTION = 60
/** How much of the answer the transcript's line keeps. */
export const LINE_ANSWER = 60
/** With several answers, how much of each question and answer the line keeps. */
export const LINE_QUESTION_OF_MANY = 30
export const LINE_ANSWER_OF_MANY = 20

/** `a`, `a and b`, `a, b and c`. */
export const listed = (items: ReadonlyArray<string>): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

const asked = (question: Question) => new Date(question.askedAt).toISOString()

const textOfOne = ({ question, answer }: Answered, same: boolean) =>
  [
    `Answer to your background question ${question.id} (asked ${asked(question)}):`,
    `Q: ${question.question}`,
    `You assumed: ${question.assume}`,
    `A: ${answer}`,
    same
      ? "This is what you assumed: carry on."
      : "This differs from your assumption: revise the work that rests on it, and say what you changed.",
  ].join("\n")

const textOfMany = (answered: ReadonlyArray<Answered>, same: ReadonlyArray<boolean>) => {
  const ids = answered.map(({ question }) => question.id)
  const differ = ids.filter((_, at) => !same[at])
  const last =
    differ.length === 0
      ? "Each is what you assumed: carry on."
      : differ.length === ids.length
        ? `These differ from your assumptions: revise the work that rests on ${listed(differ)}, and say what you changed.`
        : `Revise the work that rests on ${listed(differ)}, and say what you changed; the rest are what you assumed.`
  return [
    `Answers to your background questions ${listed(ids)}:`,
    ...answered.map(({ question, answer }, at) =>
      [
        "",
        `${question.id} (asked ${asked(question)}): ${question.question}`,
        `You assumed: ${question.assume}`,
        `A: ${answer}`,
        same[at] ? "This is what you assumed." : "This differs from your assumption.",
      ].join("\n"),
    ),
    "",
    last,
  ].join("\n")
}

/** The line that names a question dismissed beside the answers. */
export const dismissedLine = (question: Question): string =>
  `${question.id} dismissed: your assumption stands (${question.question} You assumed: ${question.assume})`

/**
 * The one message that carries `given` (at least one answer), in the order
 * given; the questions dismissed beside the answers are named after them.
 */
export const letterOf = (given: ReadonlyArray<Answered>): Letter => {
  const answered = given.filter((entry) => entry.dismissed !== true)
  const dismissed = given.filter((entry) => entry.dismissed === true).map((entry) => entry.question)
  const same = answered.map(({ question, answer }) => matches(answer, question.assume))
  const only = answered.length === 1 ? answered[0] : undefined
  const body = only !== undefined ? textOfOne(only, same[0] === true) : answered.length === 0 ? "" : textOfMany(answered, same)
  const named = dismissed.map(dismissedLine).join("\n")
  const lineOfDismissed = dismissed.length === 0 ? "" : ` · ${listed(dismissed.map((question) => question.id))} dismissed`
  return {
    text: [body, named].filter((part) => part !== "").join("\n\n"),
    description:
      (only !== undefined
        ? `answered · ${excerpt(only.question.question, LINE_QUESTION)} → ${excerpt(only.answer, LINE_ANSWER)}`
        : `answered ${answered.length} · ${answered
            .map(({ question, answer }) => `${excerpt(question.question, LINE_QUESTION_OF_MANY)} → ${excerpt(answer, LINE_ANSWER_OF_MANY)}`)
            .join(" · ")}`) + lineOfDismissed,
    metadata: {
      source: "questions",
      ...(dismissed.length === 0 ? {} : { dismissed: dismissed.map((question) => question.id) }),
      answers: answered.map(({ question, answer }, at) => ({
        id: question.id,
        question: question.question,
        ...(question.header === undefined ? {} : { header: question.header }),
        assume: question.assume,
        answer,
        matches: same[at] === true,
      })),
    },
  }
}
