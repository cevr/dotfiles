// What one kernel call answers, folded from the events the call recorded: the
// notes on what happened to the kernel, then the cell's output and display,
// or the reason the worker was lost.
import type { Fold } from "@dotfiles/decider/decider"
import { viewOf } from "./output.ts"
import type { Event } from "./session.ts"

/** How the call ended: the cell ran (and threw or not), or the worker was lost under it. */
export type Outcome =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Ran"; readonly ok: boolean; readonly output: string; readonly display: string }
  | { readonly _tag: "Lost"; readonly message: string }

export interface CellAnswerState {
  readonly notes: ReadonlyArray<string>
  readonly outcome: Outcome
}

const note = (state: CellAnswerState, text: string): CellAnswerState => ({ ...state, notes: [...state.notes, text] })

export const CellAnswer: Fold<CellAnswerState, Event> = {
  initial: { notes: [], outcome: { _tag: "Pending" } },
  evolve: (state, event) => {
    switch (event._tag) {
      case "KernelReset":
        return note(state, "[kernel reset]")
      case "KernelStarted":
        return event.restored === undefined ? state : note(state, `[new kernel; restored ${event.restored.join(", ")}]`)
      case "CellRan": {
        const noted =
          event.unkept.length === 0
            ? state
            : note(state, `[not kept across restarts: ${event.unkept.map((item) => `${item.name} (${item.reason})`).join(", ")}]`)
        return { ...noted, outcome: { _tag: "Ran", ok: event.ok, output: event.output, display: event.display } }
      }
      case "KernelLost":
        return { ...state, outcome: { _tag: "Lost", message: event.message } }
      case "KernelStopped":
        return state
    }
  },
}

/** The answer the model reads: `ok` false is the tool's error. */
export interface Answer {
  readonly ok: boolean
  readonly text: string
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
  return { ok: outcome._tag === "Ran" ? outcome.ok : true, text: viewOf(text === "" ? "(no output)" : text, viewChars) }
}
