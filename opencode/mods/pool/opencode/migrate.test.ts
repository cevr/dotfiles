// The plugin's storage from before the login store's rename, rewritten at
// start so it names the same logins by their ids now: over the in-memory
// storage the seam tests use, paged as the plugin's storage pages.
import { describe, expect, test } from "bun:test"
import { Effect, type Schema } from "effect"
import { LEGACY_PREFIX as OLD } from "../legacy-ids.ts"
import { storage } from "../memory/ledger.ts"
import { migrate } from "./migrate.ts"

const run = (entries: Map<string, Schema.Json>) => migrate(storage(entries))

describe("the storage migration", () => {
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
        })
        // A second start finds nothing to do.
        expect(yield* run(entries)).toBe(0)
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
        expect(Object.fromEntries(entries)).toEqual({ "anthropic/hold/store:work": { kind: "usage-limit", until: 50 } })
      }),
    ))

  test("reads every page of a storage larger than one scan", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entries = new Map<string, Schema.Json>(Array.from({ length: 1200 }, (_, index) => [`anthropic/reading/${OLD}l${index}`, { at: index }]))
        expect(yield* run(entries)).toBe(1200)
        expect([...entries.keys()].every((key) => key.startsWith("anthropic/reading/store:"))).toBe(true)
      }),
    ))
})
