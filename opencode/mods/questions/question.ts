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
import { Array as Arr, Effect, Option, Predicate, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"

/** One choice the agent offers. */
export const Choice = Schema.Struct({
  label: Schema.String.annotate({ description: "The choice, as the user picks it (1-5 words)" }),
  description: Schema.optional(Schema.String).annotate({ description: "What the choice means, if the label does not say" }),
})
export type Choice = typeof Choice.Type

/**
 * A question another plugin asked on the owner's behalf, by its own `key`
 * (the pool's hold): its answer is not a message to the session but waits on
 * the row for that plugin to read (`asked`) and settle (`withdrawFor`).
 */
export const From = Schema.Struct({ plugin: Schema.String, key: Schema.String })
export type From = typeof From.Type

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
  /** The plugin that asked, when a plugin did; the agent's own questions have none. */
  from: Schema.optional(From),
  /**
   * The session the question is put to (a subagent's orchestrator), which answers it in the owner's place; none: the
   * owner's. Set when it is asked, never changed; a sheet stored before routing has none, so its questions stay the owner's.
   */
  to: Schema.optional(Schema.String),
})
export type Question = typeof Question.Type

/**
 * A recorded answer and the id of the message that carries it. Written once;
 * the first answer wins. `dismissed`: the user dismissed the question beside
 * other answers, so the message names it as dismissed and `answer` is the assumption.
 */
/** Where the owner answered: the TUI's tray and /answer form, or the digest page. */
export const Via = Schema.Literals(["tray", "page"])
export type Via = typeof Via.Type

/**
 * A recorded answer and the id of the message that carries it, and (recorded since the digest page answers too) where
 * it was given and when, so a second answer from the other place is told who closed it.
 */
export const Answer = Schema.Struct({
  answer: Schema.String,
  delivery: Schema.String,
  dismissed: Schema.optional(Schema.Literal(true)),
  via: Schema.optional(Via),
  /** Epoch ms. */
  at: Schema.optional(Schema.Number),
})
export type Answer = typeof Answer.Type

/**
 * The message that puts a question to the session it is `to`: its id, recorded with the question before it is sent, so
 * a send that stopped short goes again under the same id and the session holds it once; whether it went; and the
 * asker's nudge it carries (the documents to answer from), kept so a resend says the same.
 */
export const Letter = Schema.Struct({ delivery: Schema.String, sent: Schema.Boolean, nudge: Schema.String })
export type Letter = typeof Letter.Type

/** A question as the sheet keeps it: open until `answered` is recorded, then waiting for its delivery. */
export const Row = Schema.Struct({ ...Question.fields, answered: Schema.optional(Answer), letter: Schema.optional(Letter) })
export type Row = typeof Row.Type

/**
 * One session's questions, oldest first, and the number the next one takes. `rev` counts the writes of a stored sheet
 * (a sheet stored before it counts as 0; one not stored has none): the store writes a sheet only over the rev it was
 * read at, so two writers (the tray's copy and the page's, or two servers) never both close a question.
 */
export const Sheet = Schema.Struct({ next: Schema.Number, rows: Schema.Array(Row), rev: Schema.optional(Schema.Number) })
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

/** The agent's own rows: a plugin's questions are not the agent's to withdraw, replace or drop, and their answers are no message. */
export const ownOf = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> => rows.filter((row) => row.from === undefined)

/** The rows `plugin` asked. */
export const fromOf = (rows: ReadonlyArray<Row>, plugin: string): ReadonlyArray<Row> => rows.filter((row) => row.from?.plugin === plugin)

/** The owner's rows: those put to no session. */
export const ownersOf = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> => rows.filter((row) => Predicate.isUndefined(row.to))

/** The rows put to a session, whichever. */
export const heldOf = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> => rows.filter((row) => Predicate.isNotUndefined(row.to))

/** The open rows whose letter has not gone yet. */
export const unsentOf = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> => openOf(rows).filter((row) => row.letter?.sent === false)

