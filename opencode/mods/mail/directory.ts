// The sessions an agent may write to, this server's and each paired host's,
// as cards, and the `sessions` tool that lists them: main sessions by
// default, subagents on request, narrowed by text in the title, directory or
// id, a paired host's marked with it.
import { Schema } from "effect"
import { toolInput } from "@dotfiles/decider/tool-input"

/** A session as mail reads it. */
export interface SessionCard {
  readonly id: string
  readonly title?: string | undefined
  readonly directory: string
  readonly agent?: string | undefined
  /** Whether an execution of it runs now. */
  readonly running: boolean
  /** Its parent, when it is a subagent's session. */
  readonly parentID?: string | undefined
  /** Its last activity, epoch ms. */
  readonly updated: number
  /** The paired host it is on, by its mail name; none for this server's own. */
  readonly host?: string | undefined
}

/** A paired host whose sessions could not be read, and why. */
export interface Missed {
  readonly peer: string
  readonly message: string
}

/** What a session is called: its title, else its id. */
export const nameOf = (card: { readonly id: string; readonly title?: string | undefined }): string => card.title?.trim() || card.id

/** The most sessions one listing shows. */
export const MAX_LISTED = 100
const DEFAULT_LISTED = 20

export const SessionsInput = toolInput(Schema.Struct({
  search: Schema.optional(Schema.String).annotate({
    description: "Only sessions whose title, directory or id contains this text (any case).",
  }),
  children: Schema.optional(Schema.Boolean).annotate({
    description: "Include subagents' sessions too. Default false: main sessions only.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LISTED }))).annotate({
    description: `How many sessions to show, newest activity first. Default ${DEFAULT_LISTED}.`,
  }),
}))
export type SessionsInput = typeof SessionsInput.Type

export const SESSIONS_DESCRIPTION = [
  "List the other OpenCode sessions on this server that you can write to with the message tool: each one's id, title, whether it is running or idle, its agent, its directory and when it was last active, newest first. Main sessions by default; children: true adds subagents' sessions (with their parent). search narrows by text in the title, directory or id.",
  "Your own session is marked (you). Sessions on a host paired with this one (mail pairing) are listed too, marked `on <host>`; write to one by its id.",
].join("\n\n")

/** The cards a listing shows: those `search` matches, newest activity first, at most `limit`. */
export const select = (cards: ReadonlyArray<SessionCard>, input: SessionsInput): ReadonlyArray<SessionCard> => {
  const needle = input.search?.trim().toLowerCase() ?? ""
  const matches = (card: SessionCard) =>
    needle === "" || [card.title ?? "", card.directory, card.id].some((field) => field.toLowerCase().includes(needle))
  return cards
    .filter(matches)
    .toSorted((left, right) => right.updated - left.updated)
    .slice(0, input.limit ?? DEFAULT_LISTED)
}

/** How long ago `then` was, in the largest whole unit: `just now`, `42s ago`, `5m ago`, `3h ago`, `2d ago`. */
export const ago = (then: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - then) / 1_000))
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

/** One card as the listing shows it: `ses_… "Title" · running · build · /work · 2m ago · child of ses_… · on workbox (you)`. */
export const line = (card: SessionCard, caller: string, now: number): string =>
  [
    `${card.id} ${card.title?.trim() ? JSON.stringify(card.title.trim()) : "(untitled)"}`,
    card.running ? "running" : "idle",
    card.agent,
    card.directory,
    ago(card.updated, now),
    card.parentID === undefined ? undefined : `child of ${card.parentID}`,
    card.host === undefined ? undefined : `on ${card.host}`,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ") + (card.id === caller && card.host === undefined ? " (you)" : "")

/** The `sessions` tool's answer, naming each paired host that could not be read. */
export const listing = (cards: ReadonlyArray<SessionCard>, caller: string, now: number, missed: ReadonlyArray<Missed> = []): string =>
  [
    cards.length === 0 ? "No sessions match." : [`Sessions (${cards.length}):`, ...cards.map((card) => line(card, caller, now))].join("\n"),
    ...missed.map((miss) => `${miss.peer}: unreachable (${miss.message}); its sessions are not listed.`),
  ].join("\n")
