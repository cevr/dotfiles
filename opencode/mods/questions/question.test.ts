import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Story from "@dotfiles/decider/story"
import {
  Ask,
  AnswerQuestions,
  Delivered,
  Dismiss,
  EMPTY,
  type Event,
  EmptyAnswer,
  InvalidQuestion,
  matches,
  NotOpen,
  NothingAsked,
  type Question,
  QuestionAnswered,
  QuestionClosed,
  QuestionOpened,
  Questions,
  UnknownQuestion,
} from "./question.ts"

const story = Story.make(Questions)
const NOW = "2026-11-05T15:00:00Z"
const AT = Date.parse(NOW)

const port: Question = { id: "q1", sessionID: "ses_a", question: "Which port should the dev server use?", header: "Port", options: [{ label: "8080" }, { label: "3000" }], assume: "8080", askedAt: AT }
const flag: Question = { id: "q2", sessionID: "ses_a", question: "Keep the --legacy flag?", assume: "yes", askedAt: AT }
const asked = (id: string, question: string): Question => ({ id, sessionID: "ses_a", question, assume: "no", askedAt: AT })
const ask = (questions: Ask["questions"], withdraw: ReadonlyArray<string> = []) => Ask.make({ sessionID: "ses_a", questions, withdraw })

describe("Ask", () => {
  test("opens each question as q<n> in the asking session, at the clock, its text kept on one line", () =>
    Effect.runPromise(
      story(
        Story.clock(NOW),
        Story.when(
          ask([
            { question: "Which port should the dev server use?", header: " Port ", options: [{ label: "8080" }, { label: " 3000 ", description: "  " }], assume: " 8080 " },
            { question: "Keep the --legacy flag?", assume: "yes" },
          ]),
        ),
        Story.then<Event>(QuestionOpened.make({ question: port }), QuestionOpened.make({ question: flag })),
        Story.state({ next: 3, rows: [port, flag] }),
      ),
    ))

  test("numbers carry on after questions close", () =>
    Effect.runPromise(
      story(
        Story.given<Event>(QuestionOpened.make({ question: port }), QuestionClosed.make({ id: "q1", reason: "dismissed" })),
        Story.clock(NOW),
        Story.when(ask([{ question: "Keep the --legacy flag?", assume: "yes" }])),
        Story.then<Event>(QuestionOpened.make({ question: flag })),
      ),
    ))

  test("asking the same question again, in other case and spacing, replaces the open one", () =>
    Effect.runPromise(
      story(
        Story.given<Event>(QuestionOpened.make({ question: port })),
        Story.clock(NOW),
        Story.when(ask([{ question: "which port  should the dev server use?", assume: "3000" }])),
        Story.then<Event>(
          QuestionClosed.make({ id: "q1", reason: "superseded" }),
          QuestionOpened.make({ question: { id: "q2", sessionID: "ses_a", question: "which port  should the dev server use?", assume: "3000", askedAt: AT } }),
        ),
      ),
    ))

  test("past eight open, the oldest drop", () => {
    const eight = Array.from({ length: 8 }, (_, at) => asked(`q${at + 1}`, `Question ${at + 1}?`))
    return Effect.runPromise(
      story(
        Story.given<Event>(...eight.map((question) => QuestionOpened.make({ question }))),
        Story.clock(NOW),
        Story.when(ask([{ question: "Ninth?", assume: "no" }, { question: "Tenth?", assume: "no" }])),
        Story.then<Event>(
          QuestionClosed.make({ id: "q1", reason: "dropped" }),
          QuestionClosed.make({ id: "q2", reason: "dropped" }),
          QuestionOpened.make({ question: asked("q9", "Ninth?") }),
          QuestionOpened.make({ question: asked("q10", "Tenth?") }),
        ),
      ),
    )
  })

  test("withdraws open questions, alone or with new ones", () =>
    Effect.runPromise(
      story(
        Story.given<Event>(QuestionOpened.make({ question: port }), QuestionOpened.make({ question: flag })),
        Story.clock(NOW),
        Story.when(ask([], ["q1"])),
        Story.then<Event>(QuestionClosed.make({ id: "q1", reason: "withdrawn" })),
        Story.when(ask([{ question: "Ninth?", assume: "no" }], [" q2 "])),
        Story.then<Event>(QuestionClosed.make({ id: "q2", reason: "withdrawn" }), QuestionOpened.make({ question: asked("q3", "Ninth?") })),
        Story.state({ next: 4, rows: [asked("q3", "Ninth?")] }),
      ),
    ))

  test("refuses to withdraw a question that is not open, naming what is", () =>
    Effect.runPromise(
      story(
        Story.given<Event>(QuestionOpened.make({ question: port })),
        Story.when(ask([{ question: "Ninth?", assume: "no" }], ["q7"])),
        Story.rejected(new UnknownQuestion({ ids: ["q7"], open: ["q1"] })),
      ),
    ))

  test("refuses a call that asks nothing, or more than three", () =>
    Effect.runPromise(
      story(
        Story.when(ask([])),
        Story.rejected(new NothingAsked({ reason: "give questions to ask, or ids to withdraw" })),
        Story.when(ask(Array.from({ length: 4 }, (_, at) => ({ question: `Q${at}?`, assume: "no" })))),
        Story.rejected(new NothingAsked({ reason: "ask at most 3 questions in one call" })),
      ),
    ))

  for (const [question, reason] of [
    [{ question: "  ", assume: "no" }, "the question is empty"],
    [{ question: "Port?", assume: " " }, "assume is empty: say what you do until an answer arrives"],
    [{ question: "Port?", header: "x".repeat(31), assume: "no" }, "the header is longer than 30 characters"],
    [{ question: "Port?", options: ["a", "b", "c", "d", "e"].map((label) => ({ label })), assume: "a" }, "more than 4 options"],
    [{ question: "Port?", options: [{ label: " " }], assume: "a" }, "an option has no label"],
    [{ question: "Port?", options: [{ label: "Yes" }, { label: "yes " }], assume: "yes" }, "two options share a label"],
  ] as const)
    test(`refuses a question when ${reason}, naming which`, () =>
      Effect.runPromise(
        story(
          Story.when(ask([{ question: "Fine?", assume: "yes" }, question])),
          Story.rejected(new InvalidQuestion({ index: 2, reason })),
        ),
      ))

  test("refuses one question asked twice in one call", () =>
    Effect.runPromise(
      story(
        Story.when(ask([{ question: "Port?", assume: "a" }, { question: "port? ", assume: "b" }])),
        Story.rejected(new InvalidQuestion({ index: 2, reason: "the same question is asked twice in one call" })),
      ),
    ))
})

