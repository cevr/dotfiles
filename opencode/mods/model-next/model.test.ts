// The handlers on memory: the other keys of the session's metadata (wake's
// latch mark) survive queue, cancel and both applies.
import { expect } from "bun:test"
import { Clock, Effect, Layer, Option } from "effect"
import { effectTest } from "../../sim-tui/effect-test.ts"
import { layer as modelLayer, ModelNext } from "./model.ts"
import { layer, store } from "./memory/sessions.ts"
import { Cancelled, KEY, Queued } from "./pending.ts"

const OLD = { providerID: "sim", id: "old" }
const NEW = { providerID: "other", id: "new" }
const LATCH = { id: "latch_1", opensAt: 5 }
const CASE_MS = 30_000
const cachedAt = (startedAt: number) => ({ last: Option.some({ startedAt, cached: true, ttl: Option.some(300_000), unresolved: Option.none() }), compacted: false })

/** A session on OLD with a latch mark, both models in the catalog, and the handlers over it. */
const bench = () => {
  const held = store()
  held.records.set("ses_a", { model: OLD, metadata: { latch: LATCH } })
  held.catalog.set("sim/old", { variants: [], native: false })
  held.catalog.set("other/new", { variants: [], native: false })
  return { held, handlers: modelLayer({ ttl: Option.none(), grace: 60_000 }).pipe(Layer.provide(layer(held))) }
}

const metadataOf = (held: ReturnType<typeof store>) => Option.map(Option.fromUndefinedOr(held.records.get("ses_a")), (record) => record.metadata)

{
  const { held, handlers } = bench()
  effectTest(
    "queue, cancel and an apply at the compaction keep the latch mark",
    Effect.gen(function* () {
      const next = yield* ModelNext
      expect(yield* next.queue("ses_a", NEW)).toEqual(Queued.make({ model: NEW, from: OLD }))
      expect(metadataOf(held)).toMatchObject(Option.some({ latch: LATCH, [KEY]: { model: NEW } }))
      expect(yield* next.cancel("ses_a")).toEqual(Cancelled.make({ had: true }))
      expect(metadataOf(held)).toEqual(Option.some({ latch: LATCH }))
      yield* next.queue("ses_a", NEW)
      yield* next.compacted("ses_a")
      expect(metadataOf(held)).toEqual(Option.some({ latch: LATCH }))
      expect(held.switched).toEqual([{ sessionID: "ses_a", model: NEW }])
    }).pipe(Effect.provide(handlers)),
    CASE_MS,
  )
}

{
  const { held, handlers } = bench()
  effectTest(
    "an apply at the wake past the expiry keeps the latch mark; a warm cache keeps the switch queued",
    Effect.gen(function* () {
      const next = yield* ModelNext
      yield* next.queue("ses_a", NEW)
      held.cache.set("ses_a", cachedAt(yield* Clock.currentTimeMillis))
      yield* next.woke("ses_a")
      expect(held.switched).toEqual([])
      held.cache.set("ses_a", cachedAt(0))
      yield* next.woke("ses_a")
      expect(held.switched).toEqual([{ sessionID: "ses_a", model: NEW }])
      expect(metadataOf(held)).toEqual(Option.some({ latch: LATCH }))
    }).pipe(Effect.provide(handlers)),
    CASE_MS,
  )
}

{
  const { held, handlers } = bench()
  effectTest(
    "a target the catalog lost stays queued at the compaction",
    Effect.gen(function* () {
      const next = yield* ModelNext
      yield* next.queue("ses_a", NEW)
      held.catalog.delete("other/new")
      yield* next.compacted("ses_a")
      expect(held.switched).toEqual([])
      expect(metadataOf(held)).toMatchObject(Option.some({ [KEY]: { model: NEW } }))
    }).pipe(Effect.provide(handlers)),
    CASE_MS,
  )
}

{
  const { held, handlers } = bench()
  effectTest(
    "a selection of another model drops it; one of the model it was queued from does not",
    Effect.gen(function* () {
      const next = yield* ModelNext
      yield* next.queue("ses_a", NEW)
      yield* next.selected("ses_a", OLD)
      expect(metadataOf(held)).toMatchObject(Option.some({ [KEY]: { model: NEW } }))
      yield* next.selected("ses_a", { providerID: "sim", id: "third" })
      expect(metadataOf(held)).toEqual(Option.some({ latch: LATCH }))
    }).pipe(Effect.provide(handlers)),
    CASE_MS,
  )
}
