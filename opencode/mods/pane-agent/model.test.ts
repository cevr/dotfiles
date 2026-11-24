import { describe, expect } from "bun:test"
import { Context, Duration, Effect, Exit, Layer, Option, Ref } from "effect"
import { effectTest } from "../../sim-tui/effect-test.ts"
import { hangGuard } from "../../tests/hang-guard.ts"
import { DONE_FRAME, READY_FRAME, TRUST_FRAME, WORKING_FRAME } from "./agy.fixture.ts"
import {
  emptyRexState,
  makeMemoryNotifier,
  makeMemoryResults,
  makeMemoryRex,
  makeMemoryStore,
  type MemoryRexState,
} from "./memory/doubles.ts"
import * as Model from "./model.ts"
import { formatUnsupportedRevision, RexUnsupportedRevision } from "./service.ts"
import type { PaneWorker, StoreSnapshot } from "./worker.ts"

const waitFor = (check: Effect.Effect<boolean>, maxSteps = 200) =>
  Effect.gen(function* () {
    for (let step = 0; step < maxSteps; step++) {
      if (yield* check) return true
      yield* Effect.yieldNow
    }
    return false
  })

const FAST_CONFIG: Model.ModelConfig = {
  quietFor: Duration.millis(10),
  pollTimeout: Duration.millis(20),
  pasteQuiet: Duration.millis(5),
  maxStartupChecks: 5,
}

const makeHarness = (
  rexInit: Partial<MemoryRexState> = {},
  initialStore?: StoreSnapshot,
  initialResults?: ReadonlyMap<string, { readonly content: string; readonly mtimeMs: number }>,
  config: Model.ModelConfig = FAST_CONFIG,
) =>
  Effect.gen(function* () {
    const store = yield* makeMemoryStore(initialStore)
    const rex = yield* makeMemoryRex({ ...emptyRexState, ...rexInit })
    const results = yield* makeMemoryResults(initialResults)
    const notifier = yield* makeMemoryNotifier()
    const services = yield* Layer.build(
      Model.layer(config).pipe(
        Layer.provide(Layer.mergeAll(store.layer, rex.layer, results.layer, notifier.layer)),
      ),
    )
    const model = Context.get(services, Model.PaneAgentModel)
    return { store, rex, results, notifier, model }
  })

