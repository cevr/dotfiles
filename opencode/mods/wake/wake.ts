// Wakes: alarms and monitors a session sets on itself, the long jobs it starts
// outside the server (job.ts), the latches
// orchestrate keeps for its held subagent starts (latch.ts), and the notices a
// `notify` fire leaves for the owner. An entry is kept from the moment it is
// set until its fire reached the session; the fire is recorded on the entry,
// with the id of the message that carries it, before it is sent, so a fire
// that stopped short (a reload, a crash) goes again under the same id and the
// session reads it once. Also the wakes' RPC, which the TUI and the OS
// backstop call.
import { Schema } from "effect"
import { DEFAULT_JOB_TIMEOUT_SECONDS, type JobSpec, MAX_JOB_TIMEOUT_SECONDS } from "./job.ts"
import { Latch } from "./latch.ts"

/** `wake`: the fire starts a turn. `notify`: it waits for the session's next turn and shows to the owner meanwhile. */
export const Mode = Schema.Literals(["wake", "notify"])
export type Mode = typeof Mode.Type

/** A fire recorded before it is sent: the message's id, what it says, and the tick it fired for. */
export const Firing = Schema.Struct({
  delivery: Schema.String,
  /** The session a `newSession` alarm starts, minted with the fire so a resend starts the same one. */
  session: Schema.optional(Schema.String),
  text: Schema.String,
  description: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Json),
  /** Epoch ms. */
  firedAt: Schema.Number,
  /** The due time it fired for (an alarm), or the deadline (a monitor). */
  tick: Schema.Number,
  /** A repeating monitor's match: once it reached the session the monitor goes on checking. */
  again: Schema.optional(Schema.Boolean),
})
export type Firing = typeof Firing.Type

/** An alarm's fresh session: where it starts and what it is told. */
export const Fresh = Schema.Struct({ directory: Schema.String, prompt: Schema.String })
export type Fresh = typeof Fresh.Type

const base = {
  /** `w` and six base-36 characters. */
  id: Schema.String,
  /** The session that set it: the one it wakes, and whose tray shows it. */
  sessionID: Schema.String,
  /** The directory whose server arms it. */
  directory: Schema.String,
  mode: Mode,
  note: Schema.String,
  /** Epoch ms. */
  setAt: Schema.Number,
  firing: Schema.optional(Firing),
}

export const Alarm = Schema.Struct({
  kind: Schema.Literal("alarm"),
  ...base,
  /** Epoch ms: the next fire. */
  dueAt: Schema.Number,
  everySeconds: Schema.optional(Schema.Number),
  newSession: Schema.optional(Fresh),
})
export type Alarm = typeof Alarm.Type

/**
 * How a monitor goes on after a match. Absent: it fires once and goes.
 * `match`: it keeps checking and fires on each new match, a match after a
 * check that did not match. `change`: it keeps checking and fires each time a
 * matching check's stdout differs from the last matching one's; the first
 * match is the baseline, and fires nothing.
 */
export const Repeat = Schema.Literals(["match", "change"])
export type Repeat = typeof Repeat.Type

export const Monitor = Schema.Struct({
  kind: Schema.Literal("monitor"),
  ...base,
  command: Schema.String,
  cwd: Schema.String,
  intervalSeconds: Schema.Number,
  until: Schema.optional(Schema.String),
  /** Epoch ms: past it the monitor gives up and wakes anyway (a repeating one: it ends, and says so). */
  deadline: Schema.Number,
  repeat: Schema.optional(Repeat),
  /** A `match` repeat's: whether its last check matched. */
  matching: Schema.optional(Schema.Boolean),
  /** A `change` repeat's: the fingerprint of its last matching stdout. */
  seen: Schema.optional(Schema.String),
  /** A repeat's: how many matches it fired. */
  fired: Schema.optional(Schema.Number),
})
export type Monitor = typeof Monitor.Type

/**
 * A long command running outside the server (job.ts), whose end fires a
 * letter into its session. Its run lives with its runner; the entry keeps what
 * the letter needs and how far its progress file was delivered.
 */
