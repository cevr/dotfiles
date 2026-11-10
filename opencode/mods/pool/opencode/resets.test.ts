// The Resets state in the plugin's storage: the store laws over a stand-in
// storage, and a stored value that does not decode left out.
import { expect, test } from "bun:test"
import { Effect, type Schema } from "effect"
import { resetsStoreLaws } from "../laws.ts"
import { storage } from "../memory/ledger.ts"
import { ResetsStore } from "../service.ts"
import * as OpenCodeResets from "./resets.ts"

resetsStoreLaws("OpenCode's ResetsStore", () => {
  const entries = new Map<string, Schema.Json>()
  return () => OpenCodeResets.layer(storage(entries))
})

test("an entry that does not decode is left out, the rest read", async () => {
  const entries = new Map<string, Schema.Json>([
    ["resets/wait/openai", { at: 5 }],
    ["resets/wait/anthropic", { at: "soon" }],
    ["resets/reset/k", { key: "k" }],
    ["resets/claim/000000000000001/k", 3],
  ])
  const state = await Effect.runPromise(ResetsStore.use((store) => store.read).pipe(Effect.provide(OpenCodeResets.layer(storage(entries)))))
  expect(state).toEqual({ waits: { openai: { at: 5 } }, resets: {}, claims: [] })
})
