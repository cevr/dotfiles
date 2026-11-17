// The storage every copy of the pool in one process shares: a held prefix read once for all of them, the copies'
// writes seen by each other, the rest the storage itself. Over the in-memory storage the seam tests use, counting
// the scans that reach it.
import { describe, expect } from "bun:test"
import { Effect, type Schema } from "effect"
import { PoolId } from "../account-pool.ts"
import { storage as memory } from "../memory/ledger.ts"
import { Ledger } from "../service.ts"
import * as LedgerLive from "./ledger.ts"
import * as Shared from "./shared.ts"
import { effectTest } from "../../../sim-tui/effect-test.ts"

const counted = (entries: Map<string, Schema.Json>) => {
  const scans: Array<string> = []
  const inner = memory(entries)
  return { scans, storage: { ...inner, scan: (options: Parameters<typeof inner.scan>[0]) => (scans.push(options.prefix), inner.scan(options)) } }
}

const step = (at: number, sessionID: string) => ({ at, sessionID, credentialID: "cred-a", cost: 1 })
const stepKey = (at: number, sessionID: string) => `anthropic/step/${String(at).padStart(15, "0")}/${sessionID}`

const prefixes = ["anthropic/", "limits/use/"]

describe("the shared storage", () => {
  effectTest(
    "reads a held prefix once for every copy: a second copy's restore reaches no storage",
    Effect.gen(function* () {
      const entries = new Map<string, Schema.Json>(Array.from({ length: 1200 }, (_, index) => [stepKey(index, `ses_${index}`), step(index, `ses_${index}`)]))
      entries.set("anthropic/hold/cred-a", { kind: "usage-limit", until: 9, at: 1 })
      const share = Shared.make()
      const first = counted(entries)
      const second = counted(entries)
      const restoredFirst = yield* restore(share(first.storage, prefixes))
      const restoredSecond = yield* restore(share(second.storage, prefixes))
      expect(restoredFirst.steps).toHaveLength(1200)
      expect(restoredSecond).toEqual(restoredFirst)
      expect(first.scans).toEqual(["anthropic/", "anthropic/"])
      expect(second.scans).toEqual([])
    }),
    5_000,
  )

  effectTest(
    "what one copy writes or removes the next copy's read sees, and the storage holds",
    Effect.gen(function* () {
      const entries = new Map<string, Schema.Json>([[stepKey(5, "ses_b"), step(5, "ses_b")]])
      const share = Shared.make()
      const one = share(memory(entries), prefixes)
      yield* restore(one)
      yield* one.set(stepKey(3, "ses_a"), step(3, "ses_a"))
      yield* one.set(stepKey(7, "ses_c"), step(7, "ses_c"))
      yield* one.remove(stepKey(5, "ses_b"))
      const other = counted(entries)
      const restored = yield* restore(share(other.storage, prefixes))
      expect(restored.steps.map((it) => it.sessionID)).toEqual(["ses_a", "ses_c"])
      expect([...entries.keys()].sort()).toEqual([stepKey(3, "ses_a"), stepKey(7, "ses_c")])
      expect(other.scans).toEqual([])
    }),
    5_000,
  )

  effectTest(
    "a write under a held prefix before its first read lands, and the read has it (the legacy-id migration runs first)",
    Effect.gen(function* () {
      const entries = new Map<string, Schema.Json>([[stepKey(5, "ses_b"), step(5, "ses_b")]])
      const shared = Shared.make()(memory(entries), prefixes)
      yield* shared.set("anthropic/hold/cred-a", { kind: "usage-limit", until: 9, at: 1 })
      yield* shared.remove(stepKey(5, "ses_b"))
      expect([...entries.keys()]).toEqual(["anthropic/hold/cred-a"])
      const restored = yield* restore(shared)
      expect(Object.keys(restored.holds)).toEqual(["cred-a"])
      expect(restored.steps).toEqual([])
    }),
    5_000,
  )

  effectTest(
    "pages a held prefix as the storage does, a narrower prefix and a start after a key too",
    Effect.gen(function* () {
      const entries = new Map<string, Schema.Json>([
        ["anthropic/cache/ses_1", { credentialID: "cred-a", at: 1 }],
        ["anthropic/cache/ses_2", { credentialID: "cred-a", at: 2 }],
        ["anthropic/cache/ses_3", { credentialID: "cred-a", at: 3 }],
        ["anthropic/hold/cred-a", { kind: "usage-limit", until: 9, at: 1 }],
      ])
      const shared = Shared.make()(memory(entries), prefixes)
      const direct = memory(entries)
      for (const options of [
        { prefix: "anthropic/", limit: 2 },
        { prefix: "anthropic/", after: "anthropic/cache/ses_2", limit: 2 },
        { prefix: "anthropic/cache/", limit: 10 },
        { prefix: "anthropic/cache/ses_2", limit: 1 },
        { prefix: "anthropic/cache/ses_9", limit: 1 },
      ])
        expect(yield* shared.scan(options)).toEqual(yield* direct.scan(options))
    }),
    5_000,
  )

  effectTest(
    "leaves every other prefix to the storage: each scan of it reads the storage again",
    Effect.gen(function* () {
      const entries = new Map<string, Schema.Json>([["fleet/peer/mac", { seenAt: 1 }]])
      const { scans, storage } = counted(entries)
      const shared = Shared.make()(storage, prefixes)
      yield* shared.scan({ prefix: "fleet/" })
      entries.set("fleet/peer/workbox", { seenAt: 2 })
      expect((yield* shared.scan({ prefix: "fleet/" })).entries).toHaveLength(2)
      expect(scans).toEqual(["fleet/", "fleet/"])
    }),
    5_000,
  )
})

/** The anthropic pool's ledger as a copy restores it from `storage`. */
const restore = (storage: LedgerLive.Storage) =>
  Ledger.use((ledger) => ledger.restore(PoolId.make("anthropic"))).pipe(Effect.provide(LedgerLive.layer(storage)))
