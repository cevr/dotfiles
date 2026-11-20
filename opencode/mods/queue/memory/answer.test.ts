// The queue model's seam for answers, over the memory store and a stand-in
// host: the choices an agent writes on an item, and the owner's answer to an
// item going to the session as one waking message, recorded on the item only
// as sent, until the agent writes the item again.
import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import type { ItemInput } from "../item.ts"
import { layer as queues, QueueModel } from "../model.ts"
import { explain } from "../queue.ts"
import { type NoteKind, NoteRefused, QueueHost } from "../service.ts"
import * as MemoryDigest from "@dotfiles/opencode-digest/memory/log"
import * as MemoryStore from "./store.ts"

const TIMEOUT_MS = 10_000
const T0 = Date.parse("2026-11-18T12:00:00Z")

interface Note {
  readonly sessionID: string
  readonly text: string
  readonly description: string
  readonly wake: boolean
  readonly kind: NoteKind
}

interface World {
  refuse: boolean
  readonly notes: Array<Note>
}

const hostOf = (world: World) =>
  Layer.succeed(
    QueueHost,
    QueueHost.of({
      roots: Effect.succeed([]),
      linked: () => Effect.succeed(Option.none()),
      wakes: () => Effect.succeed(Option.none()),
      questions: () => Effect.succeed(Option.none()),
      note: (sessionID, text, description, wake, kind) =>
        Effect.suspend(() => {
          if (world.refuse) return Effect.fail(new NoteRefused({ sessionID, message: "the host said no" }))
          world.notes.push({ sessionID, text, description, wake, kind })
          return Effect.void
        }),
    }),
  )

/** A test on a fresh store and the stand-in host, its clock at T0. */
const answerTest = <A, E>(name: string, body: (world: World) => Effect.Effect<A, E, QueueModel>) => {
  const world: World = { refuse: false, notes: [] }
  effectTest(
    name,
    TestClock.setTime(T0).pipe(
      Effect.andThen(body(world)),
      Effect.provide(queues.pipe(Layer.provide(Layer.mergeAll(MemoryStore.layer(MemoryStore.empty()), hostOf(world), MemoryDigest.writer())))),
      Effect.provide(TestClock.layer()),
    ),
    TIMEOUT_MS,
  )
}

const write = (upsert: ReadonlyArray<ItemInput>, remove: ReadonlyArray<string> = []) => QueueModel.use((queue) => queue.change("ses_root", { upsert, remove }))
const refused = (upsert: ReadonlyArray<ItemInput>) =>
  QueueModel.use((queue) =>
    queue.change("ses_root", { upsert }).pipe(
      Effect.as("accepted"),
      Effect.catchTag("InvalidItem", (invalid) => Effect.succeed(explain(invalid))),
      Effect.orDie,
    ),
  )
const answer = (id: string, text: string) => QueueModel.use((queue) => queue.answer("ses_root", id, text))
const items = QueueModel.use((queue) => queue.get("ses_root")).pipe(Effect.map((snapshot) => snapshot.items))

const panes: ItemInput = { id: "panes", text: "Close old Claude panes", state: "needs-you" }
const pool: ItemInput = { id: "pool", text: "Rotate the pool token", state: "next", choices: [{ label: "Rotate it now", description: "Before the next run" }, { label: "Wait for Friday" }] }

describe("an item's choices", () => {
  answerTest("are stored on one line each, kept when a patch leaves them out, cleared when written empty", () =>
    Effect.gen(function* () {
      yield* write([{ ...panes, choices: [{ label: " Close\n them ", description: "all of\nthem" }, { label: "Keep two", description: " " }] }])
      expect((yield* items)[0]?.choices).toEqual([{ label: "Close them", description: "all of them" }, { label: "Keep two" }])
      yield* write([{ id: "panes", text: "Close the panes" }])
      expect((yield* items)[0]?.choices).toEqual([{ label: "Close them", description: "all of them" }, { label: "Keep two" }])
      yield* write([{ id: "panes", choices: [] }])
      expect((yield* items)[0]).toEqual({ id: "panes", text: "Close the panes", state: "needs-you", owner: "mine" })
    }),
  )

  answerTest("past their limits are refused, saying why", () =>
    Effect.gen(function* () {
      const said = yield* Effect.forEach(
        [
          ["a", "b", "c", "d", "e"].map((label) => ({ label })),
          [{ label: " " }],
          [{ label: "Yes" }, { label: "yes" }],
          [{ label: "x".repeat(61) }],
        ],
        (choices) => refused([{ ...panes, choices }]),
      )
      expect(said).toEqual([
        'Item "panes": choices holds at most 4.',
        'Item "panes": a choice has no label.',
        'Item "panes": two choices share a label.',
        `Item "panes": choice "${"x".repeat(61)}": keep a label to 60 characters.`,
      ])
    }),
  )
})

describe("the owner's answer", () => {
  answerTest("a built-in, one of the agent's choices, or an answer of one's own each go as one waking message; the item only records it", (world) =>
    Effect.gen(function* () {
      yield* write([panes, pool])
      yield* answer("panes", "Done / no longer needed")
      yield* answer("pool", "Rotate it now")
      yield* answer("pool", " Wait\n until Monday ")
      expect(world.notes).toEqual([
        { sessionID: "ses_root", text: "Owner on queue item panes (Close old Claude panes): Done / no longer needed", description: "Queue answer: panes", wake: true, kind: "answer" },
        { sessionID: "ses_root", text: "Owner on queue item pool (Rotate the pool token): Rotate it now", description: "Queue answer: pool", wake: true, kind: "answer" },
        { sessionID: "ses_root", text: "Owner on queue item pool (Rotate the pool token): Wait until Monday", description: "Queue answer: pool", wake: true, kind: "answer" },
      ])
      const [first, second] = yield* items
      expect(first).toEqual({ id: "panes", text: "Close old Claude panes", state: "needs-you", owner: "mine", answered: { answer: "Done / no longer needed", at: T0 } })
      expect(second?.state).toBe("next")
      expect(second?.answered).toEqual({ answer: "Wait until Monday", at: T0 })
      // The agent's next write of the item clears the mark.
      yield* write([{ id: "panes", state: "done" }])
      expect((yield* items)[0]?.answered).toBeUndefined()
    }),
  )

  answerTest("an item the queue does not hold, or a blank answer, sends nothing; a note the host refuses records nothing", (world) =>
    Effect.gen(function* () {
      yield* write([panes])
      const failures = yield* Effect.forEach(
        [
          ["gone", "Done"],
          ["panes", " \n"],
        ] as const,
        ([id, text]) => Effect.flip(answer(id, text)),
      )
      expect(failures.map((failure) => failure._tag)).toEqual(["UnknownItem", "InvalidItem"])
      world.refuse = true
      expect((yield* Effect.flip(answer("panes", "Still needed")))._tag).toBe("NoteRefused")
      expect(world.notes).toEqual([])
      expect((yield* items)[0]?.answered).toBeUndefined()
    }),
  )
})
