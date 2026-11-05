// OpenCode's ledger over a stand-in for the plugin's storage that answers one
// entry per page, so every restore walks the pages; and over a storage that
// fails, which the ledger reads as empty and writes past.
import { expect, test } from "bun:test"
import { Effect, type Schema } from "effect"
import { PoolId, RequestRefused } from "../account-pool.ts"
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
