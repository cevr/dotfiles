// The words a background-question call's row shows (group.ts
// BACKGROUND_QUESTIONS): an ask (`ask_user_async`, `ask_orchestrator`) by its
// first question, else the ids it withdraws; an answer (`answer_subagent`) by
// its first ref and answer, as `<ref>: <answer>`. None for any other tool, or
// an input that is neither.
import { Option, Schema } from "effect"
import type { Fields } from "./session.ts"

const Ask = Schema.Struct({
  questions: Schema.optional(Schema.Array(Schema.Struct({ question: Schema.String }))),
  withdraw: Schema.optional(Schema.Array(Schema.String)),
})
const Answer = Schema.Struct({ answers: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })) })

const ASKS = new Set(["ask_user_async", "ask_orchestrator"])
const ANSWER = "answer_subagent"

const askWords = (input: Fields) =>
  Option.flatMap(Schema.decodeUnknownOption(Ask)(input), (ask) =>
    Option.orElse(Option.fromNullishOr(ask.questions?.[0]?.question), () =>
      Option.map(Option.liftPredicate(ask.withdraw ?? [], (ids) => ids.length > 0), (ids) => `withdraw ${ids.join(", ")}`),
    ),
  )

const answerWords = (input: Fields) =>
  Option.flatMap(Schema.decodeUnknownOption(Answer)(input), (answer) => Option.map(Option.fromNullishOr(answer.answers[0]), (first) => `${first.id}: ${first.text}`))

/** The row's words for a background-question call; none for another tool. */
export const questionSource = (tool: string, input: Fields): Option.Option<string> =>
  Option.orElse(
    Option.flatMap(Option.liftPredicate(tool, (name) => ASKS.has(name)), () => askWords(input)),
    () => Option.flatMap(Option.liftPredicate(tool, (name) => name === ANSWER), () => answerWords(input)),
  )
