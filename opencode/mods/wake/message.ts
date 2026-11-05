// What the wakes say. The fire's message, which the model reads: what fired,
// the note verbatim, when it was set, and how late it went (a fire due while
// no OpenCode server ran goes when one starts, and says so). The transcript
// draws its description as one notice row. Also the tools' receipts and the
// listing the agent reads after a handoff.
import type { Schema } from "effect"
import { type Alarm, type Check, dueOf, type Entry, type Fresh, type Monitor, type Notice } from "./wake.ts"

/** A fire as the session reads it. */
export interface Letter {
  readonly text: string
  readonly description: string
  readonly metadata: Readonly<Record<string, Schema.Json>>
}

/** A fire this much past its time or more says it went late. */
export const LATE_MS = 60_000
/** The most of a monitor's last output its message carries. */
export const OUTPUT_TAIL = 2000
/** How much of the note the transcript's row keeps. */
export const LINE_NOTE = 60

export const isoOf = (millis: number): string => new Date(millis).toISOString()

/** A span as a person reads it: `45s`, `14m`, `2h 5m`, `3d 4h`. */
export const durationOf = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

/** The text on one line, at most `max` characters, `…` where it was cut. */
export const excerpt = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  const chars = [...flat]
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`
}

/** The end of `text`, at most `max` characters, `…` where it was cut. */
export const tailOf = (text: string, max = OUTPUT_TAIL): string => {
  const trimmed = text.trim()
  const chars = [...trimmed]
  return chars.length <= max ? trimmed : `…${chars.slice(chars.length - max).join("")}`
}

/** How late a fire for `tick` went at `firedAt`; undefined when on time. */
export const lateBy = (tick: number, firedAt: number): number | undefined => (firedAt - tick >= LATE_MS ? firedAt - tick : undefined)

const lateLine = (what: string, tick: number, firedAt: number): ReadonlyArray<string> => {
  const late = lateBy(tick, firedAt)
  return late === undefined
    ? []
    : [`It ${what} ${durationOf(late)} late: no OpenCode server was running at ${isoOf(tick)}, so it went when one started.`]
}

const noticeLine = (entry: Entry): ReadonlyArray<string> =>
  entry.mode === "notify" ? ["This is a notice: it started no turn, and you are reading it at your next one."] : []

const metadataOf = (entry: Entry, tick: number, firedAt: number, extra: Record<string, Schema.Json>): Record<string, Schema.Json> => ({
  source: "wake",
  id: entry.id,
  kind: entry.kind,
  mode: entry.mode,
  setAt: entry.setAt,
  tick,
  firedAt,
  lateMs: Math.max(0, firedAt - tick),
  ...extra,
})

const rowOf = (head: string, tick: number, firedAt: number, note: string): string => {
  const late = lateBy(tick, firedAt)
  return [head, ...(late === undefined ? [] : [`${durationOf(late)} late`]), excerpt(note, LINE_NOTE)].join(" · ")
}

/** The message an alarm's fire for `tick` carries; `next` is a repeat's next due time. */
export const alarmLetter = (alarm: Alarm, tick: number, firedAt: number, next?: number): Letter => ({
  text: [
    `⏰ Wake ${alarm.id} fired: the alarm you set at ${isoOf(alarm.setAt)}, due ${isoOf(tick)}.`,
    ...lateLine("fired", tick, firedAt),
    ...noticeLine(alarm),
    ...(next === undefined || alarm.everySeconds === undefined
      ? []
      : [`It repeats every ${durationOf(alarm.everySeconds * 1000)}; the next is due ${isoOf(next)}. Cancel it with wake_cancel({ id: "${alarm.id}" }) once its work is done.`]),
    `Note: ${alarm.note}`,
  ].join("\n"),
  description: rowOf(alarm.mode === "notify" ? `notice ${alarm.id}` : `wake ${alarm.id}`, tick, firedAt, alarm.note),
  metadata: metadataOf(alarm, tick, firedAt, {}),
})

/** How a monitor ended: its check matched, or its deadline came first. */
export type Outcome = "matched" | "timed-out"

/** The message a monitor's end carries: how it ended, after how many checks, the note, and the last output's tail. */
export const monitorLetter = (monitor: Monitor, outcome: Outcome, checks: number, last: Check | undefined, firedAt: number): Letter => {
  const done = monitor.until === undefined ? "exited 0" : `printed a match for /${monitor.until}/`
  const head =
    outcome === "matched"
      ? `⏰ Monitor ${monitor.id} matched: \`${monitor.command}\` ${done} after ${checks} ${checks === 1 ? "check" : "checks"}.`
      : `⏰ Monitor ${monitor.id} timed out: \`${monitor.command}\` never ${done} in ${checks} ${checks === 1 ? "check" : "checks"}; its deadline was ${isoOf(monitor.deadline)}.`
  const output = last === undefined ? "" : tailOf([last.stdout, last.stderr].filter((part) => part.trim() !== "").join("\n"))
  return {
    text: [
      head,
      `You set it at ${isoOf(monitor.setAt)} to check every ${durationOf(monitor.intervalSeconds * 1000)} in ${monitor.cwd}.`,
      ...(outcome === "timed-out" ? lateLine("gave up", monitor.deadline, firedAt) : []),
      ...noticeLine(monitor),
      `Note: ${monitor.note}`,
      ...(last === undefined ? [] : [`Last output (exit ${last.timedOut ? "none: the check ran out of time" : last.exitCode}):`, output === "" ? "(none)" : output]),
    ].join("\n"),
    description: rowOf(`monitor ${monitor.id} ${outcome === "matched" ? "matched" : "timed out"}`, outcome === "matched" ? firedAt : monitor.deadline, firedAt, monitor.note),
    metadata: metadataOf(monitor, outcome === "matched" ? firedAt : monitor.deadline, firedAt, { outcome, checks }),
  }
}

