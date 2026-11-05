// The tray line above the composer while a session has wakes pending:
// `⏰ 2 wakes · 1 monitor · next 14:30 · 1 notice`. Alarms count as wakes;
// `next` is the soonest alarm, or the soonest monitor deadline as `until` when
// only monitors wait. Times are local: the clock alone today, the weekday
// within the week, the date past it. Optional parts drop from the right as the
// width shrinks.
import type { Pending } from "./wake.ts"

export const GLYPH = "⏰"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const pad = (value: number) => String(value).padStart(2, "0")
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** `at` as the tray says it, seen at `now`, in local time. */
export const clockOf = (at: number, now: number): string => {
  const date = new Date(at)
  const today = new Date(now)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  if (sameDay) return clock
  if (at > now && at - now < 6 * 24 * 60 * 60 * 1000) return `${DAYS[date.getDay()]} ${clock}`
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${clock}`
}

/** The line after the glyph, at most `max` columns; undefined when nothing is pending or unread. */
export const trayLine = (pending: Pending, max: number): string | undefined => {
  const alarms = pending.entries.filter((entry) => entry.kind === "alarm")
  const monitors = pending.entries.filter((entry) => entry.kind === "monitor")
  if (alarms.length === 0 && monitors.length === 0 && pending.notices.length === 0) return undefined
  const counts = [...(alarms.length === 0 ? [] : [plural(alarms.length, "wake", "wakes")]), ...(monitors.length === 0 ? [] : [plural(monitors.length, "monitor", "monitors")])]
  const soonest = (rows: ReadonlyArray<{ readonly dueAt: number }>) => Math.min(...rows.map((row) => row.dueAt))
  const when =
    alarms.length > 0 ? [`next ${clockOf(soonest(alarms), pending.now)}`] : monitors.length > 0 ? [`until ${clockOf(soonest(monitors), pending.now)}`] : []
  const notices = pending.notices.length === 0 ? [] : [plural(pending.notices.length, "notice", "notices")]
  const parts = [...counts, ...when, ...notices]
  let kept = parts.length
  while (kept > 1 && [...parts.slice(0, kept).join(" · ")].length > max) kept -= 1
  return parts.slice(0, kept).join(" · ")
}
