// The ledger held in memory: OpenCode's ledger (opencode/ledger.ts) over a
// storage kept in a map by key, paged as the plugin's storage pages. The
// plugin's seam tests run on it and read its keys.
import { Effect, type Schema } from "effect"
import * as OpenCodeLedger from "../opencode/ledger.ts"

/** A storage held in `entries`, by key, paged as the plugin's is. */
export const storage = (entries: Map<string, Schema.Json>): OpenCodeLedger.Storage => ({
  scan: ({ prefix, after, limit = OpenCodeLedger.PAGE }) =>
    Effect.sync(() => {
      const keys = [...entries.keys()].filter((key) => key.startsWith(prefix) && (after === undefined || key > after)).sort()
      const page = keys.slice(0, limit)
      const last = page.at(-1)
      return {
        entries: page.map((key) => ({ key, value: entries.get(key) })),
        ...(keys.length > limit && last !== undefined ? { next: last } : {}),
      }
    }),
  set: (key, value) => Effect.sync(() => void entries.set(key, value)),
  remove: (key) => Effect.sync(() => void entries.delete(key)),
})

/** The ledger in `entries`, by key, as the plugin's storage keeps it. */
export const layer = (entries: Map<string, Schema.Json> = new Map()) => OpenCodeLedger.layer(storage(entries))
