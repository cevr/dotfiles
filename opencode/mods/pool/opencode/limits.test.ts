// The limit tally's store survives a restart: the requests in the plugin's
// storage, the rows and the tally in the file, which the CLI reads as written.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { scratch } from "../../../tests/scratch.ts"
import { PoolId } from "../account-pool.ts"
import { LEGACY_PREFIX } from "../legacy-ids.ts"
import { storage } from "../memory/ledger.ts"
import { Limits } from "../service.ts"
import * as LimitsLive from "./limits.ts"
import { migrate } from "./migrate.ts"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ANTHROPIC = PoolId.make("anthropic")
const opus = (at: number) => ({ at, pool: ANTHROPIC, credentialID: "a", model: "claude-opus-5-5", tokens: { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 } })

/** One start of the store over `entries` and the file at `path`, as an effect. */
const start = <A>(
  entries: Map<string, Schema.Json>,
  path: string,
  body: (limits: Limits["Service"]) => Effect.Effect<A>,
  at: number,
  from = 0,
) =>
  Effect.gen(function* () {
    // The store starts at `from`, and its first tally records from then; the body runs at `at`.
    yield* TestClock.setTime(from)
    return yield* Effect.gen(function* () {
      const limits = yield* Limits
      yield* TestClock.setTime(at)
      return yield* body(limits)
    }).pipe(Effect.provide(LimitsLive.layer(storage(entries), path)))
  }).pipe(Effect.provide(TestClock.layer()))

/** The Bun test bridge: no Effect test runner is installed. */
const runTest = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

const run = <A>(entries: Map<string, Schema.Json>, path: string, body: (limits: Limits["Service"]) => Effect.Effect<A>, at: number, from = 0) =>
  runTest(start(entries, path, body, at, from))

/** The rows a tally file holds, by key: whose they are and their rise. */
const rowsOf = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ state: Schema.Struct({ rows: Schema.Record(Schema.String, Schema.Struct({ credentialID: Schema.String, rise: Schema.Number })) }) })),
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

  test("a file an older pool wrote under a store login's legacy id reads as that login's rows, and the next write names no legacy id", () => {
    const entries = new Map<string, Schema.Json>()
    using dir = scratch("limits-")
    const path = join(dir.path, "limits.json")
    const legacy = `${LEGACY_PREFIX}work`
    const reading = (at: number, utilization: number) => ({
      at,
      windows: [
        { name: "5h", utilization, resetAt: 5 * HOUR },
        { name: "7d", utilization: utilization / 4, resetAt: 6 * DAY },
      ],
    })
    return runTest(
      Effect.gen(function* () {
        // Today's file, as the pool before the rename wrote it: every row keyed and named by the legacy id.
        yield* start(
          entries,
          path,
          (limits) =>
            Effect.gen(function* () {
              yield* limits.use("msg_1", { ...opus(HOUR), credentialID: legacy })
              yield* limits.observe(ANTHROPIC, legacy, reading(2 * HOUR, 0.03))
              yield* limits.flush
            }),
          2 * HOUR,
        )
        const before = rowsOf(readFileSync(path, "utf8")).state.rows
        expect(Object.keys(before).every((key) => key.startsWith(`anthropic|${legacy}|`))).toBe(true)
        // The new pool starts: its storage rewritten (migrate.ts), the login observed under its id now.
        expect(yield* migrate(storage(entries))).toBe(1)
        yield* start(
          entries,
          path,
          (limits) =>
            Effect.gen(function* () {
              yield* limits.observe(ANTHROPIC, "store:work", reading(3 * HOUR, 0.05))
              yield* limits.flush
            }),
          3 * HOUR,
        )
        const text = readFileSync(path, "utf8")
        expect(text).not.toContain(LEGACY_PREFIX)
        const after = rowsOf(text).state.rows
        // The same rows, one per window and period, carried on under the id now, with the newer reading's rise.
        expect(Object.keys(after).toSorted()).toEqual(Object.keys(before).map((key) => key.replace(legacy, "store:work")).toSorted())
        expect(Object.values(after).map((row) => [row.credentialID, row.rise])).toEqual([
          ["store:work", 5],
          ["store:work", 1.25],
        ])
      }),
    )
  })
})
