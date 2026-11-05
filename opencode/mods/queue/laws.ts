// What every implementation of QueueStore owes, as a shared test suite. Each
// implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, type Scope } from "effect"
import { EMPTY, type Snapshot } from "./queue.ts"
import { QueueStore } from "./service.ts"

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

/** A store under test: its Layer, and a way to make one session's stored queue unreadable. */
export interface StoreProbe {
  readonly layer: Layer.Layer<QueueStore>
  readonly spoil: (sessionID: string) => Effect.Effect<void>
}

const one: Snapshot = {
  revision: 1,
  items: [{ id: "pool", text: "Sidebar pool worker", state: "running", owner: "mine", session: "ses_child" }],
}
const two: Snapshot = {
  revision: 2,
  items: [
    { id: "pool", text: "Sidebar pool worker", state: "done", owner: "mine", session: "ses_child", doneAt: 1_700_000_000_000 },
    { id: "token", text: "pool-token check", state: "scheduled", owner: "other", who: "wC:p6", at: "2026-11-04T22:07:00.000Z", detail: "cron" },
  ],
}

/** `make` gives an empty store within the test's scope. */
export const storeLaws = (name: string, make: Effect.Effect<StoreProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the QueueStore laws`, () => {
    test("a session with no queue reads as empty", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          expect(yield* QueueStore.use((store) => store.read("ses_none")).pipe(Effect.provide(probe.layer))).toEqual(EMPTY)
        }),
      ))

    test("reads what was last written, per session, every field kept", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = <A, E>(body: (store: QueueStore["Service"]) => Effect.Effect<A, E>) => QueueStore.use(body).pipe(Effect.provide(probe.layer))
          yield* run((store) => store.write("ses_a", one))
          expect(yield* run((store) => store.read("ses_a"))).toEqual(one)
          yield* run((store) => store.write("ses_a", two))
          expect(yield* run((store) => store.read("ses_a"))).toEqual(two)
          expect(yield* run((store) => store.read("ses_b"))).toEqual(EMPTY)
        }),
      ))

    test("remove forgets a session's queue, and removing none succeeds", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = <A, E>(body: (store: QueueStore["Service"]) => Effect.Effect<A, E>) => QueueStore.use(body).pipe(Effect.provide(probe.layer))
          yield* run((store) => store.write("ses_a", one))
          yield* run((store) => store.remove("ses_a"))
          expect(yield* run((store) => store.read("ses_a"))).toEqual(EMPTY)
          yield* run((store) => store.remove("ses_a"))
        }),
      ))

    test("a queue that cannot be read fails QueueUnreadable and says why; a write replaces it", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = <A, E>(body: (store: QueueStore["Service"]) => Effect.Effect<A, E>) => QueueStore.use(body).pipe(Effect.provide(probe.layer))
          yield* run((store) => store.write("ses_a", one))
          yield* probe.spoil("ses_a")
          const failure = yield* run((store) => store.read("ses_a")).pipe(Effect.flip)
          expect(failure._tag).toBe("QueueUnreadable")
          expect(failure.message).not.toBe("")
          yield* run((store) => store.write("ses_a", two))
          expect(yield* run((store) => store.read("ses_a"))).toEqual(two)
        }),
      ))
  })
