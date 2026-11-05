import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Story from "@dotfiles/decider/story"
import { MAXIMUM_QUESTION_CHARS, QuestionEmpty, QuestionTooLong } from "./question.ts"
import {
  AlreadyBroughtBack,
  BringBack,
  explain,
  FollowUp,
  FollowUpAsked,
  ForkBusy,
  ForkOpened,
  NoFork,
  NoReply,
  RecordFork,
  ReplyBroughtBack,
  type Event,
  type Rejection,
  SideQuestion,
} from "./side-question.ts"

const story = Story.make(SideQuestion)
const run = (...steps: Parameters<typeof story>) => Effect.runPromise(story(...steps))

const opened = ForkOpened.make({ sessionID: "ses_fork", name: "btw: why is the build slow?", createdAt: 10, question: "why is the build slow?" })
const reply = { replyID: "msg_r1", question: "why is the build slow?", answer: "The cache is cold." }
const broughtBack = ReplyBroughtBack.make({ sessionID: "ses_fork", ...reply })

describe("RecordFork", () => {
  test("opens the fork, named after the question on one line", () =>
    run(
      Story.when(RecordFork.make({ sessionID: "ses_fork", createdAt: 10, question: "  why is the build slow?\n" })),
      Story.then(opened),
      Story.state({ fork: { sessionID: "ses_fork", name: "btw: why is the build slow?", createdAt: 10, broughtBack: [] } }),
    ))

  test("a fork asked nothing is named btw", () =>
    run(
      Story.when(RecordFork.make({ sessionID: "ses_fork", createdAt: 10, question: "" })),
      Story.then(ForkOpened.make({ sessionID: "ses_fork", name: "btw", createdAt: 10, question: "" })),
    ))

  test("a new fork replaces the one before, its brought-back replies with it", () =>
    run(
      Story.given<Event>(opened, broughtBack),
      Story.when(RecordFork.make({ sessionID: "ses_fork2", createdAt: 20, question: "and the tests?" })),
      Story.then(ForkOpened.make({ sessionID: "ses_fork2", name: "btw: and the tests?", createdAt: 20, question: "and the tests?" })),
      Story.state({ fork: { sessionID: "ses_fork2", name: "btw: and the tests?", createdAt: 20, broughtBack: [] } }),
    ))

  test("refuses a question longer than the limit", () =>
    run(
      Story.when(RecordFork.make({ sessionID: "ses_fork", createdAt: 10, question: "x".repeat(MAXIMUM_QUESTION_CHARS + 1) })),
      Story.rejected(new QuestionTooLong({ chars: MAXIMUM_QUESTION_CHARS + 1, limit: MAXIMUM_QUESTION_CHARS })),
    ))
})

describe("FollowUp", () => {
  test("asks the open fork, trimmed", () =>
    run(
      Story.given(opened),
      Story.when(FollowUp.make({ question: " and the tests? ", replying: false })),
      Story.then(FollowUpAsked.make({ sessionID: "ses_fork", question: "and the tests?" })),
    ))

  test("refuses while the fork is answering: one question at a time", () =>
    run(Story.given(opened), Story.when(FollowUp.make({ question: "and?", replying: true })), Story.rejected(new ForkBusy({ sessionID: "ses_fork" }))))

  test("refuses with no fork", () => run(Story.when(FollowUp.make({ question: "and?", replying: false })), Story.rejected(new NoFork())))

  test("refuses an empty follow-up", () =>
    run(Story.given(opened), Story.when(FollowUp.make({ question: "   ", replying: false })), Story.rejected(new QuestionEmpty())))
})

describe("BringBack", () => {
  test("brings the newest reply back once", () =>
    run(
      Story.given(opened),
      Story.when(BringBack.make({ replying: false, reply })),
      Story.then(broughtBack),
      Story.state({ fork: { sessionID: "ses_fork", name: "btw: why is the build slow?", createdAt: 10, broughtBack: ["msg_r1"] } }),
      Story.when(BringBack.make({ replying: false, reply })),
      Story.rejected(new AlreadyBroughtBack({ sessionID: "ses_fork", replyID: "msg_r1" })),
    ))

  test("a later reply of the same fork comes back too", () =>
    run(
      Story.given<Event>(opened, broughtBack),
      Story.when(BringBack.make({ replying: false, reply: { replyID: "msg_r2", question: "and?", answer: "Yes." } })),
      Story.then(ReplyBroughtBack.make({ sessionID: "ses_fork", replyID: "msg_r2", question: "and?", answer: "Yes." })),
    ))

  test("refuses while the fork answers, before it answers, and with no fork", () =>
    run(
      Story.when(BringBack.make({ replying: false, reply })),
      Story.rejected(new NoFork()),
      Story.given(opened),
      Story.when(BringBack.make({ replying: true, reply })),
      Story.rejected(new ForkBusy({ sessionID: "ses_fork" })),
      Story.when(BringBack.make({ replying: false })),
      Story.rejected(new NoReply({ sessionID: "ses_fork" })),
    ))
})

test("every rejection explains itself to the reader on one line", () => {
  const rejections: ReadonlyArray<Rejection> = [
    new QuestionTooLong({ chars: 9000, limit: 8000 }),
    new QuestionEmpty(),
    new NoFork(),
    new ForkBusy({ sessionID: "s" }),
    new NoReply({ sessionID: "s" }),
    new AlreadyBroughtBack({ sessionID: "s", replyID: "r" }),
  ]
  const lines = rejections.map(explain)
  for (const line of lines) expect(line).toMatch(/^btw: [^\n]+$/)
  expect(new Set(lines).size).toBe(lines.length)
  expect(lines[0]).toBe("btw: the question is 9000 characters; 8000 at most")
})
