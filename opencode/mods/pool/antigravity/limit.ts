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
import { GEMINI, SHARED } from "./quota.ts"

/** A usage limit seen at `seenAt`: open again at `resetAt` when the text says when (epoch ms). */
export interface UsageLimit {
  readonly class: "usage_limit"
  readonly seenAt: number
  readonly resetAt: Option.Option<number>
}

/**
 * One limit frame parsed from a pane's text:
 * - "Individual quota reached ... Resets in <dur>" -> group `gemini`
 * - "Third-party quota reached ... Resets in <dur>" -> group `claude-gpt`
 * - Keyed by its Error ID line when present (`id:<id>`), else by reset time (`reset:<ms>`).
 */
export interface PaneLimit extends UsageLimit {
  readonly group: Option.Option<string>
  readonly errorId: Option.Option<string>
  readonly key: string
}

const INDIVIDUAL = /\bIndividual quota reached\b/i
const THIRD_PARTY = /\bThird-party quota reached\b/i
const ERROR_ID = /\bError\s+ID\s*[:=]\s*([^\s,;\]]+)/i

const LIMITED = [
  INDIVIDUAL,
  THIRD_PARTY,
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

const frameGroupOf = (frame: string): Option.Option<string> => {
  if (THIRD_PARTY.test(frame)) return Option.some(SHARED)
  if (INDIVIDUAL.test(frame)) return Option.some(GEMINI)
  return Option.none()
}

/** Max trailing lines after a limit header that belong to the same frame (e.g. "Resets in ..." and "Error ID: ..."). */
const FRAME_TAIL_LINES = 5

/**
 * Parse every live quota-limit frame from a pane's text (including multi-line
 * scrollback). Frames older than their own reset (`resetAt <= now` or
 * `resetAt <= seenAt`) are ignored. Each frame is keyed by its `Error ID:` line
 * when present (`id:<id>`), else by its reset time (`reset:<ms>`), else
 * `seen:<seenAt>`, and deduplicated within the text.
 */
export const parsePaneLimits = (text: string, now: number, frameAt?: number): ReadonlyArray<PaneLimit> => {
  const seenAt = Option.getOrElse(Option.fromUndefinedOr(frameAt), () => now)
  const lines = text.split(/\r?\n/)
  const frames: Array<string> = []
  let index = 0
  while (index < lines.length) {
    const line = Option.getOrElse(Arr.get(lines, index), () => "")
    if (!isLimit(line)) {
      index += 1
      continue
    }
    const block: Array<string> = [line]
    let next = index + 1
    while (next < lines.length && next <= index + FRAME_TAIL_LINES) {
      const candidate = Option.getOrElse(Arr.get(lines, next), () => "")
      if (candidate.trim() === "" || isLimit(candidate)) break
      block.push(candidate)
      next += 1
    }
    frames.push(block.join("\n"))
    index = next
  }
  const seenKeys = new Set<string>()
  const parsed: Array<PaneLimit> = []
  for (const frame of frames) {
    const resetAt = resetOf(frame, seenAt)
    // A frame older than its own reset is ignored.
    if (Option.exists(resetAt, (at) => at <= now || at <= seenAt)) continue
    const errorId = captured(ERROR_ID, frame)
    const key = Option.match(errorId, {
      onSome: (id) => `id:${id}`,
      onNone: () => Option.match(resetAt, { onSome: (at) => `reset:${at}`, onNone: () => `seen:${seenAt}` }),
    })
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    parsed.push({
      class: "usage_limit",
      group: frameGroupOf(frame),
      seenAt,
      resetAt,
      errorId,
      key,
    })
  }
  return parsed
}
