// What one kernel call answers, folded from the events the call recorded: the
// notes on what happened to the kernel, then the cell's output and display,
// or the reason the worker was lost.
import type { Fold } from "@dotfiles/decider/decider"
import { viewOf } from "./output.ts"
import type { Event } from "./session.ts"

/** How the call ended: the cell ran (and threw or not), or the worker was lost under it. */
export type Outcome =
  | { readonly _tag: "Pending" }
  | {
      readonly _tag: "Ran"
      readonly ok: boolean
      readonly output: string
      readonly display: string
      readonly attached: ReadonlyArray<string>
    }
  | { readonly _tag: "Lost"; readonly message: string }

export interface CellAnswerState {
  readonly notes: ReadonlyArray<string>
  readonly outcome: Outcome
}

const note = (state: CellAnswerState, text: string): CellAnswerState => ({ ...state, notes: [...state.notes, text] })

/** The most characters a new kernel's notice takes. */
export const MAX_NOTICE_CHARS = 160
/** The most lost names a notice gives; the rest are a count. */
const NOTICE_NAMES = 3
/** The most unkept bindings a cell's note names; the rest are a count. */
export const MAX_UNKEPT_NAMED = 8

const plural = (count: number, one: string) => {
  if (count === 1) return `1 ${one}`
  return `${count} ${one}s`
}

/** The names past those shown, as a count after `lead`; nothing when none are left. */
const more = (rest: number, lead: string) => {
  if (rest === 0) return ""
  return `${lead}and ${rest} more`
}

/**
 * A new kernel that lost bindings, in one line within `MAX_NOTICE_CHARS`: the
 * counts, as many of the first three lost names as fit, and the call that
 * lists what it holds. The names it restored are never listed: a session
 * holds hundreds, and a planned restart is no news.
 */
export const startNotice = (restored: number, lost: ReadonlyArray<string>): string => {
  const head = `[new kernel; ${plural(restored, "binding")} restored, ${lost.length} lost`
  const tail = "; kernel.bindings() lists what it holds]"
  for (let shown = Math.min(NOTICE_NAMES, lost.length); shown > 0; shown--) {
    const line = `${head}: ${lost.slice(0, shown).join(", ")}${more(lost.length - shown, " ")}${tail}`
    if (line.length <= MAX_NOTICE_CHARS) return line
  }
  return `${head}${tail}`
}

/** The bindings a cell made that a restart loses: at most `MAX_UNKEPT_NAMED` by name, then a count. */
export const unkeptNote = (unkept: ReadonlyArray<{ readonly name: string; readonly reason: string }>): string => {
  const named = unkept.slice(0, MAX_UNKEPT_NAMED).map((item) => `${item.name} (${item.reason})`)
  return `[not kept across restarts: ${named.join(", ")}${more(unkept.length - named.length, " … ")}]`
}

export const CellAnswer: Fold<CellAnswerState, Event> = {
  initial: { notes: [], outcome: { _tag: "Pending" } },
  evolve: (state, event) => {
    switch (event._tag) {
      case "KernelReset":
        return note(state, "[kernel reset]")
      case "KernelStarted": {
        // A start that lost nothing is no news.
        const lost = event.lost || []
        if (lost.length === 0) return state
        return note(state, startNotice((event.restored || []).length, lost))
      }
      case "CellRan": {
        const noted = event.unkept.length === 0 ? state : note(state, unkeptNote(event.unkept))
        return {
          ...noted,
          outcome: { _tag: "Ran", ok: event.ok, output: event.output, display: event.display, attached: event.attached ?? [] },
        }
      }
      case "KernelLost":
        return { ...state, outcome: { _tag: "Lost", message: event.message } }
      case "KernelStopped":
        return state
    }
  },
}

/**
 * The answer the model reads: `ok` false is the tool's error. `attached` is
 * set when a cell that did not throw attached files: the images to show after
 * the text (attachment.ts). A cell that threw attaches nothing.
 */
export interface Answer {
  readonly ok: boolean
  readonly text: string
  readonly attached?: ReadonlyArray<string>
}

/**
 * The call's answer in at most about `viewChars` characters. A lost worker's
 * reason is read whole, after the notes; a call that recorded no outcome has
 * no output.
 */
export const read = (state: CellAnswerState, viewChars: number): Answer => {
  const { notes, outcome } = state
  if (outcome._tag === "Lost") return { ok: false, text: [...notes, outcome.message].join("\n") }
  const parts = outcome._tag === "Ran" ? [...notes, outcome.output.trimEnd(), outcome.display] : [...notes]
  const text = parts.filter((part) => part !== "").join("\n")
  const ok = outcome._tag === "Ran" ? outcome.ok : true
  const attached = outcome._tag === "Ran" && ok && outcome.attached.length > 0 ? { attached: outcome.attached } : {}
  return { ok, text: viewOf(text === "" ? "(no output)" : text, viewChars), ...attached }
}