export const Job = Schema.Struct({
  kind: Schema.Literal("job"),
  ...base,
  /** Always `wake`: the end starts a turn. */
  mode: Schema.Literal("wake"),
  command: Schema.String,
  cwd: Schema.String,
  heavy: Schema.Boolean,
  timeoutSeconds: Schema.Number,
  /** Bytes of `$JOB_DRIP` already delivered as progress. */
  dripped: Schema.Number,
  /** Epoch ms: the last progress delivery, or when it was set. */
  drippedAt: Schema.Number,
})
export type Job = typeof Job.Type

export const Entry = Schema.Union([Alarm, Monitor, Latch, Job])
export type Entry = typeof Entry.Type

/** An entry that fires a letter into its session: an alarm, a monitor, or a job's end. A latch opens instead. */
export type Fired = Alarm | Monitor | Job

export const fires = (entry: Entry): entry is Fired => entry.kind !== "latch"

/** A `notify` fire the session has not read yet: the owner's tray shows it until the session's next turn takes it. */
export const Notice = Schema.Struct({
  delivery: Schema.String,
  wakeID: Schema.String,
  sessionID: Schema.String,
  directory: Schema.String,
  description: Schema.String,
  firedAt: Schema.Number,
})
export type Notice = typeof Notice.Type

// ── Limits ──

/** The farthest an alarm or a repeat lies ahead. The OS backstop (a cron line for the due minute) reaches any time within the year. */
export const MAX_AHEAD_SECONDS = 365 * 24 * 60 * 60
/** A repeat's shortest period: one OS cron minute. */
export const MIN_EVERY_SECONDS = 60
export const DEFAULT_INTERVAL_SECONDS = 30
export const MIN_INTERVAL_SECONDS = 1
export const DEFAULT_TIMEOUT_SECONDS = 1800
export const MAX_TIMEOUT_SECONDS = 86_400
/** A repeating monitor's: it watches for a day unless told otherwise, and at most 30 days. */
export const DEFAULT_REPEAT_TIMEOUT_SECONDS = 86_400
export const MAX_REPEAT_TIMEOUT_SECONDS = 30 * 86_400
/** A note's most characters. */
export const MAX_NOTE = 2000

// ── Rejections ──

/** The call was refused; `reason` says why, as the agent reads it. */
export class WakeRejected extends Schema.TaggedError<WakeRejected>()("WakeRejected", { reason: Schema.String }) {}

// ── Arming ──

/** The alarm as asked, before it has an id or a place. */
export interface AlarmAsk {
  readonly afterSeconds?: number | undefined
  readonly at?: string | undefined
  readonly everySeconds?: number | undefined
  readonly mode?: Mode | undefined
  readonly note: string
  readonly newSession?: { readonly directory?: string | undefined; readonly prompt: string } | undefined
}

/** The monitor as asked. */
export interface MonitorAsk {
  readonly command: string
  readonly cwd?: string | undefined
  readonly intervalSeconds?: number | undefined
  readonly until?: string | undefined
  readonly timeoutSeconds?: number | undefined
  readonly mode?: Mode | undefined
  readonly note: string
  readonly repeat?: Repeat | undefined
  /** A `change` repeat's baseline: the stdout it starts from, as if a check had printed it. */
  readonly baseline?: string | undefined
}

/** Where an entry is set: the session, its server's directory, the id it takes and the time. */
export interface Place {
  readonly id: string
  readonly sessionID: string
  readonly directory: string
  readonly now: number
}

const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value)

const noteOf = (note: string): string | WakeRejected => {
  if (note.trim() === "") return new WakeRejected({ reason: "note is empty: say what to check when it fires, and what result means done" })
  if (note.length > MAX_NOTE) return new WakeRejected({ reason: `note is ${note.length} characters; at most ${MAX_NOTE}` })
  return note
}

/**
 * The due time `afterSeconds` or `at` names, in epoch ms. An `at` written to
 * the second names the whole second, so one within the current second is now.
 */
export const dueAtOf = (ask: Pick<AlarmAsk, "afterSeconds" | "at">, now: number): number | WakeRejected => {
  if (ask.afterSeconds !== undefined && ask.at !== undefined) return new WakeRejected({ reason: "give afterSeconds or at, not both" })
  let due: number
  if (ask.afterSeconds !== undefined) {
    if (!finite(ask.afterSeconds) || ask.afterSeconds < 0) return new WakeRejected({ reason: "afterSeconds must be a number of seconds, 0 or more" })
    due = now + ask.afterSeconds * 1000
  } else if (ask.at !== undefined) {
    const at = Date.parse(ask.at)
    if (!Number.isFinite(at)) return new WakeRejected({ reason: `at is not an ISO 8601 time: ${ask.at}` })
    const second = now - (now % 1000)
    if (at < second) return new WakeRejected({ reason: `at is in the past: ${ask.at}` })
    due = Math.max(at, now)
  } else return new WakeRejected({ reason: "give afterSeconds (a number) or at (an ISO 8601 time)" })
  if (due - now > MAX_AHEAD_SECONDS * 1000) return new WakeRejected({ reason: "an alarm can be at most 365 days away" })
  return due
}

