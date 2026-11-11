// The /answer form: the open questions of the session on screen and of its
// subagents in the host's own question form (the one OpenCode's `question`
// tool shows: a tab per question, its choices, a line to type an answer of
// one's own, one submit). The TUI opens it in the session on screen through
// the host's `session.form.create`; the server reads its reply off the host's
// `form.replied` event and records the answers each asking session was given
// as one message to it. A question left blank stays open; one dismissed with
// ctrl+x (the form's one action) closes on its assumption.
//
// The form is the host's, so it is told apart by its field keys: each is
// `ask_user_async:<question id>` for the form session's own question and
// `ask_user_async:<session id>:<question id>` for a subagent's, a prefix no
// host form uses.
import { assumedChoice, isRecommended, type Given, type Question } from "./question.ts"
import { excerpt } from "./reply.ts"

/** What a field key starts with. */
export const KEY_PREFIX = "ask_user_async:"
/** The form's title. */
export const TITLE = "Background questions"
/** Marks the assumed choice, as "(Recommended)" marks the recommended one. */
export const ASSUMED = "assumed"

/** A label with the assumed mark: "X (assumed)", or "X (recommended, assumed)" for a label marked "(Recommended)". */
export const assumedLabel = (label: string): string =>
  isRecommended(label) ? label.replace(/\s*\(recommended\)\s*$/i, ` (recommended, ${ASSUMED})`) : `${label} (${ASSUMED})`
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
  readonly metadata: { readonly source: "questions" }
  readonly actions: ReadonlyArray<FormAction>
  readonly fields: readonly [FormField, ...Array<FormField>]
}

/** An option that answers `value`, shown as `label`. */
const option = (value: string, description: string | undefined, label = value): FormOption => ({
  value,
  label,
  ...(description === undefined ? {} : { description }),
})

/**
 * The question as a field: its choices with the assumed one first (where the
 * built-in tool puts its recommended choice, and where the cursor starts),
 * its label marked "(assumed)" as a recommended one is marked "(Recommended)",
 * one option when it is both; it answers with its own label, unmarked. With no
 * choice the assumption names (`assumedChoice`), the assumption is a choice of
 * its own at the top, marked the same. The host adds "Type your own answer" last.
 * `asker` names the subagent that asked, when the form is another session's:
 * the key then names the asking session too, and the question says who asks.
 */
export const fieldOf = (question: Question, asker?: string): FormField => {
  const choices = question.options ?? []
  const assumed = assumedChoice(question)
  const first =
    assumed === undefined
      ? option(question.assume, undefined, assumedLabel(question.assume))
      : option(assumed.label, assumed.description, assumedLabel(assumed.label))
  return {
    key: asker === undefined ? `${KEY_PREFIX}${question.id}` : `${KEY_PREFIX}${question.sessionID}:${question.id}`,
    type: "string",
    title: question.header ?? excerpt(question.question, TAB),
    description: asker === undefined ? question.question : `${asker} asks: ${question.question}`,
    options: [first, ...choices.filter((choice) => choice !== assumed).map((choice) => option(choice.label, choice.description))],
    custom: true,
  }
}

/**
 * The form, in session `screen`, for the open questions its tray shows: its
 * own, oldest first, then its subagents', oldest first, each naming who asked
 * (`askerOf`). With no `screen`, every question is the form session's own.
 */
export const formOf = (questions: ReadonlyArray<Question>, screen?: string, askerOf: (sessionID: string) => string = (sessionID) => sessionID): FormInput | undefined => {
  const theirs = (question: Question) => screen !== undefined && question.sessionID !== screen
  const [first, ...rest] = questions.toSorted((left, right) => Number(theirs(left)) - Number(theirs(right)) || left.askedAt - right.askedAt)
  if (first === undefined) return undefined
  const field = (question: Question) => fieldOf(question, theirs(question) ? askerOf(question.sessionID) : undefined)
  return {
    title: TITLE,
    metadata: { source: "questions" },
    actions: [DISMISS],
    fields: [field(first), ...rest.map(field)],
  }
}

/** Whether a host form is one of ours. */
export const isOurs = (form: { readonly fields: ReadonlyArray<{ readonly key: string }> }): boolean =>
  form.fields.length > 0 && form.fields.every((field) => field.key.startsWith(KEY_PREFIX))

/** What a form's reply gives one asking session: its answers, and its questions dismissed. */
export interface FormReply {
  readonly sessionID: string
  readonly answers: ReadonlyArray<Given>
  readonly dismissed: ReadonlyArray<string>
}

/**
 * What a reply to a form in `sessionID` gives each asking session, in its
 * keys' order, when every key is ours; a blank one is left out, and one the
 * dismiss action answered is dismissed. A key `<session>:<id>` is a
 * subagent's question, a bare `<id>` the form session's own. The subagents
 * come first and the form's session last, so a wake the form's session takes
 * on its own answers reads the notices of its subagents' too. A session with
 * nothing given is left out; none when the reply is another form's.
 */
export const replyOf = (answer: Readonly<Record<string, unknown>>, sessionID: string): ReadonlyArray<FormReply> | undefined => {
  const keys = Object.keys(answer)
  if (keys.length === 0 || !keys.every((key) => key.startsWith(KEY_PREFIX))) return undefined
  const sessions = new Map<string, { readonly answers: Array<Given>; readonly dismissed: Array<string> }>()
  for (const key of keys) {
    const rest = key.slice(KEY_PREFIX.length)
    const at = rest.lastIndexOf(":")
    const asking = at < 0 ? sessionID : rest.slice(0, at)
    const id = rest.slice(at + 1)
    const value = answer[key]
    const text = (Array.isArray(value) ? value.map(String).join(", ") : value === undefined || value === null ? "" : String(value)).trim()
    if (text === "") continue
    const given = sessions.get(asking) ?? { answers: [], dismissed: [] }
    sessions.set(asking, given)
    if (text === DISMISS_VALUE) given.dismissed.push(id)
    else given.answers.push({ id, answer: text })
  }
  return [...sessions]
    .toSorted(([left], [right]) => Number(left === sessionID) - Number(right === sessionID))
    .map(([asking, given]) => ({ sessionID: asking, ...given }))
}
