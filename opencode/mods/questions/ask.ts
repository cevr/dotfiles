// The `ask_user_async` tool as the agent sees it: its input, its description,
// what it answers (the agent carries on, on its assumption) and what it reads
// when a call is refused.
import { Schema } from "effect"
import { Ask, Choice, MAX_ASKED, MAX_HEADER, MAX_OPEN, MAX_OPTIONS, type Question, type Reason, type Rejection } from "./question.ts"

export const NAME = "ask_user_async"

export const AskedQuestion = Schema.Struct({
  question: Schema.String.annotate({ description: "The question, self-contained: the user reads it later, maybe in another context" }),
  header: Schema.optional(Schema.String).annotate({ description: `A short label for the question (at most ${MAX_HEADER} characters)` }),
  options: Schema.optional(Schema.Array(Choice)).annotate({ description: `At most ${MAX_OPTIONS} choices; the user may also type their own answer` }),
  assume: Schema.String.annotate({ description: "What you do until an answer arrives. You continue on it now" }),
})

export const AskInput = Schema.Struct({
  questions: Schema.optional(Schema.Array(AskedQuestion)).annotate({ description: `1-${MAX_ASKED} questions to ask in the background` }),
  withdraw: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Ids of your open questions that no longer matter (q1, q2, …); they leave the user's tray",
  }),
})
export type AskInput = typeof AskInput.Type

export const DESCRIPTION = [
  "Ask the user questions in the background and continue at once on a stated assumption. Returns immediately; your turn does not wait, and an unanswered question never blocks you.",
  "The user sees the open questions in a tray above the prompt and answers them with /answer when they choose. An answer arrives later as a message in this session (it wakes you if you are idle), naming the question, your assumption and the answer, and saying whether they differ; when they differ, revise the work that rests on the assumption.",
  "Use it when you can go on with a reasonable assumption; when you cannot, ask in your reply and stop. While a question is open, state its assumption in your final answer. Asking the same question again replaces the open one; withdraw a question that no longer matters with withdraw: [id]. " +
    `At most ${MAX_OPEN} stay open; past that the oldest drops.`,
].join("\n\n")

/** The command a call asks for, in the calling session. */
export const commandOf = (sessionID: string, input: AskInput): Ask =>
  Ask.make({ sessionID, questions: input.questions ?? [], withdraw: input.withdraw ?? [] })

/** What the call changed, as the tool reports it. */
export interface Asked {
  readonly opened: ReadonlyArray<Question>
  readonly closed: ReadonlyArray<{ readonly id: string; readonly reason: Reason }>
}

const CLOSED: Partial<Record<Reason, string>> = {
  withdrawn: "Withdrew",
  superseded: "Replaced (asked again)",
  dropped: `Dropped (more than ${MAX_OPEN} open)`,
}

/** What the agent reads after a call: the ids, the assumptions, and that it goes on. */
export const receipt = (asked: Asked): string => {
  const lines: Array<string> = []
  if (asked.opened.length > 0) {
    lines.push("Asked in the background; nobody has answered yet:")
    for (const question of asked.opened) lines.push(`- ${question.id}: ${question.question} · assuming ${question.assume}`)
  }
  for (const [reason, verb] of Object.entries(CLOSED)) {
    const ids = asked.closed.filter((closed) => closed.reason === reason).map((closed) => closed.id)
    if (ids.length > 0) lines.push(`${verb}: ${ids.join(", ")}.`)
  }
  if (asked.opened.length > 0)
    lines.push(
      "Continue on your assumption now. An answer arrives as a message in this session if the user gives one; if it differs from your assumption, revise the work that rests on it.",
    )
  return lines.join("\n")
}

/** What the agent reads when a call is refused. */
export const explain = (rejection: Rejection): string => {
  switch (rejection._tag) {
    case "NothingAsked":
      return `Nothing asked: ${rejection.reason}.`
    case "InvalidQuestion":
      return `Question ${rejection.index}: ${rejection.reason}. Nothing was asked.`
    case "UnknownQuestion":
      return `No open question ${rejection.ids.join(", ")} to withdraw. Open: ${rejection.open.join(", ") || "none"}. Nothing was asked.`
    case "NotOpen":
      return `Question ${rejection.id} is not open.`
    case "EmptyAnswer":
      return `The answer to ${rejection.id} is empty.`
  }
}
