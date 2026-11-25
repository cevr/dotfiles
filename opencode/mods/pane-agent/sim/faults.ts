import { Deferred, Effect, Option, Ref } from "effect"

/** Every effect boundary of the diagnosis section 4 the simulation can fault. */
export const BOUNDARIES = [
  "pane.read",
  "pane.readTail",
  "pane.alive",
  "pane.waitForQuiet",
  "pane.write",
  "pane.split",
  "pane.close",
  "store.read",
  "store.write",
  "notifier.wake",
  "notifier.changed",
  "results.read",
  "timer.sleep",
  "process.start",
] as const
export type Boundary = (typeof BOUNDARIES)[number]

/** Every fault an effect can take: ok, each typed tag, a defect, a hang, a timeout, a late completion, a crash. */
export const FAULTS = [
  "ok",
  "transient",
  "unavailable",
  "gone",
  "unsupported",
  "conflict",
  "corrupt",
  "defect",
  "hang",
  "timeout",
  "late",
  "crash",
] as const
export type Fault = (typeof FAULTS)[number]

const REX: ReadonlyArray<Fault> = ["ok", "transient", "unavailable", "gone", "unsupported", "defect", "hang", "timeout", "late", "crash"]

/** The faults that mean something at each boundary (a read has no conflict; `changed` has no error channel; only a read meets a corrupt row). */
export const faultsAt = (boundary: Boundary): ReadonlyArray<Fault> => {
  if (boundary.startsWith("pane.")) return REX
  if (boundary === "store.read") return ["ok", "transient", "corrupt", "defect", "hang", "timeout", "crash"]
  if (boundary === "store.write") return ["ok", "transient", "conflict", "defect", "hang", "timeout", "late", "crash"]
  if (boundary === "notifier.wake") return ["ok", "transient", "defect", "hang", "timeout", "late", "crash"]
  if (boundary === "notifier.changed") return ["ok", "defect", "hang", "late", "crash"]
  if (boundary === "results.read") return ["ok", "transient", "defect", "hang", "timeout", "crash"]
  if (boundary === "timer.sleep") return ["ok", "defect", "hang", "late", "crash"]
  return ["ok", "crash", "late"]
}

/** Every (boundary, fault) pair the coverage counter must see across a seed set. */
export const ALL_PAIRS: ReadonlyArray<string> = BOUNDARIES.flatMap((boundary) => faultsAt(boundary).map((fault) => pairKey(boundary, fault)))

export function pairKey(boundary: Boundary, fault: Fault): string {
  return `${boundary}|${fault}`
}

/** Deterministic mulberry32 generator, its state in a Ref (no module state). */
export interface Prng {
  readonly next: Effect.Effect<number>
  readonly int: (bound: number) => Effect.Effect<number>
  readonly chance: (p: number) => Effect.Effect<boolean>
}

const mulberry = (state: number): readonly [number, number] => {
  const s = (state + 0x6d2b79f5) | 0
  let t = Math.imul(s ^ (s >>> 15), 1 | s)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s]
}

export const makePrng = Effect.fn("Sim.makePrng")(function* (seed: number) {
  const state = yield* Ref.make(seed | 0)
  const next = Ref.modify(state, mulberry)
  const prng: Prng = {
    next,
    int: (bound) => Effect.map(next, (value) => Math.floor(value * bound)),
    chance: (p) => Effect.map(next, (value) => value < p),
  }
  return prng
})

/** A planned fault: the nth call (0-based, across every process) to a boundary, optionally only while a screen shows. */
export interface PlannedFault {
  readonly boundary: Boundary
  readonly nth: number
  readonly fault: Fault
}

/** A recorded boundary call: the effect index the crash enumeration and the shrinker refer to. */
export interface EffectRecord {
  readonly index: number
  readonly boundary: Boundary
  readonly nth: number
  readonly proc: number
  readonly fault: Fault
  readonly detail: string
}

/** A gate holds one boundary call until the driver has injected a command at that await point. */
export interface Gate {
  readonly index: Option.Option<number>
  readonly boundary: Option.Option<Boundary>
  readonly detail: Option.Option<string>
  readonly hit: Deferred.Deferred<number>
  readonly release: Deferred.Deferred<boolean>
}

export interface RandomFaults {
  readonly seed: number
  readonly rate: number
  readonly allow: ReadonlyArray<Fault>
}

export interface Injector {
  readonly decide: (boundary: Boundary, proc: number, detail: string) => Effect.Effect<EffectRecord>
  readonly plan: (faults: ReadonlyArray<PlannedFault>) => Effect.Effect<void>
  /** Plans faults counted from now: `nth` 0 is the next call to that boundary. */
  readonly planNext: (faults: ReadonlyArray<PlannedFault>) => Effect.Effect<void>
  readonly crashAt: (index: number) => Effect.Effect<void>
  readonly setGate: (gate: Option.Option<Gate>) => Effect.Effect<void>
  readonly setFaultsOn: (on: boolean) => Effect.Effect<void>
  readonly trace: Effect.Effect<ReadonlyArray<EffectRecord>>
  readonly coverage: Effect.Effect<ReadonlyMap<string, number>>
  readonly fired: Effect.Effect<ReadonlyArray<PlannedFault>>
}

interface InjectorState {
  readonly index: number
  readonly counts: ReadonlyMap<Boundary, number>
  readonly planned: ReadonlyArray<PlannedFault>
  readonly crashIndex: Option.Option<number>
  readonly on: boolean
  readonly trace: ReadonlyArray<EffectRecord>
  readonly fired: ReadonlyArray<PlannedFault>
  readonly coverage: ReadonlyMap<string, number>
}

const OK: Fault = "ok"
const CRASH: Fault = "crash"

