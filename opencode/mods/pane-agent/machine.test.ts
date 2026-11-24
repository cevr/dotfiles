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
  pendingTurnsOf,
  transition,
} from "./machine.ts"
import type { PaneWorker } from "./worker.ts"

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
  deliveredWakes: [],
  startedAt: 1000,
  updatedAt: 1000,
})

const PROMPT_FRAMES = [TRUST_FRAME, PERMISSION_FRAME, SIGNIN_FRAME] as const
const ALL_LIVE_FRAMES = [READY_FRAME, WORKING_FRAME, DONE_FRAME, TRUST_FRAME, PERMISSION_FRAME, SIGNIN_FRAME] as const

interface SimContext {
  readonly seed: number
  readonly skipPermissions: boolean
  readonly rng: () => number
  state: MachineState
  paneActuallyGone: boolean
  currentScreen: string
  now: number
  deliverySeq: number
  readonly files: Map<string, { readonly text: string; readonly partial: boolean }>
  readonly admittedWakes: Map<string, { readonly turn: number; readonly kind: string; readonly text: string }>
  readonly settledTurns: Set<number>
  readonly typedTurnOrder: Array<number>
}

const nextDeliveryId = (sim: SimContext): string => {
  sim.deliverySeq += 1
  return `msg_prop_${sim.seed}_${sim.deliverySeq}`
}

const checkActionInvariants = (sim: SimContext, actions: ReadonlyArray<{ readonly _tag: string }>) => {
  for (const action of actions) {
    if (action._tag === "WritePane") {
      // Invariant (B2): WritePane NEVER fires while currentScreen shows a human prompt.
      expect(Option.isNone(agyAdapter.needsInput(sim.currentScreen))).toBe(true)
      sim.typedTurnOrder.push(sim.state.worker.turn)
      if (sim.typedTurnOrder.length >= 2) {
        const prevTurn = Option.getOrElse(Arr.get(sim.typedTurnOrder, sim.typedTurnOrder.length - 2), () => 0)
        const currTurn = Option.getOrElse(Arr.get(sim.typedTurnOrder, sim.typedTurnOrder.length - 1), () => 0)
        expect(currTurn).toBeGreaterThan(prevTurn)
      }
    }
  }
}

const checkWakeDelivery = (sim: SimContext) => {
  const pending = Option.fromUndefinedOr(sim.state.worker.pendingWake)
  expect(Option.isSome(pending)).toBe(true)
  if (Option.isNone(pending)) return
  if (sim.rng() < 0.35) {
    const failedRes = transition(
      sim.state,
      MachineEvent.WakeFailed({ message: "refused", now: sim.now + 1 }),
      agyAdapter,
      DEFAULT_MACHINE_CONFIG,
    )
    sim.state = failedRes.state
    expect(sim.state.worker.pendingWake?.deliveryId).toBe(pending.value.deliveryId)
    return
  }
  sim.admittedWakes.set(pending.value.deliveryId, {
    turn: pending.value.turn,
    kind: pending.value.kind,
    text: pending.value.text,
  })
  const deliveredRes = transition(
    sim.state,
    MachineEvent.WakeDelivered({ now: sim.now + 1 }),
    agyAdapter,
    DEFAULT_MACHINE_CONFIG,
  )
  sim.state = deliveredRes.state
  expect(sim.state.worker.pendingWake).toBeUndefined()
}

const applyEvent = (sim: SimContext, event: MachineEvent) => {
  const prevWorker = sim.state.worker
  const result = transition(sim.state, event, agyAdapter, DEFAULT_MACHINE_CONFIG)
  sim.state = result.state

  // Invariant (B4): skipPermissions is never dropped or flipped across any transition.
  expect(sim.state.worker.skipPermissions).toBe(sim.skipPermissions)
  checkActionInvariants(sim, result.actions)

  // Invariant (B1): NEVER settle done while screen still shows WORKING_FRAME or needsInput.
  if (prevWorker.state !== "done" && sim.state.worker.state === "done") {
    expect(sim.settledTurns.has(sim.state.worker.turn)).toBe(false)
    sim.settledTurns.add(sim.state.worker.turn)
    if (!sim.paneActuallyGone) {
      expect(agyAdapter.turnEnded(sim.currentScreen)).toBe(true)
      expect(Option.isNone(agyAdapter.needsInput(sim.currentScreen))).toBe(true)
    }
    const fileEntry = Option.fromUndefinedOr(sim.files.get(sim.state.worker.resultFile))
    if (Option.isSome(fileEntry) && !fileEntry.value.partial) {
      expect(sim.state.worker.lastAnswer).toBe(fileEntry.value.text)
    }
  }

  // Invariant (B3): pane_gone is ONLY reachable when the pane is actually gone AND confirmed >= 2 times.
  if (sim.state.worker.state === "pane_gone") {
    expect(sim.paneActuallyGone).toBe(true)
    expect(sim.state.consecutiveGone).toBeGreaterThanOrEqual(DEFAULT_MACHINE_CONFIG.confirmGoneCount)
  }

  if (result.actions.some((a) => a._tag === "FlushWake")) {
    checkWakeDelivery(sim)
  }
}