/** A row as the reader sees it, without its recorded answer or its letter. */
export const questionOf = (row: Row): Question => {
  const { answered: _answered, letter: _letter, ...question } = row
  return question
}

/** A question's ref, as the session it is put to names it: `<asking session>:<id>`. */
export const refOf = (question: Pick<Question, "sessionID" | "id">): string => `${question.sessionID}:${question.id}`

/** The asking session and the question id a ref names, split at its last `:`; none when it holds no `:`. */
export const parseRef = (ref: string): Option.Option<{ readonly sessionID: string; readonly id: string }> => {
  const at = ref.trim().lastIndexOf(":")
  return Option.liftPredicate({ sessionID: ref.trim().slice(0, Math.max(0, at)), id: ref.trim().slice(at + 1) }, (parsed) => at > 0 && parsed.id !== "")
}

/** Text compared as the user means it: case and spacing do not count. */
export const normalize = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase()

/** The question form sends an option chosen with a note as `<option> (note: <note>)`. */
const withoutNote = (answer: string): string => answer.replace(/ \(note: [\s\S]*\)$/, "")

/** A label's "(Recommended)" mark at its end, as the built-in question tool asks models to write it. */
const RECOMMENDED = /\s*\(recommended\)\s*$/i

/** Whether a choice's label carries the "(Recommended)" mark. */
export const isRecommended = (label: string): boolean => RECOMMENDED.test(label)

/** A label as the assumption would name it: without its "(Recommended)" mark, compared as the user means it. */
const bare = (label: string): string => normalize(label.replace(RECOMMENDED, ""))

/**
 * The choice the assumption names, if any: the one whose label, without a
 * "(Recommended)" mark, is the assumption, or with which the assumption starts
 * as whole words ("8080" in "8080, the dev default"). The longest such label
 * wins; with none, the assumption is no choice.
 */
export const assumedChoice = (question: { readonly options?: ReadonlyArray<Choice> | undefined; readonly assume: string }): Choice | undefined => {
  const assume = normalize(question.assume)
  const named = (question.options ?? []).filter((choice) => {
    const label = bare(choice.label)
    if (label === "") return false
    if (assume === label || assume === normalize(choice.label)) return true
    return assume.startsWith(label) && !/[\p{L}\p{N}_]/u.test(assume.charAt(label.length))
  })
  return named.toSorted((left, right) => bare(right.label).length - bare(left.label).length)[0]
}

/**
 * Whether an answer says what the agent assumed: the assumption itself, or the
 * choice it names (what the form records when that choice is picked).
 */
export const matches = (answer: string, question: { readonly options?: ReadonlyArray<Choice> | undefined; readonly assume: string }): boolean => {
  const given = normalize(withoutNote(answer))
  if (given === normalize(question.assume)) return true
  const choice = assumedChoice(question)
  return choice !== undefined && given === normalize(choice.label)
}

// ── Commands ──

/** A question as the agent asks it. */
export interface Asked {
  readonly question: string
  readonly header?: string | undefined
  readonly options?: ReadonlyArray<Choice> | undefined
  readonly assume: string
}

/**
 * Where a subagent's ask goes: the session its questions are put to, the id of the message that puts them there
 * (minted before it is sent), and the nudge that message carries.
 */
export const Route = Schema.Struct({ to: Schema.String, letter: Schema.String, nudge: Schema.String })
export type Route = typeof Route.Type

/** Ask questions in `sessionID` and withdraw open ones, in one change; with a `route`, the questions opened are put to its session. */
export const Ask = Schema.TaggedStruct("Ask", {
  sessionID: Schema.String,
  questions: Schema.Array(
    Schema.Struct({ question: Schema.String, header: Schema.optional(Schema.String), options: Schema.optional(Schema.Array(Choice)), assume: Schema.String }),
  ),
  withdraw: Schema.Array(Schema.String),
  route: Schema.optional(Route),
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
  /** The session that answers, when one does in the owner's place: only questions put to it. None: the owner, who may answer any. */
  by: Schema.optional(Schema.String),
  /** Where the owner gave them; none for a session answering in his place. */
  via: Schema.optional(Via),
})
export interface AnswerQuestions extends Schema.Schema.Type<typeof AnswerQuestions> {}

