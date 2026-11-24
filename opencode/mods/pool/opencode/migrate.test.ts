// The plugin's storage from before the login store's rename, rewritten at
// start so it names the same logins by their ids now: over the in-memory
// storage the seam tests use, paged as the plugin's storage pages.
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, type Schema } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { PoolId } from "../account-pool.ts"
import { LEGACY_PREFIX as OLD, renameText, renameValue } from "../legacy-ids.ts"
import { storage } from "../memory/ledger.ts"
import { FleetStore, Ledger, PushStore, ResetsStore } from "../service.ts"
import * as FleetLive from "./fleet.ts"
import * as LedgerLive from "./ledger.ts"
import { MIGRATED, migrate } from "./migrate.ts"
import * as PushesLive from "./pushes.ts"
import * as ResetsLive from "./resets.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"

const run = (entries: Map<string, Schema.Json>) => migrate(storage(entries))

// Every place the plugin's storage names a login, in the shape its adapter
// writes: the ledger's hold and reading keys and its step and cache marks, a
// recorded request (limits/use, read in limits.test.ts), a reset and a claim
// (keyed by the reset's key, which holds the id), a peer's report (its
// readings and its limit rows' keys) and a push's allowance.
const legacy = `${OLD}work`
const resetKey = `claude:anthropic:${legacy}:123`
const window = { name: "5h", utilization: 0.5, resetAt: 9 }
const reset = {
  key: resetKey,
  pool: "anthropic",
  provider: "claude",
  credentialID: legacy,
  label: "work",
  creditID: "credit_1",
  requestID: "pool-abc",
  why: "held",
  stage: "settled",
  at: 5,
  attempts: 1,
}
const claim = {
  key: resetKey,
  pool: "anthropic",
  provider: "claude",
  credentialID: legacy,
  label: "work",
  creditID: "credit_1",
  requestID: "pool-abc",
  at: 5,
  outcome: "reset",
  before: [window],
  weekly: "kept",
}
const today = (): Map<string, Schema.Json> =>
  new Map<string, Schema.Json>([
    [`anthropic/hold/${legacy}`, { kind: "usage-limit", until: 9, at: 1 }],
    [`anthropic/reading/${legacy}`, { at: 5, windows: [window] }],
    ["anthropic/step/000000000000005/ses_1", { at: 5, sessionID: "ses_1", credentialID: legacy, cost: 2 }],
    ["anthropic/cache/ses_1", { credentialID: legacy, at: 5 }],
    ["limits/use/msg_1", { at: 5, pool: "anthropic", credentialID: legacy, model: "claude-opus-5-5", tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    [`resets/reset/${encodeURIComponent(resetKey)}`, reset],
    [`resets/claim/000000000000005/${encodeURIComponent(resetKey)}`, claim],
    [
      "fleet/peer/workbox",
      {
        report: {
          host: "workbox",
          at: 5,
          starts: [],
          readings: [{ pool: "anthropic", credentialID: legacy, reading: { at: 5, windows: [window] } }],
          limits: { since: 1, rows: [{ key: `anthropic|${legacy}|5h|0`, sums: { opus: { w: 1, raw: 1 } } }] },
        },
        seenAt: 5,
      },
    ],
    [
      "push/push/p1",
      { id: "p1", goal: "ship", scope: { host: "mac" }, startedAt: 1, endsAt: 9, untilDone: false, allowance: { max: 1, asNeeded: false, accounts: [legacy] }, by: "asked" },
    ],
  ])

/** What each adapter reads of `entries`, the login ids in it only. */
const readIds = (entries: Map<string, Schema.Json>) => {
  const store = storage(entries)
  return Effect.gen(function* () {
    const ledger = yield* Ledger.use((entry) => entry.restore(PoolId.make("anthropic")))
    const resets = yield* ResetsStore.use((entry) => entry.read)
    const fleet = yield* FleetStore.use((entry) => entry.read)
    const pushes = yield* PushStore.use((entry) => entry.read)
    return {
      holds: Object.keys(ledger.holds),
      readings: Object.keys(ledger.readings),
      steps: ledger.steps.map((step) => step.credentialID),
      caches: Object.values(ledger.recent).map((mark) => mark.credentialID),
      resets: Object.values(resets.resets).map((entry) => [entry.key, entry.credentialID]),
      claims: resets.claims.map((entry) => [entry.key, entry.credentialID]),
      peerReadings: Object.values(fleet.peers).flatMap((peer) => peer.report?.readings.map((entry) => entry.credentialID) ?? []),
      peerLimitRows: Object.values(fleet.peers).flatMap((peer) => peer.report?.limits?.rows.map((entry) => entry.key) ?? []),
      pushAccounts: Object.values(pushes.pushes).flatMap((push) => push.allowance.accounts ?? []),
    }
  }).pipe(Effect.provide(Layer.mergeAll(LedgerLive.layer(store), ResetsLive.layer(store), FleetLive.layer(store), PushesLive.layer(store))))
}

describe("the storage migration", () => {
  test("every place the storage names a login reads, through its own adapter, under the login's id now", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entries = today()
        // Today's storage reads as written: each adapter decodes it, under the legacy id.
        expect(yield* readIds(entries)).toEqual({
          holds: [legacy],
          readings: [legacy],
          steps: [legacy],
          caches: [legacy],
          resets: [[resetKey, legacy]],
          claims: [[resetKey, legacy]],
          peerReadings: [legacy],
          peerLimitRows: [`anthropic|${legacy}|5h|0`],
          pushAccounts: [legacy],
        })
        const size = entries.size
        expect(yield* run(entries)).toBe(size)
        const now = "claude:anthropic:store:work:123"
        expect(yield* readIds(entries)).toEqual({
          holds: ["store:work"],
          readings: ["store:work"],
          steps: ["store:work"],
          caches: ["store:work"],
          resets: [[now, "store:work"]],
          claims: [[now, "store:work"]],
          peerReadings: ["store:work"],
          peerLimitRows: ["anthropic|store:work|5h|0"],
          pushAccounts: ["store:work"],
        })
        expect(entries.get("limits/use/msg_1")).toMatchObject({ credentialID: "store:work" })
        // Nothing in the storage names a legacy id any more: renaming it again changes nothing.
        expect([...entries].every(([key, value]) => renameText(key) === key && renameValue(value) === value)).toBe(true)
      }),
    ))

  test("rewrites each entry naming a legacy id under its renamed key, and leaves the rest as they are", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const reset = `claude:anthropic:${OLD}work:123`
        const entries = new Map<string, Schema.Json>([
          [`anthropic/hold/${OLD}work`, { kind: "usage-limit", until: 5 }],
          ["anthropic/step/000000000000001/ses_1", { at: 1, sessionID: "ses_1", credentialID: `${OLD}work`, cost: 2 }],
          [`resets/reset/${encodeURIComponent(reset)}`, { key: reset, credentialID: `${OLD}work` }],
          ["anthropic/hold/cred_abc", { kind: "rate-limit", until: 9 }],
        ])
        expect(yield* run(entries)).toBe(3)
        expect(Object.fromEntries(entries)).toEqual({
          "anthropic/hold/store:work": { kind: "usage-limit", until: 5 },
          "anthropic/step/000000000000001/ses_1": { at: 1, sessionID: "ses_1", credentialID: "store:work", cost: 2 },
          [`resets/reset/${encodeURIComponent("claude:anthropic:store:work:123")}`]: { key: "claude:anthropic:store:work:123", credentialID: "store:work" },
          "anthropic/hold/cred_abc": { kind: "rate-limit", until: 9 },
          [MIGRATED]: true,
        })
        // A second start finds nothing to do.
        expect(yield* run(entries)).toBe(0)
      }),
    ))

  test("a storage it finished migrating is not read again: a later start scans only for its mark", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entries = new Map<string, Schema.Json>([[`anthropic/hold/${OLD}work`, { kind: "usage-limit", until: 5 }]])
        expect(yield* run(entries)).toBe(1)
        // An entry naming a legacy id after the mark is left alone, and the start reads one page of one key.
        entries.set(`anthropic/hold/${OLD}late`, { kind: "usage-limit", until: 5 })
        const scans: Array<{ readonly prefix: string; readonly limit?: number }> = []
        const store = storage(entries)
        const counted = { ...store, scan: (options: Parameters<typeof store.scan>[0]) => (scans.push(options), store.scan(options)) }
        expect(yield* migrate(counted)).toBe(0)
        expect(scans).toEqual([{ prefix: MIGRATED, limit: 1 }])
        expect(entries.has(`anthropic/hold/${OLD}late`)).toBe(true)
      }),
    ))

  test("an entry a newer pool already wrote under the renamed key wins; the old one goes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entries = new Map<string, Schema.Json>([
          [`anthropic/hold/${OLD}work`, { kind: "usage-limit", until: 5 }],
          ["anthropic/hold/store:work", { kind: "usage-limit", until: 50 }],
        ])
        yield* run(entries)
        expect(Object.fromEntries(entries)).toEqual({ "anthropic/hold/store:work": { kind: "usage-limit", until: 50 }, [MIGRATED]: true })
      }),
    ))

  test("reads every page of a storage larger than one scan", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entries = new Map<string, Schema.Json>(Array.from({ length: 1200 }, (_, index) => [`anthropic/reading/${OLD}l${index}`, { at: index }]))
        expect(yield* run(entries)).toBe(1200)
        expect([...entries.keys()].every((key) => key === MIGRATED || key.startsWith("anthropic/reading/store:"))).toBe(true)
      }),
    ))

  effectTest(
    "a migration interrupted mid-way leaves no mark, and the next start finishes it",
    Effect.gen(function* () {
      const entries = new Map<string, Schema.Json>(Array.from({ length: 10 }, (_, index) => [`anthropic/reading/${OLD}l${index}`, { at: index }]))
      const inner = storage(entries)
      const writes = { count: 0 }
      // The fifth write never ends: the process stops there.
      const stalling: LedgerLive.Storage = {
        ...inner,
        set: (key, value) =>
          Effect.suspend(() => {
            writes.count++
            return Effect.andThen(Effect.when(Effect.never, Effect.succeed(writes.count === 5)), inner.set(key, value))
          }),
      }
      const fiber = yield* Effect.forkChild(migrate(stalling))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(writes.count).toBe(5)
      expect(entries.has(MIGRATED)).toBe(false)
      expect(yield* run(entries)).toBeGreaterThan(0)
      expect(entries.get(MIGRATED)).toBe(true)
      expect([...entries.keys()].every((key) => key === MIGRATED || key.startsWith("anthropic/reading/store:"))).toBe(true)
    }),
    hangGuard("local-fixture"),
  )
})
