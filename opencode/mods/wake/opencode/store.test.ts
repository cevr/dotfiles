// The OpenCode WakeStore over a stand-in storage: a sorted map that pages its
// scans one key at a time, as the host's key-value table pages by `next`.
import { expect, test } from "bun:test"
import { Effect, type Schema } from "effect"
import { alarm, notice, storeLaws } from "../laws.ts"
import { WakeStore } from "../service.ts"
import { ENTRY, layer, NOTICE, type Storage } from "./store.ts"

const storage = (entries: Map<string, Schema.Json>): Storage => ({
  get: (key) => Effect.sync(() => entries.get(key)),
  set: (key, value) => Effect.sync(() => void entries.set(key, value)),
  remove: (key) => Effect.sync(() => void entries.delete(key)),
  scan: ({ prefix, after, limit }) =>
    Effect.sync(() => {
      const keys = [...entries.keys()].filter((key) => key.startsWith(prefix) && (after === undefined || key > after)).toSorted()
      const page = keys.slice(0, Math.min(limit ?? keys.length, 1))
      const last = page.at(-1)
      return { entries: page.map((key) => ({ key })), ...(page.length < keys.length && last !== undefined ? { next: last } : {}) }
    }),
})

storeLaws(
  "the OpenCode storage",
  Effect.sync(() => {
    const entries = new Map<string, Schema.Json>()
    return {
      layer: layer(storage(entries)),
      spoil: (id) => Effect.sync(() => void entries.set(`${ENTRY}${id}`, { kind: "alarm", dueAt: "soon" })),
    }
  }),
)

test("an entry is stored under wake:<id> and a notice under notice:<delivery>, as plain JSON", async () => {
  const entries = new Map<string, Schema.Json>()
  await Effect.runPromise(
    WakeStore.use((store) => Effect.all([store.write(alarm), store.writeNotice(notice)])).pipe(Effect.provide(layer(storage(entries)))),
  )
  expect([...entries.keys()].toSorted()).toEqual([`${NOTICE}${notice.delivery}`, `${ENTRY}${alarm.id}`])
  expect(entries.get(`${ENTRY}${alarm.id}`)).toEqual({ ...alarm })
})
