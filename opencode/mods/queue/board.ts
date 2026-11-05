// What the sidebar draws: the queue's own items grouped and ordered, each a
// single line. An item linked to a subagent session (`session`) shows that
// session's live state as its mark; the subagents themselves are not drawn
// here (Prime's rows beneath the composer carry them). Pure; the TUI supplies
// the linked sessions' states and the time.
import { fit } from "@dotfiles/opencode-subagents/line"
import type { Item } from "./item.ts"

/** A subagent session's state, as the TUI sees it. `since` (epoch ms) is when it finished. */
export type Live =
  | { readonly state: "running" }
  | { readonly state: "waiting" }
  | { readonly state: "blocked" }
  | { readonly state: "done"; readonly since?: number }
  | { readonly state: "failed"; readonly since?: number }

/** The sidebar's groups, in the order it shows them. */
export const GROUPS = ["needs-you", "running", "waiting", "scheduled", "next", "done"] as const
export type Group = (typeof GROUPS)[number]

/** How a row is marked: its group, or what a subagent's live state says within one. */
export type Mark = "needs-you" | "blocked" | "running" | "waiting" | "scheduled" | "next" | "done" | "failed"

export interface Row {
  /** Stable across refreshes: the item's id. */
  readonly key: string
  readonly group: Group
  readonly mark: Mark
  readonly text: string
  /** The scheduled time, already short (`22:07`, `Nov 5 22:07`). */
  readonly time?: string
  readonly detail?: string
  /** Whose it is, when not this agent's. */
  readonly who?: string
}

/** How long a done item stays on the board. */
export const LINGER_MS = 10 * 60_000

export const GLYPHS: Readonly<Record<Mark, string>> = {
  "needs-you": "!",
  blocked: "!",
  running: "●",
  waiting: "…",
  scheduled: "◷",
  next: "○",
  done: "✓",
  failed: "✗",
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const pad = (value: number) => String(value).padStart(2, "0")

/** `at` in local time: `22:07` on `now`'s day, else `Nov 5 22:07`. Undefined when it does not parse. */
export const when = (at: string, now: number): string | undefined => {
  const time = Date.parse(at)
  if (!Number.isFinite(time)) return undefined
  const date = new Date(time)
  const today = new Date(now)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  return sameDay ? clock : `${MONTHS[date.getMonth()]} ${date.getDate()} ${clock}`
}

/** An item's place on the board, from its own state or its subagent's. */
const placed = (item: Item, live: Live | undefined): { readonly group: Group; readonly mark: Mark; readonly since?: number } => {
  if (live === undefined) return { group: item.state, mark: item.state, ...(item.doneAt === undefined ? {} : { since: item.doneAt }) }
  switch (live.state) {
    case "running":
      return { group: "running", mark: "running" }
    case "waiting":
      return { group: "waiting", mark: "waiting" }
    case "blocked":
      return { group: "needs-you", mark: "blocked" }
    case "done":
      return { group: "done", mark: "done", ...(live.since === undefined ? {} : { since: live.since }) }
    case "failed":
      return { group: "done", mark: "failed" }
  }
}

/**
 * The rows for `items` at `now`, given the live state of each linked subagent
 * session the TUI knows (`live`, by session id): needs-you, running, waiting,
 * scheduled (soonest first), next, done. Within a group items keep the queue's
 * order. A done item drops off `linger` after it finished; a failed one stays
 * until the agent changes it.
 */
export const board = (items: ReadonlyArray<Item>, live: ReadonlyMap<string, Live>, now: number, linger = LINGER_MS): ReadonlyArray<Row> => {
  const rows: Array<Row & { readonly order: number; readonly at?: number }> = []
  for (const item of items) {
    const place = placed(item, item.session === undefined ? undefined : live.get(item.session))
    if (place.mark === "done" && place.since !== undefined && now - place.since >= linger) continue
    const time = item.at === undefined ? undefined : when(item.at, now)
    rows.push({
      key: item.id,
      group: place.group,
      mark: place.mark,
      text: item.text,
      ...(time === undefined || place.group !== "scheduled" ? {} : { time }),
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      ...(item.owner === "other" ? { who: item.who ?? "other" } : {}),
      order: rows.length,
      ...(item.at === undefined ? {} : { at: Date.parse(item.at) }),
    })
  }
  return rows
    .toSorted(
      (left, right) =>
        GROUPS.indexOf(left.group) - GROUPS.indexOf(right.group) ||
        (left.group === "scheduled" ? (left.at ?? Infinity) - (right.at ?? Infinity) : 0) ||
        left.order - right.order,
    )
    .map(({ order: _order, at: _at, ...row }) => row)
}

/** One row as a line of at most `width` characters: `◷ 22:07 pool-token check · wC:p6 · other`. */
export const line = (row: Row, width: number): string =>
  fit([`${GLYPHS[row.mark]} ${row.time === undefined ? "" : `${row.time} `}${row.text}`, row.detail, row.who].filter((part) => part !== undefined).join(" · "), width)