/** Drop an open question without telling the agent. */
export const Dismiss = Schema.TaggedStruct("Dismiss", { id: Schema.String })
export interface Dismiss extends Schema.Schema.Type<typeof Dismiss> {}

/** The message `delivery` reached the session: the questions it answers close. */
export const Delivered = Schema.TaggedStruct("Delivered", { delivery: Schema.String })
export interface Delivered extends Schema.Schema.Type<typeof Delivered> {}

/**
 * A plugin asks one question in `sessionID` under its own key. Asked again
 * under a key it already has a row for (open or answered), nothing changes:
 * a plugin asks once per key.
 */
export const AskFor = Schema.TaggedStruct("AskFor", {
  sessionID: Schema.String,
  from: From,
  question: Schema.String,
  header: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Choice)),
  assume: Schema.String,
})
export interface AskFor extends Schema.Schema.Type<typeof AskFor> {}

/** A plugin withdraws its question under `key`, open or answered: it no longer matters, or its answer was read. */
export const WithdrawFor = Schema.TaggedStruct("WithdrawFor", { from: From })
export interface WithdrawFor extends Schema.Schema.Type<typeof WithdrawFor> {}

/** The message `delivery` put its questions to their session: their letter is sent. */
export const LetterDelivered = Schema.TaggedStruct("LetterDelivered", { delivery: Schema.String })
export interface LetterDelivered extends Schema.Schema.Type<typeof LetterDelivered> {}

export type Command = Ask | AnswerQuestions | Dismiss | Delivered | AskFor | WithdrawFor | LetterDelivered

// ── Events ──

/** A question opened; one put to a session carries its letter, not yet sent. */
export const QuestionOpened = Schema.TaggedStruct("QuestionOpened", { question: Question, letter: Schema.optional(Letter) })
export interface QuestionOpened extends Schema.Schema.Type<typeof QuestionOpened> {}

export const LetterSent = Schema.TaggedStruct("LetterSent", { delivery: Schema.String })
export interface LetterSent extends Schema.Schema.Type<typeof LetterSent> {}

/** Why a question closed. */
export const Reason = Schema.Literals(["withdrawn", "superseded", "dropped", "dismissed", "delivered"])
export type Reason = typeof Reason.Type

/** A question closed; `to`, the session it was put to, for one that was, so that session can be told. */
export const QuestionClosed = Schema.TaggedStruct("QuestionClosed", { id: Schema.String, reason: Reason, to: Schema.optional(Schema.String) })
export interface QuestionClosed extends Schema.Schema.Type<typeof QuestionClosed> {}

export const QuestionAnswered = Schema.TaggedStruct("QuestionAnswered", {
  id: Schema.String,
  answer: Schema.String,
  delivery: Schema.String,
  /** Dismissed beside other answers: the message names it, and it closes as dismissed. */
  dismissed: Schema.optional(Schema.Literal(true)),
  via: Schema.optional(Via),
  /** Epoch ms. */
  at: Schema.optional(Schema.Number),
})
export interface QuestionAnswered extends Schema.Schema.Type<typeof QuestionAnswered> {}

export type Event = QuestionOpened | QuestionClosed | QuestionAnswered | LetterSent

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

/** A session answered questions not put to it, or not open: `ids` those, `held` the ones it may answer here. */
export class NotHeld extends Schema.TaggedError<NotHeld>()("NotHeld", { ids: Schema.Array(Schema.String), held: Schema.Array(Schema.String) }) {}