const stepRestart = (sim: SimContext) => {
  const persisted = sim.state.worker
  const hadPendingWake = Option.fromUndefinedOr(persisted.pendingWake)
  sim.state = initialMachineState(persisted, activeTurnTypedOf(persisted))
  if (Option.isSome(hadPendingWake)) {
    sim.admittedWakes.set(hadPendingWake.value.deliveryId, {
      turn: hadPendingWake.value.turn,
      kind: hadPendingWake.value.kind,
      text: hadPendingWake.value.text,
    })
    sim.state = transition(
      sim.state,
      MachineEvent.WakeDelivered({ now: sim.now }),
      agyAdapter,
      DEFAULT_MACHINE_CONFIG,
    ).state
  }
}

const stepScreen = (sim: SimContext) => {
  if (sim.paneActuallyGone) return
  if (sim.state.idlePendingConfirm) {
    const confirmRoll = sim.rng()
    if (confirmRoll < 0.65) {
      sim.currentScreen = DONE_FRAME
      sim.files.set(sim.state.worker.resultFile, { text: `final-t${sim.state.worker.turn}`, partial: false })
    } else if (confirmRoll < 0.85) {
      sim.currentScreen = WORKING_FRAME
    } else {
      sim.currentScreen = pick(sim.rng, PROMPT_FRAMES)
    }
    const fileAnswer = Option.map(Option.fromUndefinedOr(sim.files.get(sim.state.worker.resultFile)), (f) => f.text)
    applyEvent(
      sim,
      MachineEvent.IdleConfirmed({
        screen: sim.currentScreen,
        resultFileAnswer: fileAnswer,
        now: sim.now,
        deliveryId: nextDeliveryId(sim),
      }),
    )
    return
  }
  sim.currentScreen = pick(sim.rng, ALL_LIVE_FRAMES)
  applyEvent(
    sim,
    MachineEvent.ObserveScreen({ screen: sim.currentScreen, now: sim.now, deliveryId: nextDeliveryId(sim) }),
  )
}

const stepOne = (sim: SimContext, step: number) => {
  const roll = sim.rng()
  if (roll < 0.12) {
    stepRestart(sim)
    return
  }
  if (roll < 0.24) {
    let requestedFile: Option.Option<string> = Option.none()
    if (sim.rng() < 0.5) requestedFile = Option.some(sim.state.worker.resultFile)
    applyEvent(sim, MachineEvent.QueueFollowUp({ prompt: `Follow-up at step ${step}`, resultFile: requestedFile, now: sim.now }))
    const queued = pendingTurnsOf(sim.state.worker)
    if (queued.length > 0 && activeTurnTypedOf(sim.state.worker)) {
      const last = Option.getOrThrow(Arr.last(queued))
      expect(last.resultFile).not.toBe(sim.state.worker.resultFile)
    }
    return
  }
  if (roll < 0.34) {
    let screenOpt: Option.Option<string> = Option.some(sim.currentScreen)
    if (sim.paneActuallyGone) screenOpt = Option.none()
    applyEvent(
      sim,
      MachineEvent.RequestSteer({
        prompt: `Steer at step ${step}`,
        resultFile: Option.none(),
        screen: screenOpt,
        now: sim.now,
      }),
    )
    return
  }
  if (roll < 0.48) {
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
  if (roll < 0.6) {
    const isPartial = sim.currentScreen === WORKING_FRAME
    let text = `final-t${sim.state.worker.turn}-s${step}`
    if (isPartial) text = `partial-t${sim.state.worker.turn}-s${step}`
    sim.files.set(sim.state.worker.resultFile, { text, partial: isPartial })
    return
  }
  if (roll < 0.64) {
    sim.paneActuallyGone = true
    const fileAnswer = Option.map(Option.fromUndefinedOr(sim.files.get(sim.state.worker.resultFile)), (f) => f.text)
    applyEvent(sim, MachineEvent.ProbeGone({ tail: "closed", resultFileAnswer: fileAnswer, now: sim.now, deliveryId: nextDeliveryId(sim) }))
    if (sim.state.worker.state !== "pane_gone" && sim.state.worker.state !== "done") {
      applyEvent(
        sim,
        MachineEvent.ProbeGone({ tail: "closed", resultFileAnswer: fileAnswer, now: sim.now + 5, deliveryId: nextDeliveryId(sim) }),
      )
    }
    return
  }
  stepScreen(sim)
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
    files: new Map(),
    admittedWakes: new Map(),
    settledTurns: new Set(),
    typedTurnOrder: [],
  }

  for (let step = 0; step < steps; step++) {
    sim.now += 10
    if (sim.state.worker.state === "stopped" || sim.state.worker.state === "pane_gone") break
    stepOne(sim, step)
  }

  // Final per-run wake invariant (R1): at most ONE admitted `done` wake per turn number.
  const doneTurnsAdmitted = new Set<number>()
  for (const wake of sim.admittedWakes.values()) {
    if (wake.kind === "done") {
      expect(doneTurnsAdmitted.has(wake.turn)).toBe(false)
      doneTurnsAdmitted.add(wake.turn)
    }
  }
}

describe("PaneAgent explicit state machine (model-based property tests)", () => {
  test("holds every safety and liveness invariant across 300 generated interleavings (prompts, partial files, Rex errors, restarts, follow-ups, steers)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      runSeed(seed, 60)
    }
  })
})
