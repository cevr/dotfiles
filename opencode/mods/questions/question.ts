// The Questions aggregate: one session's background questions, the sheet the
// `ask_user_async` tool writes and the /answer pane reads. A question opens
// with the assumption the agent works on until an answer comes; it closes when
// the agent withdraws it, asks it again (superseded), asks past the cap
// (dropped), the user dismisses it, or its answer was delivered. The answers
// of one submit are recorded on their rows at once, all with the id of the one
// message that carries them, before it is sent, so a send that stopped short
// goes again under the same id and the session reads it once. A submit may
// dismiss questions too: with no answer beside them they close at once and
// nothing is sent (the assumption already stands); beside answers they ride
// in the same message, named as dismissed, and close when it is delivered.
// Also the questions' RPC, which the TUI reads.
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"

/** One choice the agent offers. */
export const Choice = Schema.Struct({
  label: Schema.String.annotate({ description: "The choice, as the user picks it (1-5 words)" }),
  description: Schema.optional(Schema.String).annotate({ description: "What the choice means, if the label does not say" }),
})
export type Choice = typeof Choice.Type

/** An open question as the sheet keeps it and the tray and pane read it. */
export const Question = Schema.Struct({
  /** `q<n>`, unique within its session. */
  id: Schema.String,
  /** The session that asked; its answer goes there. */
  sessionID: Schema.String,
  question: Schema.String,
  header: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Choice)),
  /** What the agent does until an answer arrives. */
  assume: Schema.String,
  /** Epoch ms. */
  askedAt: Schema.Number,
})
export type Question = typeof Question.Type

/**
 * A recorded answer and the id of the message that carries it. Written once;
 * the first answer wins. `dismissed`: the user dismissed the question beside
 * other answers, so the message names it as dismissed and `answer` is the assumption.
 */
export const Answer = Schema.Struct({ answer: Schema.String, delivery: Schema.String, dismissed: Schema.optional(Schema.Literal(true)) })
export type Answer = typeof Answer.Type

/** A question as the sheet keeps it: open until `answered` is recorded, then waiting for its delivery. */
export const Row = Schema.Struct({ ...Question.fields, answered: Schema.optional(Answer) })
export type Row = typeof Row.Type

/** One session's questions, oldest first, and the number the next one takes. */
export const Sheet = Schema.Struct({ next: Schema.Number, rows: Schema.Array(Row) })
export type Sheet = typeof Sheet.Type

export const EMPTY: Sheet = { next: 1, rows: [] }

/** At most this many questions stay open in a session; a new one past it drops the oldest. */
export const MAX_OPEN = 8
/** At most this many questions in one call. */
export const MAX_ASKED = 3
/** A header's most characters. */
export const MAX_HEADER = 30
/** A question's most choices. */
export const MAX_OPTIONS = 4

/** The rows the user can still answer. */
export const openOf = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> => rows.filter((row) => row.answered === undefined)

/** A row as the reader sees it, without its recorded answer. */
export const questionOf = (row: Row): Question => {
  const { answered: _answered, ...question } = row
  return question
}

/** Text compared as the user means it: case and spacing do not count. */
export const normalize = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase()

/** The question form sends an option chosen with a note as `<option> (note: <note>)`. */
const withoutNote = (answer: string): string => answer.replace(/ \(note: [\s\S]*\)$/, "")

/** Whether an answer says what the agent assumed. */
export const matches = (answer: string, assume: string): boolean => normalize(withoutNote(answer)) === normalize(assume)

// ── Commands ──

/** A question as the agent asks it. */
export interface Asked {
  readonly question: string
  readonly header?: string | undefined
  readonly options?: ReadonlyArray<Choice> | undefined
  readonly assume: string
}

/** Ask questions in `sessionID` and withdraw open ones, in one change. */
export const Ask = Schema.TaggedStruct("Ask", {
  sessionID: Schema.String,
  questions: Schema.Array(
    Schema.Struct({ question: Schema.String, header: Schema.optional(Schema.String), options: Schema.optional(Schema.Array(Choice)), assume: Schema.String }),
  ),
  withdraw: Schema.Array(Schema.String),
})
export interface Ask extends Schema.Schema.Type<typeof Ask> {}

/**
 * One question's answer as the user gave it. `keep`: the user kept the
 * assumption and `answer` is their note on it, so the answer recorded is the
 * assumption with that note (`<assumption> (note: <note>)`).
 */
