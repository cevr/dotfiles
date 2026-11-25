import { describe, expect } from "bun:test"
import { Context, Deferred, Duration, Effect, Exit, Layer, Option, Ref } from "effect"
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
import { RexCallFailed, RexClient } from "./service.ts"
import type { PaneWorker, StoreSnapshot } from "./worker.ts"

const waitFor = (check: Effect.Effect<boolean>, maxSteps = 200) =>
  Effect.gen(function* () {
    for (let step = 0; step < maxSteps; step++) {
      if (yield* check) return true
      yield* Effect.yieldNow
    }
    return false
  })

const waitForWorker = (
  store: Ref.Ref<StoreSnapshot>,
  id: string,
  pred: (w: PaneWorker) => boolean,
  maxSteps = 400,
) =>
  Effect.gen(function* () {
    for (let step = 0; step < maxSteps; step++) {
      const snap = yield* Ref.get(store)
      const found = snap.workers.find((w) => w.id === id)
      if (found && pred(found)) return found
      yield* Effect.yieldNow
    }
    const snap = yield* Ref.get(store)
    return snap.workers.find((w) => w.id === id)
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
      const running = yield* waitForWorker(h.store.state, started.id, (w) => w.state === "working" && w.blockId.length > 0)
      const blockId = running?.blockId ?? ""
      const startedAt = running?.startedAt ?? started.startedAt

      // Placeholder written while pane still shows esc to cancel
      yield* h.results.put(BASE.resultFile, "scratch", startedAt + 1)
      yield* waitFor(Ref.get(h.notifier.wakes).pipe(Effect.map((w) => w.length > 0)), 40)
      const prematureWakes = yield* Ref.get(h.notifier.wakes)
      expect(prematureWakes).toHaveLength(0)

      // Final answer written, then harness finishes and goes idle across waitForQuiet
      yield* h.results.put(BASE.resultFile, "pane-agent", startedAt + 2)
      yield* h.rex.setScreens(blockId, [DONE_FRAME, DONE_FRAME, DONE_FRAME])
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
        const blocked = yield* waitForWorker(h.store.state, started.id, (w) => w.state === "needs_input" && w.blockId.length > 0)
        expect(blocked?.state).toBe("needs_input")

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
        yield* h.rex.setScreens(blocked?.blockId ?? "", [READY_FRAME, WORKING_FRAME, WORKING_FRAME])
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
      const running = yield* waitForWorker(h.store.state, started.id, (w) => w.state === "working" && w.blockId.length > 0)
      const blockId = running?.blockId ?? ""
      const startedAt = running?.startedAt ?? started.startedAt

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

      yield* waitFor(Ref.get(h.notifier.wakes).pipe(Effect.map((w) => w.length >= 1)))
      const wakesDuringOutage = yield* Ref.get(h.notifier.wakes)
      expect(wakesDuringOutage).toHaveLength(1)
      expect(wakesDuringOutage[0]?.letter.text).toContain('state="rex_unreachable"')
      expect(wakesDuringOutage[0]?.letter.text).not.toContain('state="pane_gone"')

      // Rex recovers and turn completes cleanly
      yield* Ref.update(h.rex.state, (s) => ({ ...s, failWith: Option.none() }))
      yield* h.results.put(BASE.resultFile, "recovered-answer", startedAt + 10)
      yield* h.rex.setScreens(blockId, [DONE_FRAME, DONE_FRAME, DONE_FRAME])
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

          // Wait until at least one failed delivery attempt has been made while pendingWakes stays persisted
          const attempted = yield* waitFor(Ref.get(notifier.attempts).pipe(Effect.map((a) => a.length >= 1)))
          expect(attempted).toBe(true)
          const snap = yield* Ref.get(store.state)
          const persisted = snap.workers.find((w) => w.id === workerId)
          expect(persisted?.pendingWakes?.length).toBeGreaterThan(0)
          expect(persisted?.notifiedTurn).toBe(0)
        }),
      )

      // Server restarts: reattach flushes pendingWakes (retries with SAME deliveryId until accepted once)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(Model.layer(FAST).pipe(Layer.provide(shared)))
          const model = Context.get(services, Model.PaneAgentModel)
          yield* model.reattach(BASE.directory)
          const delivered = yield* waitFor(
            Ref.get(store.state).pipe(
              Effect.map((snap) => {
                const found = snap.workers.find((w) => w.id === workerId)
                return found?.notifiedTurn === 1 && (found?.pendingWakes?.length ?? 0) === 0
              }),
            ),
          )
          expect(delivered).toBe(true)
          expect((yield* Ref.get(notifier.wakes))).toHaveLength(1)

          // Every attempt used the exact same minted msg_ deliveryId
          const attempts = yield* Ref.get(notifier.attempts)
          expect(attempts.length).toBeGreaterThanOrEqual(3)
          const firstId = attempts[0]?.letter.id ?? ""
          expect(firstId.startsWith("msg_")).toBe(true)
          for (const attempt of attempts) {
            expect(attempt.letter.id).toBe(firstId)
          }

          // After delivery, pendingWakes is empty and notifiedTurn == 1
          const snapAfter = yield* Ref.get(store.state)
          const settled = snapAfter.workers.find((w) => w.id === workerId)
          expect(settled?.pendingWakes).toEqual([])
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
      const running = yield* waitForWorker(h.store.state, started.id, (w) => w.state === "working" && w.blockId.length > 0)
      yield* h.rex.setAlive(running?.blockId ?? "", false)
      yield* h.model.status("ses_p", started.id)
      yield* waitForWorker(h.store.state, started.id, (w) => w.state === "pane_gone")
      yield* h.model.restart({ parentSessionID: "ses_p", id: started.id })
      yield* waitForWorker(h.store.state, started.id, (w) => w.state === "working" && w.blockId.length > 0)
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
          const blocked = yield* waitForWorker(store.state, started.id, (w) => w.state === "needs_input" && w.blockId.length > 0)
          yield* waitFor(Ref.get(notifier.wakes).pipe(Effect.map((w) => w.length >= 1)))
          expect(blocked?.state).toBe("needs_input")
          workerId = started.id
          blockId = blocked?.blockId ?? ""
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
      const running = yield* waitForWorker(h.store.state, started.id, (w) => w.state === "working" && w.blockId.length > 0)
      const blockId = running?.blockId ?? ""
      const startedAt = running?.startedAt ?? started.startedAt

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
      yield* h.results.put(BASE.resultFile, "answer-turn-1", startedAt + 10)
      yield* h.rex.setScreens(blockId, [DONE_FRAME, DONE_FRAME, DONE_FRAME])

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
      const workerT2 = yield* waitForWorker(h.store.state, started.id, (w) => w.turn === 2 && w.state === "working")
      expect(workerT2?.turn).toBe(2)
      expect(workerT2?.resultFile).not.toBe(BASE.resultFile)

      yield* h.results.put(workerT2?.resultFile ?? "", "answer-turn-2", (workerT2?.startedAt ?? 0) + 10)
      yield* h.rex.setScreens(blockId, [WORKING_FRAME, DONE_FRAME, DONE_FRAME])

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