/** The alarm `ask` sets at `place`, or why not. A fresh session starts in `place.directory` unless it names another. */
export const alarmOf = (ask: AlarmAsk, place: Place): Alarm | WakeRejected => {
  const note = noteOf(ask.note)
  if (note instanceof WakeRejected) return note
  const dueAt = dueAtOf(ask, place.now)
  if (dueAt instanceof WakeRejected) return dueAt
  if (ask.everySeconds !== undefined) {
    if (!finite(ask.everySeconds) || ask.everySeconds < MIN_EVERY_SECONDS)
      return new WakeRejected({ reason: `everySeconds must be at least ${MIN_EVERY_SECONDS}` })
    if (ask.everySeconds > MAX_AHEAD_SECONDS) return new WakeRejected({ reason: "everySeconds can be at most 365 days" })
  }
  const fresh = ask.newSession
  if (fresh !== undefined && fresh.prompt.trim() === "") return new WakeRejected({ reason: "newSession.prompt is empty: say what the new session should do" })
  if (fresh !== undefined && ask.mode === "notify") return new WakeRejected({ reason: "a newSession alarm starts a session; notify mode cannot" })
  if (fresh?.directory !== undefined && !fresh.directory.startsWith("/")) return new WakeRejected({ reason: "newSession.directory must be an absolute path" })
  return {
    kind: "alarm",
    id: place.id,
    sessionID: place.sessionID,
    directory: place.directory,
    mode: ask.mode ?? "wake",
    note,
    setAt: place.now,
    dueAt,
    ...(ask.everySeconds === undefined ? {} : { everySeconds: ask.everySeconds }),
    ...(fresh === undefined ? {} : { newSession: { directory: fresh.directory ?? place.directory, prompt: fresh.prompt } }),
  }
}

/** Whether `pattern` compiles as a regular expression; `RegExp` is the only thing in the language that says. */
export const validPattern = (pattern: string): boolean => {
  try {
    return new RegExp(pattern).source.length >= 0
  } catch {
    return false
  }
}

/** The monitor `ask` sets at `place`, or why not. Its command runs in `cwd`, else the server's directory. */
export const monitorOf = (ask: MonitorAsk, place: Place): Monitor | WakeRejected => {
  const note = noteOf(ask.note)
  if (note instanceof WakeRejected) return note
  if (ask.command.trim() === "") return new WakeRejected({ reason: "command is empty" })
  if (ask.until !== undefined && !validPattern(ask.until)) return new WakeRejected({ reason: `until is not a valid regular expression: ${ask.until}` })
  const interval = ask.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS
  if (!finite(interval) || interval < MIN_INTERVAL_SECONDS) return new WakeRejected({ reason: `intervalSeconds must be at least ${MIN_INTERVAL_SECONDS}` })
  if (ask.repeat !== undefined && ask.repeat !== "match" && ask.repeat !== "change") return new WakeRejected({ reason: `repeat is "match" or "change", not ${String(ask.repeat)}` })
  if (ask.baseline !== undefined && ask.repeat !== "change") return new WakeRejected({ reason: 'a baseline is for repeat: "change"' })
  const most = ask.repeat === undefined ? MAX_TIMEOUT_SECONDS : MAX_REPEAT_TIMEOUT_SECONDS
  const timeout = ask.timeoutSeconds ?? (ask.repeat === undefined ? DEFAULT_TIMEOUT_SECONDS : DEFAULT_REPEAT_TIMEOUT_SECONDS)
  if (!finite(timeout) || timeout <= 0 || timeout > most) return new WakeRejected({ reason: `timeoutSeconds must be more than 0 and at most ${most}` })
  if (ask.cwd !== undefined && !ask.cwd.startsWith("/")) return new WakeRejected({ reason: "cwd must be an absolute path" })
  return {
    kind: "monitor",
    id: place.id,
    sessionID: place.sessionID,
    directory: place.directory,
    mode: ask.mode ?? "wake",
    note,
    setAt: place.now,
    command: ask.command,
    cwd: ask.cwd ?? place.directory,
    intervalSeconds: interval,
    ...(ask.until === undefined ? {} : { until: ask.until }),
    deadline: place.now + timeout * 1000,
    ...(ask.repeat === undefined ? {} : { repeat: ask.repeat }),
    ...(ask.baseline === undefined ? {} : { seen: fingerprint(ask.baseline) }),
  }
}

