// What the wakes say. The fire's message, which the model reads: what fired,
// the note verbatim, when it was set, and how late it went (a fire due while
// no OpenCode server ran goes when one starts, and says so). The transcript
// draws its description as one notice row. Also the tools' receipts and the
// listing the agent reads after a handoff, and the letter a latch that could
// not open leaves its parent.
import type { Schema } from "effect"
import { type JobSpec, type Launched, LOG_TAIL, type Run } from "./job.ts"
import type { Latch } from "./latch.ts"
import { type Alarm, type Check, dueOf, type Entry, type Fired, type Fresh, type Job, type Monitor, type Notice } from "./wake.ts"

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

const noticeLine = (entry: Fired): ReadonlyArray<string> =>
  entry.mode === "notify" ? ["This is a notice: it started no turn, and you are reading it at your next one."] : []

const metadataOf = (entry: Fired, tick: number, firedAt: number, extra: Record<string, Schema.Json>): Record<string, Schema.Json> => ({
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

// ── Jobs ──

/** What a check, a wait, a kill or a job's letter reads of one job. */
export interface JobView {
  readonly spec: JobSpec
  readonly run: Run
  readonly log: string
  readonly unit?: string | undefined
  /** The log's last LOG_TAIL characters. */
  readonly logTail: string
  /** Progress lines not yet delivered (a letter), or the last ones (a check). */
  readonly progress: string
}

const commandOf = (spec: JobSpec) => `\`${spec.command}\``

/** How the run stands, after the job's id: `exited 0 after 12m`, `is running (3m so far)`. */
export const runPhrase = (run: Run, now: number): string => {
  switch (run.state) {
    case "starting":
      return "is starting"
    case "running":
      return `is running (${durationOf(now - run.startedAt)} so far)`
    case "lost":
      return `was lost: ${run.why}`
    case "ended": {
      const took = durationOf(run.exit.endedAt - run.exit.startedAt)
      if (run.exit.timedOut) return `was stopped at its timeout after ${took}`
      if (run.exit.killed) return `was killed after ${took}`
      if (run.exit.exitCode === null) return `was ended by ${run.exit.signal ?? "a signal"} after ${took}`
      return `exited ${run.exit.exitCode} after ${took}`
    }
  }
}

/** The short form for a transcript row. */
const runWord = (run: Run): string =>
  run.state === "ended"
    ? run.exit.timedOut
      ? "timed out"
      : run.exit.killed
        ? "killed"
        : run.exit.exitCode === null
          ? `ended by ${run.exit.signal ?? "a signal"}`
          : `exited ${run.exit.exitCode}`
    : run.state

const whereLine = (view: JobView): string => {
  const ran = view.run.state === "ended" ? ` from ${isoOf(view.run.exit.startedAt)} to ${isoOf(view.run.exit.endedAt)}` : ""
  return `It ran in ${view.spec.cwd}${ran}${view.spec.heavy ? ", niced (heavy)" : ""}. Log: ${view.log}${view.unit === undefined ? "" : ` (systemd unit ${view.unit})`}.`
}

const bodyOf = (view: JobView): ReadonlyArray<string> => [
  ...(view.progress === "" ? [] : ["Progress ($JOB_DRIP):", view.progress]),
  `Log tail:`,
  view.logTail.trim() === "" ? "(empty)" : tailOf(view.logTail, LOG_TAIL),
]

/** The tick a job's letter is for: when it ended, or the fire's time when it was lost. */
export const jobTick = (run: Run, firedAt: number): number => (run.state === "ended" ? run.exit.endedAt : firedAt)

/** The message a job's end carries: how it ended and after how long, where, how late, the note, its progress and the log's tail. */
export const jobLetter = (job: Job, view: JobView, firedAt: number): Letter => {
  const tick = jobTick(view.run, firedAt)
  const late = lateBy(tick, firedAt)
  return {
    text: [
      `⏰ Job ${job.id} ${runPhrase(view.run, firedAt)}: ${commandOf(view.spec)}.`,
      whereLine(view),
      ...(late === undefined ? [] : [`It ended ${durationOf(late)} before this letter: no OpenCode server was running then, so it went when one started.`]),
      `Note: ${job.note}`,
      ...bodyOf(view),
    ].join("\n"),
    description: rowOf(`job ${job.id} ${runWord(view.run)}`, tick, firedAt, job.note),
    metadata: metadataOf(job, tick, firedAt, {
      state: view.run.state,
      ...(view.run.state === "ended" ? { exitCode: view.run.exit.exitCode, timedOut: view.run.exit.timedOut, killed: view.run.exit.killed } : {}),
    }),
  }
}

/** Progress a running job wrote, delivered without starting a turn. */
export const dripLetter = (job: Job, lines: string, firedAt: number): Letter => ({
  text: [`⏰ Job ${job.id} progress (still running: ${commandOf(job)}):`, lines, "This started no turn; the job's end will."].join("\n"),
  description: `job ${job.id} · ${excerpt(lines.split("\n").at(-1) ?? "", LINE_NOTE)}`,
  metadata: { source: "wake", id: job.id, kind: "job", mode: "notify", setAt: job.setAt, tick: firedAt, firedAt, lateMs: 0, progress: true },
})

/** What starting a job answers: its id and log first, then how it runs and what comes back. */
export const jobReceipt = (job: Job, launched: Launched): string =>
  [
    `Job ${job.id} started. Log: ${launched.log}`,
    `It runs ${commandOf(job)} in ${job.cwd} ${launched.how === "systemd" ? `as the systemd user unit ${launched.unit ?? ""}` : "in its own process group"}${
      job.heavy ? ", niced" : ""
    }, outside the OpenCode server, so it outlives a restart; it is stopped if still running after ${durationOf(job.timeoutSeconds * 1000)}.`,
    ...(launched.warning === undefined ? [] : [launched.warning]),
    `Lines it appends to $JOB_DRIP (${launched.drip}) reach you as progress at most once a minute, without starting a turn.`,
    `When it ends, a letter with its exit code, duration, log tail and your note starts a turn here. End your turn now unless there is other work, or wait with job({ action: "wait", id: "${job.id}" }) when nothing else is left; a subagent waits, since its turn's end hands back to its parent.`,
  ].join("\n")

/** What `check`, `wait` and `kill` answer. */
export const jobReport = (view: JobView, now: number, said: ReadonlyArray<string> = []): string =>
  [`Job ${view.spec.id} ${runPhrase(view.run, now)}: ${commandOf(view.spec)}.`, whereLine(view), ...said, `Note: ${view.spec.note}`, ...bodyOf(view)].join("\n")

/** What `list` answers: this session's jobs still kept, and how each stands. */
export const jobListing = (jobs: ReadonlyArray<{ readonly job: Job; readonly run: Run }>, now: number): string =>
  jobs.length === 0
    ? "No jobs are running or waiting to report in this session."
    : [
        `Jobs (${jobs.length}):`,
        ...jobs.map(({ job, run }) => `- ${job.id}: ${runPhrase(run, now)} · ${commandOf(job)} in ${job.cwd} · note: ${excerpt(job.note, LINE_NOTE)}`),
      ].join("\n")

/** The first prompt of the session a `newSession` alarm starts: what it was asked to do, and where that came from. */
export const freshPrompt = (alarm: Alarm, fresh: Fresh, tick: number, firedAt: number): string =>
  [
    fresh.prompt,
    "",
    `(Started by wake ${alarm.id}, set at ${isoOf(alarm.setAt)} in session ${alarm.sessionID}, due ${isoOf(tick)}.${
      lateBy(tick, firedAt) === undefined ? "" : ` It went ${durationOf(firedAt - tick)} late: no OpenCode server was running at its time.`
    } Its note: ${alarm.note})`,
  ].join("\n")

/** What a latch that will not open tells its parent: which subagent, and why it did not start. */
export const latchFailedLetter = (latch: Latch, message: string, now: number): Letter => ({
  text: [
    `⏰ Latch ${latch.id} could not start its subagent: ${message}`,
    `The ${latch.subagent.agent} subagent "${latch.subagent.description}" (sessionID: ${latch.child}) latched at ${isoOf(latch.setAt)}, held by ${holdOf(latch)}; it did not start.`,
    "Call subagent again if the work is still wanted.",
  ].join("\n"),
  description: `latch ${latch.id} failed · ${excerpt(latch.subagent.description, LINE_NOTE)}`,
  metadata: { source: "wake", id: latch.id, kind: "latch", mode: "wake", setAt: latch.setAt, tick: now, firedAt: now, lateMs: 0, child: latch.child },
})

const holdOf = (latch: Latch) => (latch.hold === "sabbath" ? "the Sabbath" : "the pace")

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
  if (entry.kind === "latch")
    return [
      `- ${entry.id}: latch · the ${entry.subagent.agent} subagent "${entry.subagent.description}" (sessionID: ${entry.child})`,
      `held by ${holdOf(entry)}: ${entry.reason}`,
      `opens ${inOf(entry.opensAt, now)}`,
      ...(entry.recheckAt < entry.opensAt ? [`asked again ${inOf(entry.recheckAt, now)}`] : []),
    ].join(" · ")
  if (entry.kind === "job")
    return `- ${entry.id}: job · \`${entry.command}\` in ${entry.cwd} · started ${isoOf(entry.setAt)} · note: ${entry.note} · job({ action: "check", id: "${entry.id}" }) reads it`
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
    entries.length === 0 ? "No alarms, monitors or latches pending." : `Pending (${entries.length}):`,
    ...entries.toSorted((left, right) => dueOf(left) - dueOf(right)).map((entry) => listingOf(entry, now)),
    ...(notices.length === 0 ? [] : [`Unread notices (${notices.length}), delivered to your next turn:`, ...notices.map((notice) => `- ${notice.wakeID}: ${notice.description}`)]),
  ].join("\n")
