// The words of the frame around the transcript, without rendering: the top
// bar's cost, the splash's model line, the tray's model and usage, the
// dock's counts and the loader's spinner.
import type { Session } from "./session.ts"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/** A session's cost as the top bar shows it: `$0.42`. */
export function cost(dollars: number) {
  return money.format(dollars)
}

/** The model the prompt sends to, as the host's model picker holds it. */
export type CurrentModel = { readonly providerID: string; readonly modelID: string; readonly variant?: string | undefined }

/**
 * The splash's model line: a subagent runs its own model, not the prompt's,
 * so its session's model shows; any other session shows the prompt's.
 */
export function splashModel(session: Session | undefined, current: CurrentModel | undefined) {
  const own = session?.parentID ? session.model : undefined
  if (own) return `${own.providerID}/${own.id}`
  return current ? `${current.providerID}/${current.modelID}` : ""
}

/** The splash's agent line: a subagent's own agent, none for a session the reader drives. */
export function splashAgent(session: Session | undefined) {
  return session?.parentID ? session.agent : undefined
}

/** Token counts the way Prime's tray shows them: `850`, `64k`, `1.2M`. */
export function compactTokens(tokens: number) {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

/** How full the context is, as the host counts it. */
export type Usage = { readonly tokens: number; readonly percent?: number | undefined }

/** The tray's usage: `64k`, or `64k (32%)` when the host knows the window. */
export function usageLabel(usage: Usage | undefined) {
  if (!usage) return undefined
  return usage.percent === undefined ? compactTokens(usage.tokens) : `${compactTokens(usage.tokens)} (${usage.percent}%)`
}

/** The tray's model: `claude-opus:high` with a variant, else the model alone. */
export function trayModel(current: CurrentModel | undefined) {
  if (!current) return ""
  return current.variant ? `${current.modelID}:${current.variant}` : current.modelID
}

/** `1 shell`, `2 shells`. */
export function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

/**
 * Whether the dock's count line shows: while a subagent works, a shell runs,
 * or a wake or monitor is pending. With all four at zero it is not drawn,
 * not even as a blank row; unread notices alone do not keep it.
 */
export function dockShown(input: { readonly subagents: number; readonly shells: number; readonly wakes: number; readonly monitors: number }) {
  return input.subagents > 0 || input.shells > 0 || input.wakes > 0 || input.monitors > 0
}

/** The loader's spinner frames, a braille turn. */
export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

/** How often the loader's spinner and clock move. */
export const SPINNER_MS = 100