export type AskRejection = NothingAsked | InvalidQuestion | UnknownQuestion
export type ReplyRejection = NotOpen | EmptyAnswer | NotHeld
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
    const open = openOf(ownOf(state.rows))
    const withdraw = [...new Set(command.withdraw.map((id) => id.trim()))]
    const unknown = withdraw.filter((id) => !open.some((row) => row.id === id))
    if (unknown.length > 0) return yield* new UnknownQuestion({ ids: unknown, open: open.map((row) => row.id) })
    const withdrawn = withdraw.flatMap((id) => open.filter((row) => row.id === id).map((row) => closedOf(row, "withdrawn")))
    const left = open.filter((row) => !withdraw.includes(row.id))
    // Asked again: the open question with the same text gives way to the new one.
    const superseded = left.filter((row) => texts.includes(normalize(row.question))).map((row) => closedOf(row, "superseded"))
    const route = Option.fromNullishOr(command.route)
    const opened = asked.map((question, at) => openedOf({ id: `q${state.next + at}`, sessionID: command.sessionID, ...question, askedAt: now }, route))
    const kept = left.filter((row) => !superseded.some((event) => event.id === row.id))
    const over = Math.max(0, kept.length + opened.length - MAX_OPEN)
    const dropped = kept.slice(0, over).map((row) => closedOf(row, "dropped"))
    return [...withdrawn, ...superseded, ...dropped, ...opened]
  })

/** The event that closes `row`, naming the session it was put to when it was. */
const closedOf = (row: Row, reason: Reason): QuestionClosed =>
  Option.match(Option.fromNullishOr(row.to), {
    onNone: () => QuestionClosed.make({ id: row.id, reason }),
    onSome: (to) => QuestionClosed.make({ id: row.id, reason, to }),
  })

/** The event that opens `question`: the owner's, or put to the route's session with its letter not yet sent. */
const openedOf = (question: Question, route: Option.Option<Route>): QuestionOpened =>
  Option.match(route, {
    onNone: () => QuestionOpened.make({ question }),
    onSome: ({ to, letter, nudge }) => QuestionOpened.make({ question: { ...question, to }, letter: { delivery: letter, sent: false, nudge } }),
  })

