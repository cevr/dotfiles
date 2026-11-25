// Pure interim wake decision for hosts with no Step to hold (pin c6664062):
// decides whether a recorded held-send row should wait, wake the subagent once,
// move forward to a new retry time, or be dropped from wake consideration.
// Deleted by the pool-hold-latch unit once the host holds the Step.
import { Option, Schema } from "effect"
import { nextRetryAt, type WirePace } from "./pace.ts"
import type { HeldSend } from "./refuse.ts"

/** How often each pool copy scans held-send rows on the Effect Clock. */
export const WAKE_INTERVAL = "30 seconds"

/** Synthetic wake message delivered once when a subagent's hold opens. */
export const WAKE_TEXT =
  "The pool hold that ended your last turn has opened. Continue from where you left off; do not repeat completed work."

/** Short description stored on the synthetic wake message. */
export const WAKE_DESCRIPTION = "pool hold opened"

/** Appended to a held subagent's turn-ending error on hosts without a Step. */
export const SUBAGENT_RESUME_NOTE = " This session resumes by itself then; stop it to cancel."

/** Whether the session behind a held-send row is a subagent, a root, or unreadable. */
export const SessionRole = Schema.Literals(["subagent", "root", "gone"])
export type SessionRole = typeof SessionRole.Type

/** What the wake scanner does for one held-send row. */
export const Decision = Schema.TaggedUnion({
  Wait: {},
  Wake: {},
  Hold: { retryAt: Schema.Finite },
  Drop: {},
})
export type Decision = typeof Decision.Type

export interface WakeInput {
  readonly row: HeldSend
  readonly session: SessionRole
  readonly now: number
  readonly pace: Option.Option<WirePace>
}

/**
 * Whether a held-send row needs a session lookup and pace check at `now`:
 * already-woken rows, Step-owned rows, and rows not yet due never wake or move.
 */
export const needsCheck = (row: HeldSend, now: number): boolean =>
  Option.isNone(Option.fromUndefinedOr(row.wokenAt)) &&
  Option.isNone(Option.fromUndefinedOr(row.stepID)) &&
  now >= row.retryAt

/**
 * Pure wake decision for one held-send row:
 * - already woken, Step-owned, root, or gone -> Drop
 * - not yet due (`now < row.retryAt`) -> Wait
 * - due, no pace answer -> Wait (never wake without admission)
 * - due, pace admits (`ok: true`) -> Wake
 * - due, pace still holds (`ok: false`) -> Hold with a strictly future retryAt
 */
export const decide = (input: WakeInput): Decision => {
  if (Option.isSome(Option.fromUndefinedOr(input.row.wokenAt))) return Decision.cases.Drop.make({})
  if (Option.isSome(Option.fromUndefinedOr(input.row.stepID))) return Decision.cases.Drop.make({})
  if (input.session !== "subagent") return Decision.cases.Drop.make({})
  if (input.now < input.row.retryAt) return Decision.cases.Wait.make({})
  return Option.match(input.pace, {
    onNone: () => Decision.cases.Wait.make({}),
    onSome: (answer) => {
      if (answer.ok) return Decision.cases.Wake.make({})
      return Decision.cases.Hold.make({ retryAt: nextRetryAt(input.now, [answer.retryAt]) })
    },
  })
}

/** Appends the subagent self-resume note once to a turn-ending hold message. */
export const appendSubagentNote = (message: string): string => {
  if (message.endsWith(SUBAGENT_RESUME_NOTE)) return message
  return `${message}${SUBAGENT_RESUME_NOTE}`
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const MASK_64 = (1n << 64n) - 1n
const FNV_PRIME = 0x100000001b3n
const FNV_OFFSET_LOW = 0xcbf29ce484222325n
const FNV_OFFSET_HIGH = 0x84222325cbf29ce4n

/** Twelve hex digits of `timestamp * 0x1000 + 1`, matching the host's ascending message id prefix. */
const hexTime = (timestamp: number): string => {
  const current = BigInt(timestamp) * 0x1000n + 1n
  return Array.from({ length: 6 }, (_, index) =>
    Number((current >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
}

/** Fourteen deterministic base62 characters derived from `seed`. */
const hashTail = (seed: string): string => {
  let low = FNV_OFFSET_LOW
  let high = FNV_OFFSET_HIGH
  for (let i = 0; i < seed.length; i += 1) {
    const code = BigInt(seed.charCodeAt(i))
    low = ((low ^ code) * FNV_PRIME) & MASK_64
    high = ((high ^ (code + BigInt(i + 1))) * FNV_PRIME) & MASK_64
  }
  let bits = (high << 64n) | low
  return Array.from({ length: 14 }, () => {
    const index = Number(bits % 62n)
    bits /= 62n
    return Option.getOrElse(Option.fromUndefinedOr(BASE62[index]), () => "0")
  }).join("")
}

/**
 * Deterministic host message id for waking one held turn (`sessionID`, `retryAt`),
 * matching `msg_` + 12 hex timestamp digits + 14 base62 characters. Every pool copy
 * and every restart computes the same id for the same hold so the host admits it once.
 */
export const wakeDeliveryId = (sessionID: string, retryAt: number): string => {
  const clamped = Math.max(0, Math.trunc(retryAt))
  return `msg_${hexTime(clamped)}${hashTail(`${sessionID}\0${clamped}`)}`
}
