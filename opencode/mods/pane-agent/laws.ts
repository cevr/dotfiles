import { expect, test } from "bun:test"
import { Effect, Exit, type Layer, type Scope } from "effect"
import { effectTest } from "../../sim-tui/effect-test.ts"
import { hangGuard } from "../../tests/hang-guard.ts"
import { WorkerStore } from "./service.ts"
import { EMPTY_SNAPSHOT, type PaneWorker } from "./worker.ts"

const sampleWorker = (id: string, turn = 1): PaneWorker => ({
  id,
  parentSessionID: "ses_parent",
  directory: "/tmp/repo",
  harness: "agy",
  role: "implementor",
  unit: "pane-agent r1",
  rexSessionId: "session:01a",
  blockId: "block:01b",
  ownedBlock: true,
  resultFile: "/tmp/run/result.md",
  state: "working",
  update: "running in Rex pane",
  turn,
  notifiedTurn: 0,
  startedAt: 1000,
  updatedAt: 1000,
})

/** Shared law suite every WorkerStore implementation must satisfy. */
export const storeLaws = (makeLayer: () => Layer.Layer<WorkerStore, never, Scope.Scope>) => {
  effectTest(
    "starts empty before any write",
    Effect.gen(function* () {
      const store = yield* WorkerStore
      const snapshot = yield* store.read()
      expect(snapshot).toEqual(EMPTY_SNAPSHOT)
    }).pipe(Effect.provide(makeLayer()), Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "persists workers and updates by id without duplicating while advancing revision",
    Effect.gen(function* () {
      const store = yield* WorkerStore
      const first = sampleWorker("pa_1", 1)
      yield* store.upsertWorker(first, 0)
      const updated = { ...first, state: "done" as const, turn: 2, updatedAt: 2000, endedAt: 2000 }
      yield* store.upsertWorker(updated, 1)
      const snapshot = yield* store.read()
      expect(snapshot.workers).toEqual([{ ...updated, revision: 2 }])
    }).pipe(Effect.provide(makeLayer()), Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "refuses stale compare-and-set writes with StoreConflict without overwriting newer state",
    Effect.gen(function* () {
      const store = yield* WorkerStore
      const first = sampleWorker("pa_cas", 1)
      yield* store.upsertWorker(first, 0)
      const newer = { ...first, update: "newer-update", updatedAt: 2000 }
      yield* store.upsertWorker(newer, 1)

      const stale = { ...first, update: "stale-overwrite", updatedAt: 1500 }
      const exit = yield* Effect.exit(store.upsertWorker(stale, 1))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("StoreConflict")
      }
      const snapshot = yield* store.read()
      expect(snapshot.workers[0]?.update).toBe("newer-update")
      expect(snapshot.workers[0]?.revision).toBe(2)
    }).pipe(Effect.provide(makeLayer()), Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "persists Rex pane anchors per session",
    Effect.gen(function* () {
      const store = yield* WorkerStore
      yield* store.saveAnchor("ses_1", { session: "session:1", block: "block:2" })
      const snapshot = yield* store.read()
      expect(snapshot.anchors["ses_1"]).toEqual({ session: "session:1", block: "block:2" })
    }).pipe(Effect.provide(makeLayer()), Effect.scoped),
    hangGuard("local-fixture"),
  )

  test("store laws registered", () => {
    expect(true).toBe(true)
  })
}
