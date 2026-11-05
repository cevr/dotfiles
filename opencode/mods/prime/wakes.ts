// The dock's wake item while the session has wakes pending or notices unread:
// `⏰ 2 wakes · 1 monitor · next 14:30 · 1 notice`. Alarms count as wakes;
// `next` is the soonest alarm, or the soonest monitor deadline as `until` when
// only monitors wait. Times are local: the clock alone today, the weekday
// within the week, the date past it. Optional parts drop from the right as the
// width shrinks. The reading comes from the wake mod's RPC (opencode/wakes.ts).

/** What the dock reads of a session's wakes: each pending entry's kind and time, and the unread notices. */
export type Wakes = {
  /** The wake server's clock when it answered, epoch ms. */
  readonly now: number
  /** An alarm's due time, a monitor's deadline. */
  readonly entries: ReadonlyArray<{ readonly kind: "alarm" | "monitor"; readonly dueAt: number }>
  readonly notices: number
}

export const WAKE_GLYPH = "⏰"
/** The glyph is two cells wide, then a space. */
const GLYPH_CELLS = 3

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const pad = (value: number) => String(value).padStart(2, "0")
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** `at` as the dock says it, seen at `now`, in local time. */
export const clockOf = (at: number, now: number): string => {
  const date = new Date(at)
  const today = new Date(now)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  if (sameDay) return clock
  if (at > now && at - now < 6 * 24 * 60 * 60 * 1000) return `${DAYS[date.getDay()]} ${clock}`
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${clock}`
}

/**
 * The wake item, glyph included, in at most `max` cells (the first part always
 * shows): `success` while anything is pending, `warning` with only notices
 * unread. Undefined when nothing is pending or unread.
 */
export const wakeItem = (wakes: Wakes, max: number): { readonly text: string; readonly tone: "success" | "warning" } | undefined => {
  const alarms = wakes.entries.filter((entry) => entry.kind === "alarm")
  const monitors = wakes.entries.filter((entry) => entry.kind === "monitor")
  if (alarms.length === 0 && monitors.length === 0 && wakes.notices === 0) return undefined
  const counts = [...(alarms.length === 0 ? [] : [plural(alarms.length, "wake", "wakes")]), ...(monitors.length === 0 ? [] : [plural(monitors.length, "monitor", "monitors")])]
  const soonest = (rows: ReadonlyArray<{ readonly dueAt: number }>) => Math.min(...rows.map((row) => row.dueAt))
  const when = alarms.length > 0 ? [`next ${clockOf(soonest(alarms), wakes.now)}`] : monitors.length > 0 ? [`until ${clockOf(soonest(monitors), wakes.now)}`] : []
  const notices = wakes.notices === 0 ? [] : [plural(wakes.notices, "notice", "notices")]
  const parts = [...counts, ...when, ...notices]
  let kept = parts.length
  while (kept > 1 && GLYPH_CELLS + [...parts.slice(0, kept).join(" · ")].length > max) kept -= 1
  return { text: `${WAKE_GLYPH} ${parts.slice(0, kept).join(" · ")}`, tone: wakes.entries.length > 0 ? "success" : "warning" }
}
