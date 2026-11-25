import { describe, expect, test } from "bun:test"
import { Array as Arr, Option } from "effect"
import { agyAdapter } from "./agy.ts"
import { DONE_FRAME, PERMISSION_FRAME, READY_FRAME, SIGNIN_FRAME, TRUST_FRAME, WORKING_FRAME } from "./agy.fixture.ts"
import {
  activeTurnTypedOf,
  DEFAULT_MACHINE_CONFIG,
  initialMachineState,
  MachineEvent,
  type MachineState,
  nextRetryableWake,
  pendingTurnsOf,
  transition,
} from "./machine.ts"
import { outboxOf, type PaneWorker, pendingWakesOf } from "./worker.ts"

const makePrng = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const pick = <A>(rng: () => number, items: ReadonlyArray<A>): A => {
  const index = Math.floor(rng() * items.length)
  return Option.getOrThrow(Arr.get(items, index))
}

const makeInitialWorker = (skipPermissions: boolean): PaneWorker => ({
  id: "pa_prop",
  parentSessionID: "ses_prop",
  directory: "/nonexistent/repo",
  cwd: "/nonexistent/lane",
  addDirs: ["/nonexistent/run"],
  skipPermissions,
  harness: "agy",
  role: "implementor",
  unit: "prop-unit",
  rexSessionId: "session:root",
  blockId: "block:prop",
  ownedBlock: true,
  resultFile: "/nonexistent/run/r.md",
  state: "starting",
  update: "starting agy in Rex pane",
  turn: 1,
  notifiedTurn: 0,
  revision: 1,
  activeTurnTyped: false,
  pendingTurns: [
    {
      turn: 1,
      brief:
        "[Task from the orchestrator]\n\nInitial task.\n\nWhen finished, write your final answer to /nonexistent/run/r.md.tmp, then rename it to /nonexistent/run/r.md.",
      resultFile: "/nonexistent/run/r.md",
      mode: "submit",
      queuedAt: 1000,
    },
  ],
  pendingWakes: [],
  deliveredWakes: [],
  startedAt: 1000,
  updatedAt: 1000,
})

const PROMPT_FRAMES = [TRUST_FRAME, PERMISSION_FRAME, SIGNIN_FRAME] as const
const ALL_LIVE_FRAMES = [READY_FRAME, WORKING_FRAME, DONE_FRAME, TRUST_FRAME, PERMISSION_FRAME, SIGNIN_FRAME] as const

interface FileRecord {
  readonly text: string
  readonly mtimeMs: number
  readonly partial: boolean
}

interface SimContext {
  readonly seed: number
  readonly skipPermissions: boolean
  readonly rng: () => number
  state: MachineState
  paneActuallyGone: boolean
  currentScreen: string
  now: number
  deliverySeq: number
  paneSeq: number
  intentSeq: number
  drainingOutbox: boolean
  readonly files: Map<string, FileRecord>
  readonly admittedWakes: Map<string, { readonly turn: number; readonly kind: string; readonly text: string }>
  readonly successfulWakeSends: Map<string, number>
  readonly settledTurns: Set<number>
  readonly typedTurnOrder: Array<number>
  readonly acceptedPrompts: Array<string>
  readonly typedBriefs: Array<string>
}

const nextDeliveryId = (sim: SimContext): string => {
  sim.deliverySeq += 1
  return `msg_prop_${sim.seed}_${sim.deliverySeq}`
}

const nextIntentId = (sim: SimContext, prefix: string): string => {
  sim.intentSeq += 1
  return `${prefix}_prop_${sim.seed}_${sim.intentSeq}`
}

const readFreshFile = (sim: SimContext): Option.Option<string> => {
  const entry = Option.fromUndefinedOr(sim.files.get(sim.state.worker.resultFile))
  if (Option.isNone(entry)) return Option.none()
  if (entry.value.mtimeMs < sim.state.worker.startedAt) return Option.none()
  return Option.some(entry.value.text)
}

