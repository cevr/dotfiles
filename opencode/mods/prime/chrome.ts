// The words of the frame around the transcript, without rendering: the top
// bar's cost, the splash's model line, the tray's model and usage, the
// dock's counts and the loader's spinner.
import { Option } from "effect"
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
export type Usage = { readonly tokens: number; readonly percent?: number | undefined; readonly cache?: number | undefined }

/**
 * The tray's usage: `64k`, or `64k (32%)` when the host knows the window,
 * then ` · cache 95%` when the latest turn's cache share is known (usage.ts).
 */
export function usageLabel(usage: Usage | undefined) {
  if (!usage) return undefined
  const context = usage.percent === undefined ? compactTokens(usage.tokens) : `${compactTokens(usage.tokens)} (${usage.percent}%)`
  return usage.cache === undefined ? context : `${context} · cache ${usage.cache}%`
}

/** The tray's model: `claude-opus:high` with a variant, else the model alone. */
export function trayModel(current: CurrentModel | undefined) {
  if (!current) return ""
  return current.variant ? `${current.modelID}:${current.variant}` : current.modelID
}

/**
 * The tray's model with a queued switch beside it: `claude-opus:high → claude-fable queued`, until the
 * switch applies (at the next compaction, or the wake after the cache expired) or is cancelled; the model alone else.
 */
export function trayModelQueued(now: string, next: Option.Option<string>) {
  return Option.match(next, { onNone: () => now, onSome: (queued) => `${now || "?"} → ${queued} queued` })
}

/** `1 shell`, `2 shells`. */
export function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

/**
 * Whether the dock's count line shows: while a subagent works, a shell or a
 * job runs, a wake or monitor is pending, or the queue holds an item not
 * done. With all of them at zero it is not drawn, not even as a blank row. An
 * unread notice keeps it too, since the dock is where it is counted until the
 * next turn reads it.
 */
export function dockShown(input: {
  readonly subagents: number
  readonly shells: number
  readonly jobs: number
  readonly wakes: number
  readonly monitors: number
  readonly notices: number
  readonly queued: number
}) {
  return Object.values(input).some((count) => count > 0)
}

/**
 * The dock's queue item: `5 queued`, and how many of them need the owner
 * (`2 need you`), drawn in the warning colour; none with nothing queued.
 */
export function queueItem(tally: { readonly open: number; readonly needsYou: number }): Option.Option<{ readonly text: string; readonly needs: Option.Option<string> }> {
  const verb = ["need", "needs"][Number(tally.needsYou === 1)]
  return Option.map(Option.liftPredicate(tally.open, (open) => open > 0), (open) => ({
    text: `${open} queued`,
    needs: Option.map(Option.liftPredicate(tally.needsYou, (needs) => needs > 0), (needs) => `${needs} ${verb} you`),
  }))
}

/** The loader's spinner frames, a braille turn. */
export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

/** How often the loader's spinner and clock move. */
export const SPINNER_MS = 100