/** A stdout's fingerprint, as a `change` repeat keeps it: FNV-1a over its trimmed text, in hex. */
export const fingerprint = (stdout: string): string => {
  let hash = 0x811c9dc5
  for (const char of stdout.trim()) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/** What a repeat keeps between checks. */
export interface MonitorState {
  readonly matching?: boolean
  readonly seen?: string
}

/**
 * What one check does to a monitor: whether it fires, and the state it
 * leaves. A one-shot fires on a match. A `match` repeat fires on a match
 * after a check that did not match (or its first). A `change` repeat fires on
 * a match whose stdout differs from the last match's; the first match only
 * sets the baseline. A check that does not match leaves a `change` repeat as
 * it was.
 */
export const stepOf = (monitor: Monitor, check: Check): { readonly fire: boolean; readonly state: MonitorState } => {
  const hit = matched(monitor, check)
  switch (monitor.repeat) {
    case undefined:
      return { fire: hit, state: {} }
    case "match":
      return { fire: hit && monitor.matching !== true, state: { matching: hit } }
    case "change": {
      if (!hit) return { fire: false, state: monitor.seen === undefined ? {} : { seen: monitor.seen } }
      const seen = fingerprint(check.stdout)
      return { fire: monitor.seen !== undefined && monitor.seen !== seen, state: { seen } }
    }
  }
}

/** Whether `state` differs from what the monitor keeps. */
export const moved = (monitor: Monitor, state: MonitorState): boolean =>
  (state.matching !== undefined && state.matching !== monitor.matching) || (state.seen !== undefined && state.seen !== monitor.seen)

/** The job as asked. */
export interface JobAsk {
  readonly command: string
  readonly cwd?: string | undefined
  readonly note: string
  readonly heavy?: boolean | undefined
  readonly timeoutSeconds?: number | undefined
}

/** The job `ask` starts at `place`, or why not. It runs in `cwd`, else the server's directory. */
export const jobOf = (ask: JobAsk, place: Place): Job | WakeRejected => {
  const note = noteOf(ask.note)
  if (note instanceof WakeRejected) return note
  if (ask.command.trim() === "") return new WakeRejected({ reason: "command is empty" })
  const timeout = ask.timeoutSeconds ?? DEFAULT_JOB_TIMEOUT_SECONDS
  if (!finite(timeout) || timeout <= 0 || timeout > MAX_JOB_TIMEOUT_SECONDS)
    return new WakeRejected({ reason: `timeoutSeconds must be more than 0 and at most ${MAX_JOB_TIMEOUT_SECONDS}` })
  if (ask.cwd !== undefined && !ask.cwd.startsWith("/")) return new WakeRejected({ reason: "cwd must be an absolute path" })
  return {
    kind: "job",
    id: place.id,
    sessionID: place.sessionID,
    directory: place.directory,
    mode: "wake",
    note,
    setAt: place.now,
    command: ask.command,
    cwd: ask.cwd ?? place.directory,
    heavy: ask.heavy ?? false,
    timeoutSeconds: timeout,
    dripped: 0,
    drippedAt: place.now,
  }
}

/** What the runner keeps of a job. */
export const specOf = (job: Job): JobSpec => ({
  id: job.id,
  sessionID: job.sessionID,
  directory: job.directory,
  command: job.command,
  cwd: job.cwd,
  note: job.note,
  heavy: job.heavy,
  timeoutSeconds: job.timeoutSeconds,
  setAt: job.setAt,
})

// ── Firing ──

/** The next tick of a repeat still ahead of `now`; every tick missed while no server ran folds into the fire that just happened. */
export const nextDueAt = (dueAt: number, everySeconds: number, now: number): number => {
  const every = Math.max(everySeconds, MIN_EVERY_SECONDS) * 1000
  const missed = Math.max(0, Math.floor((now - dueAt) / every))
  return dueAt + (missed + 1) * every
}

/** When an entry next needs its server: an alarm's due time, a monitor's deadline, the time a latch says it opens. */
export const dueOf = (entry: Entry): number =>
  entry.kind === "alarm" ? entry.dueAt : entry.kind === "monitor" ? entry.deadline : entry.kind === "latch" ? entry.opensAt : entry.setAt + entry.timeoutSeconds * 1000

/** Whether an entry has an OS backstop job: every kind but a job, whose own runner calls the server when it ends. */
export const guarded = (entry: Entry): boolean => entry.kind !== "job"

/** What a check of a monitor's command found. */
export interface Check {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /** The check ran past its time and was stopped. */
  readonly timedOut: boolean
}

/**
 * Whether a check means the monitor is done: its stdout matches `until`, or,
 * without one, the command exited 0. A check stopped for its time is never done.
 */
export const matched = (monitor: Pick<Monitor, "until">, check: Check): boolean => {
  if (check.timedOut) return false
  if (monitor.until === undefined) return check.exitCode === 0
  return validPattern(monitor.until) && new RegExp(monitor.until, "m").test(check.stdout)
}

/** Whose they are: the entries and notices set by `sessionIDs`. */
export const ofSessions = <A extends { readonly sessionID: string }>(rows: ReadonlyArray<A>, sessionIDs: ReadonlyArray<string>): ReadonlyArray<A> =>
  rows.filter((row) => sessionIDs.includes(row.sessionID))

// ── The RPC ──

const object = (properties: Record<string, unknown>, required: ReadonlyArray<string>) => ({ type: "object", properties, required }) as const
const text = { type: "string" } as const

/**
 * The wakes' RPC.
 * - `pending({ sessionIDs })`: what those sessions have pending, and their unread notices.
 * - `due({ id })`: the OS backstop's call when its job fires: fire the entry if it is due and not yet fired. `Due` says what happened.
 * - `latch(LatchAsk)`: keep a held subagent start as a latch of the asking session, with its child session made unprompted. `Latched` says its id and child, or why not.
 * - `cancel({ sessionID, id })`: the owner cancels one of the session's entries, as `wake_cancel` does. `Cancelled` says which ids went, or why not.
 * - `set({ sessionID, wake } | { sessionID, monitor })`: set an alarm or a monitor for that session, as its own `wake` or `monitor` call would (scripts/migrate-schedules.ts uses it). `Armed` says its id, or why not.
 * - `changed({ sessionID })`: published after every change to a session's wakes.
 */
export const WAKES = {
  id: "dotfiles-opencode.wake",
  methods: {
    pending: { input: object({ sessionIDs: { type: "array", items: text } }, ["sessionIDs"]), output: { type: "object" } },
    due: { input: object({ id: text }, ["id"]), output: { type: "object" } },
    latch: { input: { type: "object" }, output: { type: "object" } },
    cancel: { input: object({ sessionID: text, id: text }, ["sessionID", "id"]), output: { type: "object" } },
    set: { input: object({ sessionID: text, wake: { type: "object" }, monitor: { type: "object" } }, ["sessionID"]), output: { type: "object" } },
  },
  events: {
    changed: { schema: { type: "object", properties: { sessionID: text }, required: ["sessionID"] } },
  },
} as const

/** A monitor's newest check as the tray reads it: when, the exit code, and its output's tail (stdout, else stderr). */
export const LastCheck = Schema.Struct({ at: Schema.Number, exitCode: Schema.Number, output: Schema.String })
export type LastCheck = typeof LastCheck.Type

/** How many characters of a check's output the tray keeps: the end. */
export const LAST_OUTPUT_CHARS = 2000

export const lastCheckOf = (check: Check, at: number): LastCheck => {
  const output = (check.stdout.trim() === "" ? check.stderr : check.stdout).trimEnd()
  return { at, exitCode: check.exitCode, output: output.length > LAST_OUTPUT_CHARS ? output.slice(-LAST_OUTPUT_CHARS) : output }
}

/** One pending entry as the tray reads it. */
export const Shown = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["alarm", "monitor", "latch"]),
  sessionID: Schema.String,
  mode: Mode,
  /** A latch's: its subagent's description. */
  note: Schema.String,
  /** An alarm's due time; a monitor's deadline; when a latch opens. */
  dueAt: Schema.Number,
  /** When it was set, epoch ms: how long a monitor has watched. Optional, as an older server answers without it. */
  setAt: Schema.optional(Schema.Number),
  everySeconds: Schema.optional(Schema.Number),
  command: Schema.optional(Schema.String),
  /** A monitor's check period, seconds. */
  intervalSeconds: Schema.optional(Schema.Number),
  /** A monitor's stop pattern. */
  until: Schema.optional(Schema.String),
  /** A repeating monitor's way of going on. */
  repeat: Schema.optional(Repeat),
  /** A monitor's newest check since this server started, if it ran one. */
  last: Schema.optional(LastCheck),
  /** A latch's child session. */
  child: Schema.optional(Schema.String),
})
export type Shown = typeof Shown.Type

