// Run by sim/seed.test.ts as its own `bun test`, never by the suite: a seeded
// test whose first seed outlasts bun's own timeout for it (the runner's 300 ms
// and the 5 s grace), then a test that watches for that seed still running.
// The runner stops the seed mid-run at its timeout, so the next test sees
// nothing of it and no failure lands between the tests.
import { expect } from "bun:test"
import { Console, Effect } from "effect"
import * as Seed from "../seed.ts"

const ran: Array<string> = []
const { seeded } = Seed.runner("sim/fixtures/seed-hang.fixture.ts", { timeoutMs: 300 })

seeded("a seed that outlasts bun's timeout", ({ seed }) =>
  Effect.gen(function* () {
    ran.push(`start ${seed}`)
    // Seed 1 runs 7 s, past the runner's 300 ms and bun's 5.3 s; the others 10 ms.
    yield* Effect.sleep(Math.max(10, 7_000 * Number(seed === 1)))
    ran.push(`end ${seed}`)
  }),
)

Seed.effect(
  "the next test sees none of the first test's seeds run",
  Effect.gen(function* () {
    const before = ran.length
    yield* Effect.sleep("3 seconds")
    const during = ran.slice(before)
    yield* Console.log(`seed-hang: during the next test: ${during.join(", ") || "(none)"}`)
    expect(during).toEqual([])
  }),
)
