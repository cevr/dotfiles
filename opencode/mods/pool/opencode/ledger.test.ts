// OpenCode's ledger over a stand-in for the plugin's storage that answers one
// entry per page, so every restore walks the pages; and over a storage that
// fails, which the ledger reads as empty and writes past.
import { expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Option, Scope, type Schema } from "effect"
import { TestClock } from "effect/testing"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"
import { PoolId, RequestRefused } from "../account-pool.ts"
import { windowReading } from "../quota.ts"
import { ledgerLaws } from "../laws.ts"
import { Ledger } from "../service.ts"
import * as OpenCodeLedger from "./ledger.ts"

const pagedByOne = (entries: Map<string, Schema.Json>): OpenCodeLedger.Storage => ({
  scan: ({ prefix, after }) =>
    Effect.sync(() => {
      const keys = [...entries.keys()].filter((key) => key.startsWith(prefix) && (after === undefined || key > after)).sort()
      const [key, ...rest] = keys
      return key === undefined
        ? { entries: [] }
        : { entries: [{ key, value: entries.get(key) }], ...(rest.length > 0 ? { next: key } : {}) }
    }),
  set: (key, value) => Effect.sync(() => void entries.set(key, value)),
  remove: (key) => Effect.sync(() => void entries.delete(key)),
})

ledgerLaws("OpenCode's Ledger", () => OpenCodeLedger.layer(pagedByOne(new Map())))

test("a storage that fails restores an empty ledger, and a write to it is lost without failing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const pool = PoolId.make("broken")
      yield* ledger.record(pool, [RequestRefused.make({ credentialID: "cred-a", hold: { kind: "rate-limit", until: 2, at: 1 } })])
      expect(yield* ledger.restore(pool)).toEqual({ holds: {}, readings: {}, steps: [], recent: {} })
    }).pipe(
      Effect.provide(
        OpenCodeLedger.layer({
          scan: () => Effect.fail("storage down"),
          set: () => Effect.fail("storage down"),
          remove: () => Effect.fail("storage down"),
        }),
      ),
    ),
  ))

const virtual = TestClock.layer()
effectTest("a newer process slot cannot read for a send until the older slot drains, including its pending write",
  Effect.scoped(Effect.gen(function* () {
    const version = OpenCodeLedger.HOLD_AUTHORITY_VERSION
    const old = OpenCodeLedger.processHoldAuthority(version)
    const next = OpenCodeLedger.processHoldAuthority(version + 1)
    const records = pagedByOne(new Map())
    const failed = { once: true }
    const storage = {
      ...records,
      set: (key: string, value: Schema.Json) => Effect.suspend(() => {
        if (!failed.once) return records.set(key, value)
        failed.once = false
        return Effect.fail("temporary write fault")
      }),
    }
    const prior = yield* Scope.make()
    const services = yield* Layer.buildWithScope(OpenCodeLedger.layer(storage, void 0, old), prior)
    const oldLedger = Context.get(services, Ledger)
    const newLayer = OpenCodeLedger.layer(storage, void 0, next)
    const newLedger = Context.get(yield* Layer.build(newLayer), Ledger)
    const pool = PoolId.make("slot-version-test")
    yield* oldLedger.record(pool, [RequestRefused.make({ credentialID: "a", hold: { kind: "rate-limit", at: 0, until: 90_000 } })])
    yield* TestClock.adjust(2_000)
    const read = newLedger.withHolds(newLedger.holds(pool))
    const closed = yield* Effect.option(read)
    expect(Option.isNone(closed)).toBe(true)
    yield* Scope.close(prior, Exit.void)
    expect(yield* read).toEqual({ a: { kind: "rate-limit", at: 0, until: 90_000 } })
  }).pipe(Effect.provide(virtual))), hangGuard("unit-law"))

effectTest("a stored reading written at 04287dc0 with fiveHourAbsentAt restores with 5h ABSENT",
  Effect.gen(function* () {
    const at = 1_800_000_000_000
    const ledger = yield* Ledger
    const pool = PoolId.make("anthropic")
    const restored = yield* ledger.restore(pool)
    const row = Option.fromUndefinedOr(restored.readings["ultra"])
    expect(Option.map(row, (reading) => [reading.absent, windowReading(reading, "5h")._tag])).toEqual(Option.some([[{ name: "5h", at }], "Absent"]))
    const first = yield* ledger.firstReading(pool, "ultra", Effect.succeed(Option.none()))
    expect(Option.map(first, (reading) => [reading.absent, windowReading(reading, "5h")._tag])).toEqual(Option.some([[{ name: "5h", at }], "Absent"]))
  }).pipe(Effect.provide(OpenCodeLedger.layer(pagedByOne(new Map([
    ["anthropic/reading/ultra", { at: 1_800_000_000_000, windows: [{ name: "7d", utilization: 0.2, resetAt: 1_800_086_400_000 }], fiveHourAbsentAt: 1_800_000_000_000, usage: { at: 1_800_000_000_000, samples: 1 } }],
  ]))))), hangGuard("unit-law"))
