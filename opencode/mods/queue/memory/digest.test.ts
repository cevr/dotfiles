// The queue's digest lines, over the memory store: each item a change writes or removes is one line that decodes,
// with its unit and level; an item a change leaves as it was writes none.
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import { byteLength, decodeLine, DigestLog, MAX_LINE } from "@dotfiles/opencode-digest/event"
import * as MemoryDigest from "@dotfiles/opencode-digest/memory/log"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import type { ItemInput } from "../item.ts"
import { layer as queues, QueueModel } from "../model.ts"
import { QueueHost } from "../service.ts"
import * as MemoryStore from "./store.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"

const T0 = Date.parse("2026-11-18T12:00:00Z")

const host = Layer.succeed(
  QueueHost,
  QueueHost.of({
    roots: Effect.succeed([]),
    linked: () => Effect.succeed(Option.none()),
    wakes: () => Effect.succeed(Option.none()),
    questions: () => Effect.succeed(Option.none()),
    lost: () => Effect.succeed(Option.none()),
    note: () => Effect.void,
  }),
)

const run = <A, E>(name: string, digest: Layer.Layer<DigestLog>, body: Effect.Effect<A, E, QueueModel>) =>
  effectTest(
    name,
    TestClock.setTime(T0).pipe(
      Effect.andThen(body),
      Effect.provide(queues.pipe(Layer.provide(Layer.mergeAll(MemoryStore.layer(MemoryStore.empty()), host, digest)))),
      Effect.provide(TestClock.layer()),
    ),
    hangGuard("in-memory"),
  )

const write = (upsert: ReadonlyArray<ItemInput>, remove: ReadonlyArray<string> = []) => QueueModel.use((queue) => queue.change("ses_root", { upsert, remove }))

/** Each line as its kind, id and the fields the digest reads off an item. */
const read = (memory: MemoryDigest.MemoryLines) =>
  Effect.map(Ref.get(memory.lines), (lines) => {
    expect(lines.every((line) => byteLength(line) <= MAX_LINE)).toBe(true)
    return lines.flatMap((line) =>
      Option.toArray(
        Option.map(decodeLine(line), (event) => {
          if (event._tag === "Item") return [event._tag, event.id, event.state, Option.getOrElse(event.unit, () => "-"), Option.getOrElse(event.level, () => "-")]
          return [event._tag]
        }),
      ),
    )
  })

describe("the queue's digest lines", () => {
  const memory = MemoryDigest.empty()
  run(
    "one line per item written or removed, none for an item left as it was",
    MemoryDigest.writer(memory),
    Effect.gen(function* () {
      yield* write([
        { id: "billing", text: "Billing round 2 is with the verifier.", state: "running", unit: "billing", level: "amber" },
        { id: "docs", text: "Docs next.", state: "next" },
      ])
      expect(yield* read(memory)).toEqual([
        ["Item", "billing", "running", "billing", "amber"],
        ["Item", "docs", "next", "-", "-"],
      ])
      yield* write([{ id: "billing", level: "red" }, { id: "docs" }])
      yield* write([], ["docs"])
      expect((yield* read(memory)).slice(2)).toEqual([["Item", "billing", "running", "billing", "red"], ["ItemGone"]])
    }),
  )

  run(
    "a level that is not one of red, amber, green is refused; '' clears it",
    MemoryDigest.writer(),
    Effect.gen(function* () {
      const refused = yield* write([{ id: "a", text: "A.", state: "running", level: "crimson" }]).pipe(Effect.flip)
      expect(refused._tag).toBe("InvalidItem")
      yield* write([{ id: "a", text: "A.", state: "running", level: "red", unit: "u" }])
      const cleared = yield* write([{ id: "a", level: "", unit: "" }])
      expect(cleared.items.map((item) => ["level" in item, "unit" in item])).toEqual([[false, false]])
    }),
  )
})
