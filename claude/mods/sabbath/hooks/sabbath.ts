// The Sabbath at a place: from sunset on Friday to sunset on Saturday, its days
// counted in the place's time zone. Pure, so the codex-bridge's policy can hold
// Codex turns by the same hours.

export type Place = { name: string; lat: number; lon: number; timeZone: string }

// The owner's location (owner, 2026-10-30).
export const KNOWLTON: Place = { name: 'Knowlton, QC', lat: 45.2167, lon: -72.5167, timeZone: 'America/Toronto' }

const DAY = 864e5
const rad = Math.PI / 180

/** Sunset on a calendar day at a place, in ms (the sunrise equation; within a few minutes). */
export function sunset(y: number, m: number, d: number, place: Pick<Place, 'lat' | 'lon'>): number {
  const julian = Date.UTC(y, m - 1, d) / DAY + 2440587.5
  const n = Math.ceil(julian - 2451545 + 0.0008)
  const mean = n - place.lon / 360
  const anomaly = (357.5291 + 0.98560028 * mean) % 360
  const center = 1.9148 * Math.sin(anomaly * rad) + 0.02 * Math.sin(2 * anomaly * rad) + 0.0003 * Math.sin(3 * anomaly * rad)
  const longitude = (anomaly + center + 180 + 102.9372) % 360
  const transit = 2451545 + mean + 0.0053 * Math.sin(anomaly * rad) - 0.0069 * Math.sin(2 * longitude * rad)
  const declination = Math.asin(Math.sin(longitude * rad) * Math.sin(23.4397 * rad))
  const hour = Math.acos(
    (Math.sin(-0.833 * rad) - Math.sin(place.lat * rad) * Math.sin(declination)) / (Math.cos(place.lat * rad) * Math.cos(declination)),
  )
  return (transit + hour / rad / 360 - 2440587.5) * DAY
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** The calendar day at `t` in the place's time zone, with its weekday (0 is Sunday). */
function localDay(t: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
      .formatToParts(t)
      .map(p => [p.type, p.value]),
  )
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), weekday: WEEKDAYS.indexOf(parts.weekday!) }
}

/** The day `k` days after y-m-d. */
const shift = (y: number, m: number, d: number, k: number) => {
  const at = new Date(Date.UTC(y, m - 1, d + k))
  return [at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate()] as const
}

/** Whether `t` falls in the Sabbath, and when the current or next one starts and ends. */
export function sabbath(t: number, place: Place = KNOWLTON): { on: boolean; start: number; end: number } {
  const { y, m, d, weekday } = localDay(t, place.timeZone)
  // This week's Friday: the coming one, or yesterday's on a Saturday.
  const toFriday = weekday === 6 ? -1 : 5 - weekday
  const friday = shift(y, m, d, toFriday)
  const start = sunset(...friday, place)
  const end = sunset(...shift(...friday, 1), place)
  if (t < end) return { on: t >= start, start, end }
  // Past Saturday's sunset: the next Sabbath is a week on.
  const next = shift(...friday, 7)
  return { on: false, start: sunset(...next, place), end: sunset(...shift(...next, 1), place) }
}

/** Agent work starts again this long after Saturday's sunset (owner, 2026-10-30). */
export const AFTER_MS = 30 * 60e3

/**
 * The rest at `t`: the Sabbath and the AFTER_MS after it, when no agent works.
 * `end` is when work starts again; off the rest, `start` and `end` are the next one's.
 */
export function rest(t: number, place: Place = KNOWLTON): { on: boolean; start: number; end: number } {
  const last = sabbath(t - AFTER_MS, place)
  if (t >= last.start && t - AFTER_MS < last.end) return { on: true, start: last.start, end: last.end + AFTER_MS }
  const s = sabbath(t, place)
  return { on: s.on, start: s.start, end: s.end + AFTER_MS }
}

/** The time from `from` to `to` (ms) outside every rest: the hours agents work. */
export function awake(from: number, to: number, place: Place = KNOWLTON): number {
  let total = 0
  for (let t = from; t < to; ) {
    const s = rest(t, place)
    if (s.on) {
      t = s.end
      continue
    }
    total += Math.min(to, s.start) - t
    t = s.end
  }
  return total
}

/** When `ms` of time outside every rest has passed since `from`. */
export function awakeAfter(from: number, ms: number, place: Place = KNOWLTON): number {
  for (let t = from, left = ms; ; ) {
    const s = rest(t, place)
    if (s.on) {
      t = s.end
      continue
    }
    if (left <= s.start - t) return t + left
    left -= s.start - t
    t = s.end
  }
}

/** A time as the place reads it: `Sat 17:38`. */
export const local = (t: number, place: Place = KNOWLTON) =>
  new Intl.DateTimeFormat('en-US', { timeZone: place.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(t)
