// Wall-clock time in a named zone (`digest.timezone`): the morning a Later message returns at, and the 6-hour spans
// of the page's timeline with their labels. Pure functions of an instant and a zone, on Temporal: a zone's offset
// changes (a DST day) are the zone database's, never ours.
import { Result } from "effect"

/** The hour of the morning a message set aside comes back, in the zone (an open question to the owner: 6:00 AM). */
export const MORNING_HOUR = 6

const DAY_MS = 86_400_000

/** The host's own zone, the default of `digest.timezone`. */
export const hostZone = (): string => new Intl.DateTimeFormat().resolvedOptions().timeZone

/** Whether `zone` names a zone this runtime knows (an alias such as America/Montreal too). */
export const isZone = (zone: string): boolean => Result.isSuccess(Result.try(() => new Intl.DateTimeFormat("en-US", { timeZone: zone })))

const zoned = (t: number, zone: string) => Temporal.Instant.fromEpochMilliseconds(t).toZonedDateTimeISO(zone)

/** The instant of `hour`:00 on the calendar day of `day` in its zone; a wall time a clock change skips is read forward. */
const atHour = (day: Temporal.ZonedDateTime, hour: number): number =>
  day.toPlainDate().toZonedDateTime({ timeZone: day.timeZoneId, plainTime: new Temporal.PlainTime(hour) }).epochMilliseconds

/** The first MORNING_HOUR:00 in `zone` strictly after `t`: set aside at 2 AM, back at 6 AM that day; at 9 AM, the next day. */
export const nextMorning = (t: number, zone: string): number => {
  const now = zoned(t, zone)
  const today = atHour(now, MORNING_HOUR)
  if (today > t) return today
  return atHour(now.add({ days: 1 }), MORNING_HOUR)
}

/** The start of the calendar day of `t` in `zone`. */
export const startOfDay = (t: number, zone: string): number => zoned(t, zone).startOfDay().epochMilliseconds

/** The wall-clock hour of `t` in `zone`, 0 to 23. */
export const hourOf = (t: number, zone: string): number => zoned(t, zone).hour

/** The starts of the wall-clock spans of `hours` (a divisor of 24) from the one holding `from` up to `to`, in `zone`. */
export const spanStarts = (from: number, to: number, hours: number, zone: string): ReadonlyArray<number> => {
  const starts: Array<number> = []
  for (let day = zoned(from, zone).startOfDay(); day.epochMilliseconds < to; day = day.add({ days: 1 }).startOfDay())
    for (let hour = 0; hour < 24; hour += hours) {
      const start = atHour(day, hour)
      // A start before the last (a wall hour a clock change repeats) or past `to` is no span.
      if (start < to && starts.every((each) => each < start)) starts.push(start)
    }
  const first = starts.findLastIndex((start) => start <= from)
  return starts.slice(Math.max(0, first))
}

const formatter = (zone: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options })

/** `3:04 PM` */
export const clock = (t: number, zone: string): string => formatter(zone, { hour: "numeric", minute: "2-digit" }).format(t)

/** `3 PM`, or `3:30 PM` when not on the hour. */
export const hourLabel = (t: number, zone: string): string => {
  if (zoned(t, zone).minute === 0) return formatter(zone, { hour: "numeric" }).format(t)
  return clock(t, zone)
}

/** `Fri`. */
export const weekday = (t: number, zone: string): string => formatter(zone, { weekday: "short" }).format(t)

/** `Friday`. */
export const weekdayLong = (t: number, zone: string): string => formatter(zone, { weekday: "long" }).format(t)

/** A message's time as the page shows it: `3:04 PM` today, `Fri 3:04 PM` in the last six days, `Nov 3, 3:04 PM` before. */
export const when = (t: number, now: number, zone: string): string => {
  if (startOfDay(t, zone) === startOfDay(now, zone)) return clock(t, zone)
  if (now - t < 6 * DAY_MS) return `${weekday(t, zone)} ${clock(t, zone)}`
  return `${formatter(zone, { month: "short", day: "numeric" }).format(t)}, ${clock(t, zone)}`
}
