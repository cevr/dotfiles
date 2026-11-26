/**
 * Where a run goes: the placement walk, over plain data.
 *
 * The choice comes first, then the eligible accounts below their sustainable
 * live load by weekly reset (missing weekly readings last), then the others:
 * those with no room after those with some; then the week that would expire
 * most unused first (`expiring`), weeks not read after those read; then by
 * score, equal scores by weekly reset; then held accounts in pool order.
 * Equal resets keep pool order.
 *
 * `expiring` is the share of its week an account would leave unused at its
 * reset if it kept its week's rate so far (`used / elapsed`), per hour left to
 * that reset: `(TARGET − used) / left − used / elapsed`. A soon reset and a
 * week far under its line both raise it, so the quota that is about to be
 * lost gets the work, and an account that takes work sees it fall. The pace
 * (pace.ts) still decides which accounts may take the run at all: an account
 * past its line is not eligible, so this order never sends one past it.
 *
 * `score = load / unit + live`, where a unit is the mean recorded price of a
 * session on the provider (`spent / sessions`). With no recorded price, or no
 * session counted, the score is the live sessions alone.
 *
 * Accounts the request's admission leaves out for its model (pace.ts
 * `eligibleFor`: a window at its hold line) go after every eligible one.
 * The preferred account (where the run's prompt cache still lives) is the
 * choice unless it is held or left out. Its score and the pool's pace never move it: a move
 * writes the whole prompt again on the new account, and an account at its
 * share still serves until a refusal holds it. Load, live sessions, room and
 * pace place only a run whose cache is gone, or one that left a held account.
 * With none eligible, the preferred account, else the pool's first.
 */
import { Option, Order } from "effect"
import { TARGET, WEEK } from "./weekly-pace.ts"

const HOUR = 3_600_000

/** What placement reads of one account. */
export interface PlacementSlot<Slot> {
  readonly slot: Slot
  /** The recorded price of its steps in the window, USD. */
  readonly load: number
  /** Other sessions whose cache lives on it now. */
  readonly live: number
  /** Refused until a reset: never chosen while another account is eligible. */
  readonly held: boolean
  /**
   * A quota window at its share: it takes a new run only when every other
   * account is at its share too, whatever its score.
   */
  readonly noRoom: boolean
  /** Mean runs it can sustain, when a pace is known. */
  readonly sustainable?: number
  /** Its weekly window's reset, epoch ms, when read. */
  readonly weeklyResetAt?: number
  /** The share of its week used (0 to 1), as last read; with `weeklyResetAt` and the table's `now` it gives `expiring`. */
  readonly weeklyUsed?: number
  /**
   * False when the request's admission (pace.ts `eligibleFor`) leaves it out
   * for the model asked: it is chosen only when no eligible account is left,
   * and never kept for the cache. Absent: eligible.
   */
  readonly eligible?: boolean
}

/** One placement's table: the accounts in pool order, and what the run prefers. */
export interface PlacementTable<Slot> {
  readonly slots: readonly [PlacementSlot<Slot>, ...PlacementSlot<Slot>[]]
  /** The recorded price of the provider's steps in the window, USD, over every account. */
  readonly spent: number
  /** Distinct sessions with a priced step on the provider in the window. */
  readonly sessions: number
  /** Where the run's prompt cache still lives, if anywhere. */
  readonly preferred?: Slot
  /** The placement's time, epoch ms: without it no week is read as expiring. */
  readonly now?: number
}

/**
 * The share of its week an account would leave unused at its reset at its
 * week's rate so far, per hour left: none without a week read, or once the
 * reset it names has passed (the new week's reading is not in yet).
 */
export const expiring = (used: number, resetAt: number, now: number): Option.Option<number> =>
  Option.liftPredicate(resetAt - now, (left) => left > 0 && left <= WEEK).pipe(
    Option.map((left) => (TARGET - used) / (left / HOUR) - used / Math.max(1, (WEEK - left) / HOUR)),
  )