const executeNextOutboxIntent = (sim: SimContext): boolean => {
  const head = Arr.head(outboxOf(sim.state.worker))
  if (Option.isNone(head)) return false
  const intent = head.value
  if (intent._tag === "ClosePane") {
    applyEvent(sim, MachineEvent.CloseCompleted({ intentId: intent.intentId, now: sim.now + 1 }))
    return true
  }
  if (intent._tag === "SplitPane") {
    if (!intent.dispatched) {
      applyEvent(sim, MachineEvent.MarkSplitDispatched({ intentId: intent.intentId, ownerProc: "prop", now: sim.now + 1 }))
    }
    applyEvent(
      sim,
      MachineEvent.SplitSucceeded({
        intentId: intent.intentId,
        blockId: `block:restarted-${sim.paneSeq}`,
        now: sim.now + 1,
      }),
    )
    return true
  }
  if (intent._tag === "TypeTurn") {
    // Invariant (B2): TypeTurn NEVER executes while currentScreen shows a human prompt.
    expect(Option.isNone(agyAdapter.needsInput(sim.currentScreen))).toBe(true)
    sim.typedTurnOrder.push(intent.turn)
    sim.typedBriefs.push(intent.chunks.join(""))
    if (sim.typedTurnOrder.length >= 2) {
      const prevTurn = Option.getOrElse(Arr.get(sim.typedTurnOrder, sim.typedTurnOrder.length - 2), () => 0)
      const currTurn = Option.getOrElse(Arr.get(sim.typedTurnOrder, sim.typedTurnOrder.length - 1), () => 0)
      expect(currTurn).toBeGreaterThan(prevTurn)
    }
    applyEvent(sim, MachineEvent.TypeTurnSucceeded({ intentId: intent.intentId, turn: intent.turn, now: sim.now + 1 }))
    return true
  }
  applyEvent(sim, MachineEvent.TypeResumeSucceeded({ intentId: intent.intentId, turn: intent.turn, now: sim.now + 1 }))
  return true
}

const drainOutbox = (sim: SimContext) => {
  if (sim.drainingOutbox) return
  sim.drainingOutbox = true
  while (executeNextOutboxIntent(sim)) {
    // drain FIFO
  }
  sim.drainingOutbox = false
}

const deliverHeadWake = (sim: SimContext, allowFailure: boolean) => {
  const nextWake = nextRetryableWake(sim.state.worker)
  if (Option.isNone(nextWake)) return
  const wake = nextWake.value
  if (allowFailure && sim.rng() < 0.4) {
    const failedRes = transition(
      sim.state,
      MachineEvent.WakeFailed({ deliveryId: wake.deliveryId, message: "refused", now: sim.now + 1 }),
      agyAdapter,
      DEFAULT_MACHINE_CONFIG,
    )
    sim.state = failedRes.state
    // Failed wake stays in ordered pendingWakes queue with the exact same deliveryId.
    expect(pendingWakesOf(sim.state.worker).some((w) => w.deliveryId === wake.deliveryId)).toBe(true)
    return
  }
  const prevCount = Option.getOrElse(Option.fromUndefinedOr(sim.successfulWakeSends.get(wake.deliveryId)), () => 0)
  sim.successfulWakeSends.set(wake.deliveryId, prevCount + 1)
  sim.admittedWakes.set(wake.deliveryId, { turn: wake.turn, kind: wake.kind, text: wake.text })
  const deliveredRes = transition(
    sim.state,
    MachineEvent.WakeDelivered({ deliveryId: wake.deliveryId, now: sim.now + 1 }),
    agyAdapter,
    DEFAULT_MACHINE_CONFIG,
  )
  sim.state = deliveredRes.state
  expect(pendingWakesOf(sim.state.worker).some((w) => w.deliveryId === wake.deliveryId)).toBe(false)
}

const applyEvent = (sim: SimContext, event: MachineEvent) => {
  const prevWorker = sim.state.worker
  const prevWakesCount = pendingWakesOf(prevWorker).length
  const result = transition(sim.state, event, agyAdapter, DEFAULT_MACHINE_CONFIG)
  sim.state = result.state

  // Invariant (B4): skipPermissions is preserved across every transition including QueueRestart.
  expect(sim.state.worker.skipPermissions).toBe(sim.skipPermissions)

  // Invariant (B2 observe needs gate): whenever ObserveScreen sees a prompt, state becomes needs_input.
  if (event._tag === "ObserveScreen" && Option.isSome(agyAdapter.needsInput(event.screen))) {
    expect(sim.state.worker.state).toBe("needs_input")
  }

  // Invariant (Q2): appending a wake NEVER reduces the outbox count unless WakeDelivered or Stop ran.
  if (event._tag !== "WakeDelivered" && event._tag !== "Stop") {
    expect(pendingWakesOf(sim.state.worker).length).toBeGreaterThanOrEqual(prevWakesCount)
  }

  // Invariant (B1): NEVER settle done while screen shows WORKING_FRAME or needsInput.
  if (prevWorker.state !== "done" && sim.state.worker.state === "done") {
    expect(sim.settledTurns.has(sim.state.worker.turn)).toBe(false)
    sim.settledTurns.add(sim.state.worker.turn)
    if (!sim.paneActuallyGone) {
      expect(agyAdapter.turnEnded(sim.currentScreen)).toBe(true)
      expect(Option.isNone(agyAdapter.needsInput(sim.currentScreen))).toBe(true)
    }
    const fileEntry = Option.fromUndefinedOr(sim.files.get(sim.state.worker.resultFile))
    if (Option.isSome(fileEntry) && fileEntry.value.mtimeMs >= sim.state.worker.startedAt) {
      expect(sim.state.worker.lastAnswer).toBe(fileEntry.value.text)
    }
  }

  // Invariant (B3): pane_gone is ONLY reachable when the pane is actually gone AND confirmed >= 2 times.
  if (sim.state.worker.state === "pane_gone") {
    expect(sim.paneActuallyGone).toBe(true)
    expect(sim.state.consecutiveGone).toBeGreaterThanOrEqual(DEFAULT_MACHINE_CONFIG.confirmGoneCount)
  }

  if (result.actions.some((a) => a._tag === "FlushWake")) {
    deliverHeadWake(sim, true)
  }

  if (outboxOf(sim.state.worker).length > 0) {
    drainOutbox(sim)
  }
}

