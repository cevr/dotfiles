// reads: none (every world is in memory: no file system, no Rex, no agy, no network)
import { describe, expect } from "bun:test"
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"
import * as Service from "../service.ts"
import type { PaneWorker } from "../worker.ts"
import { LATE_LAND_MS, type ProcEnv, servicesLayer, TIMEOUT_MS } from "./doubles.ts"
import { defaultConfig, runScript, type ToolCall, type Trace } from "./driver.ts"
import { makeGate, makeInjector, type PlannedFault } from "./faults.ts"
import { CORE } from "./generator.ts"
import { checkAll, type InvariantId, referenceOfTrace, type Violation } from "./invariants.ts"
import { runOne } from "./property.ts"
import { latestTurnAt, numberingKnown, type RefCall, type Reference, referenceOf, type RefTurn } from "./reference.ts"
import { configOf, HAPPY, type Scenario, SCENARIOS } from "./scenarios.ts"
import {
  ANCHOR,
  answerOf,
  applyEvent,
  applySplit,
  applyWrite,
  type Break,
  DEFAULT_WORLD,
  findPane,
  initialWorld,
  makeWorld,
  PLACEHOLDER,
  render,
  resultFileOf,
  STALE_CONTENT,
  tick,
  type WakeRecord,
  WorldEvent,
  type WorldState,
} from "./world.ts"