export const Given = Schema.Struct({ id: Schema.String, answer: Schema.String, keep: Schema.optional(Schema.Boolean) })
export type Given = typeof Given.Type

/**
 * Record the answers the user gave in one submit, all under the one message id
 * that carries them, and the questions they dismissed in it. Written at once,
 * so the batch is closed before it is sent: a later submit takes a new id.
 */
export const AnswerQuestions = Schema.TaggedStruct("AnswerQuestions", {
  answers: Schema.Array(Given),
  dismissed: Schema.optional(Schema.Array(Schema.String)),
  delivery: Schema.String,
})
export interface AnswerQuestions extends Schema.Schema.Type<typeof AnswerQuestions> {}

/** Drop an open question without telling the agent. */
export const Dismiss = Schema.TaggedStruct("Dismiss", { id: Schema.String })
export interface Dismiss extends Schema.Schema.Type<typeof Dismiss> {}

/** The message `delivery` reached the session: the questions it answers close. */
export const Delivered = Schema.TaggedStruct("Delivered", { delivery: Schema.String })
export interface Delivered extends Schema.Schema.Type<typeof Delivered> {}

export type Command = Ask | AnswerQuestions | Dismiss | Delivered

// ── Events ──

export const QuestionOpened = Schema.TaggedStruct("QuestionOpened", { question: Question })
export interface QuestionOpened extends Schema.Schema.Type<typeof QuestionOpened> {}

/** Why a question closed. */
export const Reason = Schema.Literals(["withdrawn", "superseded", "dropped", "dismissed", "delivered"])
export type Reason = typeof Reason.Type

export const QuestionClosed = Schema.TaggedStruct("QuestionClosed", { id: Schema.String, reason: Reason })
export interface QuestionClosed extends Schema.Schema.Type<typeof QuestionClosed> {}

export const QuestionAnswered = Schema.TaggedStruct("QuestionAnswered", {
  id: Schema.String,
  answer: Schema.String,
  delivery: Schema.String,
  /** Dismissed beside other answers: the message names it, and it closes as dismissed. */
  dismissed: Schema.optional(Schema.Literal(true)),
})
export interface QuestionAnswered extends Schema.Schema.Type<typeof QuestionAnswered> {}

export type Event = QuestionOpened | QuestionClosed | QuestionAnswered

// ── Rejections ──

/** The call asks nothing and withdraws nothing, or asks more than MAX_ASKED. */
export class NothingAsked extends Schema.TaggedError<NothingAsked>()("NothingAsked", { reason: Schema.String }) {}

/** One asked question breaks a rule; `index` counts from 1. */
export class InvalidQuestion extends Schema.TaggedError<InvalidQuestion>()("InvalidQuestion", { index: Schema.Number, reason: Schema.String }) {}

/** A withdraw names questions that are not open. */
export class UnknownQuestion extends Schema.TaggedError<UnknownQuestion>()("UnknownQuestion", {
  ids: Schema.Array(Schema.String),
  open: Schema.Array(Schema.String),
}) {}

/** The question is not open: answered already, dismissed, withdrawn or never asked. */
export class NotOpen extends Schema.TaggedError<NotOpen>()("NotOpen", { id: Schema.String }) {}

/** An answer with no text. */
export class EmptyAnswer extends Schema.TaggedError<EmptyAnswer>()("EmptyAnswer", { id: Schema.String }) {}

export type AskRejection = NothingAsked | InvalidQuestion | UnknownQuestion
export type ReplyRejection = NotOpen | EmptyAnswer
export type Rejection = AskRejection | ReplyRejection

const flat = (text: string) => text.replace(/\s+/g, " ").trim()

