// The guard's second rule: a subagent's foreground shell call that opens by
// sleeping 30 seconds or more is refused, and the refusal names what to do
// instead. Such a call holds the subagent's turn doing nothing, and a long
// one is often cancelled (the 2026-11-06 dream: 60 "Command cancelled" shells
// in 37 workbox sessions; 4 of 17 cancelled calls in a Mac sample were
// `sleep N; tail …` polls). A root session is not refused: the owner may
// mean it, and the root can set a wake or a monitor.
//
// A call opens with a sleep when its first simple command (shell-line.ts:
// prefixes such as `nohup` skipped) is `sleep`: `sleep 60`, `sleep 60 && tail
// log`, `sleep 1m; gh run view`. A sleep later in the line, or inside a loop,
// is not read. A call with `background: true` holds no turn, so it runs.
import { Schema } from "effect"
import { runningWords, simpleCommands } from "./shell-line.ts"

/** The shortest opening sleep the guard refuses, in seconds. */
export const SLEEP_FLOOR_SECONDS = 30

const UNIT_SECONDS: Readonly<Record<string, number>> = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 }

/** One `sleep` operand in seconds (`30`, `1.5m`, `2h`, `infinity`); undefined when it is not a duration, such as `$N`. */
const operandSeconds = (word: string): number | undefined => {
  if (word === "infinity" || word === "inf") return Number.POSITIVE_INFINITY
  const match = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(word)
  if (match === null) return undefined
  return Number(match[1]) * (UNIT_SECONDS[match[2] ?? ""] ?? 1)
}

/** How long `sleep` waits for its operands (they add up, as GNU's do); undefined when one is not a duration or there is none. */
export const sleepSeconds = (operands: ReadonlyArray<string>): number | undefined => {
  if (operands.length === 0) return undefined
  let total = 0
  for (const operand of operands) {
    const seconds = operandSeconds(operand)
    if (seconds === undefined) return undefined
    total += seconds
  }
  return total
}

/** A line's opening sleep: the `sleep` command as written (`sleep 60`) and how long it waits. */
export interface OpeningSleep {
  readonly sleep: string
  readonly seconds: number
}

/** How long a command line sleeps before anything else runs: its first simple command's `sleep`; undefined when it opens with anything else. */
export const openingSleep = (command: string): OpeningSleep | undefined => {
  const first = simpleCommands(command)[0]
  if (first === undefined) return undefined
  const running = runningWords(first)
  if (running[0]?.text.split("/").pop() !== "sleep") return undefined
  const seconds = sleepSeconds(running.slice(1).map((word) => word.text))
  return seconds === undefined ? undefined : { sleep: running.map((word) => word.text).join(" "), seconds }
}

/** Whether a line opens with a sleep the guard refuses in a subagent's foreground call. */
export const sleepsTooLong = (command: string): OpeningSleep | undefined => {
  const opening = openingSleep(command)
  return opening !== undefined && opening.seconds >= SLEEP_FLOOR_SECONDS ? opening : undefined
}

/** A subagent's shell call that would sleep its turn away, with the words the model reads. */
export class Idle extends Schema.TaggedError<Idle>()("Idle", {
  command: Schema.String,
  seconds: Schema.Number,
  reason: Schema.String,
}) {}

const duration = (seconds: number) => (Number.isFinite(seconds) ? `${seconds} s` : "ever")

/** Why an opening sleep is refused, and what to run instead. */
export const idleReason = ({ sleep, seconds }: OpeningSleep): string =>
  `\`${sleep}\` would hold this subagent's turn for ${duration(seconds)} doing nothing, and a long call is often cancelled. ` +
  'Start what you wait on with `background: true` and wait on its handle with `shell({ action: "wait", id, ms })`; ' +
  "for outside state (CI, a deploy, a file), run the check itself as a background loop (`until <check>; do sleep 30; done`) and wait on that handle. " +
  "wake and monitor are the root session's, not a subagent's"

/** What the model reads of the refusal. */
export const idleMessage = (reason: string): string => `guard-sleep: ${reason}.`
