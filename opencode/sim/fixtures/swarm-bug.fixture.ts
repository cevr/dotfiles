// Run by scripts/accept.test.ts as a stand-in simulated suite, never by the
// gate: a seeded test with a bug only seed-dependent input reaches. Each seed
// draws a queue of message sizes from its own generator; the "bug" drops the
// last message when the queue's sizes sum to a multiple of 97, which about one
// seed in a hundred reaches and none of the 20 fixed seeds does
// (scripts/accept.test.ts checks both).
import { Effect } from "effect"
import * as Seed from "../seed.ts"

const { seeded } = Seed.runner("sim/fixtures/swarm-bug.fixture.ts")

/** mulberry32: the seed's own sizes. */
const sizesOf = (seed: number) => {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
  return Array.from({ length: 3 + Math.floor(next() * 5) }, () => 1 + Math.floor(next() * 40))
}

/** The code under test: the queue's messages as delivered, with the bug. */
export const delivered = (sizes: ReadonlyArray<number>) => {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  return (total % 97 === 0 && sizes.slice(0, -1)) || sizes
}

seeded("every queued message is delivered", ({ seed, expect }) =>
  Effect.sync(() => {
    const sizes = sizesOf(seed)
    expect(delivered(sizes)).toEqual(sizes)
  }),
)
