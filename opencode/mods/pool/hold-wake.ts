// Pure interim wake decision for hosts with no Step to hold (pin c6664062):
// decides whether a recorded held-send row should wait, wake the subagent,
// be checked again later, or be left alone, and what the row records after a
// delivery and after a failed one. Deleted by the pool-hold-latch unit once
// the host holds the Step.
//
// A row is one hold that ended one turn: its `retryAt` is the time that hold
// named and never changes, so the wake's message id, built from the session
// and that time, is the same on every attempt, every pool copy, every process
// and every restart. The host admits one id once, so an attempt repeated after
// a failure, an interrupt or a lost mark wakes nobody twice. The mark
// (`wokenAt`) is written only after the host took the wake: it saves asking
// again, and its loss costs one more admission the host refuses as a repeat.
import { Option, Schema } from "effect"
import { nextRetryAt, type WirePace } from "./pace.ts"
import type { HeldSend } from "./refuse.ts"

/** The first wait after a failed delivery; each later failure doubles it, up to `WAKE_RETRY_MAX_MS`. */
export const WAKE_RETRY_MS = 30_000
/** The longest wait between two delivery attempts. */
export const WAKE_RETRY_MAX_MS = 10 * 60_000
/** Failed deliveries after which the pool stops trying and logs that the child's parent must wake it. */
export const MAX_WAKE_FAILURES = 8

/** Synthetic wake message delivered when a subagent's hold opens. It defers to a newer task that came with it. */
export const WAKE_TEXT =
  "The pool hold that ended your last turn has opened. If a newer task came with this notice, do that task instead; otherwise continue from where you left off, without repeating completed work."

/** Short description stored on the synthetic wake message. */
export const WAKE_DESCRIPTION = "pool hold opened"

/**
 * Appended to a held subagent's turn-ending error on hosts without a Step. A stopped Session is not woken by a
 * notice (the host keeps it for the Session's next task, where `WAKE_TEXT` gives way to that task).
 */
export const SUBAGENT_RESUME_NOTE = " This session resumes by itself then, unless it is stopped first."

/** Whether the session behind a held-send row is a subagent, a root, or unreadable. */
export const SessionRole = Schema.Literals(["subagent", "root", "gone"])
export type SessionRole = typeof SessionRole.Type

/** What the wake scanner does for one held-send row. */
export const Decision = Schema.TaggedUnion({
  /** Not due yet: look again at `dueAt`. */
  Wait: {},
  /** Due and admitted: deliver the wake with this id. */
  Wake: { id: Schema.String },
  /** Due and still held: look again at `recheckAt` (strictly later than now). */
  Hold: { recheckAt: Schema.Finite },
  /** Never woken by the pool: a root, a gone session, a Step's row, a row the installed pool wrote, or woken already. */
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
 * When the row is next looked at, or none when the pool never wakes it: woken already, a Step's row (the host holds
 * that request), a row with no `model` (the installed pool wrote it, and its parent was never told the child resumes
 * by itself), or one whose deliveries failed `MAX_WAKE_FAILURES` times.
 */
export const dueAt = (row: HeldSend): Option.Option<number> => {
  if (Option.isSome(Option.fromUndefinedOr(row.wokenAt))) return Option.none()
  if (Option.isSome(Option.fromUndefinedOr(row.stepID))) return Option.none()
  if (Option.isNone(Option.fromUndefinedOr(row.model))) return Option.none()
  if (Option.getOrElse(Option.fromUndefinedOr(row.wakeFailures), () => 0) >= MAX_WAKE_FAILURES) return Option.none()
  return Option.some(heldUntil(row))
}

/** The latest time the row names: its hold's own `retryAt`, or a later recheck. Its retention counts from here. */
export const heldUntil = (row: HeldSend): number =>
  Math.max(row.retryAt, Option.getOrElse(Option.fromUndefinedOr(row.recheckAt), () => row.retryAt))

/** Whether the row needs a session lookup and an admission question at `now`. */
export const needsCheck = (row: HeldSend, now: number): boolean => Option.exists(dueAt(row), (due) => now >= due)

/**
 * Pure wake decision for one held-send row:
 * - never woken by the pool (`dueAt` none), or a session that is no subagent -> Drop
 * - not yet due, or no admission answer -> Wait
 * - due and admitted -> Wake with the hold's one id
 * - due and still held -> Hold with a strictly later recheck
 */
export const decide = (input: WakeInput): Decision => {
  const due = dueAt(input.row)
  if (Option.isNone(due) || input.session !== "subagent") return Decision.cases.Drop.make({})
  if (input.now < due.value) return Decision.cases.Wait.make({})
  return Option.match(input.pace, {
    onNone: () => Decision.cases.Wait.make({}),
    onSome: (answer) => {
      if (answer.ok) return Decision.cases.Wake.make({ id: wakeDeliveryId(input.row.sessionID, input.row.retryAt) })
      return Decision.cases.Hold.make({ recheckAt: nextRetryAt(input.now, [answer.retryAt]) })
    },
  })
}

/** Whether `current` is still the hold `seen` was: the same session's same hold, not replaced by a newer one. */
export const sameHold = (seen: HeldSend, current: HeldSend): boolean =>
  seen.sessionID === current.sessionID && seen.retryAt === current.retryAt

/** The row once the host took its wake. */
export const delivered = (row: HeldSend, now: number): HeldSend => ({ ...row, wokenAt: now })

/** The wait after the `failures`-th failed delivery (1-based). */
export const retryDelay = (failures: number): number =>
  Math.min(WAKE_RETRY_MAX_MS, WAKE_RETRY_MS * 2 ** Math.max(0, failures - 1))

/** The row after one more failed delivery: counted, and looked at again after `retryDelay`. */
export const failed = (row: HeldSend, now: number): HeldSend => {
  const failures = Option.getOrElse(Option.fromUndefinedOr(row.wakeFailures), () => 0) + 1
  return { ...row, wakeFailures: failures, recheckAt: now + retryDelay(failures) }
}

/** Appends the subagent self-resume notice once to a turn-ending hold message. */
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
