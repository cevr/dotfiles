// An Antigravity limit as its CLI prints it, read the way T3 Code reads a
// failed turn (pingdotgg/t3code apps/server/src/provider/acp/AntigravityTurnOutcome.ts
// at 55085df2): a quota refusal is a usage limit with a reset time, never a
// generic failure. A limited agy pane prints
// "Individual quota reached. Please upgrade your subscription to increase your
// limits. Resets in 1h8m38s.", the API's form "RESOURCE_EXHAUSTED (code 429): …";
// the reset is the Go duration after "Resets in" (or the RPC's
// quotaResetDelay, retryDelay or quotaResetTimeStamp). Pure: the caller gives
// the time the text was seen. Exported for the pane agent's adapter.
import { Array as Arr, DateTime, Option } from "effect"

/** A usage limit seen at `seenAt`: open again at `resetAt` when the text says when (epoch ms). */
export interface UsageLimit {
  readonly class: "usage_limit"
  readonly seenAt: number
  readonly resetAt: Option.Option<number>
}

const LIMITED = [
  /\bIndividual quota reached\b/i,
  /\bRESOURCE_EXHAUSTED\b/,
  /\(code 429\)/,
  /\breason:QUOTA_EXHAUSTED\b/,
  /\bquota (?:reached|exceeded|exhausted)\b/i,
]

const DURATION = "(?:\\d+(?:\\.\\d+)?(?:ns|us|µs|μs|ms|h|m|s))+"
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\]]+)/
const DELAYS = [
  new RegExp(`\\bquotaResetDelay:(${DURATION})(?=[\\s\\]]|$)`),
  new RegExp(`\\bretryDelay:(${DURATION})(?=[\\s\\]]|$)`),
  new RegExp(`\\bResets in (${DURATION})(?!\\w|\\.\\d)`, "i"),
]
const PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g
const UNIT_MS = new Map([
  ["ns", 1e-6],
  ["us", 1e-3],
  ["µs", 1e-3],
  ["μs", 1e-3],
  ["ms", 1],
  ["s", 1_000],
  ["m", 60_000],
  ["h", 3_600_000],
])

/** A Go duration (`1h8m38s`, `4m42.5s`, `850ms`) in milliseconds; none when it says nothing. */
export const durationMs = (text: string): Option.Option<number> => {
  const total = [...text.matchAll(PART)].reduce(
    (sum, [, amount, unit]) => sum + Number(amount) * Option.getOrElse(Option.fromUndefinedOr(UNIT_MS.get(Option.getOrElse(Option.fromUndefinedOr(unit), () => ""))), () => 0),
    0,
  )
  return Option.liftPredicate(total, (ms) => Number.isFinite(ms) && ms > 0)
}

const captured = (pattern: RegExp, text: string) => Option.flatMap(Option.fromNullishOr(pattern.exec(text)), (match) => Option.fromUndefinedOr(match[1]))

const resetOf = (text: string, now: number): Option.Option<number> =>
  Option.orElse(
    Option.map(Option.flatMap(captured(RESET_TIMESTAMP, text), DateTime.make), DateTime.toEpochMillis),
    () => Option.map(Arr.findFirst(DELAYS, (pattern) => Option.isSome(captured(pattern, text))).pipe(Option.flatMap((pattern) => captured(pattern, text)), Option.flatMap(durationMs)), (ms) => now + ms),
  )

/** Whether `text` is an Antigravity quota refusal. */
export const isLimit = (text: string) => LIMITED.some((pattern) => pattern.test(text))

/** `text` as a usage limit seen at `now`, its reset when the text gives one; none when it is no quota refusal. */
export const parseLimit = (text: string, now: number): Option.Option<UsageLimit> =>
  Option.liftPredicate(text, isLimit).pipe(Option.map((limited) => ({ class: "usage_limit", seenAt: now, resetAt: resetOf(limited, now) })))