const stepRestartServer = (sim: SimContext) => {
  // Simulates server crash/restart: drops all in-memory counters; reloads strictly from persisted worker.
  const persisted = sim.state.worker
  sim.state = initialMachineState(persisted, activeTurnTypedOf(persisted))
  if (pendingWakesOf(sim.state.worker).length > 0) {
    sim.state = transition(
      sim.state,
      MachineEvent.RestartWakeRetries({ now: sim.now }),
      agyAdapter,
      DEFAULT_MACHINE_CONFIG,
    ).state
    deliverHeadWake(sim, false)
  }
}

const stepScreen = (sim: SimContext) => {
  if (sim.paneActuallyGone) return
  if (sim.state.idlePendingConfirm) {
    const confirmRoll = sim.rng()
    if (confirmRoll < 0.65) {
      sim.currentScreen = DONE_FRAME
      sim.files.set(sim.state.worker.resultFile, {
        text: `final-t${sim.state.worker.turn}`,
        mtimeMs: sim.now,
        partial: false,
      })
    } else if (confirmRoll < 0.85) {
      sim.currentScreen = WORKING_FRAME
    } else {
      sim.currentScreen = pick(sim.rng, PROMPT_FRAMES)
    }
    applyEvent(
      sim,
      MachineEvent.IdleConfirmed({
        screen: sim.currentScreen,
        resultFileAnswer: readFreshFile(sim),
        now: sim.now,
        deliveryId: nextDeliveryId(sim),
      }),
    )
    return
  }
  sim.currentScreen = pick(sim.rng, ALL_LIVE_FRAMES)
  applyEvent(
    sim,
    MachineEvent.ObserveScreen({
      screen: sim.currentScreen,
      now: sim.now,
      deliveryId: nextDeliveryId(sim),
      intentId: nextIntentId(sim, "tt"),
      ownerProc: "prop",
    }),
  )
}

const stepPaneRestart = (sim: SimContext) => {
  if (sim.state.worker.state !== "pane_gone") return
  const queuedBefore = pendingTurnsOf(sim.state.worker).length
  sim.paneSeq += 1
  sim.paneActuallyGone = false
  sim.currentScreen = WORKING_FRAME
  applyEvent(
    sim,
    MachineEvent.QueueRestart({
      rexSessionId: "session:root",
      anchorBlockId: "block:anchor",
      label: `agy:prop-unit#rq_${sim.paneSeq}`,
      reqId: `rq_${sim.paneSeq}`,
      command: ["agy", "--continue"],
      cwd: "/nonexistent/lane",
      addDirs: ["/nonexistent/run"],
      resultFile: sim.state.worker.resultFile,
      resumedBrief: "Resume",
      splitIntentId: nextIntentId(sim, "sp"),
      closeIntentId: Option.none(),
      ownerProc: "prop",
      now: sim.now,
    }),
  )
  // Invariant (Q1): restart preserves ALL pendingTurns in order!
  expect(pendingTurnsOf(sim.state.worker).length).toBe(queuedBefore)
}