/** The entries the tray shows: a job is not among them (its readers know three kinds). */
export const shown = (entry: Entry): entry is Exclude<Entry, Job> => entry.kind !== "job"

export const shownOf = (entry: Exclude<Entry, Job>): Shown => ({
  id: entry.id,
  kind: entry.kind,
  sessionID: entry.sessionID,
  mode: entry.kind === "latch" ? "wake" : entry.mode,
  note: entry.kind === "latch" ? entry.subagent.description : entry.note,
  dueAt: dueOf(entry),
  setAt: entry.setAt,
  ...(entry.kind === "latch" ? { child: entry.child } : {}),
  ...(entry.kind === "alarm" && entry.everySeconds !== undefined ? { everySeconds: entry.everySeconds } : {}),
  ...(entry.kind === "monitor"
    ? {
        command: entry.command,
        intervalSeconds: entry.intervalSeconds,
        ...(entry.until === undefined ? {} : { until: entry.until }),
        ...(entry.repeat === undefined ? {} : { repeat: entry.repeat }),
      }
    : {}),
})

/** What `pending` answers. */
export const Pending = Schema.Struct({ now: Schema.Number, entries: Schema.Array(Shown), notices: Schema.Array(Notice) })
export type Pending = typeof Pending.Type

/**
 * What `due` answers: `fired` (the fire went now), `pending` (not due yet, or a
 * monitor still polling), `gone` (fired before, or cancelled), `refused` (the
 * session would not take it; it goes again).
 */