/** With `by`, the ids answered or dismissed that are not open questions put to `by`, and those that are; none without `by`. */
const unheld = (state: Sheet, command: AnswerQuestions): Option.Option<NotHeld> =>
  Option.flatMap(Option.fromNullishOr(command.by), (by) => {
    const held = openOf(state.rows)
      .filter((row) => row.to === by)
      .map((row) => row.id)
    const ids = [...command.answers.map((given) => given.id.trim()), ...(command.dismissed ?? []).map((id) => id.trim())].filter((id) => !held.includes(id))
    return Option.liftPredicate(new NotHeld({ ids, held }), () => ids.length > 0)
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
export const decideAnswers = (state: Sheet, command: AnswerQuestions, now: number): Effect.Effect<ReadonlyArray<Event>, ReplyRejection> => {
  const recorded = { delivery: command.delivery, at: now, ...Option.getOrElse(Option.map(Option.fromUndefinedOr(command.via), (via) => ({ via })), () => ({})) }
  const empty = command.answers.find((given) => given.answer.trim() === "")
  if (empty !== undefined) return Effect.fail(new EmptyAnswer({ id: empty.id }))
  const refused = unheld(state, command)
  if (Option.isSome(refused)) return Effect.fail(refused.value)
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
        return [QuestionAnswered.make({ id: row.id, answer, ...recorded })]
      }
      return isDismissed(row) ? [QuestionAnswered.make({ id: row.id, answer: row.assume, ...recorded, dismissed: true })] : []
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
    ownOf(state.rows)
      .filter((row) => row.answered?.delivery === command.delivery)
      .map((row) => QuestionClosed.make({ id: row.id, reason: row.answered?.dismissed === true ? "dismissed" : "delivered" })),
  )

/** What a plugin's question records: it opens, unless the plugin has a row under its key already. */
export const decideAskFor = (state: Sheet, command: AskFor, now: number): Effect.Effect<ReadonlyArray<Event>, InvalidQuestion> =>
  Effect.gen(function* () {
    if (fromOf(state.rows, command.from.plugin).some((row) => row.from?.key === command.from.key)) return []
    const question = yield* validated(command, 0)
    return [QuestionOpened.make({ question: { id: `q${state.next}`, sessionID: command.sessionID, ...question, askedAt: now, from: command.from } })]
  })

/** What a plugin's withdrawal records: its row under the key closes, whether answered or not; none, nothing. */
export const decideWithdrawFor = (state: Sheet, command: WithdrawFor): Effect.Effect<ReadonlyArray<Event>> =>
  Effect.succeed(
    fromOf(state.rows, command.from.plugin)
      .filter((row) => row.from?.key === command.from.key)
      .map((row) => QuestionClosed.make({ id: row.id, reason: "withdrawn" })),
  )

/** What a letter's delivery records: the questions it put are sent; one seen before, or none open, records nothing. */
export const decideLetterDelivered = (state: Sheet, command: LetterDelivered): Effect.Effect<ReadonlyArray<Event>> =>
  Effect.succeed(
    Arr.filter([LetterSent.make({ delivery: command.delivery })], () => unsentOf(state.rows).some((row) => row.letter?.delivery === command.delivery)),
  )

/** The row with its letter marked sent, when the letter is `delivery`'s. */
const sentOf = (row: Row, delivery: string): Row =>
  Option.match(
    Option.filter(Option.fromNullishOr(row.letter), (letter) => letter.delivery === delivery),
    { onNone: () => row, onSome: (letter) => ({ ...row, letter: { ...letter, sent: true } }) },
  )

/** The row an opened question starts as: with its letter, when it is put to a session. */
const rowOf = (event: QuestionOpened): Row =>
  Option.match(Option.fromNullishOr(event.letter), { onNone: () => event.question, onSome: (letter) => ({ ...event.question, letter }) })

/** The answer a row keeps of `event`: what, under which message, and where and when when the event says. */
const answerOf = (event: QuestionAnswered): Answer => {
  const { _tag, id: _id, ...answer } = event
  return answer
}

export const Questions: Decider<Sheet, Command, Event, Rejection> = {
  initial: EMPTY,
  decide: (state, command, now) => {
    switch (command._tag) {
      case "Ask":
        return decideAsk(state, command, now)
      case "AnswerQuestions":
        return decideAnswers(state, command, now)
      case "Dismiss":
        return decideDismiss(state, command)
      case "Delivered":
        return decideDelivered(state, command)
      case "AskFor":
        return decideAskFor(state, command, now)
      case "WithdrawFor":
        return decideWithdrawFor(state, command)
      case "LetterDelivered":
        return decideLetterDelivered(state, command)
    }
  },
  evolve: (state, event) => {
    switch (event._tag) {
      case "QuestionOpened": {
        const number = Number(event.question.id.slice(1))
        return { next: Math.max(state.next, Number.isInteger(number) ? number + 1 : state.next), rows: [...state.rows, rowOf(event)] }
      }
      case "QuestionClosed":
        return { ...state, rows: state.rows.filter((row) => row.id !== event.id) }
      case "QuestionAnswered":
        return {
          ...state,
          rows: state.rows.map((row) =>
            row.id === event.id
              ? { ...row, answered: answerOf(event) }
              : row,
          ),
        }
      case "LetterSent":
        return { ...state, rows: state.rows.map((row) => sentOf(row, event.delivery)) }
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
 * - `askFor({ sessionID, plugin, key, question, header?, options?, assume })`:
 *   another plugin asks the owner in `sessionID` (the tray of its tree's
 *   root shows it), once per key; `Reply`.
 * - `asked({ plugin })`: that plugin's questions, open and answered, each with
 *   its key and, once given, its answer (`Asked`).
 * - `withdrawFor({ plugin, key })`: the plugin's question under `key` goes,
 *   open or answered (the plugin read its answer); `Reply`.
 * - `put({ sessionID, to, nudge, questions?, withdraw? })`: a subagent asks as
 *   `ask_user_async` does, but its questions are put to the session `to` (its
 *   orchestrator), which gets one letter per call carrying `nudge`; `Put`. The
 *   orchestrate plugin's `ask_orchestrator` calls it.
 * - `reply({ by, answers: [{ id, text }] })`: the session `by` answers questions
 *   put to it, each by its ref (`<asking session>:<id>`); each asker's go as one
 *   message, as the owner's would. A ref not open or not put to `by` refuses the
 *   whole call; `Reply`. The orchestrate plugin's `answer_subagent` calls it.
 * - `changed({ sessionID })`: published after every change to a session's questions.
 */
export const QUESTIONS = {
  id: "dotfiles-opencode.questions",
  methods: {
    askFor: {
      input: object(
        {
          sessionID: text,
          plugin: text,
          key: text,
          question: text,
          header: text,
          options: { type: "array", items: object({ label: text, description: text }, ["label"]) },
          assume: text,
        },
        ["sessionID", "plugin", "key", "question", "assume"],
      ),
      output: { type: "object" },
    },
    asked: { input: object({ plugin: text }, ["plugin"]), output: { type: "object" } },
    withdrawFor: { input: object({ plugin: text, key: text }, ["plugin", "key"]), output: { type: "object" } },
    open: { input: object({ sessionIDs: { type: "array", items: text } }, ["sessionIDs"]), output: { type: "object" } },
    answer: {
      input: object(
        { sessionID: text, answers: { type: "array", items: object({ id: text, answer: text }, ["id", "answer"]) }, via: { type: "string", enum: ["tray", "page"] } },
        ["sessionID", "answers"],
      ),
      output: { type: "object" },
    },
    dismiss: { input: object({ sessionID: text, id: text }, ["sessionID", "id"]), output: { type: "object" } },
    put: {
      input: object(
        {
          sessionID: text,
          to: text,
          nudge: text,
          questions: {
            type: "array",
            items: object(
              { question: text, header: text, options: { type: "array", items: object({ label: text, description: text }, ["label"]) }, assume: text },
              ["question", "assume"],
            ),
          },
          withdraw: { type: "array", items: text },
        },
        ["sessionID", "to", "nudge"],
      ),
      output: { type: "object" },
    },
    reply: {
      input: object({ by: text, answers: { type: "array", items: object({ id: text, text }, ["id", "text"]) } }, ["by", "answers"]),
      output: { type: "object" },
    },
  },
  events: {
    changed: { schema: { type: "object", properties: { sessionID: text }, required: ["sessionID"] } },
  },
} as const

/**
 * What `open` answers: the owner's open questions, and beside them, `held`, the open ones put to a session (each
 * naming it, `to`), which the owner does not answer unless they choose to.
 */
export const Open = Schema.Struct({ questions: Schema.Array(Question), held: Schema.optional(Schema.Array(Question)) })
export type Open = typeof Open.Type

/** What `put` answers: done, with what opened and closed, or why not. */
export const Put = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.optional(Schema.String),
  opened: Schema.optional(Schema.Array(Question)),
  closed: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, reason: Reason }))),
})
export type Put = typeof Put.Type

/** One question a plugin asked, as `asked` answers it: its session, id and key, and the answer once given. */
export const PluginQuestion = Schema.Struct({ sessionID: Schema.String, id: Schema.String, key: Schema.String, answer: Schema.optional(Schema.String) })
export type PluginQuestion = typeof PluginQuestion.Type

/** What `asked` answers. */
export const PluginAsked = Schema.Struct({ questions: Schema.Array(PluginQuestion) })
export type PluginAsked = typeof PluginAsked.Type

/** What `answer` and `dismiss` answer: done, or why not; `closed`: refused because none of them was open any more. */
export const Reply = Schema.Struct({ ok: Schema.Boolean, message: Schema.optional(Schema.String), closed: Schema.optional(Schema.Literal(true)) })
export type Reply = typeof Reply.Type

/** The event the server publishes on every change: its full type, as the TUI's event stream carries it. */
export const CHANGED = `rpc.${QUESTIONS.id}.changed`
