// A session's wakes as Prime shows them, plain values. The dock's wake item
// while the session has wakes pending or notices unread, counts only:
// `2 wakes · 1 monitor · 1 notice`, alarms counted as wakes, parts dropping
// from the right as the width shrinks. And the composer panel's Wakes and
// Monitors tabs (tui/composer.tsx): one row per alarm or monitor, the detail
// Enter shows, and what an empty tab says. The reading comes from the wake
// mod's RPC (opencode/wakes.ts).

/** A monitor's newest check: when, its exit code, and its output's tail. */
export type LastCheck = { readonly at: number; readonly exitCode: number; readonly output: string }

/** One pending alarm or monitor. */
export type WakeEntry = {
  readonly id: string
  readonly kind: "alarm" | "monitor"
  /** An alarm's due time, a monitor's deadline, epoch ms. */
  readonly dueAt: number
  /** When it was set, epoch ms, when the wake server says. */
  readonly setAt?: number
  readonly note: string
  /** `wake` starts a turn when it fires; `notify` waits for the next one. */
  readonly mode: "wake" | "notify"
  /** An alarm's repeat. */
  readonly everySeconds?: number | undefined
  /** A monitor's command, check period and stop pattern. */
  readonly command?: string | undefined
  readonly intervalSeconds?: number | undefined
  readonly until?: string | undefined
  /** A monitor's newest check, once it ran one. */
  readonly last?: LastCheck | undefined
}

/** What Prime reads of a session's wakes: each pending alarm and monitor, and how many notices are unread. */
export type Wakes = {
  /** The wake server's clock when it answered, epoch ms. */
  readonly now: number
  readonly entries: ReadonlyArray<WakeEntry>
  readonly notices: number
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** The dock's wake item: its words and their tone. */
export type WakeItem = { readonly text: string; readonly tone: "success" | "warning" }

/** Whether two wake items (`wakeItem`'s answers) draw the same: the dock keeps its item while a new reading says the same. */
export const sameWakeItem = (a: ReturnType<typeof wakeItem>, b: ReturnType<typeof wakeItem>): boolean => a?.text === b?.text && a?.tone === b?.tone

/**
 * The wake item, in at most `max` cells (the first part always
 * shows): `success` while anything is pending, `warning` with only notices
 * unread. Undefined when nothing is pending or unread.
 */
export const wakeItem = (wakes: Wakes, max: number): WakeItem | undefined => {
  const alarms = wakes.entries.filter((entry) => entry.kind === "alarm")
  const monitors = wakes.entries.filter((entry) => entry.kind === "monitor")
  if (alarms.length === 0 && monitors.length === 0 && wakes.notices === 0) return undefined
  const counts = [...(alarms.length === 0 ? [] : [plural(alarms.length, "wake", "wakes")]), ...(monitors.length === 0 ? [] : [plural(monitors.length, "monitor", "monitors")])]
  const notices = wakes.notices === 0 ? [] : [plural(wakes.notices, "notice", "notices")]
  const parts = [...counts, ...notices]
  let kept = parts.length
  while (kept > 1 && [...parts.slice(0, kept).join(" · ")].length > max) kept -= 1
  return { text: parts.slice(0, kept).join(" · "), tone: wakes.entries.length > 0 ? "success" : "warning" }
}

// ── The composer panel's tabs ──

/** The two tabs: alarms under Wakes, monitors under Monitors. */
export type WakeTab = "alarm" | "monitor"

/** What an empty tab says. */
export const EMPTY: Record<WakeTab, string> = { alarm: "No pending wakes", monitor: "No monitors" }

/** How many characters a row's free text (a note, a command, an output line) shows. */
const CLIP = 48

const clip = (text: string, max = CLIP) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const firstLine = (text: string) => text.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? ""

/** A length of time in its two largest units: `45s`, `10m`, `2h 05m`, `3d 4h`. */
export function span(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const minutes = Math.floor(s / 60)
  if (minutes < 60) return s % 60 === 0 ? `${minutes}m` : `${minutes}m ${String(s % 60).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

const two = (value: number) => String(value).padStart(2, "0")
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** A time in local hours, `14:10`, with its day in front when it is not `now`'s day: `Nov 7 14:10`. */
export function clock(at: number, now: number): string {
  const date = new Date(at)
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`
  return new Date(now).toDateString() === date.toDateString() ? time : `${MONTHS[date.getMonth()]} ${date.getDate()} ${time}`
}

/** When it is due, as the row reads it: `14:10 in 10m`, or `due now` once the time passed. */
export function when(at: number, now: number): string {
  return at <= now ? `${clock(at, now)} due now` : `${clock(at, now)} in ${span((at - now) / 1000)}`
}

/** How it repeats: `once`, or `every 1h`. */
export const repeat = (entry: Pick<WakeEntry, "everySeconds">) => (entry.everySeconds === undefined ? "once" : `every ${span(entry.everySeconds)}`)

/** What the monitor stops on: its pattern, else a check that exits 0. */
export const stopsOn = (entry: Pick<WakeEntry, "until">) => (entry.until === undefined ? "until exit 0" : `until /${entry.until}/`)

/** The newest check's last line with text, or what stands in for it. */
export function lastOutput(last: LastCheck | undefined): string {
  if (last === undefined) return "not checked yet"
  const line = last.output
    .split(/\r?\n/)
    .map((each) => each.trim())
    .findLast((each) => each !== "")
  return line === undefined ? `exit ${last.exitCode}, no output` : clip(line)
}

/** The entries one tab lists, soonest first. */
export const tabEntries = (wakes: Wakes | undefined, tab: WakeTab): ReadonlyArray<WakeEntry> =>
  (wakes?.entries ?? []).filter((entry) => entry.kind === tab).toSorted((a, b) => a.dueAt - b.dueAt)

/**
 * One row of a tab, its parts joined with ` · `. An alarm: when it is due,
 * its note's first line, its mode, its repeat. A monitor: its command, its
 * check period, what it stops on, its newest output line.
 */
export function wakeRow(entry: WakeEntry, now: number): string {
  if (entry.kind === "alarm") return [when(entry.dueAt, now), clip(firstLine(entry.note)), entry.mode, repeat(entry)].join(" · ")
  return [clip(firstLine(entry.command ?? "")), `every ${span(entry.intervalSeconds ?? 0)}`, stopsOn(entry), lastOutput(entry.last)].join(" · ")
}

/** What Enter shows for an entry: a title and the whole of it. */
export function wakeDetail(entry: WakeEntry, now: number): { readonly title: string; readonly message: string } {
  const mode = entry.mode === "wake" ? "wake: its fire starts a turn" : "notify: its fire waits for the next turn"
  if (entry.kind === "alarm")
    return {
      title: `Wake ${entry.id}`,
      message: [`Due: ${when(entry.dueAt, now)}`, `Repeat: ${repeat(entry)}`, `Mode: ${mode}`, "", entry.note].join("\n"),
    }
  const last = entry.last
  return {
    title: `Monitor ${entry.id}`,
    message: [
      `Command: ${entry.command ?? ""}`,
      `Checks: every ${span(entry.intervalSeconds ?? 0)}, ${stopsOn(entry)}`,
      `Gives up: ${when(entry.dueAt, now)}`,
      `Mode: ${mode}`,
      "",
      last === undefined ? "Not checked yet." : `Last check: ${clock(last.at, now)}, exit ${last.exitCode}`,
      ...(last === undefined ? [] : [last.output === "" ? "(no output)" : last.output]),
      "",
      entry.note,
    ].join("\n"),
  }
}
