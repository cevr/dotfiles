// The owner's answer to a queue item. Pressing an item in the Queue tab opens
// the host's own question form (the one ask_user_async's /answer opens and
// OpenCode's `question` tool shows: the choices, a line to type an answer of
// one's own, one submit) with the item's choices, or this module's when the
// agent gave none. The server reads the submit off the host's `form.replied`
// event (`answersOf`) and sends the session that owns the queue one message
// (`letterOf`); the agent decides what follows. Pure.
//
// The form is the host's, so it is told apart by its field key:
// `queue:<root session id>:<item id>`, a prefix no host form and no
// ask_user_async form (`ask_user_async:`) uses. A session id holds no `:`; an
// item id may, so the root ends at the first.
import { Array as Arr, Option, Schema } from "effect"
import type { Choice, Item } from "./item.ts"

/** What a field key starts with. */
export const KEY_PREFIX = "queue:"
/** The form's title. */
export const TITLE = "Queue item"

/** What the owner can pick when the agent offered nothing. */
export const BUILT_INS: ReadonlyArray<Choice> = [
  { label: "Done / no longer needed", description: "Mark it done or remove it" },
  { label: "Still needed", description: "Keep it as it is" },
]

/** The answers an item offers: the agent's choices, else the built-ins. The host adds "Type your own answer" last. */
export const offered = (item: Pick<Item, "choices">): ReadonlyArray<Choice> =>
  Option.getOrElse(Option.filter(Option.fromNullishOr(item.choices), Arr.isReadonlyArrayNonEmpty), () => BUILT_INS)

/** A host form option: a choice, answering with its label. */
export interface FormOption extends Choice {
  readonly value: string
}

/** The form's one field, the shape the built-in question tool asks with: a string with choices and a custom answer. */
export interface FormField {
  readonly key: string
  readonly type: "string"
  readonly title: string
  readonly description: string
  readonly options: ReadonlyArray<FormOption>
  readonly custom: true
}

/** What `session.form.create` takes, but the session. */
export interface FormInput {
  readonly title: string
  readonly metadata: { readonly source: "queue" }
  readonly fields: readonly [FormField]
}

/**
 * The form for `item` of `root`'s queue: the item's text as the question,
 * `detail` (the item's whole block, as the Queue tab draws it) under it, and
 * what it offers as choices, each answering with its label.
 */
export const formOf = (root: string, item: Pick<Item, "id" | "text" | "choices">, detail: string = item.text): FormInput => ({
  title: TITLE,
  metadata: { source: "queue" },
  fields: [
    {
      key: `${KEY_PREFIX}${root}:${item.id}`,
      type: "string",
      title: item.text,
      description: detail,
      options: offered(item).map((choice) => ({ value: choice.label, ...choice })),
      custom: true,
    },
  ],
})

/** One answer a form's reply gives: to item `id` of `root`'s queue. */
export interface Answer {
  readonly root: string
  readonly id: string
  readonly answer: string
}

/** A value of a host form's reply (Form.Value in the fork). */
export type FormValue = string | number | boolean | ReadonlyArray<string>

const text = Schema.decodeUnknownOption(Schema.String)

/** The answer one key of a reply gives, when the key is ours and the answer has text. */
const answerOf = ([key, value]: readonly [string, FormValue]): Option.Option<Answer> =>
  Option.gen(function* () {
    const rest = yield* Option.map(
      Option.liftPredicate(key, (each) => each.startsWith(KEY_PREFIX)),
      (each) => each.slice(KEY_PREFIX.length),
    )
    const at = yield* Option.liftPredicate(rest.indexOf(":"), (index) => index > 0 && index < rest.length - 1)
    const answer = yield* Option.filter(Option.map(text(value), (each) => each.trim()), (each) => each !== "")
    return { root: rest.slice(0, at), id: rest.slice(at + 1), answer }
  })

/** The answers a host form's reply gives, when its keys are ours; a blank one is left out, another form's give none. */
export const answersOf = (answer: Readonly<Record<string, FormValue>>): ReadonlyArray<Answer> => Arr.getSomes(Object.entries(answer).map(answerOf))

/** The message the session that owns the queue gets. */
export const letterOf = (item: Pick<Item, "id" | "text">, answer: string): string => `Owner on queue item ${item.id} (${item.text}): ${answer}`

/** The notice row the message shows as in the transcript. */
export const noticeOf = (item: Pick<Item, "id">): string => `Queue answer: ${item.id}`