const plannedFor = (state: InjectorState, boundary: Boundary, nth: number): Option.Option<PlannedFault> =>
  Option.fromUndefinedOr(state.planned.find((item) => item.boundary === boundary && item.nth === nth))

const gateMatches = (gate: Gate, record: EffectRecord): boolean =>
  Option.match(gate.index, {
    onSome: (index) => index === record.index,
    onNone: () =>
      Option.contains(gate.boundary, record.boundary) &&
      Option.match(gate.detail, { onNone: () => true, onSome: (detail) => record.detail.includes(detail) }),
  })

/**
 * The seeded fault injector every world double routes its calls through. It picks the fault from the plan,
 * then the crash index, then the seed; records the call (the trace and the coverage counter); and holds a
 * gated call until the driver releases it.
 */
export const makeInjector = Effect.fn("Sim.makeInjector")(function* (random: Option.Option<RandomFaults>) {
  const prng = yield* makePrng(Option.match(random, { onNone: () => 1, onSome: (r) => r.seed }))
  const state = yield* Ref.make<InjectorState>({
    index: 0,
    counts: new Map(),
    planned: [],
    crashIndex: Option.none(),
    on: true,
    trace: [],
    fired: [],
    coverage: new Map(),
  })
  const gateRef = yield* Ref.make<Option.Option<Gate>>(Option.none())

  const randomFault = Effect.fn("Sim.randomFault")(function* (boundary: Boundary) {
    if (Option.isNone(random)) return Option.none<Fault>()
    const allowed = faultsAt(boundary).filter((fault) => fault !== "ok" && random.value.allow.includes(fault))
    if (allowed.length === 0) return Option.none<Fault>()
    if (!(yield* prng.chance(random.value.rate))) return Option.none<Fault>()
    const pick = yield* prng.int(allowed.length)
    return Option.fromUndefinedOr(allowed[pick])
  })

  const choose = Effect.fn("Sim.chooseFault")(function* (current: InjectorState, boundary: Boundary, nth: number) {
    if (!current.on) return { fault: OK, planned: false }
    const planned = plannedFor(current, boundary, nth)
    if (Option.isSome(planned)) return { fault: planned.value.fault, planned: true }
    if (Option.contains(current.crashIndex, current.index)) return { fault: CRASH, planned: true }
    const picked = yield* randomFault(boundary)
    return { fault: Option.getOrElse(picked, () => OK), planned: Option.isSome(picked) }
  })

  const decide = Effect.fn("Sim.decide")(function* (boundary: Boundary, proc: number, detail: string) {
    const current = yield* Ref.get(state)
    const nth = Option.getOrElse(Option.fromUndefinedOr(current.counts.get(boundary)), () => 0)
    const chosen = yield* choose(current, boundary, nth)
    const record: EffectRecord = { index: current.index, boundary, nth, proc, fault: chosen.fault, detail }
    yield* Ref.update(state, (prev) => {
      const counts = new Map(prev.counts)
      counts.set(boundary, nth + 1)
      const coverage = new Map(prev.coverage)
      const key = pairKey(boundary, chosen.fault)
      coverage.set(key, Option.getOrElse(Option.fromUndefinedOr(coverage.get(key)), () => 0) + 1)
      const fired = [...prev.fired]
      if (chosen.planned && chosen.fault !== "ok") fired.push({ boundary, nth, fault: chosen.fault })
      return { ...prev, index: prev.index + 1, counts, coverage, fired, trace: [...prev.trace, record] }
    })
    const gate = yield* Ref.get(gateRef)
    if (Option.isSome(gate) && gateMatches(gate.value, record)) {
      yield* Ref.set(gateRef, Option.none())
      yield* Deferred.succeed(gate.value.hit, record.index)
      yield* Deferred.await(gate.value.release)
    }
    return record
  })

  const injector: Injector = {
    decide,
    plan: (faults) => Ref.update(state, (prev) => ({ ...prev, planned: [...prev.planned, ...faults] })),
    planNext: (faults) =>
      Ref.update(state, (prev) => ({
        ...prev,
        planned: [
          ...prev.planned,
          ...faults.map((f) => ({ ...f, nth: f.nth + Option.getOrElse(Option.fromUndefinedOr(prev.counts.get(f.boundary)), () => 0) })),
        ],
      })),
    crashAt: (index) => Ref.update(state, (prev) => ({ ...prev, crashIndex: Option.some(index) })),
    setGate: (gate) => Ref.set(gateRef, gate),
    setFaultsOn: (on) => Ref.update(state, (prev) => ({ ...prev, on })),
    trace: Effect.map(Ref.get(state), (s) => s.trace),
    coverage: Effect.map(Ref.get(state), (s) => s.coverage),
    fired: Effect.map(Ref.get(state), (s) => s.fired),
  }
  return injector
})

export const makeGate = Effect.fn("Sim.makeGate")(function* (
  index: Option.Option<number>,
  boundary: Option.Option<Boundary>,
  detail: Option.Option<string>,
) {
  const hit = yield* Deferred.make<number>()
  const release = yield* Deferred.make<boolean>()
  const gate: Gate = { index, boundary, detail, hit, release }
  return gate
})

/** A counter over many runs: which (boundary, fault) pairs the seed set hit. */
export const mergeCoverage = (into: Map<string, number>, from: ReadonlyMap<string, number>): void => {
  for (const [key, count] of from) into.set(key, Option.getOrElse(Option.fromUndefinedOr(into.get(key)), () => 0) + count)
}

export const unhitPairs = (coverage: ReadonlyMap<string, number>): ReadonlyArray<string> =>
  ALL_PAIRS.filter((key) => !coverage.has(key))
