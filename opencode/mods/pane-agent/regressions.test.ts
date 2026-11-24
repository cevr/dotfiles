import { describe, expect } from "bun:test"
import { Context, Duration, Effect, Layer, Option, Ref } from "effect"
import { effectTest } from "../../sim-tui/effect-test.ts"
import { hangGuard } from "../../tests/hang-guard.ts"
import { DONE_FRAME, PERMISSION_FRAME, READY_FRAME, TRUST_FRAME, WORKING_FRAME } from "./agy.fixture.ts"
import {
  emptyRexState,
  makeMemoryNotifier,
  makeMemoryResults,
  makeMemoryRex,
  makeMemoryStore,
  type MemoryRexState,
} from "./memory/doubles.ts"
import * as Model from "./model.ts"
import { RexCallFailed } from "./service.ts"
import type { StoreSnapshot } from "./worker.ts"

const waitFor = (check: Effect.Effect<boolean>, maxSteps = 200) =>
  Effect.gen(function* () {
    for (let step = 0; step < maxSteps; step++) {
      if (yield* check) return true
      yield* Effect.yieldNow
    }
    return false
  })

const FAST: Model.ModelConfig = {
  quietFor: Duration.millis(5),
  pollTimeout: Duration.millis(15),
  pasteQuiet: Duration.zero,
  retryDelay: Duration.zero,
  maxStartupChecks: 5,
  maxTransientErrors: 4,
}

const makeHarness = (rexInit: Partial<MemoryRexState>, initialStore?: StoreSnapshot) =>
  Effect.gen(function* () {
    const store = yield* makeMemoryStore(initialStore)
    const rex = yield* makeMemoryRex({ ...emptyRexState, ...rexInit })
    const results = yield* makeMemoryResults()
    const notifier = yield* makeMemoryNotifier()
    const services = yield* Layer.build(
      Model.layer(FAST).pipe(
        Layer.provide(Layer.mergeAll(store.layer, rex.layer, results.layer, notifier.layer)),
      ),
    )
    const model = Context.get(services, Model.PaneAgentModel)
    yield* model.bindPane("ses_p", { session: "session:root", block: "block:anchor" })
    return { store, rex, results, notifier, model }
  })

const BASE = {
  parentSessionID: "ses_p",
  directory: "/nonexistent/repo",
  harness: "agy" as const,
  description: "worker x",
  prompt: "Do it.",
  resultFile: "/nonexistent/run/r.md",
}

