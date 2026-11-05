// The OS backstop's names and times. Every pending entry has an OS job (a
// launchd agent on macOS, a crontab line on Linux, both through Bun.cron) titled
// `opencode-wake-<id>`, so it fires though no OpenCode server runs. A job runs
// at a whole minute in local time, so it is set for the first minute at or
// after the entry's time. A repeat whose period the cron fields can say exactly
// gets a recurring job; any other entry gets a one-shot for its minute, set
// again after each fire. A one-shot line (`M H D Mo *`) names a date, so the
// year after it would run again: the job is removed once the entry fired or
// went.
import { type Entry, dueOf } from "./wake.ts"

export const TITLE_PREFIX = "opencode-wake-"

export const titleOf = (id: string): string => `${TITLE_PREFIX}${id}`

/** The entry id a backstop title names; undefined for any other title. */
export const idOfTitle = (title: string): string | undefined =>
  title.startsWith(TITLE_PREFIX) && title.length > TITLE_PREFIX.length ? title.slice(TITLE_PREFIX.length) : undefined

const MINUTE = 60_000

/** The first whole minute at or after `at`, in epoch ms. */
export const minuteOf = (at: number): number => Math.ceil(at / MINUTE) * MINUTE

/** An OS job's schedule: its five cron fields, and whether it fires more than once. */
export interface Schedule {
  readonly cron: string
  readonly recurring: boolean
}

/** One field listing every `step`-th value from `first`'s place in a `span`-long cycle. */
const stepped = (first: number, step: number, span: number): string =>
  step === 1 ? "*" : Array.from({ length: span / step }, (_, index) => (first % step) + index * step).join(",")

/** The one-shot for the minute of `at`, in local time. */
export const oneShot = (at: number): Schedule => {
  const minute = new Date(minuteOf(at))
  return { cron: `${minute.getMinutes()} ${minute.getHours()} ${minute.getDate()} ${minute.getMonth() + 1} *`, recurring: false }
}

/**
 * The job for `entry`: a recurring line when it repeats on a period the cron
 * fields hit on every tick (minutes dividing an hour, hours dividing a day, a
 * day, a week), else a one-shot for its next time.
 */
export const scheduleOf = (entry: Entry): Schedule => {
  const due = dueOf(entry)
  if (entry.kind !== "alarm" || entry.everySeconds === undefined || entry.everySeconds % 60 !== 0) return oneShot(due)
  const minutes = entry.everySeconds / 60
  const first = new Date(minuteOf(due))
  const m = first.getMinutes()
  const h = first.getHours()
  if (minutes < 60 && 60 % minutes === 0) return { cron: `${stepped(m, minutes, 60)} * * * *`, recurring: true }
  if (minutes % 60 === 0 && minutes / 60 < 24 && 24 % (minutes / 60) === 0) return { cron: `${m} ${stepped(h, minutes / 60, 24)} * * *`, recurring: true }
  if (minutes === 24 * 60) return { cron: `${m} ${h} * * *`, recurring: true }
  if (minutes === 7 * 24 * 60) return { cron: `${m} ${h} * * ${first.getDay()}`, recurring: true }
  return oneShot(due)
}

/** What a job's script needs to reach the entry's server with no environment: the entry, where it is armed, and how to start OpenCode. */
export interface Descriptor {
  readonly id: string
  readonly title: string
  readonly directory: string
  /** The `opencode` launcher, by absolute path: a cron or launchd job has a bare PATH. */
  readonly opencode: string
  /** The environment the server ran with that picks its state and config (XDG_*_HOME, OPENCODE_CONFIG_DIR, OPENCODE_DB, HOME). */
  readonly env: Readonly<Record<string, string>>
}

/** The job the model asks for: the entry, its title, and the directory whose server arms it. */
export type Job = Pick<Descriptor, "id" | "title" | "directory">

/** The variables a descriptor carries from the server's environment. */
export const CARRIED = ["HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_DB"] as const

/** The carried part of `env`. */
export const carried = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(CARRIED.flatMap((name) => {
    const value = env[name]
    return value === undefined || value === "" ? [] : [[name, value] as const]
  }))
