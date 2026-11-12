/**
 * The readiness wait against an independent reference model, on generated command sequences under
 * the test clock with a fake probe: publish, advance the clock, run to the next probe, cancel, in
 * any order, before, at and past the deadline, and again after the wait ended. After every
 * command the wait and the model agree on the outcome, the value a ready probe saw, the state a
 * timeout names, how many probes ran and how many times the wait's scope was finalized. The
 * deadline wins at equality, ready is only a publication a probe saw before the deadline, and no
 * probe runs after a cancel or an outcome. No process starts here: the real waits are the runner's
 * and the checks' own tests.
 */
import { describe, expect, test } from "bun:test"
import { Array as Arr, Clock, Effect, Exit, Fiber, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import { BodyTimeout, bounded, LIMIT_MARGIN_MS, NEVER_PROBED, notYet, ready, ReadinessTimeout, testLimitMs, waitFor } from "./readiness.ts"

type Status = "waiting" | "ready" | "timeout" | "cancelled"

/** One command a sequence runs: `probe` advances the clock to the model's next probe. */
type Command = { readonly kind: "publish" } | { readonly kind: "advance"; readonly by: number } | { readonly kind: "probe" } | { readonly kind: "cancel" }

/** The reference model: the clock, the publication, the outcome and what the wait did so far. */
interface Model {
  readonly every: number
  readonly deadline: number
  readonly now: number
  readonly published: boolean
  readonly status: Status
  readonly observedAt: number
  readonly last: string
  readonly probes: number
  readonly finalized: number
  readonly nextProbe: number
}

const unpublishedAt = (now: number) => `unpublished at ${now}`

/** The probe the model runs at `at`: the deadline wins at equality, else it sees the publication or not. */
const probeAt = (model: Model, at: number): Model => {
  if (at >= model.deadline) return { ...model, now: at, status: "timeout", finalized: model.finalized + 1 }
  const probed = { ...model, now: at, probes: model.probes + 1, nextProbe: Math.min(at + model.every, model.deadline) }
  if (model.published) return { ...probed, status: "ready", observedAt: at, finalized: model.finalized + 1 }
  return { ...probed, last: unpublishedAt(at) }
}

/** The model's clock moved to `to`, with every probe due on the way run in order. */
const advanceTo = (model: Model, to: number): Model => {
  if (model.status !== "waiting" || model.nextProbe > to) return { ...model, now: Math.max(model.now, to) }
  return advanceTo(probeAt(model, model.nextProbe), to)
}

/** The model started at time zero: its first probe runs at once. */
const started = (every: number, deadline: number): Model =>
  probeAt({ every, deadline, now: 0, published: false, status: "waiting", observedAt: -1, last: NEVER_PROBED, probes: 0, finalized: 0, nextProbe: 0 }, 0)

/** How far a command moves the clock, read from the model before it runs. */
const stepOf = (model: Model, command: Command) => {
  if (command.kind === "advance") return command.by
  if (command.kind === "probe" && model.status === "waiting") return model.nextProbe - model.now
  return 0
}

const stepModel = (model: Model, command: Command): Model => {
  if (command.kind === "publish") return { ...model, published: true }
  if (command.kind === "cancel" && model.status === "waiting") return { ...model, status: "cancelled", finalized: model.finalized + 1 }
  return advanceTo(model, model.now + stepOf(model, command))
}

/** A seeded generator, so a failing case names its seed and replays. */
const generator = (seed: number) => {
  const state = { value: seed >>> 0 }
  const next = () => {
    state.value = (state.value + 0x6d2b79f5) >>> 0
    const mixed = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value)
    const spread = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((spread ^ (spread >>> 14)) >>> 0) / 4294967296
  }
  return { int: (below: number) => Math.floor(next() * below) }
}

/** A case: the spacing, the deadline and the commands, with advances that land before, on and past the deadline. */
const caseOf = (seed: number) => {
  const random = generator(seed)
  const every = 1 + random.int(4)
  const deadline = random.int(9)
  const commandOf = (): Command => {
    const pick = random.int(8)
    if (pick === 0) return { kind: "publish" }
    if (pick === 1) return { kind: "cancel" }
    if (pick < 5) return { kind: "probe" }
    return { kind: "advance", by: random.int(deadline + 3) }
  }
  return { seed, every, deadline, commands: Arr.makeBy(1 + random.int(12), commandOf) }
}

/** What the wait is at a moment, read the way the model is. */
interface Seen {
  readonly status: Status
  readonly observedAt: number
  readonly last: string
  readonly waitedMs: number
  readonly probes: number
  readonly finalized: number
}

const seenOf = (exit: Option.Option<Exit.Exit<number, ReadinessTimeout>>, probes: number, finalized: number): Seen => {
  const waiting: Seen = { status: "waiting", observedAt: -1, last: "", waitedMs: -1, probes, finalized }
  if (Option.isNone(exit)) return waiting
  if (Exit.isSuccess(exit.value)) return { ...waiting, status: "ready", observedAt: exit.value.value }
  if (Exit.hasInterrupts(exit.value)) return { ...waiting, status: "cancelled" }
  return Option.match(Exit.findErrorOption(exit.value), {
    onNone: () => waiting,
    onSome: (timeout) => ({ ...waiting, status: "timeout", last: timeout.last, waitedMs: timeout.waitedMs }),
  })
}

