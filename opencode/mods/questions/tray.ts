// The tray line above the composer: how many questions are open, the one
// question's label and assumption (or every label), and the hotkey and the
// command that open the pane. Optional parts drop from the right as the width shrinks, and
// a last one is cut to fit. Also which sessions' questions a session's tray
// shows: its own and its subagents', at any depth.
import { HOTKEY_LABEL } from "./hotkey.ts"
import type { Question } from "./question.ts"

export const GLYPH = "?"
export const COMMAND = "/answer"

/** Columns as the terminal counts them, near enough: one per code point. */
export const width = (text: string): number => [...text].length

/** `text` in at most `max` columns, `…` where it was cut. */
export const truncate = (text: string, max: number): string => {
  const chars = [...text]
  if (chars.length <= max) return text
  if (max <= 1) return "…".slice(0, Math.max(0, max))
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`
}

export const labelOf = (question: Question): string => question.header ?? question.question

/** The parts joined by ` · `; past `max` the optional parts drop from the right, and the first is cut to the room left. */
export const fitParts = (head: string, optional: ReadonlyArray<string>, tail: string, max: number): string => {
  const join = (parts: ReadonlyArray<string>) => [head, ...parts, tail].join(" · ")
  let kept = optional.length
  while (kept > 0 && width(join(optional.slice(0, kept))) > max) kept -= 1
  if (kept > 0) return join(optional.slice(0, kept))
  const first = optional[0]
  const room = max - width(join([])) - 3
  if (first === undefined || room < 8) return join([])
  return join([truncate(first, room)])
}

/** The ways to open the pane, last on the line: the hotkey and the command. */
export const OPENERS = `${HOTKEY_LABEL} ${COMMAND}`

/** The line after the glyph, in at most `max` columns; the hotkey goes last, when even the count and both openers do not fit. */
export const trayLine = (questions: ReadonlyArray<Question>, max: number): string => {
  const only = questions.length === 1 ? questions[0] : undefined
  const fit = (tail: string) =>
    only !== undefined
      ? fitParts("1 open question", [labelOf(only), `assuming ${only.assume}`], tail, max)
      : fitParts(`${questions.length} open questions`, [questions.map(labelOf).join(", ")], tail, max)
  const line = fit(OPENERS)
  return width(line) <= max ? line : fit(COMMAND)
}

/** A session as the tray reads its family. */
export interface Member {
  readonly id: string
  readonly parentID?: string | undefined
}

/** `sessionID` and every session under it, as far as `members` tell. */
export const under = (sessionID: string, members: ReadonlyArray<Member>): ReadonlyArray<string> => {
  const children = new Map<string, Array<string>>()
  for (const member of members) {
    if (member.parentID === undefined) continue
    children.set(member.parentID, [...(children.get(member.parentID) ?? []), member.id])
  }
  const found: Array<string> = []
  const visit = (id: string) => {
    if (found.includes(id)) return
    found.push(id)
    for (const child of children.get(id) ?? []) visit(child)
  }
  visit(sessionID)
  return found
}