export const Due = Schema.Struct({ outcome: Schema.Literals(["fired", "pending", "gone", "refused"]) })
export type Due = typeof Due.Type

/** What `cancel` answers: the ids that went, or the refusal `wake_cancel` would give. */
export const Cancelled = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("cancelled"), ids: Schema.Array(Schema.String) }),
  Schema.Struct({ outcome: Schema.Literal("refused"), reason: Schema.String }),
])
export type Cancelled = typeof Cancelled.Type

/** What `set` takes: the session, and the alarm or the monitor as its tool would. */
export const SetAsk = Schema.Union([
  Schema.Struct({
    sessionID: Schema.String,
    wake: Schema.Struct({
      afterSeconds: Schema.optional(Schema.Number),
      at: Schema.optional(Schema.String),
      everySeconds: Schema.optional(Schema.Number),
      mode: Schema.optional(Mode),
      note: Schema.String,
    }),
  }),
  Schema.Struct({
    sessionID: Schema.String,
    monitor: Schema.Struct({
      command: Schema.String,
      cwd: Schema.optional(Schema.String),
      intervalSeconds: Schema.optional(Schema.Number),
      until: Schema.optional(Schema.String),
      timeoutSeconds: Schema.optional(Schema.Number),
      mode: Schema.optional(Mode),
      note: Schema.String,
      repeat: Schema.optional(Repeat),
      baseline: Schema.optional(Schema.String),
    }),
  }),
])
export type SetAsk = typeof SetAsk.Type

/** What `set` answers: the entry's id, or the refusal its tool would give. */
export const Armed = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("set"), id: Schema.String }),
  Schema.Struct({ outcome: Schema.Literal("refused"), reason: Schema.String }),
])
export type Armed = typeof Armed.Type

/** The event the server publishes on every change: its full type, as the TUI's event stream carries it. */
export const CHANGED = `rpc.${WAKES.id}.changed`