/** The first prompt of the session a `newSession` alarm starts: what it was asked to do, and where that came from. */
export const freshPrompt = (alarm: Alarm, fresh: Fresh, tick: number, firedAt: number): string =>
  [
    fresh.prompt,
    "",
    `(Started by wake ${alarm.id}, set at ${isoOf(alarm.setAt)} in session ${alarm.sessionID}, due ${isoOf(tick)}.${
      lateBy(tick, firedAt) === undefined ? "" : ` It went ${durationOf(firedAt - tick)} late: no OpenCode server was running at its time.`
    } Its note: ${alarm.note})`,
  ].join("\n")

// ── Receipts ──

const inOf = (at: number, now: number) => `${isoOf(at)} (in ${durationOf(at - now)})`

/** Said when the OS backstop could not be set: the entry still fires, but only while a server runs. */
export const unguarded = (reason: string) => `No OS backstop was set (${reason}): it fires only while an OpenCode server runs.`

/** What the `wake` tool answers. */
export const alarmReceipt = (alarm: Alarm, now: number, warning?: string): string =>
  [
    alarm.newSession === undefined
      ? `Alarm ${alarm.id} set: it ${alarm.mode === "notify" ? "leaves a notice for" : "wakes"} this session at ${inOf(alarm.dueAt, now)}${
          alarm.everySeconds === undefined ? "" : `, then every ${durationOf(alarm.everySeconds * 1000)} until you cancel it`
        }.`
      : `Alarm ${alarm.id} set: it starts a new session in ${alarm.newSession.directory} at ${inOf(alarm.dueAt, now)}${
          alarm.everySeconds === undefined ? "" : `, then every ${durationOf(alarm.everySeconds * 1000)} until you cancel it`
        }.`,
    ...(warning === undefined ? [] : [warning]),
    alarm.mode === "wake" && alarm.newSession === undefined
      ? "End your turn now unless there is other work: the alarm starts a new turn with your note."
      : `Cancel it with wake_cancel({ id: "${alarm.id}" }).`,
  ].join("\n")

/** What the `monitor` tool answers. */
export const monitorReceipt = (monitor: Monitor, now: number, warning?: string): string =>
  [
    `Monitor ${monitor.id} set: it runs \`${monitor.command}\` in ${monitor.cwd} every ${durationOf(monitor.intervalSeconds * 1000)} until ${
      monitor.until === undefined ? "it exits 0" : `its stdout matches /${monitor.until}/`
    }, and gives up at ${inOf(monitor.deadline, now)}.`,
    ...(warning === undefined ? [] : [warning]),
    monitor.mode === "wake"
      ? "End your turn now unless there is other work: the monitor starts a new turn with its last output and your note."
      : "Its result waits for your next turn, and the user sees it meanwhile.",
  ].join("\n")

/** What `wake_cancel` answers. */
export const cancelReceipt = (cancelled: ReadonlyArray<string>): string =>
  cancelled.length === 0 ? "Nothing was pending to cancel." : `Cancelled ${cancelled.join(", ")}.`

const listingOf = (entry: Entry, now: number): string => {
  if (entry.kind === "alarm")
    return [
      `- ${entry.id}: alarm · ${entry.mode} · due ${inOf(entry.dueAt, now)}`,
      ...(entry.everySeconds === undefined ? [] : [`every ${durationOf(entry.everySeconds * 1000)}`]),
      ...(entry.newSession === undefined ? [] : [`starts a session in ${entry.newSession.directory}`]),
      `note: ${entry.note}`,
    ].join(" · ")
  return [
    `- ${entry.id}: monitor · ${entry.mode} · \`${entry.command}\` every ${durationOf(entry.intervalSeconds * 1000)}`,
    entry.until === undefined ? "until exit 0" : `until /${entry.until}/`,
    `gives up ${inOf(entry.deadline, now)}`,
    `note: ${entry.note}`,
  ].join(" · ")
}

/** What `wake_list` answers: now, every pending entry, and the notices the session has not read. */
export const listing = (entries: ReadonlyArray<Entry>, notices: ReadonlyArray<Notice>, now: number): string =>
  [
    `Now: ${isoOf(now)}.`,
    entries.length === 0 ? "No alarms or monitors pending." : `Pending (${entries.length}):`,
    ...entries.toSorted((left, right) => dueOf(left) - dueOf(right)).map((entry) => listingOf(entry, now)),
    ...(notices.length === 0 ? [] : [`Unread notices (${notices.length}), delivered to your next turn:`, ...notices.map((notice) => `- ${notice.wakeID}: ${notice.description}`)]),
  ].join("\n")
