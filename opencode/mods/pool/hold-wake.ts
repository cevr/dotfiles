// Pure interim wake decision for holds that end a turn (a host with no Step to
// hold, pin c6664062; and on a host with one, fork 24dca3c1, a signed provider's
// placement, which the pool does not defer on the Step yet; a row held on a Step,
// one with a `stepID`, is the host's and never woken here):
// decides whether a recorded held-send row should wait, wake the subagent,
// be checked again later, tell the subagent's parent that it will not be
// woken, or be left alone, and what the row records after each outcome.
// Deleted by the pool-hold-latch unit, which holds every primary on the Step.
//
// A row is one hold that ended one turn: its `retryAt` is the time that hold
// named and never changes, so each message the pool sends for it (the wake,
// or the word to the parent) has an id built from the session and that time,
// the same on every attempt, every pool copy, every process and every
// restart. The host admits one id once, so an attempt repeated after a
// failure, an interrupt or a lost mark sends nothing twice. A mark (`wokenAt`,
// `toldAt`) is written only after the host took the message.
//
// The parent of a held subagent read "this session resumes by itself". That
// stays true until the pool says otherwise: a row that is due is tried again
// for as long as it lives, a failure backing off to `WAKE_RETRY_MAX_MS` and no
// further; the pool stops only when the child is gone, and then it tells the
// parent once.
import { Option, Schema } from "effect"
import { HoldReason, nextRetryAt } from "./pace.ts"
import { HeldSend } from "./refuse.ts"

/** The first wait after a failed attempt; each later failure doubles it, up to `WAKE_RETRY_MAX_MS`. */
export const WAKE_RETRY_MS = 30_000
/** The longest wait between two attempts: however long the host was down, the child is woken this soon after. */
export const WAKE_RETRY_MAX_MS = 10 * 60_000
/** How long one delivery may take before it counts as failed (the same id goes again). */
export const DELIVERY_TIMEOUT_MS = 60_000

/** Synthetic wake message delivered when a subagent's hold opens. It defers to a newer task that came with it. */
export const WAKE_TEXT =
  "The pool hold that ended your last turn has opened. If a newer task came with this notice, do that task instead; otherwise continue from where you left off, without repeating completed work."

/** Short description stored on the synthetic wake message. */
export const WAKE_DESCRIPTION = "pool hold opened"

/** What the parent of a held subagent reads once the child is gone: the pool will not wake it. */
export const goneText = (sessionID: string): string =>
  `The pool will not wake it: the subagent ${sessionID}, which a pool hold stopped and which was to resume by itself, no longer exists, so its last task did not finish. Start that work again if it is still needed.`

/** Short description stored on the parent's notice. */
export const GONE_DESCRIPTION = "held subagent gone"

/**
 * Appended to a held subagent's turn-ending error (a hold no Step holds). A stopped Session is not woken by a
 * notice (the host keeps it for the Session's next task, where `WAKE_TEXT` gives way to that task).
 */
export const SUBAGENT_RESUME_NOTE = " This session resumes by itself then, unless it is stopped first."

/**
 * The session behind a held-send row: a subagent, a root, gone (the host says it does not exist), or unknown (the
 * host did not answer, which says nothing of the session).
 */
export const SessionRole = Schema.Literals(["subagent", "root", "gone", "unknown"])
export type SessionRole = typeof SessionRole.Type

/** What the wake scanner does for one held-send row. */
export const Decision = Schema.TaggedUnion({
  /** Not due yet, or no admission answer: look again at `dueAt`. */
  Wait: {},
  /** Due and admitted: deliver the wake with this id. */
  Wake: { id: Schema.String },
  /** Due and still held: look again at `recheckAt` (strictly later than now). */
  Hold: { recheckAt: Schema.Finite },
  /** Due, but the host did not say what the session is: count it as a failed attempt and back off. */
  Retry: {},
  /** The child is gone: tell its parent once, with this id, that it will not be woken. */
  Tell: { parentID: Schema.String, id: Schema.String },
  /** Never sent anything by the pool: a root, a gone child with no known parent, a Step's row, a row the installed pool wrote, or done. */
  Drop: {},
})
export type Decision = typeof Decision.Type

/** What the held request's own admission answers now (asked, not taken): admitted, or held until `retryAt`. */
export const Answer = Schema.TaggedUnion({
  Admitted: {},
  Held: { retryAt: Schema.Finite },
})
export type Answer = typeof Answer.Type

export interface WakeInput {
  readonly row: HeldSend
  readonly session: SessionRole
  readonly now: number
  readonly answer: Option.Option<Answer>
}

/**
 * When the row is next looked at, or none when the pool never sends anything for it: woken or its parent told
 * already, a Step's row (the host holds that request), or a row with no `model` (the installed pool wrote it, and its
 * parent was never told the child resumes by itself). Failed attempts never end it: they only move `recheckAt`.
 */
export const dueAt = (row: HeldSend): Option.Option<number> => {
  if (Option.isSome(Option.fromUndefinedOr(row.wokenAt))) return Option.none()
  if (Option.isSome(Option.fromUndefinedOr(row.toldAt))) return Option.none()
  if (Option.isSome(Option.fromUndefinedOr(row.stepID))) return Option.none()
  if (Option.isNone(Option.fromUndefinedOr(row.model))) return Option.none()
  return Option.some(heldUntil(row))
}

/** The latest time the row names: its hold's own `retryAt`, or a later recheck. Its retention counts from here. */
export const heldUntil = (row: HeldSend): number =>
  Math.max(row.retryAt, Option.getOrElse(Option.fromUndefinedOr(row.recheckAt), () => row.retryAt))

