// What the /answer pane shows and what its keys do: the rows of a question
// (its choices with the one the agent assumed marked, or the assumption as a
// row of its own at the top when no choice names it), where the cursor starts
// (on the assumption, the agent's own pick), the free-text row under them,
// the answer Enter sends, and the pane's title and key hints.
import { type Choice, normalize, type Question } from "./question.ts"

export const ASSUMED = "assumed"

export interface Choices {
  /** The choice rows; the free-text row comes after them, at `rows.length`. */
  readonly rows: ReadonlyArray<Choice>
  /** The row of the assumption, where the cursor starts. */
  readonly assumed: number
}

export const choicesOf = (question: Question): Choices => {
  const options = question.options ?? []
  const assumed = options.findIndex((option) => normalize(option.label) === normalize(question.assume))
  if (assumed < 0) return { rows: [{ label: question.assume, description: ASSUMED }, ...options], assumed: 0 }
  return {
    rows: options.map((option, index) =>
      index === assumed ? { label: option.label, description: option.description === undefined ? ASSUMED : `${ASSUMED} · ${option.description}` } : option,
    ),
    assumed,
  }
}

/** The cursor moved by `delta` over the choice rows and the free-text row, wrapping. */
export const moved = (cursor: number, delta: number, choices: Choices): number => {
  const count = choices.rows.length + 1
  return (((cursor + delta) % count) + count) % count
}

/** What Enter sends: typed text when there is some, else the choice under the cursor; nothing on an empty free-text row. */
export const answerOf = (choices: Choices, cursor: number, typed: string): string | undefined => {
  const text = typed.trim()
  if (text !== "") return text
  return choices.rows[cursor]?.label
}

/** How long ago, compactly. */
export const ago = (millis: number): string => {
  const seconds = Math.floor(Math.max(0, millis) / 1000)
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** `Question 1/2 · <header> · from <subagent> · asked 3m ago`; `from` names the asker when it is not the session on screen. */
export const paneTitle = (question: Question, total: number, now: number, from?: string): string =>
  [`Question 1/${total}`, ...(question.header === undefined ? [] : [question.header]), ...(from === undefined ? [] : [`from ${from}`]), `asked ${ago(now - question.askedAt)}`].join(
    " · ",
  )

export const FREE_TEXT = "Type your own answer"
export const HINTS = "↑↓ move · enter answer · type your own · ctrl+x dismiss · esc close"
export const ARMED = "ctrl+x again dismisses this question; the agent is not told"
