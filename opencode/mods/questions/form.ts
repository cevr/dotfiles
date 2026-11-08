// The /answer form: one session's open questions in the host's own question
// form (the one OpenCode's `question` tool shows: a tab per question, its
// choices, a line to type an answer of one's own, one submit). The TUI opens
// it through the host's `session.form.create`; the server reads its reply off
// the host's `form.replied` event and records every answer given as one
// message. A question left blank stays open; one dismissed with ctrl+x (the
// form's one action) closes on its assumption.
//
// The form is the host's, so it is told apart by its field keys: each is
// `ask_user_async:<question id>`, a prefix no host form uses.
import { normalize, type Given, type Question } from "./question.ts"
import { excerpt } from "./reply.ts"

/** What a field key starts with. */
export const KEY_PREFIX = "ask_user_async:"
/** The form's title. */
export const TITLE = "Background questions"
/** Marks the assumed choice. */
export const ASSUMED = "assumed"
/** How much of the question a tab's label keeps when it has no header. */
export const TAB = 24
/** What the form replies for a dismissed question: a value no typed answer is. */
export const DISMISS_VALUE = `${KEY_PREFIX}dismiss`

/** A host form action: a key that answers the question on screen with `value` (Form.Action in the fork). */
export interface FormAction {
  readonly key: string
  readonly label: string
  readonly value: string
  readonly mark?: string
}

/**
 * The form's one action: ctrl+x dismisses the question on screen, keeping the
 * assumption, and moves to the next; ctrl+x again on it undoes that. The tab
 * and the Submit tab show it as dismissed until the submit.
 */
export const DISMISS: FormAction = { key: "ctrl+x", label: "dismiss", value: DISMISS_VALUE, mark: "dismissed" }

/** A host form option. */
export interface FormOption {
  readonly value: string
  readonly label: string
  readonly description?: string
}

/** A host form field, the shape the built-in question tool asks with: a string with choices and a custom answer. */
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
  readonly metadata: { readonly source: "questions"; readonly message?: string }
  readonly actions: ReadonlyArray<FormAction>
  readonly fields: readonly [FormField, ...Array<FormField>]
}

const option = (label: string, description: string | undefined): FormOption => ({
  value: label,
  label,
  ...(description === undefined ? {} : { description }),
})

/**
 * The question as a field: its choices with the assumed one first (where the
 * built-in tool puts its recommended choice, and where the cursor starts),
 * marked `assumed`; with no choice naming the assumption, the assumption is a
 * choice of its own at the top. The host adds "Type your own answer" last.
 */
export const fieldOf = (question: Question): FormField => {
  const choices = question.options ?? []
  const assumed = choices.find((choice) => normalize(choice.label) === normalize(question.assume))
  const first =
    assumed === undefined
      ? option(question.assume, ASSUMED)
      : option(assumed.label, assumed.description === undefined ? ASSUMED : `${ASSUMED} · ${assumed.description}`)
  return {
    key: `${KEY_PREFIX}${question.id}`,
    type: "string",
    title: question.header ?? excerpt(question.question, TAB),
    description: question.question,
    options: [first, ...choices.filter((choice) => choice !== assumed).map((choice) => option(choice.label, choice.description))],
    custom: true,
  }
}

/** The form for one session's open questions, oldest first; `from` names the asker when it is not the session on screen. */
export const formOf = (questions: ReadonlyArray<Question>, from?: string): FormInput | undefined => {
  const [first, ...rest] = questions.toSorted((left, right) => left.askedAt - right.askedAt)
  if (first === undefined) return undefined
  return {
    title: TITLE,
    metadata: { source: "questions", ...(from === undefined ? {} : { message: `Asked by ${from}` }) },
    actions: [DISMISS],
    fields: [fieldOf(first), ...rest.map(fieldOf)],
  }
}

/** Whether a host form is one of ours. */
export const isOurs = (form: { readonly fields: ReadonlyArray<{ readonly key: string }> }): boolean =>
  form.fields.length > 0 && form.fields.every((field) => field.key.startsWith(KEY_PREFIX))

/** What a form's reply gives: the answers, and the questions dismissed. */
export interface FormReply {
  readonly answers: ReadonlyArray<Given>
  readonly dismissed: ReadonlyArray<string>
}

/**
 * What a form's reply gives, in its keys' order, when every key is ours; a
 * blank one is left out, and one the dismiss action answered is dismissed.
 * None when the reply is another form's.
 */
export const replyOf = (answer: Readonly<Record<string, unknown>>): FormReply | undefined => {
  const keys = Object.keys(answer)
  if (keys.length === 0 || !keys.every((key) => key.startsWith(KEY_PREFIX))) return undefined
  const answers: Array<Given> = []
  const dismissed: Array<string> = []
  for (const key of keys) {
    const id = key.slice(KEY_PREFIX.length)
    const value = answer[key]
    const text = (Array.isArray(value) ? value.map(String).join(", ") : value === undefined || value === null ? "" : String(value)).trim()
    if (text === "") continue
    if (text === DISMISS_VALUE) dismissed.push(id)
    else answers.push({ id, answer: text })
  }
  return { answers, dismissed }
}