/** Whether the row needs a session lookup and an admission question at `now`. */
export const needsCheck = (row: HeldSend, now: number): boolean => Option.exists(dueAt(row), (due) => now >= due)

/**
 * Pure wake decision for one held-send row:
 * - never sent anything by the pool (`dueAt` none), or a root -> Drop
 * - not yet due -> Wait
 * - the host did not answer -> Retry
 * - the child is gone -> Tell its parent, or Drop when no parent is known
 * - a subagent with no admission answer -> Wait; admitted -> Wake with the hold's one id; held -> Hold, strictly later
 */
export const decide = (input: WakeInput): Decision => {
  const due = dueAt(input.row)
  if (Option.isNone(due) || input.session === "root") return Decision.cases.Drop.make({})
  if (input.now < due.value) return Decision.cases.Wait.make({})
  if (input.session === "unknown") return Decision.cases.Retry.make({})
  if (input.session === "gone")
    return Option.match(Option.fromUndefinedOr(input.row.parentID), {
      onNone: () => Decision.cases.Drop.make({}),
      onSome: (parentID) => Decision.cases.Tell.make({ parentID, id: goneNoticeId(input.row.sessionID, input.row.retryAt) }),
    })
  return Option.match(input.answer, {
    onNone: () => Decision.cases.Wait.make({}),
    onSome: Answer.match({
      Admitted: () => Decision.cases.Wake.make({ id: wakeDeliveryId(input.row.sessionID, input.row.retryAt) }),
      Held: ({ retryAt }) => Decision.cases.Hold.make({ recheckAt: nextRetryAt(input.now, [retryAt]) }),
    }),
  })
}

/** Whether `current` is still the hold `seen` was: the same session's same hold, not replaced by a newer one. */
export const sameHold = (seen: HeldSend, current: HeldSend): boolean =>
  seen.sessionID === current.sessionID && seen.retryAt === current.retryAt

/** The row once the host took its wake. */
export const delivered = (row: HeldSend, now: number): HeldSend => ({ ...row, wokenAt: now })

/** The row once the host took the word to the parent that the child will not be woken (or the parent is gone too). */
export const told = (row: HeldSend, now: number): HeldSend => ({ ...row, toldAt: now })

/** The wait after the `failures`-th failed attempt (1-based): doubling from `WAKE_RETRY_MS`, never past `WAKE_RETRY_MAX_MS`. */
export const retryDelay = (failures: number): number =>
  Math.min(WAKE_RETRY_MAX_MS, WAKE_RETRY_MS * 2 ** Math.min(16, Math.max(0, failures - 1)))

/** The row after one more failed attempt: counted, and looked at again after `retryDelay`. */
export const failed = (row: HeldSend, now: number): HeldSend => {
  const failures = Option.getOrElse(Option.fromUndefinedOr(row.wakeFailures), () => 0) + 1
  return { ...row, wakeFailures: failures, recheckAt: now + retryDelay(failures) }
}

/** What can be read of a stored row that does not decode: its key names its session. */
const Damaged = Schema.Struct({
  providerID: Schema.optionalKey(Schema.Unknown),
  model: Schema.String,
  reasonCode: Schema.optionalKey(Schema.Unknown),
  retryAt: Schema.optionalKey(Schema.Unknown),
  parentID: Schema.optionalKey(Schema.Unknown),
})
const damagedOf = Schema.decodeUnknownOption(Damaged)
const stringOf = Schema.decodeUnknownOption(Schema.String)
const finiteOf = Schema.decodeUnknownOption(Schema.Finite)
const reasonOf = Schema.decodeUnknownOption(HoldReason)

/**
 * A row this pool's kind wrote (it names a `model`, so its parent read "resumes by itself") that no longer decodes,
 * rebuilt from what can be read, `now` standing in for a time that cannot: the wake goes on for it rather than drop
 * it in silence. None for a row that names no model (not the wake's) or one that decodes.
 */
export const repaired = (sessionID: string, stored: Schema.Json, now: number): Option.Option<HeldSend> => {
  if (Option.isSome(Schema.decodeUnknownOption(HeldSend)(stored))) return Option.none()
  return Option.map(damagedOf(stored), (head) =>
    HeldSend.make({
      sessionID,
      providerID: Option.getOrElse(stringOf(head.providerID), () => "anthropic"),
      model: head.model,
      reasonCode: Option.getOrElse(reasonOf(head.reasonCode), () => "record-unreadable"),
      retryAt: Option.getOrElse(finiteOf(head.retryAt), () => now),
      ...Option.match(stringOf(head.parentID), { onNone: () => ({}), onSome: (parentID) => ({ parentID }) }),
    }),
  )
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

const messageId = (timestamp: number, seed: string): string => {
  const clamped = Math.max(0, Math.trunc(timestamp))
  return `msg_${hexTime(clamped)}${hashTail(`${seed}\0${clamped}`)}`
}

/**
 * Deterministic host message id for waking one held turn (`sessionID`, `retryAt`),
 * matching `msg_` + 12 hex timestamp digits + 14 base62 characters. Every pool copy
 * and every restart computes the same id for the same hold so the host admits it once.
 */
export const wakeDeliveryId = (sessionID: string, retryAt: number): string => messageId(retryAt, sessionID)

/** Deterministic id of the word to the parent that the held child `sessionID` will not be woken, distinct from its wake's. */
export const goneNoticeId = (sessionID: string, retryAt: number): string => messageId(retryAt, `${sessionID}\0gone`)
