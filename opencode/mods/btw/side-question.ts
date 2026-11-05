// The SideQuestion aggregate: one per session, the fork its /btw opened last
// and the replies brought back from that fork. A fork opens with the first
// question (or none); follow-ups go to that fork while it is not replying;
// its newest reply comes back into the session once. A new /btw opens a new
// fork, which the session's side question follows from then on. The store
// keeps the folded state, keyed by the session.
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { forkName, QuestionEmpty, questionOf, QuestionTooLong } from "./question.ts"

/** The fork a session's /btw opened last. */
export const OpenFork = Schema.Struct({
  sessionID: Schema.String,
  name: Schema.String,
  /** When the host made the fork (epoch ms): its own messages are the ones from then on. */
  createdAt: Schema.Number,
  /** The replies of this fork already brought back, by message id. */
  broughtBack: Schema.Array(Schema.String),
})
export interface OpenFork extends Schema.Schema.Type<typeof OpenFork> {}

export const SideQuestionState = Schema.Struct({ fork: Schema.optionalKey(OpenFork) })
export interface SideQuestionState extends Schema.Schema.Type<typeof SideQuestionState> {}

export const INITIAL: SideQuestionState = {}

/** An exchange the fork answered, as the pane read it. */
export const Reply = Schema.Struct({ replyID: Schema.String, question: Schema.String, answer: Schema.String })

// ── Commands ──

/** The host made a fork of the session for a question (empty asks nothing yet). */
export const RecordFork = Schema.TaggedStruct("RecordFork", { sessionID: Schema.String, createdAt: Schema.Number, question: Schema.String })
export interface RecordFork extends Schema.Schema.Type<typeof RecordFork> {}

/** Ask the open fork a follow-up; `replying` is whether the fork is answering now. */
export const FollowUp = Schema.TaggedStruct("FollowUp", { question: Schema.String, replying: Schema.Boolean })
export interface FollowUp extends Schema.Schema.Type<typeof FollowUp> {}

/** Bring the open fork's newest reply back into the session; `reply` is that reply as read, if any. */
export const BringBack = Schema.TaggedStruct("BringBack", { replying: Schema.Boolean, reply: Schema.optionalKey(Reply) })
export interface BringBack extends Schema.Schema.Type<typeof BringBack> {}

export type Command = RecordFork | FollowUp | BringBack

// ── Events ──

/** The session's side question follows this fork from now on. */
export const ForkOpened = Schema.TaggedStruct("ForkOpened", { sessionID: Schema.String, name: Schema.String, createdAt: Schema.Number, question: Schema.String })
export interface ForkOpened extends Schema.Schema.Type<typeof ForkOpened> {}

/** A follow-up goes to the fork. */
export const FollowUpAsked = Schema.TaggedStruct("FollowUpAsked", { sessionID: Schema.String, question: Schema.String })
export interface FollowUpAsked extends Schema.Schema.Type<typeof FollowUpAsked> {}

/** The fork's reply goes into the session. */
export const ReplyBroughtBack = Schema.TaggedStruct("ReplyBroughtBack", {
  sessionID: Schema.String,
  replyID: Schema.String,
  question: Schema.String,
  answer: Schema.String,
})
export interface ReplyBroughtBack extends Schema.Schema.Type<typeof ReplyBroughtBack> {}

export type Event = ForkOpened | FollowUpAsked | ReplyBroughtBack

// ── Rejections ──

/** The session has opened no fork to ask or bring back from. */
export class NoFork extends Schema.TaggedError<NoFork>()("NoFork", {}) {}

/** The fork is still answering: one question at a time, and only a finished answer comes back. */
export class ForkBusy extends Schema.TaggedError<ForkBusy>()("ForkBusy", { sessionID: Schema.String }) {}

/** The fork has answered nothing yet. */
export class NoReply extends Schema.TaggedError<NoReply>()("NoReply", { sessionID: Schema.String }) {}

/** The fork's newest reply is already in the session. */
export class AlreadyBroughtBack extends Schema.TaggedError<AlreadyBroughtBack>()("AlreadyBroughtBack", {
  sessionID: Schema.String,
  replyID: Schema.String,
}) {}

export declare namespace RecordFork {
  export type Rejections = QuestionTooLong
}
export declare namespace FollowUp {
  export type Rejections = QuestionEmpty | QuestionTooLong | NoFork | ForkBusy
}
export declare namespace BringBack {
  export type Rejections = NoFork | ForkBusy | NoReply | AlreadyBroughtBack
}

export type Rejection = RecordFork.Rejections | FollowUp.Rejections | BringBack.Rejections

const recordFork = (command: RecordFork) =>
  questionOf(command.question).pipe(
    Effect.map((question): ReadonlyArray<Event> => [
      ForkOpened.make({ sessionID: command.sessionID, name: forkName(question), createdAt: command.createdAt, question }),
    ]),
  )

const followUp = (state: SideQuestionState, command: FollowUp) =>
  Effect.gen(function* () {
    const question = yield* questionOf(command.question)
    if (question.length === 0) return yield* new QuestionEmpty()
    if (state.fork === undefined) return yield* new NoFork()
    if (command.replying) return yield* new ForkBusy({ sessionID: state.fork.sessionID })
    return [FollowUpAsked.make({ sessionID: state.fork.sessionID, question })]
  })

const bringBack = (state: SideQuestionState, command: BringBack) =>
  Effect.gen(function* () {
    const fork = state.fork
    if (fork === undefined) return yield* new NoFork()
    if (command.replying) return yield* new ForkBusy({ sessionID: fork.sessionID })
    const reply = command.reply
    if (reply === undefined) return yield* new NoReply({ sessionID: fork.sessionID })
    if (fork.broughtBack.includes(reply.replyID)) return yield* new AlreadyBroughtBack({ sessionID: fork.sessionID, replyID: reply.replyID })
    return [ReplyBroughtBack.make({ sessionID: fork.sessionID, ...reply })]
  })

export const SideQuestion: Decider<SideQuestionState, Command, Event, Rejection> = {
  initial: INITIAL,
  decide: (state, command) => {
    switch (command._tag) {
      case "RecordFork":
        return recordFork(command)
      case "FollowUp":
        return followUp(state, command)
      case "BringBack":
        return bringBack(state, command)
    }
  },
  evolve: (state, event) => {
    switch (event._tag) {
      case "ForkOpened":
        return { fork: { sessionID: event.sessionID, name: event.name, createdAt: event.createdAt, broughtBack: [] } }
      case "FollowUpAsked":
        return state
      case "ReplyBroughtBack":
        return state.fork?.sessionID === event.sessionID
          ? { fork: { ...state.fork, broughtBack: [...state.fork.broughtBack, event.replyID] } }
          : state
    }
  },
}

/** What the reader is told when a side question is refused. */
export const explain = (rejection: Rejection): string => {
  switch (rejection._tag) {
    case "QuestionTooLong":
      return `btw: the question is ${rejection.chars} characters; ${rejection.limit} at most`
    case "QuestionEmpty":
      return "btw: type a question first"
    case "NoFork":
      return "btw: no side question here yet; ask one with /btw <question>"
    case "ForkBusy":
      return "btw: the fork is still answering; try again when it is done"
    case "NoReply":
      return "btw: the fork has no answer to bring back yet"
    case "AlreadyBroughtBack":
      return "btw: this answer is already brought back"
  }
}
