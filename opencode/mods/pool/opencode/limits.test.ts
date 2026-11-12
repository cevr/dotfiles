// The limit tally's store survives a restart: the requests in the plugin's
// storage, the rows and the tally in the file, which the CLI reads as written.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, type Schema } from "effect"
import { TestClock } from "effect/testing"
import { scratch } from "../../../tests/scratch.ts"
import { PoolId } from "../account-pool.ts"
import { storage } from "../memory/ledger.ts"
import { Limits } from "../service.ts"
import * as LimitsLive from "./limits.ts"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ANTHROPIC = PoolId.make("anthropic")
const opus = (at: number) => ({ at, pool: ANTHROPIC, credentialID: "a", model: "claude-opus-5-5", tokens: { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 } })

const run = <A>(
  entries: Map<string, Schema.Json>,
  path: string,
  body: (limits: Limits["Service"]) => Effect.Effect<A>,
  at: number,
  start = 0,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      // The store starts at `start`, and its first tally records from then; the body runs at `at`.
      yield* TestClock.setTime(start)
      return yield* Effect.gen(function* () {
        const limits = yield* Limits
        yield* TestClock.setTime(at)
        return yield* body(limits)
      }).pipe(Effect.provide(LimitsLive.layer(storage(entries), path)))
    }).pipe(Effect.provide(TestClock.layer())),
  )

describe("the limit store", () => {
  test("a restart reads back the requests and the rows: the tally is the same, and the file holds it", async () => {
    const entries = new Map<string, Schema.Json>()
    using dir = scratch("limits-")
    const path = join(dir.path, "state", "limits.json")
    const before = await run(
      entries,
      path,
      (limits) =>
        Effect.gen(function* () {
          yield* limits.use("msg_1", opus(HOUR))
          // The same message from another instance counts once.
          yield* limits.use("msg_1", opus(HOUR))
          yield* limits.observe(ANTHROPIC, "a", { at: 2 * HOUR, windows: [{ name: "5h", utilization: 0.03, resetAt: 5 * HOUR }] })
          yield* limits.flush
          return yield* limits.tally
        }),
      2 * HOUR,
    )
    expect(before.recent[0]?.families[0]?.weighted.rate).toBe(3)
    expect([...entries.keys()]).toEqual(["limits/use/msg_1"])
    const file = JSON.parse(readFileSync(path, "utf8"))
    expect(file.line).toBe("limit/Mtok 5h: Opus 3.0% n 1 (last 7 days)")
    expect(file.tally).toEqual(before)
    const after = await run(entries, path, (limits) => limits.tally, 2 * HOUR)
    expect(after).toEqual(before)
  })

  test("a request older than the longest period is forgotten at the next flush; its row keeps its count", async () => {
    const entries = new Map<string, Schema.Json>()
    using dir = scratch("limits-")
    const path = join(dir.path, "limits.json")
    await run(
      entries,
      path,
      (limits) =>
        Effect.gen(function* () {
          yield* limits.use("msg_1", opus(HOUR))
          yield* limits.observe(ANTHROPIC, "a", { at: 2 * HOUR, windows: [{ name: "5h", utilization: 0.03, resetAt: 5 * HOUR }] })
          yield* limits.flush
        }),
      2 * HOUR,
    )
    const later = await run(
      entries,
      path,
      (limits) => Effect.andThen(limits.flush, limits.tally),
      9 * DAY,
    )
    expect(entries.size).toBe(0)
    expect(later.cumulative[0]?.families[0]?.mtok).toBe(1)
    expect(later.recent).toEqual([])
    expect(existsSync(path)).toBe(true)
  })
})
