// The questions' handlers: ask, answer and dismiss through the Questions
// aggregate, read what is open, and send the answers recorded but not yet
// delivered. The answers of one submit share one message id and go as one
// message. Changes to the sheets are serialized; a delivery runs outside the
// lock, under the id recorded with its answers, so a repeated send puts one
// message in the session. Each change is announced through `Changes`.
import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { type Asked, type AskInput, commandOf } from "./ask.ts"
import {
  AnswerQuestions,
  type AskRejection,
  Delivered,
  decideAnswers,
  decideAsk,
  decideDelivered,
  decideDismiss,
  Dismiss,
  type Event,
  type Given,
  openOf,
  type Question,
  questionOf,
  Questions,
  type ReplyRejection,
  type Sheet,
} from "./question.ts"
import { type Answered, letterOf } from "./reply.ts"
import { Changes, Courier, type DeliveryRefused, QuestionStore, type QuestionsUnreadable } from "./service.ts"

export class QuestionsModel extends Context.Service<
  QuestionsModel,
  {
    /** The calling session asks and withdraws; what changed. */
    readonly ask: (sessionID: string, input: AskInput) => Effect.Effect<Asked, AskRejection | QuestionsUnreadable>
    /** The open questions of `sessionIDs`, oldest first. A sheet that cannot be read shows none. */
    readonly open: (sessionIDs: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Question>>
    /**
     * Record the answers given in one submit under one message id, then deliver
     * them as that one message; the questions close once it is delivered. The
     * questions `dismissed` in the submit ride in that message, or close at once
     * with no message when nothing was answered. What was answered, what was
     * dismissed, and the ids left out because they were no longer open.
     */
    readonly answer: (
      sessionID: string,
      answers: ReadonlyArray<Given>,
      dismissed?: ReadonlyArray<string>,
    ) => Effect.Effect<
      { readonly answered: ReadonlyArray<string>; readonly dismissed: ReadonlyArray<string>; readonly skipped: ReadonlyArray<string> },
      ReplyRejection | QuestionsUnreadable | DeliveryRefused
    >
    readonly dismiss: (sessionID: string, id: string) => Effect.Effect<void, ReplyRejection | QuestionsUnreadable>
    /** Send every answer recorded in a stored sheet and not yet delivered (a restart's leftovers); how many went. A sheet whose session is gone is removed. */
    readonly resend: Effect.Effect<number>
    readonly forget: (sessionID: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/questions/QuestionsModel") {}

export const layer = Layer.effect(
  QuestionsModel,
  Effect.gen(function* () {
    const store = yield* QuestionStore
    const courier = yield* Courier
    const changes = yield* Changes
    const lock = yield* Semaphore.make(1)

    /** Decide on the session's sheet and store what it records; the events. */
    const apply = <J,>(sessionID: string, decide: (sheet: Sheet, now: number) => Effect.Effect<ReadonlyArray<Event>, J>) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const sheet = yield* store.read(sessionID)
          const now = yield* Clock.currentTimeMillis
          const events = yield* decide(sheet, now)
          if (events.length === 0) return events
          yield* store.write(sessionID, fold(Questions, events, sheet))
          yield* changes.changed(sessionID)
          return events
        }),
      )

    /**
     * Deliver every batch of answers the session's sheet holds, oldest first,
     * each as one message under its recorded id, then close what it answered;
     * how many messages went.
     */
    const flush = Effect.fn("QuestionsModel.flush")(function* (sessionID: string) {
      const sheet = yield* store.read(sessionID)
      const batches = new Map<string, Array<Answered>>()
      for (const row of sheet.rows) {
        if (row.answered === undefined) continue
        const batch = batches.get(row.answered.delivery) ?? []
        batch.push({ question: questionOf(row), answer: row.answered.answer, ...(row.answered.dismissed === true ? { dismissed: true } : {}) })
        batches.set(row.answered.delivery, batch)
      }
      // Delivery ids ascend, so the older submit goes first.
      for (const delivery of [...batches.keys()].toSorted()) {
        yield* courier.deliver(sessionID, delivery, letterOf(batches.get(delivery) ?? []))
        yield* apply(sessionID, (current) => decideDelivered(current, Delivered.make({ delivery })))
      }
      return batches.size
    })

    return {
      ask: Effect.fn("QuestionsModel.ask")(function* (sessionID: string, input: AskInput) {
        const events = yield* apply(sessionID, (sheet, now) => decideAsk(sheet, commandOf(sessionID, input), now))
        return {
          opened: events.flatMap((event) => (event._tag === "QuestionOpened" ? [event.question] : [])),
          closed: events.flatMap((event) => (event._tag === "QuestionClosed" ? [{ id: event.id, reason: event.reason }] : [])),
        }
      }),
      open: Effect.fn("QuestionsModel.open")(function* (sessionIDs: ReadonlyArray<string>) {
        // Reading sends nothing: a recorded answer goes when it is given, again with the session's next answer, and at the plugin's start.
        const sheets = yield* Effect.forEach(sessionIDs, (sessionID) => store.read(sessionID).pipe(Effect.orElseSucceed(() => undefined)))
        return sheets
          .flatMap((sheet) => (sheet === undefined ? [] : openOf(sheet.rows).map(questionOf)))
          .toSorted((left, right) => left.askedAt - right.askedAt)
      }),
      answer: Effect.fn("QuestionsModel.answer")(function* (sessionID: string, answers: ReadonlyArray<Given>, dismissed: ReadonlyArray<string> = []) {
        const delivery = yield* courier.newDelivery
        const events = yield* apply(sessionID, (sheet) => decideAnswers(sheet, AnswerQuestions.make({ answers, dismissed, delivery })))
        const answered = events.flatMap((event) => (event._tag === "QuestionAnswered" && event.dismissed !== true ? [event.id] : []))
        const gone = events.flatMap((event) =>
          (event._tag === "QuestionAnswered" && event.dismissed === true) || (event._tag === "QuestionClosed" && event.reason === "dismissed") ? [event.id] : [],
        )
        // A submit that only dismissed sends nothing: the assumptions already stand.
        if (answered.length > 0) yield* flush(sessionID)
        const asked = [...answers.map((given) => given.id.trim()), ...dismissed.map((id) => id.trim())]
        return { answered, dismissed: gone, skipped: [...new Set(asked)].filter((id) => !answered.includes(id) && !gone.includes(id)) }
      }),
      dismiss: (sessionID, id) => apply(sessionID, (sheet) => decideDismiss(sheet, Dismiss.make({ id }))).pipe(Effect.asVoid),
      resend: Effect.gen(function* () {
        const sessions = yield* store.sessions
        const sent = yield* Effect.forEach(sessions, (sessionID) =>
          flush(sessionID).pipe(
            // A session deleted while no server ran has nobody to read its answers: its sheet goes.
            Effect.catchTag("DeliveryRefused", (refused) =>
              refused.gone ? lock.withPermits(1)(store.remove(sessionID)).pipe(Effect.as(0)) : Effect.fail(refused),
            ),
            Effect.catchCause((cause) => Effect.logWarning("questions: a recorded answer was not sent", { sessionID, cause }).pipe(Effect.as(0))),
          ),
        )
        return sent.reduce((sum, count) => sum + count, 0)
      }),
      forget: (sessionID) => lock.withPermits(1)(store.remove(sessionID)).pipe(Effect.andThen(changes.changed(sessionID))),
    }
  }),
)
