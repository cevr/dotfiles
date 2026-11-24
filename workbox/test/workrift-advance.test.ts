// A model, on a manual clock, of the protocol by which `workrift create` advanced its base before the base's lock
// was shared (every create took the base's one lock exclusively and advanced, installed and warmed the base under
// it), held to the Bite workbox's measured schedule of 2026-11-21 22:01Z (/tmp/vperf2 logs): a fast-forward of
// 30 s, an install of 16 s, a warm of 628 s, `work new`'s clone of 96 to 239 s each. The protocol that replaced it
// (a ticket queue, first come first served, an advance that only moves the base) is modelled in
// workrift-queue.test.ts, with the invariants this file's round-1 model held: never a copy of a half-moved base,
// never two moves at once, every create ends, no lock outlives its holder.
import { describe, expect, test } from "bun:test"

interface CreateSpec {
  readonly arrive: number
  readonly fetch: number
  readonly clone: number
}

interface Timing {
  readonly ff: number
  readonly install: number
  readonly warm: number
}

/** One run of the model: creates served in arrival order, each holding the base's one lock for its advance and clone. */
const simulate = (creates: ReadonlyArray<CreateSpec>, timing: Timing, window = 600) => {
  const base = { head: 0, stamp: -Infinity }
  const origin = 1
  let free = 0
  const locked = new Map<number, number>()
  const order = creates.map((spec, i) => ({ spec, i })).sort((a, b) => a.spec.arrive + a.spec.fetch - (b.spec.arrive + b.spec.fetch))
  for (const { spec, i } of order) {
    const asked = spec.arrive + spec.fetch
    let now = Math.max(asked, free)
    locked.set(i, now)
    if (base.head !== origin && now - base.stamp >= window) {
      now += timing.ff + timing.install + timing.warm
      base.head = origin
      base.stamp = now
    }
    free = now + spec.clone
  }
  const waited = creates.map((spec, i) => (locked.get(i) ?? Infinity) - (spec.arrive + spec.fetch))
  return { locked, waited }
}

const measuredTiming: Timing = { ff: 30, install: 16, warm: 628 }
/** 22:00:57Z = 0: the holder (scratch-vfy-21699-r2), lab-replay, offprice, vitrine, whole-publish, in the order they got the lock. */
const observedSchedule: ReadonlyArray<CreateSpec> = [
  { arrive: 0, fetch: 6, clone: 153 },
  { arrive: 29, fetch: 3, clone: 168 },
  { arrive: 35, fetch: 2, clone: 96 },
  { arrive: 42, fetch: 2, clone: 239 },
  { arrive: 50, fetch: 2, clone: 175 },
]

describe("the base's one exclusive lock under five creates and an advance (a model on a manual clock)", () => {
  test("the measured schedule comes back: every create queued behind the advance's warm and the clones before it", () => {
    const run = simulate(observedSchedule, measuredTiming)
    // Measured, in s after 22:00:57Z, when each got the lock: 22:01:03, 22:14:55, 22:17:43, 22:19:19, 22:23:18
    // (the work registry's `since` of the one before, and each log's 'locked' line).
    const measuredLocked = [6, 838, 1006, 1102, 1341]
    for (const [i, seconds] of measuredLocked.entries()) expect({ i, off: Math.abs((run.locked.get(i) ?? Infinity) - seconds) <= 20 }).toEqual({ i, off: true })
    // whole-publish's own wait: 1291 s from its start.
    expect(Math.abs((run.locked.get(4) ?? 0) - 50 - 1291)).toBeLessThanOrEqual(20)
    expect(Math.max(...run.waited)).toBeGreaterThan(1000)
  })
})