const answer = (delivery: string, ...answers: ReadonlyArray<readonly [string, string]>) =>
  AnswerQuestions.make({ answers: answers.map(([id, text]) => ({ id, answer: text })), delivery })

describe("AnswerQuestions, Dismiss and Delivered", () => {
  test("an answer is recorded with its message id; the question leaves the open list once delivered", () =>
    Effect.runPromise(
      story(
        Story.given<Event>(QuestionOpened.make({ question: port })),
        Story.when(answer("msg_1", ["q1", " 3000 "])),
        Story.then<Event>(QuestionAnswered.make({ id: "q1", answer: "3000", delivery: "msg_1" })),
        Story.state({ next: 2, rows: [{ ...port, answered: { answer: "3000", delivery: "msg_1" } }] }),
        Story.when(answer("msg_2", ["q1", "8080"])),
        Story.rejected(new NotOpen({ id: "q1" })),
        Story.when(Delivered.make({ delivery: "msg_1" })),
        Story.then<Event>(QuestionClosed.make({ id: "q1", reason: "delivered" })),
        Story.state({ next: 2, rows: [] }),
        Story.when(Delivered.make({ delivery: "msg_1" })),
        Story.then<Event>(),
      ),
    ))

  test("refuses an empty answer and an answer to a question never asked", () =>
    Effect.runPromise(
      story(
        Story.given<Event>(QuestionOpened.make({ question: port })),
        Story.when(answer("msg_1", ["q1", "  "])),
        Story.rejected(new EmptyAnswer({ id: "q1" })),
        Story.when(answer("msg_1", ["q9", "yes"])),
        Story.rejected(new NotOpen({ id: "q9" })),
      ),
    ))

  test("one submit records every answer under one message id, in the order asked; one delivery closes them all", () =>
    Effect.runPromise(
      story(
        Story.given<Event>(QuestionOpened.make({ question: port }), QuestionOpened.make({ question: flag }), QuestionOpened.make({ question: asked("q3", "Third?") })),
        Story.when(answer("msg_1", ["q3", "yes"], ["q1", "3000"], ["q1", "again"])),
        Story.then<Event>(
          QuestionAnswered.make({ id: "q1", answer: "3000", delivery: "msg_1" }),
          QuestionAnswered.make({ id: "q3", answer: "yes", delivery: "msg_1" }),
        ),
        Story.when(Delivered.make({ delivery: "msg_1" })),
        Story.then<Event>(QuestionClosed.make({ id: "q1", reason: "delivered" }), QuestionClosed.make({ id: "q3", reason: "delivered" })),
        // The one left blank stays open.
        Story.state({ next: 4, rows: [flag] }),
      ),
    ))

  test("a submit leaves out a question no longer open, and is refused when nothing it answers is open", () =>
    Effect.runPromise(
      story(
        Story.given<Event>(QuestionOpened.make({ question: port }), QuestionOpened.make({ question: flag }), QuestionClosed.make({ id: "q2", reason: "withdrawn" })),
        Story.when(answer("msg_1", ["q2", "no"], ["q1", "3000"])),
        Story.then<Event>(QuestionAnswered.make({ id: "q1", answer: "3000", delivery: "msg_1" })),
        Story.when(answer("msg_2", ["q2", "no"])),
        Story.rejected(new NotOpen({ id: "q2" })),
      ),
    ))

  test("dismiss closes an open question; a second dismiss is refused", () =>
    Effect.runPromise(
      story(
        Story.given<Event>(QuestionOpened.make({ question: port })),
        Story.when(Dismiss.make({ id: "q1" })),
        Story.then<Event>(QuestionClosed.make({ id: "q1", reason: "dismissed" })),
        Story.when(Dismiss.make({ id: "q1" })),
        Story.rejected(new NotOpen({ id: "q1" })),
        Story.state({ ...EMPTY, next: 2 }),
      ),
    ))

  test("an answered question waiting for delivery can no longer be withdrawn or dismissed", () =>
    Effect.runPromise(
      story(
        Story.given<Event>(QuestionOpened.make({ question: port }), QuestionAnswered.make({ id: "q1", answer: "3000", delivery: "msg_1" })),
        Story.when(Dismiss.make({ id: "q1" })),
        Story.rejected(new NotOpen({ id: "q1" })),
        Story.when(ask([], ["q1"])),
        Story.rejected(new UnknownQuestion({ ids: ["q1"], open: [] })),
      ),
    ))
})

test("an answer matches its assumption regardless of case and spacing", () => {
  expect(matches(" Yes ", "yes")).toBe(true)
  expect(matches("use  8080", "Use 8080")).toBe(true)
  expect(matches("3000", "8080")).toBe(false)
})
