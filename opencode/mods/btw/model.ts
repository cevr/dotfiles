// The btw handlers: read the session's side question from the store, gather
// what the fork reads as, send the command to the SideQuestion aggregate,
// carry out what it records on the host, then store the state it folds to.
import { Clock, Context, Effect, Layer, Option } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { bringBackDescription, bringBackID, bringBackText } from "./bring-back.ts"
import { forkNote, questionOf } from "./question.ts"
import { ForkReadings, Forks, type HostFailed, type Reading, SideQuestions } from "./service.ts"
import { BringBack, FollowUp, NoFork, type OpenFork, RecordFork, type Rejection, SideQuestion, type SideQuestionState } from "./side-question.ts"
import { replyOf } from "./turns.ts"

export class Btw extends Context.Service<
  Btw,
  {
    /**
     * /btw in a session. A question forks the session as it is now and asks
     * the fork; with no question, the fork the session opened last opens
     * again, or, when there is none, a fork opens asking nothing. The fork
     * the side question follows from then on.
     */
    readonly ask: (sessionID: string, question: string) => Effect.Effect<OpenFork, Rejection | HostFailed>
    /** A follow-up typed into the pane, for the session's open fork. */
    readonly followUp: (sessionID: string, question: string) => Effect.Effect<void, Rejection | HostFailed>
    /** Brings the open fork's newest reply back into the session. */
    readonly bringBack: (sessionID: string) => Effect.Effect<void, Rejection | HostFailed>
    /** What the session's open fork reads as now: no turns when it has none. */
    readonly read: (sessionID: string) => Effect.Effect<Reading>
  }
>()("dotfiles-opencode/btw/Btw") {}

export const layer = Layer.effect(
  Btw,
  Effect.gen(function* () {
    const forks = yield* Forks
    const readings = yield* ForkReadings
    const store = yield* SideQuestions

    const decide = (state: SideQuestionState, command: RecordFork | FollowUp | BringBack) =>
      Clock.currentTimeMillis.pipe(Effect.flatMap((now) => SideQuestion.decide(state, command, now)))

    const reading = (state: SideQuestionState): Effect.Effect<Reading> =>
      state.fork === undefined ? Effect.succeed({ turns: [], replying: false }) : readings.read(state.fork)

    return {
      ask: Effect.fn("Btw.ask")(function* (sessionID: string, raw: string) {
        const question = yield* questionOf(raw)
        const state = yield* store.get(sessionID)
        if (question.length === 0 && state.fork !== undefined) return state.fork
        const made = yield* forks.fork(sessionID)
        const events = yield* decide(state, RecordFork.make({ sessionID: made.sessionID, createdAt: made.createdAt, question }))
        const next = fold(SideQuestion, events, state)
        yield* store.set(sessionID, next)
        // ForkOpened always opens one; the check keeps the type honest.
        const fork = next.fork
        if (fork === undefined) return yield* new NoFork()
        yield* forks.name(fork.sessionID, fork.name)
        if (question.length > 0) yield* forks.ask(fork.sessionID, forkNote(sessionID), question)
        return fork
      }),
      followUp: Effect.fn("Btw.followUp")(function* (sessionID: string, question: string) {
        const state = yield* store.get(sessionID)
        const { turns, replying } = yield* reading(state)
        const events = yield* decide(state, FollowUp.make({ question, replying }))
        // The note frames the fork once, with its first question; a fork opened asking nothing gets it here.
        const note = turns.length === 0 ? forkNote(sessionID) : undefined
        for (const event of events) if (event._tag === "FollowUpAsked") yield* forks.ask(event.sessionID, note, event.question)
      }),
      bringBack: Effect.fn("Btw.bringBack")(function* (sessionID: string) {
        const state = yield* store.get(sessionID)
        const { turns, replying } = yield* reading(state)
        const reply = Option.getOrUndefined(replyOf(turns, replying))
        const events = yield* decide(state, BringBack.make({ replying, ...(reply === undefined ? {} : { reply }) }))
        for (const event of events)
          if (event._tag === "ReplyBroughtBack" && state.fork !== undefined)
            yield* forks.bringBack(sessionID, {
              id: bringBackID(event.replyID),
              text: bringBackText(state.fork, event),
              description: bringBackDescription(event),
            })
        yield* store.set(sessionID, fold(SideQuestion, events, state))
      }),
      read: Effect.fn("Btw.read")(function* (sessionID: string) {
        return yield* reading(yield* store.get(sessionID))
      }),
    }
  }),
)