const expectedOf = (model: Model): Seen => ({
  status: model.status,
  observedAt: model.observedAt,
  last: Option.getOrElse(Option.liftPredicate(model.last, () => model.status === "timeout"), () => ""),
  waitedMs: Option.getOrElse(Option.liftPredicate(model.deadline, () => model.status === "timeout"), () => -1),
  probes: model.probes,
  finalized: model.finalized,
})

/** Lets the forked wait run until it suspends on its next probe's delay. */
const settle = Effect.repeat(Effect.yieldNow, { times: 8 })

const runCase = Effect.fn("ReadinessTest.runCase")(function* (generated: ReturnType<typeof caseOf>) {
  const published = yield* Ref.make(false)
  const probes = yield* Ref.make(0)
  const ends = yield* Ref.make<ReadonlyArray<Exit.Exit<number, ReadinessTimeout>>>([])
  const probe = Effect.gen(function* () {
    yield* Ref.update(probes, (count) => count + 1)
    const now = yield* Clock.currentTimeMillis
    if (yield* Ref.get(published)) return ready(now)
    return notYet(unpublishedAt(now))
  })
  const wait = waitFor("the fake publication", probe, { within: generated.deadline, every: generated.every }).pipe(
    Effect.onExit((exit) => Ref.update(ends, (seen) => [...seen, exit])),
  )
  const fiber = yield* Effect.forkChild(wait)
  yield* settle
  const observe = Effect.gen(function* () {
    const ended = yield* Ref.get(ends)
    return seenOf(Arr.last(ended), yield* Ref.get(probes), ended.length)
  })
  const initial = started(generated.every, generated.deadline)
  expect({ seed: generated.seed, at: "start", ...(yield* observe) }).toEqual({ seed: generated.seed, at: "start", ...expectedOf(initial) })
  const model = yield* Ref.make(initial)
  yield* Effect.forEach(
    generated.commands,
    (command, index) =>
      Effect.gen(function* () {
        const before = yield* Ref.get(model)
        const step = stepOf(before, command)
        if (command.kind === "publish") yield* Ref.set(published, true)
        if (command.kind === "cancel") yield* Fiber.interrupt(fiber)
        if (step > 0) yield* TestClock.adjust(step)
        yield* settle
        const next = stepModel(before, command)
        expect({ seed: generated.seed, at: index, command, ...(yield* observe) }).toEqual({ seed: generated.seed, at: index, command, ...expectedOf(next) })
        yield* Ref.set(model, next)
      }),
    { discard: true },
  )
  yield* Fiber.interrupt(fiber)
  return (yield* Ref.get(model)).status
})

const SEEDS = Arr.makeBy(600, (seed) => seed + 1)

/** Every generated case, each on its own test clock, and the outcomes they reached between them. */
const allCases = Effect.gen(function* () {
  const outcomes = yield* Effect.forEach(SEEDS, (seed) => Effect.scoped(runCase(caseOf(seed))).pipe(Effect.provide(TestClock.layer())), { concurrency: 1 })
  expect(new Set(outcomes)).toEqual(new Set<Status>(["waiting", "ready", "timeout", "cancelled"]))
})

describe("a readiness wait", () => {
  test("agrees with the reference model on every generated sequence of publish, advance, probe and cancel", () => Effect.runPromise(allCases))
})

/** A body that holds a scoped resource, counts its releases, and then runs `end`. */
const scopedBody = (released: Ref.Ref<number>, end: Effect.Effect<string>) =>
  Effect.acquireRelease(Effect.void, () => Ref.update(released, (count) => count + 1)).pipe(Effect.andThen(end))

const BOUNDS = { body: 10, release: 5 }

/** A bounded body run to its end on the test clock: how many times its scope released before the bound, its exit, and the releases in all. */
const boundedRun = Effect.fn("ReadinessTest.boundedRun")(function* (end: Effect.Effect<string>) {
  const released = yield* Ref.make(0)
  const fiber = yield* Effect.forkChild(bounded("the probe body", scopedBody(released, end), BOUNDS))
  yield* settle
  const releasedBefore = yield* Ref.get(released)
  yield* TestClock.adjust(BOUNDS.body)
  const exit = yield* Fiber.await(fiber)
  return { releasedBefore, exit, released: yield* Ref.get(released) }
})

const boundedCases = Effect.gen(function* () {
  const stuck = yield* boundedRun(Effect.never)
  expect({ releasedBefore: stuck.releasedBefore, released: stuck.released, error: Exit.findErrorOption(stuck.exit) }).toEqual({
    releasedBefore: 0,
    released: 1,
    error: Option.some(new BodyTimeout({ label: "the probe body", boundMs: BOUNDS.body })),
  })
  const done = yield* boundedRun(Effect.succeed("done"))
  expect({ released: done.released, exit: done.exit }).toEqual({ released: 1, exit: Exit.succeed("done") })
}).pipe(Effect.provide(TestClock.layer()))

describe("a bounded test body", () => {
  test("is cut at its body bound with BodyTimeout and releases its scope once, and releases it once when it ends in time", () => Effect.runPromise(boundedCases))

  test("gets a Bun limit past its body and its release, so the Effect always ends first", () => {
    expect(testLimitMs({ body: "40 seconds", release: "10 seconds" })).toBe(40_000 + 10_000 + LIMIT_MARGIN_MS)
    expect(LIMIT_MARGIN_MS).toBeGreaterThan(0)
  })
})
