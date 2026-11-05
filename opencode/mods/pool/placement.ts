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
 * The preferred account (where the run's prompt cache still lives) is the
 * choice unless it is held, or it has no room (a quota window at its share)
 * while another eligible account has room. Its score and pace never move it:
 * a move writes the whole prompt again on the new account. Load, live
 * sessions and pace place only a run whose cache is gone, or one that left a
 * held or full account (then the first eligible account, or the first with
 * room). With none eligible, the preferred account, else the pool's first.
 */

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
  /** Where the run's prompt cache still lives, if anywhere. */
  readonly preferred?: Slot
}

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
  // A held account is not eligible, so `kept` is unset when its hold moves the run. Room here is
  // the quota's alone (`entry.noRoom`), never `noRoom` above, which counts pace too.
  const kept = table.preferred === undefined ? undefined : eligible.find((entry) => entry.slot === table.preferred)
  const roomed = eligible.find((entry) => !entry.noRoom)
  const choice =
    kept !== undefined
      ? kept.noRoom && roomed !== undefined
        ? roomed.slot
        : kept.slot
      : (eligible[0]?.slot ?? table.preferred ?? table.slots[0].slot)
  const rest = [
    ...eligible.map((entry) => entry.slot),
    ...table.slots.filter((entry) => entry.held).map((entry) => entry.slot),
  ].filter((slot) => slot !== choice)
  return [choice, ...rest]
}
