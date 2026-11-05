// What the sidebar draws: the queue's items grouped and ordered, each a single
// line. An item linked to a subagent session shows that session's live state,
// and every running subagent no item names joins the Running group, so the
// board never misses running work. A subagent's row also says which role
// does it, what it is doing now and for how long, as the shared subagent
// rows do (@dotfiles/opencode-subagents). Pure; the TUI supplies the
// subagents and the time.
import { elapsed, fit } from "@dotfiles/opencode-subagents/line"
import type { Item } from "./item.ts"

/** A subagent session's state, as the TUI sees it. `since` (epoch ms) is when it finished. */
export type Live =
  | { readonly state: "running" }
  | { readonly state: "blocked" }
  | { readonly state: "done"; readonly since?: number }
  | { readonly state: "failed"; readonly since?: number }

/**
 * A subagent of the route's root session: its session, what its call said it
 * is for, its state, and, when known, its role (the session's agent), its
 * one-sentence update and how long its current run has taken (ms).
 */
export interface Subagent {
  readonly session: string
  readonly description: string
  readonly live: Live
  readonly role?: string
  readonly update?: string
  readonly elapsed?: number
}

/** Who works on a subagent's row, and how it goes: drawn on the row's second line. */
export interface Agent {
  readonly role: string
  readonly update: string
  readonly elapsed?: number
}

/** The sidebar's groups, in the order it shows them. */
export const GROUPS = ["needs-you", "running", "waiting", "scheduled", "next", "done"] as const
export type Group = (typeof GROUPS)[number]

/** How a row is marked: its group, or what a subagent's live state says within one. */
export type Mark = "needs-you" | "blocked" | "running" | "waiting" | "scheduled" | "next" | "done" | "failed"

export interface Row {
  /** Stable across refreshes: the item's id, or `session:<id>` for an unnamed subagent. */
  readonly key: string
  readonly group: Group
  readonly mark: Mark
  readonly text: string
  /** The scheduled time, already short (`22:07`, `Nov 5 22:07`). */
  readonly time?: string
  readonly detail?: string
  /** Whose it is, when not this agent's. */
  readonly who?: string
  /** The subagent doing it, when the row is a subagent's and its role is known. */
  readonly agent?: Agent
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

const agentOf = (subagent: Subagent | undefined): { readonly agent?: Agent } =>
  subagent?.role === undefined
    ? {}
    : { agent: { role: subagent.role, update: subagent.update ?? "", ...(subagent.elapsed === undefined ? {} : { elapsed: subagent.elapsed }) } }

/** An item's place on the board, from its own state or its subagent's. */
const placed = (item: Item, live: Live | undefined): { readonly group: Group; readonly mark: Mark; readonly since?: number } => {
  if (live === undefined) return { group: item.state, mark: item.state, ...(item.doneAt === undefined ? {} : { since: item.doneAt }) }
  switch (live.state) {
    case "running":
      return { group: "running", mark: "running" }
    case "blocked":
      return { group: "needs-you", mark: "blocked" }
    case "done":
      return { group: "done", mark: "done", ...(live.since === undefined ? {} : { since: live.since }) }
    case "failed":
      return { group: "done", mark: "failed" }
  }
}

/**
 * The rows for `items` and the root session's `subagents` at `now`: needs-you,
 * running, waiting, scheduled (soonest first), next, done. Within a group items
 * keep the queue's order and unnamed subagents follow them. A done item drops
 * off `linger` after it finished; a failed one stays until the agent changes it.
 */
export const board = (items: ReadonlyArray<Item>, subagents: ReadonlyArray<Subagent>, now: number, linger = LINGER_MS): ReadonlyArray<Row> => {
  const bySession = new Map(subagents.map((subagent) => [subagent.session, subagent]))
  const named = new Set(items.flatMap((item) => (item.session === undefined ? [] : [item.session])))
  const rows: Array<Row & { readonly order: number; readonly at?: number }> = []
  for (const item of items) {
    const subagent = item.session === undefined ? undefined : bySession.get(item.session)
    const place = placed(item, subagent?.live)
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
      ...agentOf(subagent),
      order: rows.length,
      ...(item.at === undefined ? {} : { at: Date.parse(item.at) }),
    })
  }
  for (const subagent of subagents) {
    if (named.has(subagent.session)) continue
    if (subagent.live.state !== "running" && subagent.live.state !== "blocked") continue
    const blocked = subagent.live.state === "blocked"
    rows.push({
      key: `session:${subagent.session}`,
      group: blocked ? "needs-you" : "running",
      mark: blocked ? "blocked" : "running",
      text: subagent.description,
      ...agentOf(subagent),
      order: rows.length,
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

/** The widest role among `rows`, so the agent lines of one board line up. */
export const roleWidth = (rows: ReadonlyArray<Row>): number => Math.max(0, ...rows.map((row) => [...(row.agent?.role ?? "")].length))

/**
 * A subagent row's second line, under its first: `  implementor  editing src/money.ts · 1m 05s`,
 * the role padded to `roles`, the update giving way to the width before the role does.
 */
export const agentLine = (agent: Agent, width: number, roles = [...agent.role].length): string => {
  const lead = `  ${agent.role.padEnd(roles)}  `
  const time = agent.elapsed === undefined ? "" : ` · ${elapsed(agent.elapsed)}`
  const room = width - [...lead].length - [...time].length
  const update = fit(agent.update, room)
  return fit(update === "" ? lead.trimEnd() : `${lead}${update}${time}`, width)
}

/** One row as a line of at most `width` characters: `◷ 22:07 pool-token check · wC:p6 · other`. */
export const line = (row: Row, width: number): string =>
  fit([`${GLYPHS[row.mark]} ${row.time === undefined ? "" : `${row.time} `}${row.text}`, row.detail, row.who].filter((part) => part !== undefined).join(" · "), width)