describe("pane-agent r1 review regressions (B1-B4, R1-R3)", () => {
  effectTest(
    "B1: placeholder write to resultFile while pane still shows working NEVER settles early; settles once after turnEnded with final content",
    Effect.gen(function* () {
      const h = yield* makeHarness({ defaultScreens: [READY_FRAME, WORKING_FRAME, WORKING_FRAME, WORKING_FRAME] })
      const started = yield* h.model.start(BASE)

      // Placeholder written while pane still shows esc to cancel
      yield* h.results.put(BASE.resultFile, "scratch", started.startedAt + 1)
      yield* waitFor(Ref.get(h.notifier.wakes).pipe(Effect.map((w) => w.length > 0)), 40)
      const prematureWakes = yield* Ref.get(h.notifier.wakes)
      expect(prematureWakes).toHaveLength(0)

      // Final answer written, then harness finishes and goes idle across waitForQuiet
      yield* h.results.put(BASE.resultFile, "pane-agent", started.startedAt + 2)
      yield* h.rex.setScreens(started.blockId, [DONE_FRAME, DONE_FRAME, DONE_FRAME])
      const woke = yield* waitFor(Ref.get(h.notifier.wakes).pipe(Effect.map((w) => w.length > 0)))
      expect(woke).toBe(true)

      const wakes = yield* Ref.get(h.notifier.wakes)
      expect(wakes).toHaveLength(1)
      expect(wakes[0]?.letter.text).toContain('state="done"')
      expect(wakes[0]?.letter.text).toContain('source="result-file"')
      expect(wakes[0]?.letter.text).toContain("pane-agent")
      expect(wakes[0]?.letter.text).not.toContain("scratch")
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "B2: follow_up and steer NEVER write into a pane showing a trust or permission prompt and preserve the unsent first task in order",
    Effect.gen(function* () {
      for (const frame of [TRUST_FRAME, PERMISSION_FRAME]) {
        const h = yield* makeHarness({ defaultScreens: [frame, frame, frame] })
        const started = yield* h.model.start(BASE)
        expect(started.state).toBe("needs_input")

        const afterFollow = yield* h.model.followUp({ parentSessionID: "ses_p", id: started.id, prompt: "next-queued" })
        const afterSteer = yield* h.model.followUp({
          parentSessionID: "ses_p",
          id: started.id,
          prompt: "next-steered",
          steer: true,
        })
        expect(afterFollow.state).toBe("needs_input")
        expect(afterSteer.state).toBe("needs_input")

        const writesWhileBlocked = (yield* Ref.get(h.rex.state)).panes[0]?.writes ?? []
        expect(writesWhileBlocked).toEqual([])

        // Once human clears the prompt, first task is typed first (never dropped!)
        yield* h.rex.setScreens(started.blockId, [READY_FRAME, WORKING_FRAME, WORKING_FRAME])
        const typedFirst = yield* waitFor(
          Ref.get(h.rex.state).pipe(Effect.map((s) => (s.panes[0]?.writes.length ?? 0) > 0)),
        )
        expect(typedFirst).toBe(true)
        const firstWrites = (yield* Ref.get(h.rex.state)).panes[0]?.writes.join("") ?? ""
        expect(firstWrites).toContain("Do it.")
        expect(firstWrites).not.toContain("next-queued")
      }
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "B3: a brief transient Rex timeout never marks a live pane pane_gone; persistent outages surface rex_unreachable and recover once Rex answers",
    Effect.gen(function* () {
      const h = yield* makeHarness({ defaultScreens: [READY_FRAME, WORKING_FRAME, WORKING_FRAME] })
      const started = yield* h.model.start(BASE)

      // Persistent transient Rex outage exceeds maxTransientErrors -> surfaces distinct rex_unreachable (NEVER pane_gone)
      yield* Ref.update(h.rex.state, (s) => ({
        ...s,
        failWith: Option.some(new RexCallFailed({ operation: "terminals.read", message: "request timeout" })),
      }))
      const reachedUnreachable = yield* waitFor(
        Ref.get(h.store.state).pipe(
          Effect.map((snap) => snap.workers.find((w) => w.id === started.id)?.state === "rex_unreachable"),
        ),
      )
      expect(reachedUnreachable).toBe(true)

      const statusDuringOutage = yield* h.model.status("ses_p", started.id)
      expect(statusDuringOutage.state).toBe("rex_unreachable")
      expect(statusDuringOutage.state).not.toBe("pane_gone")

      const wakesDuringOutage = yield* Ref.get(h.notifier.wakes)
      expect(wakesDuringOutage).toHaveLength(1)
      expect(wakesDuringOutage[0]?.letter.text).toContain('state="rex_unreachable"')
      expect(wakesDuringOutage[0]?.letter.text).not.toContain('state="pane_gone"')

      // Rex recovers and turn completes cleanly
      yield* Ref.update(h.rex.state, (s) => ({ ...s, failWith: Option.none() }))
      yield* h.results.put(BASE.resultFile, "recovered-answer", started.startedAt + 10)
      yield* h.rex.setScreens(started.blockId, [DONE_FRAME, DONE_FRAME, DONE_FRAME])
      const woke = yield* waitFor(Ref.get(h.notifier.wakes).pipe(Effect.map((w) => w.length >= 2)))
      expect(woke).toBe(true)

      const wakes = yield* Ref.get(h.notifier.wakes)
      expect(wakes).toHaveLength(2)
      expect(wakes[1]?.letter.text).toContain('state="done"')
      expect(wakes[1]?.letter.text).toContain("recovered-answer")
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "R1: failed wake keeps pendingWake on disk and retries with the exact same deliveryId; once marked, reattach never double-wakes",
    Effect.gen(function* () {
      const store = yield* makeMemoryStore()
      const rex = yield* makeMemoryRex({
        ...emptyRexState,
        defaultScreens: [READY_FRAME, WORKING_FRAME, DONE_FRAME, DONE_FRAME],
      })
      const results = yield* makeMemoryResults()
      const notifier = yield* makeMemoryNotifier()
      const shared = Layer.mergeAll(store.layer, rex.layer, results.layer, notifier.layer)

      // First two wake deliveries fail (simulating refused synthetic call before restart)
      yield* notifier.failNextWakes(2)

      let workerId = ""
      yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(Model.layer(FAST).pipe(Layer.provide(shared)))
          const model = Context.get(services, Model.PaneAgentModel)
          yield* model.bindPane("ses_p", { session: "session:root", block: "block:anchor" })
          const started = yield* model.start(BASE)
          workerId = started.id
          yield* results.put(BASE.resultFile, "durable-answer", started.startedAt + 10)

          // Wait until at least one failed delivery attempt has been made while pendingWake stays persisted
          const attempted = yield* waitFor(Ref.get(notifier.attempts).pipe(Effect.map((a) => a.length >= 1)))
          expect(attempted).toBe(true)
          const snap = yield* Ref.get(store.state)
          const persisted = snap.workers.find((w) => w.id === workerId)
          expect(persisted?.pendingWake).toBeDefined()
          expect(persisted?.notifiedTurn).toBe(0)
        }),
      )

      // Server restarts: reattach flushes pendingWake (retries with SAME deliveryId until accepted once)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(Model.layer(FAST).pipe(Layer.provide(shared)))
          const model = Context.get(services, Model.PaneAgentModel)
          yield* model.reattach(BASE.directory)
          const delivered = yield* waitFor(Ref.get(notifier.wakes).pipe(Effect.map((w) => w.length === 1)))
          expect(delivered).toBe(true)

          // Every attempt used the exact same minted msg_ deliveryId
          const attempts = yield* Ref.get(notifier.attempts)
          expect(attempts.length).toBeGreaterThanOrEqual(3)
          const firstId = attempts[0]?.letter.id ?? ""
          expect(firstId.startsWith("msg_")).toBe(true)
          for (const attempt of attempts) {
            expect(attempt.letter.id).toBe(firstId)
          }

          // After delivery, pendingWake is cleared and notifiedTurn == 1
          const snapAfter = yield* Ref.get(store.state)
          const settled = snapAfter.workers.find((w) => w.id === workerId)
          expect(settled?.pendingWake).toBeUndefined()
          expect(settled?.notifiedTurn).toBe(1)

          // Pin the once-per-turn guard: if a stale working state with notifiedTurn=1 reattaches, ZERO second wake attempts occur
          const settledOpt = Option.fromUndefinedOr(settled)
          if (Option.isSome(settledOpt)) {
            yield* Ref.update(store.state, (s) => ({
              ...s,
              workers: s.workers.map((w) => {
                if (w.id === workerId) return { ...w, state: "working" as const, activeTurnTyped: true }
                return w
              }),
            }))
          }
          const attemptsBefore = (yield* Ref.get(notifier.attempts)).length
          yield* model.reattach(BASE.directory)
          const attemptsAfter = (yield* Ref.get(notifier.attempts)).length
          expect(attemptsAfter).toBe(attemptsBefore)
          expect((yield* Ref.get(notifier.wakes))).toHaveLength(1)
        }),
      )
    }),
    hangGuard("local-fixture"),
  )

  effectTest(
    "B4: restart preserves skipPermissions: false given at start",
    Effect.gen(function* () {
      const h = yield* makeHarness({ defaultScreens: [READY_FRAME, WORKING_FRAME, WORKING_FRAME] })
      const started = yield* h.model.start({ ...BASE, skipPermissions: false })
      yield* h.rex.setAlive(started.blockId, false)
      yield* h.model.restart({ parentSessionID: "ses_p", id: started.id })
      const splits = (yield* Ref.get(h.rex.state)).splits
      expect(splits).toHaveLength(2)
      expect(splits[0]?.command).not.toContain("--dangerously-skip-permissions")
      expect(splits[1]?.command).not.toContain("--dangerously-skip-permissions")
      expect(splits[1]?.command).toContain("--continue")
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "R2: server restart while waiting at a startup trust prompt preserves and types the original task once the prompt clears",
    Effect.gen(function* () {
      const store = yield* makeMemoryStore()
      const rex = yield* makeMemoryRex({ ...emptyRexState, defaultScreens: [TRUST_FRAME, TRUST_FRAME] })
      const results = yield* makeMemoryResults()
      const notifier = yield* makeMemoryNotifier()
      const shared = Layer.mergeAll(store.layer, rex.layer, results.layer, notifier.layer)

      let workerId = ""
      let blockId = ""

      // Server instance 1 starts worker -> lands on TRUST_FRAME (needs_input) -> server shuts down
      yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(Model.layer(FAST).pipe(Layer.provide(shared)))
          const model = Context.get(services, Model.PaneAgentModel)
          yield* model.bindPane("ses_p", { session: "session:root", block: "block:anchor" })
          const started = yield* model.start(BASE)
          expect(started.state).toBe("needs_input")
          workerId = started.id
          blockId = started.blockId
        }),
      )

      // Server instance 2 boots, reattaches, human clears prompt -> original task MUST be typed & completed
      yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(Model.layer(FAST).pipe(Layer.provide(shared)))
          const model = Context.get(services, Model.PaneAgentModel)
          yield* model.reattach(BASE.directory)

          // No duplicate needs_input wake after restart!
          const wakesBeforeClear = yield* Ref.get(notifier.wakes)
          expect(wakesBeforeClear).toHaveLength(1)

          yield* rex.setScreens(blockId, [READY_FRAME, WORKING_FRAME, DONE_FRAME, DONE_FRAME])
          const done = yield* waitFor(Ref.get(notifier.wakes).pipe(Effect.map((w) => w.length >= 2)))
          expect(done).toBe(true)

          const writes = (yield* Ref.get(rex.state)).panes[0]?.writes.join("") ?? ""
          expect(writes).toContain("Do it.")
          const wakes = yield* Ref.get(notifier.wakes)
          expect(wakes).toHaveLength(2)
          expect(wakes[1]?.letter.text).toContain('state="done"')
        }),
      )
      expect(workerId.length).toBeGreaterThan(0)
    }),
    hangGuard("local-fixture"),
  )

  effectTest(
    "R3: follow_up queued while turn 1 runs settles turn 1 with turn 1's answer, then starts turn 2 and settles turn 2 with turn 2's answer",
    Effect.gen(function* () {
      const h = yield* makeHarness({ defaultScreens: [READY_FRAME, WORKING_FRAME, WORKING_FRAME, WORKING_FRAME] })
      const started = yield* h.model.start(BASE)

      // Queue follow-up while turn 1 is still running (even reusing same resultFile!)
      yield* h.model.followUp({
        parentSessionID: "ses_p",
        id: started.id,
        prompt: "Second turn task.",
        resultFile: BASE.resultFile,
      })

      // Turn 2 must NOT have been typed yet while turn 1 is running
      const writesDuringT1 = (yield* Ref.get(h.rex.state)).panes[0]?.writes.join("") ?? ""
      expect(writesDuringT1).not.toContain("Second turn task.")

      // Turn 1 writes its answer and goes idle
      yield* h.results.put(BASE.resultFile, "answer-turn-1", started.startedAt + 10)
      yield* h.rex.setScreens(started.blockId, [DONE_FRAME, DONE_FRAME, DONE_FRAME])

      const t1Done = yield* waitFor(Ref.get(h.notifier.wakes).pipe(Effect.map((w) => w.length >= 1)))
      expect(t1Done).toBe(true)

      const wakes1 = yield* Ref.get(h.notifier.wakes)
      expect(wakes1[0]?.letter.text).toContain('turn="1"')
      expect(wakes1[0]?.letter.text).toContain("answer-turn-1")

      // After turn 1 settles, turn 2 is typed automatically with its own distinct result file
      const t2Typed = yield* waitFor(
        Ref.get(h.rex.state).pipe(Effect.map((s) => (s.panes[0]?.writes.join("") ?? "").includes("Second turn task."))),
      )
      expect(t2Typed).toBe(true)

      // Turn 2 finishes without prematurely grabbing turn 1's result file
      const snapAfterT2Typed = yield* Ref.get(h.store.state)
      const workerT2 = snapAfterT2Typed.workers.find((w) => w.id === started.id)
      expect(workerT2?.turn).toBe(2)
      expect(workerT2?.resultFile).not.toBe(BASE.resultFile)

      yield* h.results.put(workerT2?.resultFile ?? "", "answer-turn-2", (workerT2?.startedAt ?? 0) + 10)
      yield* h.rex.setScreens(started.blockId, [WORKING_FRAME, DONE_FRAME, DONE_FRAME])

      const t2Done = yield* waitFor(Ref.get(h.notifier.wakes).pipe(Effect.map((w) => w.length >= 2)))
      expect(t2Done).toBe(true)

      const wakes2 = yield* Ref.get(h.notifier.wakes)
      expect(wakes2).toHaveLength(2)
      expect(wakes2[1]?.letter.text).toContain('turn="2"')
      expect(wakes2[1]?.letter.text).toContain("answer-turn-2")
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )
})
