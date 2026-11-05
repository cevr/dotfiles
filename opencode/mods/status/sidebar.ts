// What the session sidebar's Pool section draws, as text: the account the
// session is on (the pool's `session` answer, dotfiles-opencode.pool), its
// weekly and 5-hour use with when each resets, and how alarming each line is.
// tui/sidebar.tsx reads the answer and draws these lines.
import { Schema } from "effect"
import { stamp } from "./pane.ts"

/**
 * The pool's `session` answer as the sidebar reads it. The pool's
 * `SessionAnswer` (`@dotfiles/opencode-pool/status`) carries these fields and
 * more; the sidebar reads only these, so it needs no import of the pool's model.
 */
export const SidebarAnswer = Schema.Struct({
  account: Schema.optionalKey(
    Schema.Struct({
      label: Schema.String,
      on: Schema.Literals(["placed", "next"]),
      hold: Schema.optionalKey(Schema.Struct({ kind: Schema.String, until: Schema.Number })),
      reading: Schema.optionalKey(
        Schema.Struct({
          windows: Schema.Array(
            Schema.Struct({ name: Schema.String, utilization: Schema.Number, resetAt: Schema.optionalKey(Schema.Number) }),
          ),
        }),
      ),
    }),
  ),
})
export type SidebarAnswer = typeof SidebarAnswer.Type

/** How a line reads: muted, plain, or in the warning or error colour. */
export type Tone = "muted" | "base" | "warning" | "error"

export interface SidebarLine {
  readonly text: string
  readonly tone: Tone
}

/** Use from which a window's line turns to the warning colour, and to the error colour. */
export const WARNING_AT = 0.8
export const ERROR_AT = 0.95

/** The windows the sidebar shows, in order, by the name it gives each. */
const WINDOWS = [
  ["7d", "week"],
  ["5h", "5h"],
] as const

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How long from `now` until `at`, to the two largest units: `in 1d 4h`, `in 2h 5m`, `in 12m`, or `now`. */
export const until = (at: number, now: number) => {
  const left = at - now
  if (left < MINUTE) return "now"
  if (left < HOUR) return `in ${Math.floor(left / MINUTE)}m`
  if (left < DAY) return `in ${Math.floor(left / HOUR)}h ${Math.floor((left % HOUR) / MINUTE)}m`
  return `in ${Math.floor(left / DAY)}d ${Math.floor((left % DAY) / HOUR)}h`
}

/**
 * A time as the sidebar shows it, from the pane's stamp (UTC, to the
 * minute): relative, then `HH:MMZ` today, `Thu HH:MMZ` within the week, else
 * `MM-DD HH:MMZ`.
 */
export const when = (at: number, now: number) => {
  const full = stamp(at)
  const day = full.slice(0, 10)
  const time = full.slice(11)
  const date =
    day === stamp(now).slice(0, 10)
      ? time
      : at - now < 6 * DAY
        ? `${WEEKDAYS[new Date(at).getUTCDay()] ?? ""} ${time}`
        : `${full.slice(5, 10)} ${time}`
  return `${until(at, now)} · ${date}`
}

const toneOf = (utilization: number): Tone => (utilization >= ERROR_AT ? "error" : utilization >= WARNING_AT ? "warning" : "muted")

/**
 * The Pool section: the account's label (`· next` before the session's first
 * request), whether it is held and until when, then each window it has a
 * reading of. Nothing when the pool names no account.
 */
export const sidebarLines = (answer: SidebarAnswer, now: number): ReadonlyArray<SidebarLine> => {
  const account = answer.account
  if (account === undefined) return []
  const held = account.hold !== undefined && account.hold.until > now
  const title: SidebarLine = {
    text: account.on === "next" ? `${account.label} · next` : account.label,
    tone: held ? "warning" : "base",
  }
  const hold: ReadonlyArray<SidebarLine> =
    held && account.hold !== undefined ? [{ text: `held · ${when(account.hold.until, now)}`, tone: "warning" }] : []
  const windows = WINDOWS.flatMap(([name, shown]): ReadonlyArray<SidebarLine> => {
    const window = account.reading?.windows.find((item) => item.name === name)
    if (window === undefined) return []
    // A window that has reset since the answer is empty, until the next one says otherwise.
    const reset = window.resetAt !== undefined && window.resetAt > now ? window.resetAt : undefined
    const utilization = window.resetAt !== undefined && reset === undefined ? 0 : window.utilization
    const percent = `${shown} ${Math.round(utilization * 100)}%`
    return [{ text: reset === undefined ? percent : `${percent} · ${when(reset, now)}`, tone: toneOf(utilization) }]
  })
  return [title, ...hold, ...(windows.length === 0 ? [{ text: "no reading yet", tone: "muted" as const }] : windows)]
}