/** The question as the sheet keeps it, or why it cannot be asked. */
const validated = (asked: Asked, index: number): Effect.Effect<Omit<Question, "id" | "sessionID" | "askedAt">, InvalidQuestion> => {
  const fail = (reason: string) => Effect.fail(new InvalidQuestion({ index: index + 1, reason }))
  const question = asked.question.trim()
  const assume = flat(asked.assume)
  const header = asked.header === undefined ? "" : flat(asked.header)
  if (question === "") return fail("the question is empty")
  if (assume === "") return fail("assume is empty: say what you do until an answer arrives")
  if ([...header].length > MAX_HEADER) return fail(`the header is longer than ${MAX_HEADER} characters`)
  const options = (asked.options ?? []).map((option) => ({
    label: flat(option.label),
    ...(option.description === undefined || flat(option.description) === "" ? {} : { description: flat(option.description) }),
  }))
  if (options.length > MAX_OPTIONS) return fail(`more than ${MAX_OPTIONS} options`)
  if (options.some((option) => option.label === "")) return fail("an option has no label")
  const labels = options.map((option) => normalize(option.label))
  if (labels.some((label, at) => labels.indexOf(label) !== at)) return fail("two options share a label")
  return Effect.succeed({
    question,
    ...(header === "" ? {} : { header }),
    ...(options.length === 0 ? {} : { options }),
    assume,
  })
}

/** What an Ask records, or why it is refused. */
export const decideAsk = (state: Sheet, command: Ask, now: number): Effect.Effect<ReadonlyArray<Event>, AskRejection> =>
  Effect.gen(function* () {
    if (command.questions.length === 0 && command.withdraw.length === 0)
      return yield* new NothingAsked({ reason: "give questions to ask, or ids to withdraw" })
    if (command.questions.length > MAX_ASKED) return yield* new NothingAsked({ reason: `ask at most ${MAX_ASKED} questions in one call` })
    const asked = yield* Effect.forEach(command.questions, validated)
    const texts = asked.map((question) => normalize(question.question))
    const twice = texts.findIndex((text, at) => texts.indexOf(text) !== at)
    if (twice >= 0) return yield* new InvalidQuestion({ index: twice + 1, reason: "the same question is asked twice in one call" })
    const open = openOf(state.rows)
    const withdraw = [...new Set(command.withdraw.map((id) => id.trim()))]
    const unknown = withdraw.filter((id) => !open.some((row) => row.id === id))
    if (unknown.length > 0) return yield* new UnknownQuestion({ ids: unknown, open: open.map((row) => row.id) })
    const withdrawn = withdraw.map((id) => QuestionClosed.make({ id, reason: "withdrawn" }))
    const left = open.filter((row) => !withdraw.includes(row.id))
    // Asked again: the open question with the same text gives way to the new one.
    const superseded = left
      .filter((row) => texts.includes(normalize(row.question)))
      .map((row) => QuestionClosed.make({ id: row.id, reason: "superseded" }))
    const opened = asked.map((question, at) =>
      QuestionOpened.make({ question: { id: `q${state.next + at}`, sessionID: command.sessionID, ...question, askedAt: now } }),
    )
    const kept = left.filter((row) => !superseded.some((event) => event.id === row.id))
    const over = Math.max(0, kept.length + opened.length - MAX_OPEN)
    const dropped = kept.slice(0, over).map((row) => QuestionClosed.make({ id: row.id, reason: "dropped" }))
    return [...withdrawn, ...superseded, ...dropped, ...opened]
  })

/**
 * What a submit records: each answer and the one message id on its open row,
 * in the order asked. An answer to a question no longer open (withdrawn or
 * answered meanwhile) is left out, and an id given twice counts once; a submit
 * that answers and dismisses nothing open is refused, as is an empty answer.
 * A dismissal with no answer beside it closes its question at once, since no
 * message goes; beside answers it is recorded under the same message id, so
 * the message names it. A question both answered and dismissed is answered.
 */
export const decideAnswers = (state: Sheet, command: AnswerQuestions): Effect.Effect<ReadonlyArray<Event>, ReplyRejection> => {
  const empty = command.answers.find((given) => given.answer.trim() === "")
  if (empty !== undefined) return Effect.fail(new EmptyAnswer({ id: empty.id }))
  const open = openOf(state.rows)
  const givenOf = (row: Row) => command.answers.find((candidate) => candidate.id.trim() === row.id)
  const dismissed = command.dismissed ?? []
  const isDismissed = (row: Row) => givenOf(row) === undefined && dismissed.some((id) => id.trim() === row.id)
  const answered = open.filter((row) => givenOf(row) !== undefined)
  if (answered.length === 0) {
    const closed = open.filter(isDismissed).map((row) => QuestionClosed.make({ id: row.id, reason: "dismissed" }))
    return closed.length === 0 ? Effect.fail(new NotOpen({ id: command.answers[0]?.id ?? dismissed[0] ?? "" })) : Effect.succeed(closed)
  }
  return Effect.succeed(
    open.flatMap((row) => {
      const given = givenOf(row)
      if (given !== undefined) {
        const answer = given.keep === true ? `${row.assume} (note: ${given.answer.trim()})` : given.answer.trim()
        return [QuestionAnswered.make({ id: row.id, answer, delivery: command.delivery })]
      }
      return isDismissed(row) ? [QuestionAnswered.make({ id: row.id, answer: row.assume, delivery: command.delivery, dismissed: true })] : []
    }),
  )
}