const stepSpuriousGone = (sim: SimContext) => {
  if (sim.paneActuallyGone || sim.state.consecutiveGone > 0) return
  applyEvent(
    sim,
    MachineEvent.ProbeGone({
      tail: "glitch",
      resultFileAnswer: Option.none(),
      now: sim.now,
      deliveryId: nextDeliveryId(sim),
    }),
  )
  expect(sim.state.worker.state).not.toBe("pane_gone")
  sim.currentScreen = WORKING_FRAME
  applyEvent(
    sim,
    MachineEvent.ObserveScreen({
      screen: WORKING_FRAME,
      now: sim.now + 1,
      deliveryId: nextDeliveryId(sim),
      intentId: nextIntentId(sim, "tt"),
      ownerProc: "prop",
    }),
  )
  expect(sim.state.consecutiveGone).toBe(0)
}

const stepRealClose = (sim: SimContext) => {
  sim.paneActuallyGone = true
  applyEvent(
    sim,
    MachineEvent.ProbeGone({
      tail: "closed",
      resultFileAnswer: readFreshFile(sim),
      now: sim.now,
      deliveryId: nextDeliveryId(sim),
    }),
  )
  if (sim.state.worker.state !== "pane_gone" && sim.state.worker.state !== "done") {
    applyEvent(
      sim,
      MachineEvent.ProbeGone({
        tail: "closed",
        resultFileAnswer: readFreshFile(sim),
        now: sim.now + 5,
        deliveryId: nextDeliveryId(sim),
      }),
    )
  }
}

const stepFileWrite = (sim: SimContext, step: number) => {
  const isStale = sim.rng() < 0.3
  const isPartial = sim.currentScreen === WORKING_FRAME
  let mtimeMs = sim.now
  if (isStale) mtimeMs = sim.state.worker.startedAt - 500
  let text = `final-t${sim.state.worker.turn}-s${step}`
  if (isPartial) text = `partial-t${sim.state.worker.turn}-s${step}`
  sim.files.set(sim.state.worker.resultFile, { text, mtimeMs, partial: isPartial })
}

const stepQueueFollowUp = (sim: SimContext, step: number) => {
  const tag = `FOLLOW-${sim.seed}-${step}`
  let requestedFile: Option.Option<string> = Option.none()
  if (sim.rng() < 0.5) requestedFile = Option.some(sim.state.worker.resultFile)
  applyEvent(sim, MachineEvent.QueueFollowUp({ prompt: tag, resultFile: requestedFile, now: sim.now }))
  sim.acceptedPrompts.push(tag)
  const queued = pendingTurnsOf(sim.state.worker)
  if (queued.length > 0 && activeTurnTypedOf(sim.state.worker)) {
    const last = Option.getOrThrow(Arr.last(queued))
    expect(last.resultFile).not.toBe(sim.state.worker.resultFile)
  }
}

const stepRequestSteer = (sim: SimContext, step: number) => {
  applyEvent(
    sim,
    MachineEvent.QueueFollowUp({
      prompt: `STEER-${sim.seed}-${step}`,
      resultFile: Option.none(),
      steer: true,
      now: sim.now,
    }),
  )
}

const stepOne = (sim: SimContext, step: number) => {
  if (sim.state.worker.state === "pane_gone") {
    if (sim.rng() < 0.7) stepPaneRestart(sim)
    return
  }
  const roll = sim.rng()
  if (roll < 0.1) return stepRestartServer(sim)
  if (roll < 0.22) return stepQueueFollowUp(sim, step)
  if (roll < 0.3) return stepRequestSteer(sim, step)
  if (roll < 0.4) {
    applyEvent(
      sim,
      MachineEvent.TransientError({
        operation: "terminals.read",
        message: "request timeout",
        now: sim.now,
        deliveryId: nextDeliveryId(sim),
      }),
    )
    expect(sim.state.worker.state).not.toBe("pane_gone")
    return
  }
  if (roll < 0.46) return stepSpuriousGone(sim)
  if (roll < 0.54) return stepFileWrite(sim, step)
  if (roll < 0.58) return stepRealClose(sim)
  if (roll < 0.6 && step > 45) {
    applyEvent(
      sim,
      MachineEvent.Stop({
        close: sim.rng() < 0.5,
        closeIntentId: nextIntentId(sim, "cl"),
        ownerProc: "prop",
        now: sim.now,
      }),
    )
    return
  }
  stepScreen(sim)
}

