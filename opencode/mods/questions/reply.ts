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
//
// A subagent's questions put to its orchestrator go to it as a question
// letter (`askedLetterOf`): one per ask, each question by its ref, what the
// subagent assumes, how to answer it, and the asker's nudge (which documents
// to answer from, and whom to ask when they do not settle it). A question put
// to a session that closes unanswered is a one-line notice to it
// (`withdrawnOf`), which does not wake it.
import { Array as Arr, Option, Predicate } from "effect"
import { type Choice, MAX_OPEN, matches, type Question, type Reason, refOf, type Row } from "./question.ts"

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
    /** On a notice to the root session: the subagent whose questions were answered, and its name. */
    readonly notice?: { readonly sessionID: string; readonly asker: string }
    /** The ids of the questions dismissed beside the answers, when there are any. */
    readonly dismissed?: ReadonlyArray<string>
    /** On a question letter, to the session the questions are put to: who asked, and each question by its ref. */
    readonly asked?: Asking
    /** On the notice that a question put to the session closed unanswered: who asked, its ref and why. */
    readonly withdrawn?: { readonly sessionID: string; readonly asker: string; readonly ref: string; readonly reason: string }
    /** On an answer letter: the answers it carries. */
    readonly answers?: ReadonlyArray<{
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

/** The subagent whose questions a notice reports: its session and its name (asker.ts). */
export interface Asker {
  readonly sessionID: string
  readonly name: string
}

const verdict = (same: boolean) => (same ? "(as it assumed)" : "(differs from its assumption)")

/**
 * The notice the root session of a subagent's tree gets when the owner
 * answers the subagent's questions: what was asked, assumed and answered, so
 * the orchestrator knows the decision. The answers went to the subagent, which
 * acts on them; the notice asks nothing of the root.
 */
export const noticeOf = (asker: Asker, given: ReadonlyArray<Answered>): Letter => {
  const letter = letterOf(given)
  const answered = given.filter((entry) => entry.dismissed !== true)
  const dismissed = given.filter((entry) => entry.dismissed === true).map((entry) => entry.question)
  const ids = answered.map(({ question }) => question.id)
  const only = answered.length === 1 ? answered[0] : undefined
  const same = answered.map(({ question, answer }) => matches(answer, question))
  const head =
    only !== undefined
      ? `The subagent ${asker.name} had its background question ${only.question.id} answered; the answer went to it:`
      : `The subagent ${asker.name} had its background questions ${listed(ids)} answered; the answers went to it:`
  const blocks =
    only !== undefined
      ? [[`Q: ${only.question.question}`, `It assumed: ${only.question.assume}`, `A: ${only.answer} ${verdict(same[0] === true)}`].join("\n")]
      : answered.map(({ question, answer }, at) =>
          ["", `${question.id}: ${question.question}`, `It assumed: ${question.assume}`, `A: ${answer} ${verdict(same[at] === true)}`].join("\n"),
        )
  const named = dismissed.map((question) => `${question.id} dismissed: its assumption stands (${question.question} It assumed: ${question.assume})`)
  const lineOfDismissed = dismissed.length === 0 ? "" : ` · ${listed(dismissed.map((question) => question.id))} dismissed`
  return {
    text: [
      [head, ...blocks].join("\n"),
      ...named,
      `The subagent revises its own work on ${only !== undefined ? "it" : "them"}; this is for your record.`,
    ].join("\n\n"),
    description:
      (only !== undefined
        ? `${asker.name}'s question ${only.question.id} answered · ${excerpt(only.question.question, LINE_QUESTION)} → ${excerpt(only.answer, LINE_ANSWER)}`
        : `${asker.name}'s questions answered ${answered.length} · ${answered
            .map(({ question, answer }) => `${excerpt(question.question, LINE_QUESTION_OF_MANY)} → ${excerpt(answer, LINE_ANSWER_OF_MANY)}`)
            .join(" · ")}`) + lineOfDismissed,
    metadata: { ...letter.metadata, notice: { sessionID: asker.sessionID, asker: asker.name } },
  }
}

/**
 * The one message that carries `given` (at least one answer), in the order
 * given; the questions dismissed beside the answers are named after them.
 */
export const letterOf = (given: ReadonlyArray<Answered>): Letter => {
  const answered = given.filter((entry) => entry.dismissed !== true)
  const dismissed = given.filter((entry) => entry.dismissed === true).map((entry) => entry.question)
  const same = answered.map(({ question, answer }) => matches(answer, question))
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

/** One question of a question letter, as its metadata keeps it. */
export interface AskedQuestion {
  readonly ref: string
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly options?: ReadonlyArray<Choice>
  readonly assume: string
}

/** A question letter's metadata: the session that asked, its name, and its questions. */
export interface Asking {
  readonly sessionID: string
  readonly asker: string
  readonly questions: ReadonlyArray<AskedQuestion>
}

/** A row as a question letter names it: its ref, and what was asked. */
export const askedOf = (row: Row): AskedQuestion => {
  const { answered: _answered, letter: _letter, sessionID: _sessionID, askedAt: _askedAt, from: _from, to: _to, ...asked } = row
  return { ref: refOf(row), ...asked }
}

/** A choice as the letter lists it: its label, and what it means when it says. */
const choiceOf = (choice: Choice): string =>
  Option.match(Option.fromNullishOr(choice.description), { onNone: () => choice.label, onSome: (description) => `${choice.label} (${description})` })

/** One question's lines in a letter: the question, its choices when it has any, and the assumption it goes on. */
const askedLines = (row: Row): ReadonlyArray<string> => [
  `Q: ${row.question}`,
  ...Arr.match(row.options ?? [], { onEmpty: () => [], onNonEmpty: (choices) => [`Options: ${choices.map(choiceOf).join(" · ")}`] }),
  `It assumes: ${row.assume}, and continues on it.`,
]

/** How much of the assumption the transcript's line keeps. */
export const LINE_ASSUME = 40

/** The block of each question when a letter carries several. */
const askedBlock = (row: Row): string => [`${refOf(row)} (asked ${asked(row)}):`, ...askedLines(row)].join("\n")

/** The call that answers `rows`, as the letter shows it. */
const callOf = (rows: ReadonlyArray<Row>): string => `answer_subagent({ answers: [${rows.map((row) => `{ id: "${refOf(row)}", text: "…" }`).join(", ")}] })`

/** The text of a question letter of one question. */
const textOfAsked = (asker: Asker, row: Row): string =>
  [`Question from your subagent ${asker.name} (${refOf(row)}, asked ${asked(row)}):`, ...askedLines(row), "", `Answer it with ${callOf([row])}; the answer reaches it as the owner's would.`].join(
    "\n",
  )

/** The text of a question letter of several questions. */
const textOfAskedMany = (asker: Asker, rows: ReadonlyArray<Row>): string =>
  [
    `Questions from your subagent ${asker.name}:`,
    ...rows.map((row) => `\n${askedBlock(row)}`),
    "",
    `Answer them with ${callOf(rows)}; each answer reaches it as the owner's would.`,
  ].join("\n")

/**
 * The letter that puts `rows` (one ask's questions, at least one) to the session they are `to`: who asked, each
 * question by its ref with its choices and the assumption the subagent goes on, how to answer, then `nudge` (the
 * asker's: which documents to answer from, and whom to ask when they do not settle it).
 */
export const askedLetterOf = (asker: Asker, rows: ReadonlyArray<Row>, nudge: string): Letter => {
  const metadata = { source: "questions" as const, asked: { sessionID: asker.sessionID, asker: asker.name, questions: rows.map(askedOf) } }
  const [only] = rows
  if (rows.length === 1 && Predicate.isNotUndefined(only))
    return {
      text: [textOfAsked(asker, only), nudge].join("\n"),
      description: `question · ${asker.name} · ${excerpt(only.question, LINE_QUESTION)} · assuming ${excerpt(only.assume, LINE_ASSUME)}`,
      metadata,
    }
  return {
    text: [textOfAskedMany(asker, rows), nudge].join("\n"),
    description: `questions ${rows.length} · ${asker.name} · ${rows.map((row) => excerpt(row.question, LINE_QUESTION_OF_MANY)).join(" · ")}`,
    metadata,
  }
}

const CLOSED_VERB: Record<Reason, string> = {
  withdrawn: "withdrew",
  superseded: "replaced (asked again)",
  dropped: `dropped (more than ${MAX_OPEN} open)`,
  dismissed: "dismissed",
  delivered: "closed",
}

/** The notice that the question `ref` put to the session closed unanswered: one line, which does not wake it. */
export const withdrawnOf = (asker: Asker, ref: string, reason: Reason): Letter => ({
  text: `${asker.name} ${CLOSED_VERB[reason]} its question ${ref}.`,
  description: `question ${CLOSED_VERB[reason]} · ${asker.name} · ${ref}`,
  metadata: { source: "questions", withdrawn: { sessionID: asker.sessionID, asker: asker.name, ref, reason } },
})
