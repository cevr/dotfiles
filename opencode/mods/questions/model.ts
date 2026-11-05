// The questions' handlers: ask, answer and dismiss through the Questions
// aggregate, read what is open, and send the answers recorded but not yet
// delivered. Changes to the sheets are serialized; a delivery runs outside the
// lock, under the id recorded with its answer, so a repeated send puts one
// message in the session. Each change is announced through `Changes`.
import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { type Asked, type AskInput, commandOf } from "./ask.ts"
import {
  AnswerQuestion,
  type AskRejection,
  Delivered,
  decideAnswer,
  decideAsk,
  decideDelivered,
  decideDismiss,
  Dismiss,
  type Event,
  openOf,
  type Question,
  questionOf,
  Questions,
  type ReplyRejection,
  type Sheet,
} from "./question.ts"
import { letterOf } from "./reply.ts"
import { Changes, Courier, type DeliveryRefused, QuestionStore, type QuestionsUnreadable } from "./service.ts"

export class QuestionsModel extends Context.Service<
  QuestionsModel,
  {
    /** The calling session asks and withdraws; what changed. */
    readonly ask: (sessionID: string, input: AskInput) => Effect.Effect<Asked, AskRejection | QuestionsUnreadable>
    /** The open questions of `sessionIDs`, oldest first, after sending their recorded answers. A sheet that cannot be read shows none. */
    readonly open: (sessionIDs: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Question>>
    /** Record the answer, then deliver it; the question closes once it is delivered. */
    readonly answer: (sessionID: string, id: string, answer: string) => Effect.Effect<void, ReplyRejection | QuestionsUnreadable | DeliveryRefused>
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

    /** Deliver every answer the session's sheet holds, each under its recorded id, then close what was delivered. */
    const flush = Effect.fn("QuestionsModel.flush")(function* (sessionID: string) {
      const sheet = yield* store.read(sessionID)
      let sent = 0
      for (const row of sheet.rows) {
        const answered = row.answered
        if (answered === undefined) continue
        yield* courier.deliver(sessionID, answered.delivery, letterOf(questionOf(row), answered.answer))
        yield* apply(sessionID, (current) => decideDelivered(current, Delivered.make({ delivery: answered.delivery })))
        sent += 1
      }
      return sent
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
        const sheets = yield* Effect.forEach(
          sessionIDs,
          (sessionID) =>
            // An answer recorded and not yet sent goes first: the reader no longer sees its question, so nothing else would send it.
            flush(sessionID).pipe(
              Effect.ignore,
              Effect.andThen(store.read(sessionID)),
              Effect.orElseSucceed(() => undefined),
            ),
        )
        return sheets
          .flatMap((sheet) => (sheet === undefined ? [] : openOf(sheet.rows).map(questionOf)))
          .toSorted((left, right) => left.askedAt - right.askedAt)
      }),
      answer: Effect.fn("QuestionsModel.answer")(function* (sessionID: string, id: string, answer: string) {
        const delivery = yield* courier.newDelivery
        yield* apply(sessionID, (sheet) => decideAnswer(sheet, AnswerQuestion.make({ id, answer, delivery })))
        yield* flush(sessionID)
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
