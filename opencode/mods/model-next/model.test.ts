// The handlers on memory: the other keys of the session's metadata (wake's
// latch mark) survive queue, cancel and both applies.
import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { layer as modelLayer, ModelNext } from "./model.ts"
import { layer, store } from "./memory/sessions.ts"
import { KEY } from "./pending.ts"

const OLD = { providerID: "sim", id: "old" }
const NEW = { providerID: "other", id: "new" }
const LATCH = { id: "latch_1", opensAt: 5 }

const bench = () => {
  const held = store()
  held.records.set("ses_a", { model: OLD, metadata: { latch: LATCH } })
  held.catalog.set("sim/old", { variants: [], native: false })
  held.catalog.set("other/new", { variants: [], native: false })
  const run = <A>(body: (next: typeof ModelNext.Service) => Effect.Effect<A>) =>
    Effect.runPromise(ModelNext.use(body).pipe(Effect.provide(modelLayer({ ttl: Option.none(), grace: 60_000 })), Effect.provide(layer(held))))
  return { held, run }
}

test("queue, cancel and an apply at the compaction keep the latch mark", async () => {
  const { held, run } = bench()
  expect(await run((next) => next.queue("ses_a", NEW))).toMatchObject({ _tag: "Queued" })
  expect(held.records.get("ses_a")?.metadata).toMatchObject({ latch: LATCH, [KEY]: { model: NEW } })
  expect(await run((next) => next.cancel("ses_a"))).toEqual({ _tag: "Cancelled", had: true })
  expect(held.records.get("ses_a")?.metadata).toEqual({ latch: LATCH })
  await run((next) => next.queue("ses_a", NEW))
  await run((next) => next.compacted("ses_a"))
  expect(held.records.get("ses_a")?.metadata).toEqual({ latch: LATCH })
  expect(held.switched).toEqual([{ sessionID: "ses_a", model: NEW }])
})

test("an apply at the wake past the expiry keeps the latch mark; a warm cache keeps the switch queued", async () => {
  const { held, run } = bench()
  await run((next) => next.queue("ses_a", NEW))
  held.cache.set("ses_a", { last: Option.some({ startedAt: Date.now(), cached: true, ttl: Option.some(300_000) }), compacted: false })
  await run((next) => next.woke("ses_a"))
  expect(held.switched).toEqual([])
  held.cache.set("ses_a", { last: Option.some({ startedAt: 0, cached: true, ttl: Option.some(300_000) }), compacted: false })
  await run((next) => next.woke("ses_a"))
  expect(held.switched).toEqual([{ sessionID: "ses_a", model: NEW }])
  expect(held.records.get("ses_a")?.metadata).toEqual({ latch: LATCH })
})

test("a target the catalog lost stays queued at the compaction", async () => {
  const { held, run } = bench()
  await run((next) => next.queue("ses_a", NEW))
  held.catalog.delete("other/new")
  await run((next) => next.compacted("ses_a"))
  expect(held.switched).toEqual([])
  expect(held.records.get("ses_a")?.metadata).toMatchObject({ [KEY]: { model: NEW } })
})

test("a selection of another model drops it; one of the model it was queued from does not", async () => {
  const { held, run } = bench()
  await run((next) => next.queue("ses_a", NEW))
  await run((next) => next.selected("ses_a", OLD))
  expect(held.records.get("ses_a")?.metadata).toMatchObject({ [KEY]: { model: NEW } })
  await run((next) => next.selected("ses_a", { providerID: "sim", id: "third" }))
  expect(held.records.get("ses_a")?.metadata).toEqual({ latch: LATCH })
})
