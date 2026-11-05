// What the pane draws of a fork: its own exchanges, each question paired with
// the text that answered it (gent's forkTurns). A fork's own messages are the
// ones made after the fork was: the history it copied keeps the times it had
// in the session it came from (the fork's projector copies `time_created`,
// packages/core/src/session/projector.ts:214-221), the same rule the host's
// session stats use (packages/core/src/session/stats.ts:95).
//
// The messages come as the host stores them (packages/schema/src/
// session-message.ts): a `user` message carries the question as `text`; an
// `assistant` message is one step of the answer, its `content` holding text,
// reasoning and tool parts, with an `error` when the step failed. Only text
// parts are the answer; the fork's hidden note (a `synthetic` message) is
// never a turn.
import { Option, Schema } from "effect"
import { cut, oneLine } from "./question.ts"

/** One exchange on the fork. `answer` grows while the fork replies. */
export interface Turn {
  readonly question: string
  readonly answer: string
  /** The newest step that answered the question, when one has. */
  readonly replyID?: string
  /** Why the newest step failed, when it did. */
  readonly error?: string
}

/** The fork's newest answered exchange: what bringing it back sends. */
export interface Reply {
  readonly replyID: string
  readonly question: string
  readonly answer: string
}

const Created = Schema.Struct({ time: Schema.Struct({ created: Schema.Number }) })
const User = Schema.Struct({ type: Schema.Literal("user"), text: Schema.String })
const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const Assistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  id: Schema.String,
  content: Schema.Array(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
})
const decodeCreated = Schema.decodeUnknownOption(Created)
const decodeUser = Schema.decodeUnknownOption(User)
const decodeText = Schema.decodeUnknownOption(Text)
const decodeAssistant = Schema.decodeUnknownOption(Assistant)

/** Step texts of one answer, a blank line between them. */
const joinSteps = (answer: string, step: string): string => (step.length === 0 ? answer : answer.length === 0 ? step : `${answer}\n\n${step}`)

/** The messages made at or after `since` (epoch ms): the fork's own, not the history it copied. */
export const ownMessages = (messages: ReadonlyArray<unknown>, since: number): ReadonlyArray<unknown> =>
  messages.filter((message) => Option.exists(decodeCreated(message), (created) => created.time.created >= since))

/** Each question asked on the fork, oldest first, with the text that followed it. */
export const forkTurns = (messages: ReadonlyArray<unknown>, since: number): ReadonlyArray<Turn> =>
  ownMessages(messages, since).reduce<ReadonlyArray<Turn>>((turns, message) => {
    const user = decodeUser(message)
    if (Option.isSome(user)) return [...turns, { question: user.value.text, answer: "" }]
    const assistant = decodeAssistant(message)
    const last = turns.at(-1)
    if (Option.isNone(assistant) || last === undefined) return turns
    const step = assistant.value.content.flatMap((part) => Option.match(decodeText(part), { onNone: () => [], onSome: (text) => [text.text] })).join("")
    const error = assistant.value.error?.message
    const answered: Turn = {
      question: last.question,
      answer: joinSteps(last.answer, step),
      replyID: assistant.value.id,
      ...(error === undefined ? {} : { error }),
    }
    return [...turns.slice(0, -1), answered]
  }, [])

/** The newest exchange the fork answered with text, unless it is still replying. */
export const replyOf = (turns: ReadonlyArray<Turn>, replying: boolean): Option.Option<Reply> => {
  const last = turns.at(-1)
  if (replying || last?.replyID === undefined || last.answer.trim().length === 0) return Option.none()
  return Option.some({ replyID: last.replyID, question: last.question, answer: last.answer })
}

/** How many characters of a question the transcript's notice row shows. */
export const PREVIEW_CHARS = 120

/** One line of at most PREVIEW_CHARS characters, for a notice row. */
export const preview = (text: string): string => cut(oneLine(text), PREVIEW_CHARS)