const expiringOf = <Slot>(entry: PlacementSlot<Slot>, now: Option.Option<number>): Option.Option<number> =>
  Option.all([Option.fromUndefinedOr(entry.weeklyUsed), Option.fromUndefinedOr(entry.weeklyResetAt), now]).pipe(
    Option.flatMap(([used, resetAt, at]) => expiring(used, resetAt, at)),
  )

/**
 * The step `expiring` is compared in: 0.05 points of the week per hour left.
 * Two weeks within one step are equal and fall through to load, so fresh
 * sessions still spread over equal accounts between usage readings (which
 * `expiring` does not see change): two readings a moment apart, whose resets
 * differ by that moment, would otherwise pile every new session on one.
 */
export const EXPIRING_STEP = 0.0005

/** The week that would expire most unused first, in steps of `EXPIRING_STEP`; a week not read after every one read. */
const byExpiring = Order.mapInput(Order.flip(Option.makeOrder(Order.Number)), (value: Option.Option<number>) =>
  Option.map(value, (rate) => Math.round(rate / EXPIRING_STEP)),
)

/** The accounts in the order a run should try them; the first is the choice. */
export function rankPlacement<Slot>(table: PlacementTable<Slot>): readonly [Slot, ...Slot[]] {
  const mean = table.spent / table.sessions
  const unit = mean > 0 && Number.isFinite(mean) ? mean : undefined
  const score = (entry: PlacementSlot<Slot>) => (unit === undefined ? 0 : entry.load / unit) + entry.live
  const underPace = (entry: PlacementSlot<Slot>) => entry.sustainable !== undefined && entry.live < entry.sustainable
  const noRoom = (entry: PlacementSlot<Slot>) => entry.noRoom || entry.sustainable === 0
  // Infinity puts a missing weekly reading last; equal resets keep pool order.
  const byWeeklyReset = (left: PlacementSlot<Slot>, right: PlacementSlot<Slot>) => {
    const leftReset = left.weeklyResetAt ?? Infinity
    const rightReset = right.weeklyResetAt ?? Infinity
    if (leftReset === rightReset) return 0
    return leftReset < rightReset ? -1 : 1
  }
  const admitted = (entry: PlacementSlot<Slot>) => entry.eligible !== false
  const now = Option.fromUndefinedOr(table.now)
  const eligible = table.slots
    .filter((entry) => !entry.held)
    .sort((left, right) => {
      const byAdmission = Number(admitted(right)) - Number(admitted(left))
      if (byAdmission !== 0) return byAdmission
      const leftUnder = underPace(left)
      const rightUnder = underPace(right)
      if (leftUnder !== rightUnder) return leftUnder ? -1 : 1
      if (leftUnder) return byWeeklyReset(left, right)
      const leftFull = noRoom(left)
      const rightFull = noRoom(right)
      if (leftFull !== rightFull) return leftFull ? 1 : -1
      const byWeek = byExpiring(expiringOf(left, now), expiringOf(right, now))
      if (byWeek !== 0) return byWeek
      const byScore = score(left) - score(right)
      if (byScore !== 0) return byScore
      return byWeeklyReset(left, right)
    })
  // A held account is not eligible, so `kept` is unset when its hold moves the run. An account at
  // its share still serves: leaving it writes the whole prompt again, its refusal moves the run anyway.
  // The cache keeps its account only while the request's admission leaves it eligible.
  const kept = table.preferred === undefined ? undefined : eligible.find((entry) => entry.slot === table.preferred && admitted(entry))
  const choice = kept?.slot ?? eligible[0]?.slot ?? table.preferred ?? table.slots[0].slot
  const rest = [
    ...eligible.map((entry) => entry.slot),
    ...table.slots.filter((entry) => entry.held).map((entry) => entry.slot),
  ].filter((slot) => slot !== choice)
  return [choice, ...rest]
}