describe("PaneAgentModel", () => {
  effectTest(
    "start splits right beside the anchor, pastes brief naming only the orchestrator, and wakes on result file",
    Effect.gen(function* () {
      const h = yield* makeHarness({ defaultScreens: [READY_FRAME, WORKING_FRAME, WORKING_FRAME] })
      yield* h.model.bindPane("ses_parent", { session: "session:root", block: "block:anchor" })
      const started = yield* h.model.start({
        parentSessionID: "ses_parent",
        directory: "/nonexistent/repo",
        harness: "agy",
        description: "implementor pane-agent r1",
        prompt: "Implement unit pane-agent.",
        resultFile: "/nonexistent/run/result.md",
      })

      expect(started.state).toBe("working")
      expect(started.harness).toBe("agy")
      expect(started.ownedBlock).toBe(true)

      const rexState = yield* Ref.get(h.rex.state)
      expect(rexState.splits).toHaveLength(1)
      expect(rexState.splits[0]?.anchorBlockId).toBe("block:anchor")
      expect(rexState.splits[0]?.command).toEqual(["agy"])
      const written = rexState.panes[0]?.writes.join("") ?? ""
      expect(written).toContain("the orchestrator")
      expect(written.toLowerCase()).not.toContain("opencode")
      expect(written).toContain("/nonexistent/run/result.md")
      expect(written).toContain("\x1b[200~")
      expect(written).toContain("\r")

      yield* h.results.put("/nonexistent/run/result.md", "Head: abc123\npane-agent r1: ready", started.startedAt + 50)
      const settled = yield* waitFor(
        Ref.get(h.notifier.wakes).pipe(Effect.map((wakes) => wakes.length > 0)),
      )
      expect(settled).toBe(true)
      const wakes = yield* Ref.get(h.notifier.wakes)
      expect(wakes).toHaveLength(1)
      expect(wakes[0]?.letter.text).toContain('state="done"')
      expect(wakes[0]?.letter.text).toContain('source="result-file"')
      expect(wakes[0]?.letter.text).toContain("pane-agent r1: ready")
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "idle signature held across waitForQuiet completes turn and extracts last answer when no result file is written",
    Effect.gen(function* () {
      const h = yield* makeHarness({
        defaultScreens: [READY_FRAME, READY_FRAME, WORKING_FRAME, DONE_FRAME, DONE_FRAME],
      })
      yield* h.model.bindPane("ses_parent", { session: "session:root", block: "block:anchor" })
      yield* h.model.start({
        parentSessionID: "ses_parent",
        directory: "/nonexistent/repo",
        harness: "agy",
        description: "worker ping",
        prompt: "Reply with pong.",
        resultFile: "/nonexistent/run/none.md",
      })
      const settled = yield* waitFor(
        Ref.get(h.notifier.wakes).pipe(Effect.map((wakes) => wakes.length > 0)),
      )
      expect(settled).toBe(true)
      const wakes = yield* Ref.get(h.notifier.wakes)
      expect(wakes[0]?.letter.text).toContain('source="pane"')
      expect(wakes[0]?.letter.text).toContain("pong")
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "startup trust prompt surfaces needs_input with last lines without typing, then submits once resolved",
    Effect.gen(function* () {
      const h = yield* makeHarness({ defaultScreens: [TRUST_FRAME, TRUST_FRAME, TRUST_FRAME] })
      yield* h.model.bindPane("ses_parent", { session: "session:root", block: "block:anchor" })
      const started = yield* h.model.start({
        parentSessionID: "ses_parent",
        directory: "/nonexistent/repo",
        harness: "agy",
        description: "worker trust-check",
        prompt: "Do the check.",
        resultFile: "/nonexistent/run/trust.md",
      })
      expect(started.state).toBe("needs_input")
      expect(started.lastLines).toContain("Do you trust the contents of this project?")

      const beforeResolve = yield* Ref.get(h.rex.state)
      expect(beforeResolve.panes[0]?.writes).toEqual([])

      const wakes1 = yield* Ref.get(h.notifier.wakes)
      expect(wakes1).toHaveLength(1)
      expect(wakes1[0]?.letter.text).toContain('state="needs_input"')

      yield* h.rex.setScreens(started.blockId, [READY_FRAME, WORKING_FRAME, DONE_FRAME, DONE_FRAME])
      const finished = yield* waitFor(
        Ref.get(h.notifier.wakes).pipe(Effect.map((wakes) => wakes.length >= 2)),
      )
      expect(finished).toBe(true)
      const afterResolve = yield* Ref.get(h.rex.state)
      expect(afterResolve.panes[0]?.writes.join("")).toContain("Do the check.")
      const wakes2 = yield* Ref.get(h.notifier.wakes)
      expect(wakes2[1]?.letter.text).toContain('state="done"')
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "refuses to start without a known Rex anchor and never guesses another pane",
    Effect.gen(function* () {
      const h = yield* makeHarness()
      const exit = yield* Effect.exit(
        h.model.start({
          parentSessionID: "ses_unknown",
          directory: "/nonexistent/repo",
          harness: "agy",
          description: "worker orphan",
          prompt: "hello",
          resultFile: "/nonexistent/run/orphan.md",
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      const rexState = yield* Ref.get(h.rex.state)
      expect(rexState.splits).toHaveLength(0)
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "follow_up types into the same pane and stop interrupts with Esc without closing unowned panes",
    Effect.gen(function* () {
      const h = yield* makeHarness({
        panes: [
          {
            sessionId: "session:existing",
            blockId: "block:user-named",
            label: "existing",
            command: ["agy"],
            cwd: "/nonexistent/repo",
            screens: [READY_FRAME, WORKING_FRAME, DONE_FRAME, DONE_FRAME],
            screenIndex: 0,
            writes: [],
            alive: true,
            closed: false,
          },
        ],
      })
      const started = yield* h.model.start({
        parentSessionID: "ses_parent",
        directory: "/nonexistent/repo",
        harness: "agy",
        description: "worker explicit",
        prompt: "First turn.",
        resultFile: "/nonexistent/run/t1.md",
        rexSession: "session:existing",
        blockId: "block:user-named",
      })
      expect(started.ownedBlock).toBe(false)
      expect(started.blockId).toBe("block:user-named")

      yield* h.rex.setScreens("block:user-named", [WORKING_FRAME, WORKING_FRAME])
      const next = yield* h.model.followUp({
        parentSessionID: "ses_parent",
        id: started.id,
        prompt: "Second turn.",
        resultFile: "/nonexistent/run/t2.md",
      })
      expect(next.turn).toBe(2)
      expect(next.blockId).toBe("block:user-named")

      const stopped = yield* h.model.stop({ parentSessionID: "ses_parent", id: started.id, close: true })
      expect(stopped.state).toBe("stopped")
      const rexState = yield* Ref.get(h.rex.state)
      const pane = rexState.panes[0]
      expect(pane?.writes[pane.writes.length - 1]).toBe("\x1b")
      expect(pane?.closed).toBe(false)
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "stop with close: true closes panes created by pane-agent",
    Effect.gen(function* () {
      const h = yield* makeHarness({ defaultScreens: [READY_FRAME, WORKING_FRAME, WORKING_FRAME] })
      yield* h.model.bindPane("ses_parent", { session: "session:root", block: "block:anchor" })
      const started = yield* h.model.start({
        parentSessionID: "ses_parent",
        directory: "/nonexistent/repo",
        harness: "agy",
        description: "worker owned",
        prompt: "Work on task.",
        resultFile: "/nonexistent/run/owned.md",
      })
      yield* h.model.stop({ parentSessionID: "ses_parent", id: started.id, close: true })
      const rexState = yield* Ref.get(h.rex.state)
      expect(rexState.panes[0]?.closed).toBe(true)
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "server restart reattach wakes once when result file already exists and NEVER retypes",
    Effect.gen(function* () {
      const existing: PaneWorker = {
        id: "pa_restart1",
        parentSessionID: "ses_parent",
        directory: "/nonexistent/repo",
        harness: "agy",
        role: "implementor",
        unit: "pane-agent r1",
        rexSessionId: "session:root",
        blockId: "block:live1",
        ownedBlock: true,
        resultFile: "/nonexistent/run/restart.md",
        state: "working",
        update: "running in Rex pane",
        turn: 1,
        notifiedTurn: 0,
        startedAt: 1000,
        updatedAt: 1000,
      }
      const h = yield* makeHarness(
        {
          panes: [
            {
              sessionId: "session:root",
              blockId: "block:live1",
              label: "agy:pane-agent",
              command: ["agy"],
              cwd: "/nonexistent/repo",
              screens: [WORKING_FRAME],
              screenIndex: 0,
              writes: [],
              alive: true,
              closed: false,
            },
          ],
        },
        { workers: [existing], anchors: {} },
        new Map([["/nonexistent/run/restart.md", { content: "finished while server restarted", mtimeMs: 2000 }]]),
      )

      const attached = yield* h.model.reattach("/nonexistent/repo")
      expect(attached).toHaveLength(1)
      expect(attached[0]?.state).toBe("done")

      yield* h.model.reattach("/nonexistent/repo")
      const wakes = yield* Ref.get(h.notifier.wakes)
      expect(wakes).toHaveLength(1)
      expect(wakes[0]?.letter.text).toContain("finished while server restarted")
      const rexState = yield* Ref.get(h.rex.state)
      expect(rexState.panes[0]?.writes).toEqual([])
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )

  effectTest(
    "RexUnsupportedRevision surfaces a plain sentence naming both revisions",
    Effect.gen(function* () {
      const mismatch = new RexUnsupportedRevision({
        requiredRevision: 18,
        serverRevision: Option.some(19),
        message: formatUnsupportedRevision(18, Option.some(19)),
      })
      const h = yield* makeHarness({ failWith: Option.some(mismatch) })
      yield* h.model.bindPane("ses_parent", { session: "session:root", block: "block:anchor" })
      const exit = yield* Effect.exit(
        h.model.start({
          parentSessionID: "ses_parent",
          directory: "/nonexistent/repo",
          harness: "agy",
          description: "worker rev",
          prompt: "hello",
          resultFile: "/nonexistent/run/rev.md",
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const text = String(exit.cause)
        expect(text).toContain("18")
        expect(text).toContain("19")
      }
    }).pipe(Effect.scoped),
    hangGuard("local-fixture"),
  )
})
