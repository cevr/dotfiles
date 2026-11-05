// The message that carries an answer to the agent. The model reads the text:
// the question, its assumption, the answer, and whether they differ, so it
// needs no lookup. The transcript draws the description as one notice line,
// `answered · <question> → <answer>`. The metadata names the source and keeps
// the answer's fields for anything that reads the transcript.
import { matches, type Question } from "./question.ts"

export interface Letter {
  readonly text: string
  readonly description: string
  readonly metadata: {
    readonly source: "questions"
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

export const letterOf = (question: Question, answer: string): Letter => {
  const same = matches(answer, question.assume)
  return {
    text: [
      `Answer to your background question ${question.id} (asked ${new Date(question.askedAt).toISOString()}):`,
      `Q: ${question.question}`,
      `You assumed: ${question.assume}`,
      `A: ${answer}`,
      same
        ? "This is what you assumed: carry on."
        : "This differs from your assumption: revise the work that rests on it, and say what you changed.",
    ].join("\n"),
    description: `answered · ${excerpt(question.question, LINE_QUESTION)} → ${excerpt(answer, LINE_ANSWER)}`,
    metadata: {
      source: "questions",
      answers: [
        {
          id: question.id,
          question: question.question,
          ...(question.header === undefined ? {} : { header: question.header }),
          assume: question.assume,
          answer,
          matches: same,
        },
      ],
    },
  }
}