/** What a dismissal records: the open question closes. */
export const decideDismiss = (state: Sheet, command: Dismiss): Effect.Effect<ReadonlyArray<Event>, NotOpen> => {
  const row = openOf(state.rows).find((candidate) => candidate.id === command.id)
  if (row === undefined) return Effect.fail(new NotOpen({ id: command.id }))
  return Effect.succeed([QuestionClosed.make({ id: row.id, reason: "dismissed" })])
}

/** What a delivery records: the questions it answered close; a delivery seen before records nothing. */
export const decideDelivered = (state: Sheet, command: Delivered): Effect.Effect<ReadonlyArray<Event>> =>
  Effect.succeed(
    state.rows
      .filter((row) => row.answered?.delivery === command.delivery)
      .map((row) => QuestionClosed.make({ id: row.id, reason: row.answered?.dismissed === true ? "dismissed" : "delivered" })),
  )

export const Questions: Decider<Sheet, Command, Event, Rejection> = {
  initial: EMPTY,
  decide: (state, command, now) => {
    switch (command._tag) {
      case "Ask":
        return decideAsk(state, command, now)
      case "AnswerQuestions":
        return decideAnswers(state, command)
      case "Dismiss":
        return decideDismiss(state, command)
      case "Delivered":
        return decideDelivered(state, command)
    }
  },
  evolve: (state, event) => {
    switch (event._tag) {
      case "QuestionOpened": {
        const number = Number(event.question.id.slice(1))
        return { next: Math.max(state.next, Number.isInteger(number) ? number + 1 : state.next), rows: [...state.rows, event.question] }
      }
      case "QuestionClosed":
        return { ...state, rows: state.rows.filter((row) => row.id !== event.id) }
      case "QuestionAnswered":
        return {
          ...state,
          rows: state.rows.map((row) =>
            row.id === event.id
              ? { ...row, answered: { answer: event.answer, delivery: event.delivery, ...(event.dismissed === true ? { dismissed: true as const } : {}) } }
              : row,
          ),
        }
    }
  },
}

// ── The RPC the TUI reads ──

const object = (properties: Record<string, unknown>, required: ReadonlyArray<string>) => ({ type: "object", properties, required }) as const
const text = { type: "string" } as const

/**
 * The questions' RPC.
 * - `open({ sessionIDs })`: the open questions of those sessions, oldest first.
 * - `answer({ sessionID, answers: [{ id, answer }] })`: answer several of one
 *   session's questions as one message; `Reply` says whether it reached the
 *   session. The TUI answers through the host's form instead (form.ts).
 * - `dismiss({ sessionID, id })`: drop one without telling the agent.
 * - `changed({ sessionID })`: published after every change to a session's questions.
 */
export const QUESTIONS = {
  id: "dotfiles-opencode.questions",
  methods: {
    open: { input: object({ sessionIDs: { type: "array", items: text } }, ["sessionIDs"]), output: { type: "object" } },
    answer: {
      input: object({ sessionID: text, answers: { type: "array", items: object({ id: text, answer: text }, ["id", "answer"]) } }, ["sessionID", "answers"]),
      output: { type: "object" },
    },
    dismiss: { input: object({ sessionID: text, id: text }, ["sessionID", "id"]), output: { type: "object" } },
  },
  events: {
    changed: { schema: { type: "object", properties: { sessionID: text }, required: ["sessionID"] } },
  },
} as const

/** What `open` answers. */
export const Open = Schema.Struct({ questions: Schema.Array(Question) })
export type Open = typeof Open.Type

/** What `answer` and `dismiss` answer: done, or why not. */
export const Reply = Schema.Struct({ ok: Schema.Boolean, message: Schema.optional(Schema.String) })
export type Reply = typeof Reply.Type

/** The event the server publishes on every change: its full type, as the TUI's event stream carries it. */
export const CHANGED = `rpc.${QUESTIONS.id}.changed`
