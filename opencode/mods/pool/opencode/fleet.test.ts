// OpenCode's FleetStore over a stand-in for the plugin's storage that answers
// one entry per page, so every read walks the pages; and over a storage that
// fails, which the store reads as an empty fleet and writes past.
import { expect, test } from "bun:test"
import { Effect, type Schema } from "effect"
import { PollClaimed, StartRecorded } from "../fleet.ts"
import { fleetStoreLaws } from "../laws.ts"
import { FleetStore } from "../service.ts"
import * as OpenCodeFleet from "./fleet.ts"
import type { Storage } from "./ledger.ts"

const pagedByOne = (entries: Map<string, Schema.Json>): Storage => ({
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

fleetStoreLaws("OpenCode's FleetStore", () => {
  const entries = new Map<string, Schema.Json>()
  return () => OpenCodeFleet.layer(pagedByOne(entries))
})

test("keeps one key per start and per peer, under fleet/, beside the ledger's", () => {
  const entries = new Map<string, Schema.Json>()
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* FleetStore
      const start = { providerID: "anthropic", at: 1_800_000_000_000 }
      yield* store.record([StartRecorded.make({ start }), PollClaimed.make({ peer: "work box", at: 5 })], {
        starts: [start],
        peers: { "work box": { polledAt: 5 } },
      })
      expect([...entries.keys()].map((key) => key.replace(/[0-9a-f-]{36}$/, "<id>"))).toEqual([
        "fleet/start/001800000000000/<id>",
        "fleet/peer/work%20box",
      ])
      expect([...entries.values()]).toEqual([start, { polledAt: 5 }])
    }).pipe(Effect.provide(OpenCodeFleet.layer(pagedByOne(entries)))),
  )
})

test("a storage that fails reads an empty fleet, and a write to it is lost without failing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* FleetStore
      const start = { providerID: "anthropic", at: 1 }
      yield* store.record([StartRecorded.make({ start })], { starts: [start], peers: {} })
      expect(yield* store.read).toEqual({ starts: [], peers: {} })
    }).pipe(
      Effect.provide(
        OpenCodeFleet.layer({
          scan: () => Effect.fail("storage down"),
          set: () => Effect.fail("storage down"),
          remove: () => Effect.fail("storage down"),
        }),
      ),
    ),
  ))
