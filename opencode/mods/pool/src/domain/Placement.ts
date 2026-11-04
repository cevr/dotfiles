/**
 * Where a run goes: gent's placement walk, over plain data.
 *
 * The choice comes first, then the eligible accounts below their sustainable
 * live load by weekly reset (missing weekly readings last), then the others
 * by score (those with no room after those with some; equal scores by weekly
 * reset), then held accounts in pool order. Equal resets keep pool order.
 *
 * `score = load / unit + live`, where a unit is the mean recorded price of a
 * session on the provider (`spent / sessions`). With no recorded price, or no
 * session counted, the score is the live sessions alone.
 *
 * The preferred account (where the run's cache lives) stays while it is below
 * pace, has room when the best account has, and is within one session of the
 * best eligible account's score. With no known pace, the pace rule is off. With none eligible, the preferred
 * account, else the pool's first.
 */

/** How far the preferred account's score may sit above the best one's, in sessions. */
export const PLACEMENT_HYSTERESIS_SESSIONS = 1

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
}

/** One placement's table: the accounts in pool order, and what the run prefers. */
export interface PlacementTable<Slot> {
  readonly slots: readonly [PlacementSlot<Slot>, ...PlacementSlot<Slot>[]]
  /** The recorded price of the provider's steps in the window, USD, over every account. */
  readonly spent: number
  /** Distinct sessions with a priced step on the provider in the window. */
  readonly sessions: number
  /** Where the run's cache lives, if anywhere. */
  readonly preferred?: Slot
}

/** The accounts in the order a run should try them; the first is the choice. */
export function rankPlacement<Slot>(table: PlacementTable<Slot>): readonly [Slot, ...Slot[]] {
  const mean = table.spent / table.sessions
  const unit = mean > 0 && Number.isFinite(mean) ? mean : undefined
  const score = (entry: PlacementSlot<Slot>) => (unit === undefined ? 0 : entry.load / unit) + entry.live
  const underPace = (entry: PlacementSlot<Slot>) => entry.sustainable !== undefined && entry.live < entry.sustainable
  const noRoom = (entry: PlacementSlot<Slot>) => entry.noRoom || entry.sustainable === 0
  const paced = table.slots.some((entry) => entry.sustainable !== undefined)
  // Infinity puts a missing weekly reading last; equal resets keep pool order.
  const byWeeklyReset = (left: PlacementSlot<Slot>, right: PlacementSlot<Slot>) => {
    const leftReset = left.weeklyResetAt ?? Infinity
    const rightReset = right.weeklyResetAt ?? Infinity
    if (leftReset === rightReset) return 0
    return leftReset < rightReset ? -1 : 1
  }
  const eligible = table.slots
    .filter((entry) => !entry.held)
    .sort((left, right) => {
      const leftUnder = underPace(left)
      const rightUnder = underPace(right)
      if (leftUnder !== rightUnder) return leftUnder ? -1 : 1
      if (leftUnder) return byWeeklyReset(left, right)
      const leftFull = noRoom(left)
      const rightFull = noRoom(right)
      if (leftFull !== rightFull) return leftFull ? 1 : -1
      const byScore = score(left) - score(right)
      if (byScore !== 0) return byScore
      return byWeeklyReset(left, right)
    })
  const kept = table.preferred === undefined ? undefined : eligible.find((entry) => entry.slot === table.preferred)
  const low = eligible[0]
  const choice =
    low === undefined
      ? (table.preferred ?? table.slots[0].slot)
      : kept !== undefined &&
          (!paced || underPace(kept)) &&
          !(noRoom(kept) && !noRoom(low)) &&
          score(kept) <= score(low) + PLACEMENT_HYSTERESIS_SESSIONS
        ? kept.slot
        : low.slot
  const rest = [
    ...eligible.map((entry) => entry.slot),
    ...table.slots.filter((entry) => entry.held).map((entry) => entry.slot),
  ].filter((slot) => slot !== choice)
  return [choice, ...rest]
}