describe("pane-agent r2 review regressions (E1, Q1-Q3)", () => {
  effectTest(
    "E1: follow_up queued while the watcher is blocked confirming idle is NEVER lost and is typed after turn 1 settles",
    Effect.gen(function* () {
      const store = yield* makeMemoryStore()
      const rex = yield* makeMemoryRex({ ...emptyRexState, defaultScreens: [READY_FRAME, WORKING_FRAME, WORKING_FRAME] })
      const results = yield* makeMemoryResults()
      const notifier = yield* makeMemoryNotifier()
      const armed = yield* Ref.make(false)
      const blocked = yield* Ref.make(false)
      const latch = yield* Deferred.make<void>()
      const inner = yield* Layer.build(rex.layer).pipe(Effect.map((ctx) => Context.get(ctx, RexClient)))
      const gated = Layer.succeed(
        RexClient,
        RexClient.of({
          ...inner,
          waitForQuiet: (target, opts) =>
            Effect.gen(function* () {
              const screen = yield* inner.read(target).pipe(Effect.orElseSucceed(() => ""))
              if ((yield* Ref.get(armed)) && screen === DONE_FRAME) {
                yield* Ref.set(blocked, true)
                yield* Deferred.await(latch)
              }
              return yield* inner.waitForQuiet(target, opts)
            }),
        }),
      )
      const services = yield* Layer.build(
        Model.layer(FAST).pipe(Layer.provide(Layer.mergeAll(store.layer, gated, results.layer, notifier.layer))),
      )
      const model = Context.get(services, Model.PaneAgentModel)
      yield* model.bindPane("ses_p", { session: "session:root", block: "block:anchor" })
      const started = yield* model.start(BASE)
      const running = yield* waitForWorker(store.state, started.id, (w) => w.state === "working" && w.blockId.length > 0)

      // Let watcher observe WORKING_FRAME at least once, then arm the ConfirmIdle waitForQuiet gate.
      yield* waitFor(Effect.succeed(false), 5)
      yield* Ref.set(armed, true)
      yield* rex.setScreens(running?.blockId ?? "", [DONE_FRAME, DONE_FRAME, DONE_FRAME])
      const isBlocked = yield* waitFor(Ref.get(blocked), 400)
      expect(isBlocked).toBe(true)

      // Queue SECOND-TASK right inside the ConfirmIdle waitForQuiet window.
      yield* model.followUp({ parentSessionID: "ses_p", id: started.id, prompt: "SECOND-TASK" })
      yield* Ref.set(armed, false)
      yield* Deferred.succeed(latch, void 0)

      const typedSecond = yield* waitFor(
        Ref.get(rex.state).pipe(Effect.map((s) => (s.panes[0]?.writes.join("") ?? "").includes("SECOND-TASK"))),
        400,
      )
      expect(typedSecond).toBe(true)

      const gotTurn1Wake = yield* waitFor(
        Ref.get(notifier.wakes).pipe(Effect.map((w) => w.some((item) => item.letter.text.includes('turn="1"')))),
        400,
      )
      expect(gotTurn1Wake).toBe(true)
      const wakesAfterT1 = yield* Ref.get(notifier.wakes)
      expect(wakesAfterT1.some((w) => w.letter.text.includes('turn="1"'))).toBe(true)
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "Q1: turns queued before a pane vanishes survive pane_gone and restart in FIFO order",
    Effect.gen(function* () {
      const h = yield* makeHarness({ defaultScreens: [READY_FRAME, WORKING_FRAME, WORKING_FRAME] })
      const started = yield* h.model.start(BASE)
      const running = yield* waitForWorker(h.store.state, started.id, (w) => w.state === "working" && w.blockId.length > 0)
      yield* h.model.followUp({ parentSessionID: "ses_p", id: started.id, prompt: "QUEUED-AFTER-RESTART" })

      // Pane vanishes before QUEUED-AFTER-RESTART is typed
      yield* h.rex.setAlive(running?.blockId ?? "", false)
      yield* h.model.status("ses_p", started.id)
      const gone = yield* waitForWorker(h.store.state, started.id, (w) => w.state === "pane_gone")
      expect(gone?.state).toBe("pane_gone")
      expect(gone?.pendingTurns?.length).toBe(1)

      // Restart resumes the vanished turn AND preserves QUEUED-AFTER-RESTART
      yield* h.model.restart({
        parentSessionID: "ses_p",
        id: started.id,
        prompt: "Resume vanished work.",
      })
      const restarted = yield* waitForWorker(h.store.state, started.id, (w) => w.state === "working" && w.blockId.length > 0)
      expect(restarted?.pendingTurns?.length).toBe(1)

      // Once resumed turn finishes, QUEUED-AFTER-RESTART is typed into the new pane!
      const restartedBlock = restarted?.blockId ?? ""
      yield* h.rex.setScreens(restartedBlock, [WORKING_FRAME, WORKING_FRAME, DONE_FRAME, DONE_FRAME, READY_FRAME, READY_FRAME])
      const typedQueued = yield* waitFor(
        Ref.get(h.rex.state).pipe(
          Effect.map((s) => {
            const newPane = s.panes.find((p) => p.blockId === restartedBlock)
            return (newPane?.writes.join("") ?? "").includes("QUEUED-AFTER-RESTART")
          }),
        ),
        400,
      )
      expect(typedQueued).toBe(true)
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "Q2: wake outbox is an ordered FIFO queue; a later wake (e.g. pane_gone or turn 2) NEVER overwrites an earlier undelivered wake",
    Effect.gen(function* () {
      const store = yield* makeMemoryStore()
      const rex = yield* makeMemoryRex({ ...emptyRexState, defaultScreens: [TRUST_FRAME, TRUST_FRAME, TRUST_FRAME] })
      const results = yield* makeMemoryResults()
      const notifier = yield* makeMemoryNotifier()
      const shared = Layer.mergeAll(store.layer, rex.layer, results.layer, notifier.layer)

      // Block wake delivery while needs_input fires AND THEN pane vanishes
      yield* notifier.failNextWakes(20)

      let workerId = ""
      let blockId = ""
      yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(Model.layer(FAST).pipe(Layer.provide(shared)))
          const model = Context.get(services, Model.PaneAgentModel)
          yield* model.bindPane("ses_p", { session: "session:root", block: "block:anchor" })
          const started = yield* model.start(BASE)
          const blocked = yield* waitForWorker(store.state, started.id, (w) => w.state === "needs_input" && w.blockId.length > 0)
          yield* waitFor(Ref.get(notifier.wakes).pipe(Effect.map((w) => w.length >= 1)))
          expect(blocked?.state).toBe("needs_input")
          workerId = started.id
          blockId = blocked?.blockId ?? ""

          // Pane vanishes while needs_input wake is STILL undelivered -> pane_gone wake must queue AFTER it, not replace it!
          yield* rex.setAlive(blockId, false)
          yield* model.status("ses_p", workerId)
        }),
      )

      // Server restarts with notifier healthy -> BOTH needs_input AND pane_gone wakes are delivered in FIFO order!
      yield* notifier.failNextWakes(0)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(Model.layer(FAST).pipe(Layer.provide(shared)))
          const model = Context.get(services, Model.PaneAgentModel)
          yield* model.reattach(BASE.directory)
          const deliveredBoth = yield* waitFor(
            Ref.get(notifier.wakes).pipe(Effect.map((w) => w.length >= 2)),
            200,
          )
          expect(deliveredBoth).toBe(true)
          const wakes = yield* Ref.get(notifier.wakes)
          expect(wakes[0]?.letter.text).toContain('state="needs_input"')
          expect(wakes[1]?.letter.text).toContain('state="pane_gone"')
        }),
      )
    }),
    hangGuard("local-fixture"),
  )

  effectTest(
    "Q3: an undeliverable wake stops retrying at the cap, surfaces wake_undelivered, and NEVER blocks running the next queued turn",
    Effect.gen(function* () {
      const store = yield* makeMemoryStore()
      const rex = yield* makeMemoryRex({ ...emptyRexState, defaultScreens: [READY_FRAME, WORKING_FRAME, WORKING_FRAME] })
      const results = yield* makeMemoryResults()
      const notifier = yield* makeMemoryNotifier()
      const shared = Layer.mergeAll(store.layer, rex.layer, results.layer, notifier.layer)

      // Every wake refuses permanently during turn 1 & turn 2
      yield* notifier.failNextWakes(100)

      const services = yield* Layer.build(Model.layer(FAST).pipe(Layer.provide(shared)))
      const model = Context.get(services, Model.PaneAgentModel)
      yield* model.bindPane("ses_p", { session: "session:root", block: "block:anchor" })
      const started = yield* model.start(BASE)
      const running = yield* waitForWorker(store.state, started.id, (w) => w.state === "working" && w.blockId.length > 0)
      const blockId = running?.blockId ?? ""
      const startedAt = running?.startedAt ?? started.startedAt

      // Queue turn 2 while turn 1 runs
      yield* model.followUp({ parentSessionID: "ses_p", id: started.id, prompt: "TURN-2-MUST-RUN" })

      // Turn 1 finishes; its wake fails repeatedly -> MUST NOT block turn 2 from being typed!
      yield* results.put(BASE.resultFile, "turn-1-answer", startedAt + 10)
      yield* rex.setScreens(blockId, [DONE_FRAME, DONE_FRAME, READY_FRAME, WORKING_FRAME, DONE_FRAME, DONE_FRAME])

      const turn2Typed = yield* waitFor(
        Ref.get(rex.state).pipe(Effect.map((s) => (s.panes[0]?.writes.join("") ?? "").includes("TURN-2-MUST-RUN"))),
        400,
      )
      expect(turn2Typed).toBe(true)

      // After both turns hit the wake retry cap, worker surfaces wake_undelivered and stops spinning forever
      const reachedUndelivered = yield* waitFor(
        Ref.get(store.state).pipe(
          Effect.map((s) => s.workers.find((w) => w.id === started.id)?.state === "wake_undelivered"),
        ),
        400,
      )
      expect(reachedUndelivered).toBe(true)
      const attemptsAtCap = (yield* Ref.get(notifier.attempts)).length
      expect(attemptsAtCap).toBeLessThan(30)

      // Later when notifier recovers and reattach runs, BOTH undelivered wakes are delivered!
      yield* notifier.failNextWakes(0)
      yield* model.reattach(BASE.directory)
      const deliveredBoth = yield* waitFor(
        Ref.get(notifier.wakes).pipe(Effect.map((w) => w.length >= 2)),
        200,
      )
      expect(deliveredBoth).toBe(true)
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "CAS: two interpreters on one shared store never silently overwrite each other; stale writer fails with StoreConflict",
    Effect.gen(function* () {
      const store = yield* makeMemoryStore()
      const rex = yield* makeMemoryRex({ ...emptyRexState, defaultScreens: [READY_FRAME, WORKING_FRAME, WORKING_FRAME] })
      const results = yield* makeMemoryResults()
      const notifier = yield* makeMemoryNotifier()
      const deps = Layer.mergeAll(store.layer, rex.layer, results.layer, notifier.layer)

      const ctxA = yield* Layer.build(Model.layer(FAST).pipe(Layer.provide(deps)))
      const ctxB = yield* Layer.build(Model.layer(FAST).pipe(Layer.provide(deps)))
      const modelA = Context.get(ctxA, Model.PaneAgentModel)
      const modelB = Context.get(ctxB, Model.PaneAgentModel)

      yield* modelA.bindPane("ses_p", { session: "session:root", block: "block:anchor" })
      const started = yield* modelA.start(BASE)

      // Interpreter B advances the worker in the shared store (bumping revision)
      yield* modelB.followUp({ parentSessionID: "ses_p", id: started.id, prompt: "FROM-SERVER-B" })

      // Interpreter A holds stale revision -> its write MUST fail with StoreConflict, NEVER overwriting FROM-SERVER-B!
      const exitA = yield* Effect.exit(
        modelA.followUp({ parentSessionID: "ses_p", id: started.id, prompt: "STALE-FROM-A" }),
      )
      expect(Exit.isFailure(exitA)).toBe(true)
      if (Exit.isFailure(exitA)) {
        expect(String(exitA.cause)).toContain("StoreConflict")
      }

      const snap = yield* Ref.get(store.state)
      const saved = snap.workers.find((w) => w.id === started.id)
      expect(saved?.pendingTurns?.some((t) => t.brief.includes("FROM-SERVER-B"))).toBe(true)
      expect(saved?.pendingTurns?.some((t) => t.brief.includes("STALE-FROM-A"))).toBe(false)
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "interleaving: tool calls fired at every gated await point of the actor loop NEVER lose an accepted follow-up",
    Effect.gen(function* () {
      const gates = ["read", "waitForQuiet", "alive"] as const
      for (let idx = 0; idx < 18; idx++) {
        const gateKind = gates[idx % gates.length] ?? "waitForQuiet"
        const withPrompt = idx % 3 === 0
        const store = yield* makeMemoryStore()
        let initScreens: ReadonlyArray<string> = [READY_FRAME, WORKING_FRAME, WORKING_FRAME]
        if (withPrompt) {
          initScreens = [TRUST_FRAME, TRUST_FRAME]
        }
        const rex = yield* makeMemoryRex({ ...emptyRexState, defaultScreens: initScreens })
        const results = yield* makeMemoryResults()
        const notifier = yield* makeMemoryNotifier()
        const armed = yield* Ref.make(false)
        const hitGate = yield* Ref.make(false)
        const latch = yield* Deferred.make<void>()
        const inner = yield* Layer.build(rex.layer).pipe(Effect.map((ctx) => Context.get(ctx, RexClient)))

        const gateOnce = Effect.gen(function* () {
          const isArmed = yield* Ref.getAndSet(armed, false)
          if (isArmed) {
            yield* Ref.set(hitGate, true)
            yield* Deferred.await(latch)
          }
        })

        const gated = Layer.succeed(
          RexClient,
          RexClient.of({
            ...inner,
            read: (t) =>
              Effect.gen(function* () {
                if (gateKind === "read") yield* gateOnce
                return yield* inner.read(t)
              }),
            waitForQuiet: (t, opts) =>
              Effect.gen(function* () {
                if (gateKind === "waitForQuiet") yield* gateOnce
                return yield* inner.waitForQuiet(t, opts)
              }),
            alive: (t) =>
              Effect.gen(function* () {
                if (gateKind === "alive") yield* gateOnce
                return yield* inner.alive(t)
              }),
          }),
        )

        const services = yield* Layer.build(
          Model.layer(FAST).pipe(Layer.provide(Layer.mergeAll(store.layer, gated, results.layer, notifier.layer))),
        )
        const model = Context.get(services, Model.PaneAgentModel)
        yield* model.bindPane("ses_p", { session: "session:root", block: "block:anchor" })
        const started = yield* model.start({ ...BASE, prompt: `TURN1-RUN-${idx}` })
        const ready = yield* waitForWorker(
          store.state,
          started.id,
          (w) => w.blockId.length > 0 && (w.state === "working" || w.state === "needs_input"),
        )
        const blockId = ready?.blockId ?? ""

        // Arm the chosen I/O gate and fire two concurrent follow-ups right while the actor's paneIo is blocked
        yield* Ref.set(armed, true)
        const gatedReached = yield* waitFor(Ref.get(hitGate), 200)
        expect(gatedReached).toBe(true)

        yield* model.followUp({ parentSessionID: "ses_p", id: started.id, prompt: `FOLLOW-A-${idx}` })
        yield* model.followUp({ parentSessionID: "ses_p", id: started.id, prompt: `FOLLOW-B-${idx}` })

        if (withPrompt) {
          // Zero writes allowed while TRUST_FRAME is active
          const writesWhilePrompt = (yield* Ref.get(rex.state)).panes[0]?.writes ?? []
          expect(writesWhilePrompt).toEqual([])
        }

        // Release gate and drive pane through completion for all queued turns
        yield* Deferred.succeed(latch, void 0)
        let drainScreens: ReadonlyArray<string> = [
          DONE_FRAME,
          DONE_FRAME,
          READY_FRAME,
          WORKING_FRAME,
          DONE_FRAME,
          DONE_FRAME,
          READY_FRAME,
          WORKING_FRAME,
          DONE_FRAME,
          DONE_FRAME,
        ]
        if (withPrompt) {
          drainScreens = [READY_FRAME, WORKING_FRAME, ...drainScreens]
        }
        yield* rex.setScreens(blockId, drainScreens)

        const allTyped = yield* waitFor(
          Ref.get(rex.state).pipe(
            Effect.map((s) => {
              const all = s.panes[0]?.writes.join("") ?? ""
              return (
                all.includes(`TURN1-RUN-${idx}`) &&
                all.includes(`FOLLOW-A-${idx}`) &&
                all.includes(`FOLLOW-B-${idx}`)
              )
            }),
          ),
          500,
        )
        expect(allTyped).toBe(true)

        // Verify strict FIFO order in the PTY stream
        const fullText = (yield* Ref.get(rex.state)).panes[0]?.writes.join("") ?? ""
        const pos1 = fullText.indexOf(`TURN1-RUN-${idx}`)
        const posA = fullText.indexOf(`FOLLOW-A-${idx}`)
        const posB = fullText.indexOf(`FOLLOW-B-${idx}`)
        expect(pos1).toBeGreaterThanOrEqual(0)
        expect(posA).toBeGreaterThan(pos1)
        expect(posB).toBeGreaterThan(posA)
      }
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )
})
