// What the /btw pane draws, as plain data (tui/pane.tsx draws it): its title,
// each exchange as a question and what stands for its answer, and the key
// hints under the ask line (gent's ForkPane).
import { Option } from "effect"
import type { OpenFork } from "./side-question.ts"
import { replyOf, type Turn } from "./turns.ts"

/** The pane's title: the fork's name (`btw: <question>`), or `btw` before there is one. */
export const paneTitle = (fork: OpenFork | undefined): string => fork?.name ?? "btw"

/** One exchange as the pane shows it. */
export type Row =
  | { readonly _tag: "Answer"; readonly question: string; readonly answer: string; readonly streaming: boolean; readonly error?: string }
  /** No text yet: `thinking…` while the fork replies, `forking…` before the fork exists, else `no answer`. */
  | { readonly _tag: "Waiting"; readonly question: string; readonly note: string; readonly error?: string }

/** The pane's exchanges: the fork's own, then a question still on its way, if any. */
export const rows = (turns: ReadonlyArray<Turn>, replying: boolean, pending: string | undefined): ReadonlyArray<Row> => {
  const drawn = turns.map((turn, index): Row => {
    const last = index === turns.length - 1
    const error = turn.error === undefined ? {} : { error: turn.error }
    if (turn.answer.length > 0) return { _tag: "Answer", question: turn.question, answer: turn.answer, streaming: last && replying, ...error }
    return { _tag: "Waiting", question: turn.question, note: last && replying ? "thinking…" : "no answer", ...error }
  })
  // A question already on the fork shows once: the pending copy goes when its turn appears.
  const shown = pending !== undefined && turns.at(-1)?.question !== pending
  return shown ? [...drawn, { _tag: "Waiting", question: pending, note: turns.length === 0 ? "forking…" : "asking…" }] : drawn
}

/**
 * The key hints under the ask line: Enter asks, or opens the fork when the
 * line is empty; ctrl+s shows only when an answer can come back (the key
 * still says why it cannot).
 */
export const hints = (input: { readonly draft: string; readonly fork: boolean; readonly canBringBack: boolean }): string =>
  [
    input.draft.trim().length === 0 && input.fork ? "enter open" : "enter ask",
    ...(input.canBringBack ? ["ctrl+s bring back"] : []),
    "esc close",
  ].join(" · ")

/** Whether ctrl+s would bring an answer back now: the fork's newest answer, finished and not brought back yet. */
export const canBringBack = (fork: OpenFork | undefined, turns: ReadonlyArray<Turn>, replying: boolean): boolean =>
  fork !== undefined && Option.exists(replyOf(turns, replying), (reply) => !fork.broughtBack.includes(reply.replyID))