const SPLIT = { sessionId: ANCHOR.session, anchorBlockId: ANCHOR.block, label: "agy:u", command: ["agy"], cwd: "/sim/repo" }
const BRIEF = (token: string) => `[Task from the orchestrator]\n\nDo ${token}.\n\nWhen finished, write your final answer to /sim/run/r.md.tmp, then rename it to /sim/run/r.md.`
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`

const SAMPLE_WORKER: PaneWorker = {
  id: "pa_1",
  parentSessionID: "ses",
  directory: "/sim/repo",
  harness: "agy",
  role: "worker",
  unit: "u",
  rexSessionId: ANCHOR.session,
  blockId: "block:sim-1",
  ownedBlock: true,
  resultFile: "/sim/run/r.md",
  state: "working",
  update: "",
  turn: 1,
  notifiedTurn: 0,
  startedAt: 0,
  updatedAt: 0,
}

const pane = (state: WorldState, blockId: string) => Option.getOrThrow(findPane(state, blockId))

const stillRunning = <A, E>(fiber: Fiber.Fiber<A, E>) => Effect.sync(() => Option.isNone(Option.fromUndefinedOr(fiber.pollUnsafe())))

const typed = (state: WorldState, blockId: string, text: string): WorldState => applyWrite(applyWrite(state, blockId, paste(text), 1), blockId, "\r", 1)

const scenario = (name: string): Scenario => Option.getOrThrow(Option.fromUndefinedOr(SCENARIOS.find((item) => item.name === name)))

const doublesEnv = Effect.fn("SimTest.doublesEnv")(function* (faults: ReadonlyArray<PlannedFault>) {
  const clock = yield* TestClock.make()
  const world = yield* makeWorld(DEFAULT_WORLD)
  const injector = yield* makeInjector(Option.none())
  yield* injector.plan(faults)
  const env: ProcEnv = { world, injector, clock, worldScope: yield* Effect.scope, proc: 1 }
  const ctx = yield* Layer.build(servicesLayer(env))
  return { env, rex: Context.get(ctx, Service.RexClient), store: Context.get(ctx, Service.WorkerStore), notifier: Context.get(ctx, Service.Notifier) }
})

describe("pane-agent-sim fault injector", () => {
  effectTest(
    "a planned fault fires on its call and only there; planNext counts from now; the trace and the coverage counter record every call",
    Effect.gen(function* () {
      const injector = yield* makeInjector(Option.none())
      yield* injector.plan([{ boundary: "pane.read", nth: 1, fault: "defect" }])
      const first = yield* injector.decide("pane.read", 1, "a")
      const second = yield* injector.decide("pane.read", 1, "b")
      yield* injector.planNext([{ boundary: "pane.read", nth: 0, fault: "hang" }])
      const third = yield* injector.decide("pane.read", 1, "c")
      const fourth = yield* injector.decide("pane.read", 1, "d")
      expect([first.fault, second.fault, third.fault, fourth.fault]).toEqual(["ok", "defect", "hang", "ok"])
      yield* injector.crashAt(5)
      yield* injector.decide("store.read", 2, "e")
      expect((yield* injector.decide("store.write", 2, "f")).fault).toBe("crash")
      expect((yield* injector.trace).map((record) => record.index)).toEqual([0, 1, 2, 3, 4, 5])
      expect((yield* injector.coverage).get("pane.read|ok")).toBe(2)
      expect((yield* injector.fired).map((fault) => fault.fault)).toEqual(["defect", "hang", "crash"])
    }).pipe(Effect.scoped),
    hangGuard("unit-law"),
  )

  effectTest(
    "the same seed picks the same random faults; with faults off every call is ok",
    Effect.gen(function* () {
      const picks = (seed: number) =>
        Effect.gen(function* () {
          const injector = yield* makeInjector(Option.some({ seed, rate: 0.5, allow: ["transient", "hang", "defect"] }))
          const out: Array<string> = []
          for (let i = 0; i < 40; i++) out.push((yield* injector.decide("pane.write", 1, "")).fault)
          return out
        })
      expect(yield* picks(7)).toEqual(yield* picks(7))
      expect(yield* picks(7)).not.toEqual(yield* picks(8))
      const off = yield* makeInjector(Option.some({ seed: 7, rate: 1, allow: ["hang"] }))
      yield* off.setFaultsOn(false)
      expect((yield* off.decide("pane.write", 1, "")).fault).toBe("ok")
    }),
    hangGuard("unit-law"),
  )

  effectTest(
    "a gate holds the matching call until the driver releases it",
    Effect.gen(function* () {
      const injector = yield* makeInjector(Option.none())
      const gate = yield* makeGate(Option.none(), Option.some("pane.waitForQuiet"), Option.some(":done"))
      yield* injector.setGate(Option.some(gate))
      yield* injector.decide("pane.waitForQuiet", 1, "block:1:working")
      const held = yield* Effect.forkChild(injector.decide("pane.waitForQuiet", 1, "block:1:done"))
      yield* Deferred.await(gate.hit)
      expect(yield* stillRunning(held)).toBe(true)
      yield* Deferred.succeed(gate.release, true)
      expect((yield* Fiber.join(held)).index).toBe(1)
    }).pipe(Effect.scoped),
    hangGuard("unit-law"),
  )
})

describe("pane-agent-sim world model", () => {
  effectTest(
    "paste then Enter at a ready prompt starts a turn; it ends with the final file and a done screen showing the answer",
    Effect.sync(() => {
      const [blockId, split] = applySplit(initialWorld(DEFAULT_WORLD), SPLIT, 1)
      const started = typed(split, blockId, BRIEF("TK-a-1"))
      expect(pane(started, blockId).screen).toBe("working")
      const ended = tick(started, 60)
      expect(pane(ended, blockId).screen).toBe("done")
      expect(ended.files.get("/sim/run/r.md")?.content).toBe("ANSWER-TK-a-1")
      expect(render(pane(ended, blockId))).toContain("ANSWER-TK-a-1")
      expect(ended.writes.map((write) => write.screen)).toEqual(["ready", "ready"])
    }),
    hangGuard("unit-law"),
  )

  effectTest(
    "Enter while working queues the text; Alt+M steers over the turn; Enter on a trust prompt confirms it; partial and stale files",
    Effect.sync(() => {
      const world = initialWorld({ ...DEFAULT_WORLD, fileModes: ["partial", "stale"], splitScreens: ["trust"] })
      const [blockId, split] = applySplit(world, SPLIT, 1)
      const confirmed = applyWrite(split, blockId, "\r", 1)
      expect(pane(confirmed, blockId).screen).toBe("ready")
      const running = typed(confirmed, blockId, BRIEF("TK-a-1"))
      const queued = typed(tick(running, 30), blockId, BRIEF("TK-a-2"))
      expect(pane(queued, blockId).queue.length).toBe(1)
      expect(queued.files.get("/sim/run/r.md")?.content).toBe(PLACEHOLDER)
      const next = tick(tick(queued, 60), 75)
      expect(next.runs.map((run) => Option.getOrElse(run.token, () => ""))).toEqual(["TK-a-1", "TK-a-2"])
      expect(next.files.get("/sim/run/r.md")?.content).toBe(STALE_CONTENT)
      const steered = applyWrite(applyWrite(next, blockId, paste(BRIEF("TK-a-3")), 1), blockId, "\x1bm", 1)
      expect(steered.runs.find((run) => Option.contains(run.token, "TK-a-2"))?.interrupted).toBe(true)
      expect(Option.getOrElse(steered.runs.at(-1)?.token ?? Option.none(), () => "")).toBe("TK-a-3")
      const gone = applyEvent({ ...steered, now: 99 }, WorldEvent.PaneExits({ blockId: Option.some(blockId) }))
      expect(gone.deaths).toEqual([{ blockId, at: 99 }])
    }),
    hangGuard("unit-law"),
  )

  effectTest(
    "the result path is read from both brief formats (rename contract and plain)",
    Effect.sync(() => {
      expect(Option.getOrNull(resultFileOf(BRIEF("TK-a-1")))).toBe("/sim/run/r.md")
      expect(Option.getOrNull(resultFileOf("Do it.\n\nWhen finished, write your final answer to /sim/run/x.md."))).toBe("/sim/run/x.md")
    }),
    hangGuard("unit-law"),
  )
})

describe("pane-agent-sim world doubles", () => {
  effectTest(
    "each fault: typed failures by tag, a defect, a hang, a timeout, a late write that lands after its error, a crash",
    Effect.gen(function* () {
      const { env, rex } = yield* doublesEnv([
        { boundary: "pane.read", nth: 0, fault: "transient" },
        { boundary: "pane.read", nth: 1, fault: "gone" },
        { boundary: "pane.read", nth: 2, fault: "defect" },
        { boundary: "pane.read", nth: 3, fault: "hang" },
        { boundary: "pane.read", nth: 4, fault: "timeout" },
        { boundary: "pane.write", nth: 0, fault: "late" },
        { boundary: "pane.write", nth: 1, fault: "crash" },
      ])
      const blockId = yield* rex.splitRight(SPLIT)
      const target = { sessionId: ANCHOR.session, blockId }
      const transient = yield* Effect.flip(rex.read(target))
      expect(transient._tag).toBe("RexCallFailed")
      expect(["RexPaneGone", "RexCallFailed"]).toContain((yield* Effect.flip(rex.read(target)))._tag)
      expect(Exit.hasDies(yield* Effect.exit(rex.read(target)))).toBe(true)
      const hung = yield* Effect.forkChild(rex.read(target))
      yield* env.clock.adjust(Duration.seconds(30))
      expect(yield* stillRunning(hung)).toBe(true)
      const timed = yield* Effect.forkChild(Effect.flip(rex.read(target)))
      yield* env.clock.adjust(TIMEOUT_MS)
      expect((yield* Fiber.join(timed))._tag).toBe("RexCallFailed")
      const late = yield* Effect.forkChild(Effect.flip(rex.write(target, "late-bytes")))
      yield* env.clock.adjust(TIMEOUT_MS)
      expect((yield* Fiber.join(late))._tag).toBe("RexCallFailed")
      expect((yield* env.world.get).writes.length).toBe(0)
      yield* env.clock.adjust(LATE_LAND_MS)
      expect((yield* env.world.get).writes.map((write) => write.data)).toEqual(["late-bytes"])
      const crashed = yield* Effect.forkChild(rex.write(target, "never"))
      yield* env.clock.adjust(Duration.seconds(1))
      expect(yield* stillRunning(crashed)).toBe(true)
      expect(yield* env.world.procAlive(1)).toBe(false)
      const afterCrash = yield* Effect.forkChild(rex.read(target))
      yield* env.clock.adjust(Duration.seconds(1))
      expect(yield* stillRunning(afterCrash)).toBe(true)
      expect((yield* env.world.get).writes.length).toBe(1)
    }).pipe(Effect.scoped),
    hangGuard("unit-law"),
  )

  effectTest(
    "the store refuses a stale revision and keeps the newer row; the notifier records every delivery, duplicates included",
    Effect.gen(function* () {
      const { env, store, notifier } = yield* doublesEnv([])
      const worker = SAMPLE_WORKER
      yield* store.upsertWorker(worker, 0)
      yield* store.upsertWorker({ ...worker, turn: 2 }, 1)
      const stale = yield* Effect.flip(store.upsertWorker({ ...worker, turn: 3 }, 1))
      expect(stale._tag).toBe("StoreConflict")
      expect((yield* store.read()).workers.map((w) => [w.turn, w.revision])).toEqual([[2, 2]])
      const letter = { id: "msg_1", description: "d", text: "t", metadata: { workerId: "pa_1", state: "done", turn: 1 } }
      yield* notifier.wake("ses", letter)
      yield* notifier.wake("ses", letter)
      expect((yield* env.world.get).wakes.length).toBe(2)
    }).pipe(Effect.scoped),
    hangGuard("unit-law"),
  )

  effectTest(
    "a corrupt-row read quarantines the first row and answers with its siblings; the row stays in the world for the next read",
    Effect.gen(function* () {
      const { store } = yield* doublesEnv([{ boundary: "store.read", nth: 1, fault: "corrupt" }])
      yield* store.upsertWorker(SAMPLE_WORKER, 0)
      yield* store.upsertWorker({ ...SAMPLE_WORKER, id: "pa_2", blockId: "block:sim-2" }, 0)
      const ids = Effect.map(store.read(), (snapshot) => snapshot.workers.map((w) => w.id))
      expect(yield* ids).toEqual(["pa_1", "pa_2"])
      expect(yield* ids).toEqual(["pa_2"])
      expect(yield* ids).toEqual(["pa_1", "pa_2"])
    }).pipe(Effect.scoped),
    hangGuard("unit-law"),
  )
})

describe("pane-agent-sim usage limit in the world (SPEC v2 ruling 5)", () => {
  effectTest(
    "one limit marks every working run of the sign-in; a run started before the reset meets it at once; continue before the reset is refused, after it continues the same turn with its token",
    Effect.sync(() => {
      const world = initialWorld({ ...DEFAULT_WORLD, limitRuns: [1] })
      const [a, one] = applySplit(world, SPLIT, 1)
      const [b, two] = applySplit(one, SPLIT, 1)
      const both = typed(typed(two, a, BRIEF("TK-a-1")), b, BRIEF("TK-b-1"))
      const limited = tick(both, 60)
      expect([pane(limited, a).screen, pane(limited, b).screen]).toEqual(["limit", "limit"])
      expect(limited.runs.map((run) => [run.limited, Option.getOrNull(run.resetAt)])).toEqual([
        [true, 1_060],
        [true, 1_060],
      ])
      const early = continueAt(limited, a, 500)
      expect(early.runs.length).toBe(2)
      const resumed = continueAt(early, a, 1_060)
      expect(Option.getOrNull(resumed.runs.at(-1)?.token ?? Option.none())).toBe("TK-a-1")
      expect(tick(resumed, 1_120).files.get("/sim/run/r.md")?.content).toBe("ANSWER-TK-a-1")
      const lost = continueAt({ ...early, config: { ...early.config, breaks: ["continue-loses-token"] } }, a, 1_060)
      expect(Option.isNone(lost.runs.at(-1)?.token ?? Option.none())).toBe(true)
    }),
    hangGuard("unit-law"),
  )
})

const refCall = (command: string, token: string, outcome: string, at: number): RefCall => ({
  command,
  worker: "w1",
  token: Option.some(token),
  issuedAt: at,
  at,
  outcome,
  workerId: Option.some("pa_1"),
  skipPermissions: true,
})

describe("pane-agent-sim reference model", () => {
  effectTest(
    "start, follow_up, a refused follow_up, a crashed one and a stop fold into accepted, rejected and maybe turns",
    Effect.sync(() => {
      const ref = referenceOf([
        refCall("start", "TK-w1-1", "success", 10),
        refCall("follow_up", "TK-w1-2", "success", 20),
        refCall("follow_up", "TK-w1-3", "failure", 30),
        refCall("steer", "TK-w1-4", "killed", 40),
        { ...refCall("stop", "", "success", 50), token: Option.none() },
        refCall("restart", "TK-w1-5", "success", 60),
      ])
      const worker = Option.getOrThrow(Option.fromUndefinedOr(ref.workers.get("w1")))
      expect(worker.turns.map((turn) => [turn.index, turn.token, turn.mode, turn.certain])).toEqual([
        [1, "TK-w1-1", "start", true],
        [2, "TK-w1-2", "follow_up", true],
        [3, "TK-w1-4", "steer", false],
        [4, "TK-w1-5", "restart", true],
      ])
      expect([...ref.rejected]).toEqual(["TK-w1-3"])
      expect([...ref.maybe]).toEqual(["TK-w1-4"])
      expect(Option.getOrNull(worker.stoppedAt)).toBe(50)
      expect(worker.supersedes.map((command) => command.at)).toEqual([50, 60])
      expect(numberingKnown(worker, 2)).toBe(true)
      expect(numberingKnown(worker, 4)).toBe(false)
      expect(Option.map(latestTurnAt(worker, 25), (turn) => turn.token)).toEqual(Option.some("TK-w1-2"))
    }),
    hangGuard("unit-law"),
  )

  effectTest(
    "the simulation is deterministic: each of three different scenarios (one worker, the limit on two workers, a crash with two workers) gives the same trace twice",
    Effect.gen(function* () {
      const view = (trace: Trace) => [trace.calls.map((call) => [call.command, call.outcome, call.startedAt]), trace.world.writes, trace.world.wakes, trace.world.runs, trace.effects]
      for (const name of ["R3-follow-up-queued-during-turn", "usage-limit-sibling", "D12-reattach-serial-one-hang"]) {
        const run = runScript(configOf(scenario(name)), scenario(name).steps)
        expect(view(yield* run)).toEqual(view(yield* run))
      }
    }),
    hangGuard("in-memory"),
  )
})

const broken = (name: string, breaks: ReadonlyArray<Break>) => {
  const base = scenario(name)
  return runOne({ ...configOf(base), world: { ...configOf(base).world, breaks } }, base.steps)
}

const happy = (breaks: ReadonlyArray<Break>) => runOne({ ...defaultConfig("happy", 1), world: { ...DEFAULT_WORLD, breaks } }, HAPPY)

/** The core trace ends with an idle worker, so the quiescence probe (a fresh follow_up) runs on it. */
const core = (breaks: ReadonlyArray<Break>) => runOne({ ...defaultConfig("core", 1), world: { ...DEFAULT_WORLD, breaks } }, CORE)

const of = (violations: ReadonlyArray<Violation>, id: InvariantId) => violations.filter((item) => item.invariant === id)

const withReference = (trace: Trace, mutate: (ref: Reference) => Reference) => checkAll(trace, mutate(referenceOfTrace(trace)))

const dropLastTurn = (ref: Reference): Reference => ({
  ...ref,
  workers: new Map([...ref.workers].map(([key, worker]) => [key, { ...worker, turns: worker.turns.slice(0, -1) }])),
})

const phantom: RefTurn = { index: 0, token: "TK-w1-999", mode: "follow_up", acceptedAt: 0, certain: true }

const phantomTurn = (ref: Reference): Reference => ({
  ...ref,
  workers: new Map([...ref.workers].map(([key, worker]) => [key, { ...worker, turns: [...worker.turns, { ...phantom, index: worker.turns.length + 1 }] }])),
})

type LimitVariant = "correct" | "no-resume" | "two-resumes" | "early-resume" | "lost-token" | "unreported"

const limitWake = (at: number, id: string, state: string, text: string): WakeRecord => ({
  at,
  proc: 1,
  sessionID: "ses_sim",
  letter: { id, description: "", text, metadata: { workerId: SAMPLE_WORKER.id, state, turn: 1 } },
})

const continueAt = (state: WorldState, blockId: string, at: number): WorldState => typed(tick(state, at), blockId, "continue")

/** When the shell types `continue` in each variant (none: it never resumes). */
const CONTINUES: Readonly<Record<LimitVariant, ReadonlyArray<number>>> = {
  correct: [1_060],
  "no-resume": [],
  "two-resumes": [1_060, 1_065],
  "early-resume": [500],
  "lost-token": [1_060],
  unreported: [1_060],
}

const ROW_STATES = ["working", "done"] as const

/**
 * A hand-built trace of the shell ruling (5) asks for, on the real world model: turn 1 meets the limit at
 * t=60 (reset t=1060), one "limited" wake, `continue` typed at the reset, the continued run (the same turn,
 * its token kept) ends, and the turn's one done wake. The variants break one step each.
 */
const limitTrace = (variant: LimitVariant): Trace => {
  const breaks: ReadonlyArray<Break> = (["continue-loses-token"] as const).filter(() => variant === "lost-token")
  const [blockId, split] = applySplit(initialWorld({ ...DEFAULT_WORLD, limitRuns: [1], breaks }), SPLIT, 1)
  const limited = tick(typed(split, blockId, BRIEF("TK-w1-1")), 60)
  const resumed = CONTINUES[variant].reduce((state, at) => continueAt(state, blockId, at), limited)
  const ended = tick(resumed, 1_130)
  const resumedOnce = CONTINUES[variant].length > 0 && variant !== "early-resume"
  const limitedWake = limitWake(65, "msg_limited_1", "limited", `<pane-agent-result state="limited" turn="1" reset="1970-01-01T00:00:01.060Z">\nTurn 1 hit the usage limit.\n</pane-agent-result>`)
  const doneWake = limitWake(1_135, "msg_done_1", "done", `<pane-agent-result state="done" turn="1">\n${answerOf("TK-w1-1")}\n</pane-agent-result>`)
  const wakes = [...[limitedWake].filter(() => variant !== "unreported"), ...[doneWake].filter(() => resumedOnce)]
  const row: PaneWorker = { ...SAMPLE_WORKER, blockId, state: ROW_STATES[Number(resumedOnce)], notifiedTurn: Number(resumedOnce) }
  const world: WorldState = { ...ended, now: 1_200, wakes, store: { version: 2, workers: [row], anchors: {} } }
  const startCall: ToolCall = {
    id: 1,
    proc: 1,
    command: "start",
    worker: "w1",
    token: Option.some("TK-w1-1"),
    startedAt: 0,
    endedAt: Option.some(0),
    outcome: "success",
    error: "",
    reply: [{ ...row, state: "starting", notifiedTurn: 0 }],
    probe: false,
    skipPermissions: true,
  }
  const statusCall: ToolCall = { ...startCall, id: 2, command: "status", token: Option.none(), startedAt: 1_200, endedAt: Option.some(1_200), reply: [row], probe: true }
  return { name: `limit:${variant}`, seed: 1, calls: [startCall, statusCall], world, effects: [], fired: [], coverage: new Map(), boundMs: 400, workerIds: new Map([["w1", row.id]]), restarts: 0 }
}

describe("pane-agent-sim invariants are not vacuous: a broken double or a mutant reference makes each one fail", () => {
  effectTest(
    "the happy trace holds every invariant (the base the mutants are measured against)",
    Effect.map(happy([]), (result) => expect(result.violations).toEqual([])),
    hangGuard("in-memory"),
  )

  const cases: ReadonlyArray<readonly [InvariantId, string, Effect.Effect<ReadonlyArray<Violation>>, Effect.Effect<ReadonlyArray<Violation>>]> = [
    [1, "a store that never answers late", Effect.map(core([]), (r) => r.violations), Effect.map(core(["hang-late-reads"]), (r) => r.violations)],
    [2, "a reference that forgets the last accepted turn", Effect.map(happy([]), (r) => r.violations), Effect.map(happy([]), (r) => withReference(r.trace, dropLastTurn))],
    [3, "a reference that believes in a turn the caller never sent", Effect.map(core([]), (r) => r.violations), Effect.map(core([]), (r) => withReference(r.trace, phantomTurn))],
    [4, "a notifier that drops done wakes", Effect.map(happy([]), (r) => r.violations), Effect.map(happy(["drop-done-wakes"]), (r) => r.violations)],
    [
      5,
      "a pane that shows ready over the trust prompt",
      Effect.map(broken("B2-follow-up-and-steer-into-trust-prompt", []), (r) => r.violations),
      Effect.map(broken("B2-follow-up-and-steer-into-trust-prompt", ["ready-over-prompt"]), (r) => r.violations),
    ],
    [6, "a pane reported gone while it is alive", Effect.map(happy([]), (r) => r.violations), Effect.map(happy(["gone-when-alive"]), (r) => r.violations)],
    [7, "a store that drops the worker's options", Effect.map(happy([]), (r) => r.violations), Effect.map(happy(["drop-options"]), (r) => r.violations)],
    [8, "a store that refuses every late write", Effect.map(core([]), (r) => r.violations), Effect.map(core(["refuse-late-writes"]), (r) => r.violations)],
  ]

  effectTest(
    "invariant 3's typed-twice and FIFO clauses fire with a broken world double: a pane that logs each write twice, a pane that logs its first paste late",
    Effect.gen(function* () {
      expect(of((yield* happy([])).violations, 3)).toEqual([])
      expect(of((yield* happy(["echo-writes"])).violations, 3).some((item) => /typed 2 times/.test(item.detail))).toBe(true)
      expect(of((yield* happy(["late-stamp-first-paste"])).violations, 3).some((item) => /not FIFO/.test(item.detail))).toBe(true)
    }),
    hangGuard("in-memory"),
  )

  effectTest(
    "invariant 9 (ruling 5): a correct limit trace (limit, one limited wake, one continue at the reset, the same turn's done) holds every invariant; each wrong variant fails I9 or I6",
    Effect.sync(() => {
      expect(checkAll(limitTrace("correct"))).toEqual([])
      for (const variant of ["no-resume", "two-resumes", "early-resume", "lost-token", "unreported"] as const) {
        const broke = checkAll(limitTrace(variant)).filter((item) => item.invariant === 9 || item.invariant === 6)
        expect(broke.length, variant).toBeGreaterThan(0)
      }
      expect(of(checkAll(limitTrace("lost-token")), 6).length).toBeGreaterThan(0)
      expect(of(checkAll(limitTrace("two-resumes")), 9).map((item) => item.detail).join()).toMatch(/resumed 2 times/)
      expect(of(checkAll(limitTrace("early-resume")), 9).map((item) => item.detail).join()).toMatch(/before its reset/)
      expect(of(checkAll(limitTrace("unreported")), 9).map((item) => item.detail).join()).toMatch(/no "limited" wake/)
    }),
    hangGuard("in-memory"),
  )

  effectTest(
    "ruling (3): only <pane-agent-result state=\"not_typed\" turn=\"N\"> with \"Turn N was not typed: <reason>\" reports an untyped turn",
    Effect.gen(function* () {
      const result = yield* core([])
      const ref = phantomTurn(referenceOfTrace(result.trace))
      const worker = Option.getOrThrow(Option.fromUndefinedOr([...ref.workers.values()][0]))
      const n = worker.turns.length
      const wakeAs = (state: string, text: string): Trace => ({
        ...result.trace,
        world: {
          ...result.trace.world,
          wakes: [
            ...result.trace.world.wakes,
            { at: 9_999, proc: 1, sessionID: "ses_sim", letter: { id: `msg_nt_${state}`, description: "", text, metadata: { workerId: worker.id, state, turn: n } } },
          ],
        },
      })
      const mine = (violations: ReadonlyArray<Violation>) => of(violations, 3).filter((item) => item.detail.startsWith(`${worker.key} `))
      expect(mine(checkAll(wakeAs("not_typed", `<pane-agent-result state="not_typed" turn="${n}">\nTurn ${n} was not typed: pane closed\n</pane-agent-result>`), ref))).toEqual([])
      expect(mine(checkAll(wakeAs("failed", `Turn ${n} was not typed: pane closed`), ref)).length).toBeGreaterThan(0)
    }),
    hangGuard("in-memory"),
  )

  for (const [id, mutant, base, broke] of cases) {
    effectTest(
      `invariant ${id} holds on its base and fails with ${mutant}`,
      Effect.gen(function* () {
        expect(of(yield* base, id)).toEqual([])
        expect(of(yield* broke, id).length).toBeGreaterThan(0)
      }),
      hangGuard("in-memory"),
    )
  }
})
