// The wake tools as the agent sees them: their names, inputs and
// descriptions, adapted from gent's (packages/extensions/src/wake.ts). The
// names take `_` where gent's take `.`: a tool name with a dot is refused by
// Anthropic's API.
import { Schema } from "effect"
import { DEFAULT_INTERVAL_SECONDS, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, MIN_EVERY_SECONDS, Mode } from "./wake.ts"

export const NAMES = { wake: "wake", monitor: "monitor", cancel: "wake_cancel", list: "wake_list" } as const

const WakeMode = Mode.annotate({
  description: "`wake` (default): the fire starts a turn. `notify`: the fire waits for your next turn and is shown to the user meanwhile, without starting one.",
})

export const WakeInput = Schema.Struct({
  afterSeconds: Schema.optional(Schema.Number).annotate({ description: "Seconds from now until the alarm fires." }),
  at: Schema.optional(Schema.String).annotate({ description: "ISO 8601 time at which the alarm fires, e.g. 2026-11-05T14:30:00-05:00." }),
  everySeconds: Schema.optional(Schema.Number).annotate({
    description: `Repeat every this many seconds after the first fire, until wake_cancel. At least ${MIN_EVERY_SECONDS}. Omit for one fire.`,
  }),
  mode: Schema.optional(WakeMode),
  note: Schema.String.annotate({ description: "What to check when the alarm fires, and what result means done. Arrives verbatim in the wake message." }),
  newSession: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String).annotate({ description: "Absolute path the new session works in. Default: this session's directory." }),
      prompt: Schema.String.annotate({ description: "The new session's first message: self-contained, since it starts with no context." }),
    }),
  ).annotate({ description: "Start a fresh session at the time instead of waking this one." }),
})
export type WakeInput = typeof WakeInput.Type

export const MonitorInput = Schema.Struct({
  command: Schema.String.annotate({
    description: "Command run by /bin/sh on every check, with no shell startup files. Without `until`, exit 0 means done (e.g. `gh run view 123 --exit-status`).",
  }),
  cwd: Schema.optional(Schema.String).annotate({ description: "Absolute working directory for the command. Default: this session's directory." }),
  intervalSeconds: Schema.optional(Schema.Number).annotate({ description: `Seconds between checks. Default ${DEFAULT_INTERVAL_SECONDS}.` }),
  until: Schema.optional(Schema.String).annotate({ description: "Regular expression; when it matches the command's stdout (multiline) the monitor is done." }),
  timeoutSeconds: Schema.optional(Schema.Number).annotate({
    description: `Give up after this long and wake anyway. Default ${DEFAULT_TIMEOUT_SECONDS}, at most ${MAX_TIMEOUT_SECONDS}.`,
  }),
  mode: Schema.optional(WakeMode),
  note: Schema.String.annotate({ description: "What to do when the monitor wakes you. Arrives verbatim in the wake message." }),
})
export type MonitorInput = typeof MonitorInput.Type

export const CancelInput = Schema.Struct({
  id: Schema.optional(Schema.String).annotate({ description: "The alarm, monitor or notice to cancel. Omit to cancel every one of this session." }),
})
export type CancelInput = typeof CancelInput.Type

export const ListInput = Schema.Struct({})

export const WAKE_DESCRIPTION = [
  "Set an alarm. When it fires, a wake message carrying your note starts a new turn in this session, even if no OpenCode server is running then (an OS job starts one). Use it to check on work that runs outside this session (CI, a deploy, a remote job) at a known time instead of polling, and for any later wake-up or reminder.",
  "- When you are waiting on something outside the session, set a wake with a note saying what to check, answer, and stop; do not poll in a loop.",
  "- The note is all the wake message carries, so name the command or URL to check and what result means done.",
  "- Pick afterSeconds from how fast the thing actually changes: one check after a CI run's usual length beats many short ones.",
  "- everySeconds makes the alarm repeat; each fire starts a turn, so cancel it with wake_cancel as soon as the work it checks on is done.",
  '- mode: "notify" is for a reminder the user should see now and you should read next time you run; it never starts a turn.',
  "- newSession starts a fresh session at that time with its prompt, for work that should not run in this one.",
].join("\n")

export const MONITOR_DESCRIPTION = [
  "Poll a command on an interval until it exits 0 (or its stdout matches `until`), then wake this session with a message carrying the last output and your note. Use it for CI runs, deploys, ports, files, or URLs that change on their own.",
  "- One monitor replaces a loop of shell checks: give the check as a command that exits 0 when done, or an `until` regex on its output, then answer and stop.",
  "- Set intervalSeconds to how fast the thing changes; a CI run needs a check every minute, not every second.",
  "- The wake message carries the last output, so make the command print what you will need to decide the next step.",
  "- It runs while an OpenCode server runs; if none runs at its deadline, an OS job starts one to finish it.",
].join("\n")

export const CANCEL_DESCRIPTION =
  "Cancel a pending alarm or monitor by id, or every pending one of this session when no id is given. Use it when the thing you were waiting for is already done. A notice still shown to the user is dismissed the same way."

export const LIST_DESCRIPTION =
  "List the alarms and monitors pending in this session and the notices not yet read, with ISO times and the current time as `now`. Use it after a context handoff, or before you set a wake that may already exist."
