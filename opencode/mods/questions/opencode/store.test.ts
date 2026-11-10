// The OpenCode QuestionStore over a stand-in storage: a sorted map that pages
// its scans one key at a time, as the host's key-value table pages by `next`.
import { expect, test } from "bun:test"
import { Effect, type Schema } from "effect"
import { storeLaws } from "../laws.ts"
import { QuestionStore } from "../service.ts"
import { keyOf, layer, type Storage } from "./store.ts"

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
      spoil: (sessionID) => Effect.sync(() => void entries.set(keyOf(sessionID), { next: "one", rows: 3 })),
    }
  }),
)

test("only the session keys are listed, not other keys the plugin keeps", async () => {
  const entries = new Map<string, Schema.Json>([
    ["other", 1],
    [keyOf("ses_a"), { next: 1, rows: [] }],
  ])
  expect(await Effect.runPromise(QuestionStore.use((store) => store.sessions).pipe(Effect.provide(layer(storage(entries)))))).toEqual(["ses_a"])
})

test("a sheet is stored as plain JSON, with no undefined fields", async () => {
  const entries = new Map<string, Schema.Json>()
  await Effect.runPromise(
    QuestionStore.use((store) =>
      store.write("ses_a", { next: 2, rows: [{ id: "q1", sessionID: "ses_a", question: "Port?", header: undefined, options: [{ label: "a", description: undefined }], assume: "a", askedAt: 1 }] }),
    ).pipe(Effect.provide(layer(storage(entries)))),
  )
  expect(JSON.stringify(entries.get(keyOf("ses_a")))).toBe('{"next":2,"rows":[{"id":"q1","sessionID":"ses_a","question":"Port?","assume":"a","askedAt":1,"options":[{"label":"a"}]}]}')
})

test("a plugin's question keeps who asked it, and under which key, across a read", async () => {
  const entries = new Map<string, Schema.Json>()
  const row = { id: "q1", sessionID: "ses_a", question: "Claim it?", assume: "no", askedAt: 1, from: { plugin: "dotfiles-opencode.pool", key: "hold-1" } }
  const read = await Effect.runPromise(
    QuestionStore.use((store) => store.write("ses_a", { next: 2, rows: [row] }).pipe(Effect.andThen(store.read("ses_a")))).pipe(Effect.provide(layer(storage(entries)))),
  )
  expect(read.rows).toEqual([row])
})