/** Drains remaining prompts/turns on a live non-stopped worker to verify liveness (every accepted follow-up runs!). */
const drainLiveness = (sim: SimContext) => {
  if (sim.state.worker.state === "stopped") return
  if (sim.state.worker.state === "pane_gone") {
    stepPaneRestart(sim)
  }
  for (let guard = 0; guard < 160; guard++) {
    sim.now += 10
    if (pendingWakesOf(sim.state.worker).length > 0) {
      sim.state = transition(
        sim.state,
        MachineEvent.RestartWakeRetries({ now: sim.now }),
        agyAdapter,
        DEFAULT_MACHINE_CONFIG,
      ).state
      deliverHeadWake(sim, false)
    }
    const doneAll =
      sim.state.worker.state === "done" &&
      pendingTurnsOf(sim.state.worker).length === 0 &&
      pendingWakesOf(sim.state.worker).length === 0 &&
      outboxOf(sim.state.worker).length === 0
    if (doneAll) break

    if (sim.state.idlePendingConfirm) {
      sim.currentScreen = DONE_FRAME
      sim.files.set(sim.state.worker.resultFile, {
        text: `drained-t${sim.state.worker.turn}`,
        mtimeMs: sim.now,
        partial: false,
      })
      applyEvent(
        sim,
        MachineEvent.IdleConfirmed({
          screen: DONE_FRAME,
          resultFileAnswer: readFreshFile(sim),
          now: sim.now,
          deliveryId: nextDeliveryId(sim),
        }),
      )
    } else if (!activeTurnTypedOf(sim.state.worker)) {
      sim.currentScreen = READY_FRAME
      applyEvent(
        sim,
        MachineEvent.ObserveScreen({
          screen: READY_FRAME,
          now: sim.now,
          deliveryId: nextDeliveryId(sim),
          intentId: nextIntentId(sim, "tt"),
          ownerProc: "prop",
        }),
      )
    } else if (!sim.state.sawWorking) {
      sim.currentScreen = WORKING_FRAME
      applyEvent(
        sim,
        MachineEvent.ObserveScreen({
          screen: WORKING_FRAME,
          now: sim.now,
          deliveryId: nextDeliveryId(sim),
          intentId: nextIntentId(sim, "tt"),
          ownerProc: "prop",
        }),
      )
    } else {
      sim.currentScreen = DONE_FRAME
      applyEvent(
        sim,
        MachineEvent.ObserveScreen({
          screen: DONE_FRAME,
          now: sim.now,
          deliveryId: nextDeliveryId(sim),
          intentId: nextIntentId(sim, "tt"),
          ownerProc: "prop",
        }),
      )
    }
  }

  // Liveness invariant: every accepted follow-up prompt was eventually typed in exact order!
  expect(pendingTurnsOf(sim.state.worker)).toHaveLength(0)
  expect(pendingWakesOf(sim.state.worker)).toHaveLength(0)
  const combinedTyped = sim.typedBriefs.join("\n")
  let lastPos = -1
  for (const tag of sim.acceptedPrompts) {
    const pos = combinedTyped.indexOf(tag)
    expect(pos).toBeGreaterThan(lastPos)
    lastPos = pos
  }
}

const runSeed = (seed: number, steps: number) => {
  const rng = makePrng(seed * 7919 + 17)
  const skipPermissions = seed % 2 === 0
  const sim: SimContext = {
    seed,
    skipPermissions,
    rng,
    state: initialMachineState(makeInitialWorker(skipPermissions)),
    paneActuallyGone: false,
    currentScreen: pick(rng, ALL_LIVE_FRAMES),
    now: 2000,
    deliverySeq: 0,
    paneSeq: 0,
    intentSeq: 0,
    drainingOutbox: false,
    files: new Map(),
    admittedWakes: new Map(),
    successfulWakeSends: new Map(),
    settledTurns: new Set(),
    typedTurnOrder: [],
    acceptedPrompts: [],
    typedBriefs: [],
  }

  for (let step = 0; step < steps; step++) {
    sim.now += 10
    if (sim.state.worker.state === "stopped") break
    stepOne(sim, step)
  }

  drainLiveness(sim)

  // Final wake invariants (R1): at most ONE admitted `done` wake per turn, and every wake sent successfully at most once!
  const doneTurnsAdmitted = new Set<number>()
  for (const wake of sim.admittedWakes.values()) {
    if (wake.kind === "done") {
      expect(doneTurnsAdmitted.has(wake.turn)).toBe(false)
      doneTurnsAdmitted.add(wake.turn)
    }
  }
  for (const count of sim.successfulWakeSends.values()) {
    expect(count).toBe(1)
  }
}

describe("PaneAgent explicit state machine (model-based safety + liveness property tests)", () => {
  test("holds every safety and liveness invariant across 300 generated interleavings (prompts, partial/stale files, spurious gone, Rex errors, restarts, stop, follow-ups, steers, wake failures)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      runSeed(seed, 60)
    }
  })
})
