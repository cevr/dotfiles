import { Clock, Context, Duration, Effect, Layer, Option, Random, Scope } from "effect"
import type { TestClock } from "effect/testing"
import * as Model from "../model.ts"
import * as Service from "../service.ts"
import type { PaneLiveness, PaneTarget, RexError, SplitRightInput, WakeLetter } from "../service.ts"
import type { PaneAnchor, PaneWorker, StoreSnapshot } from "../worker.ts"
import type { Boundary, Fault, Injector } from "./faults.ts"
import { applyClose, applySplit, applyWrite, type Break, findPane, PROMPT_SCREENS, render, type ScreenKind, type World, type WorldState } from "./world.ts"

/** Virtual milliseconds a timed-out call takes before it answers, and how much later a late effect lands. */
export const TIMEOUT_MS = 40
export const LATE_LAND_MS = 5

/** Runtime feature detection over the service module, so the same files run at 48b4a22b, fca6400f and 44f5ed09. */
const exported = (name: string): boolean => Object.keys(Service).includes(name)

const untyped = <T>(value: Service.RexCallFailed): T => {
  const widened: ReturnType<typeof JSON.parse> = value
  return widened
}

export const goneError = (operation: string): RexError => {
  const message = `Pane is closed or its process exited (${operation}).`
  if (exported("RexPaneGone")) return new Service.RexPaneGone({ operation, message })
  return new Service.RexCallFailed({ operation, message })
}

const rexError = (fault: Fault, operation: string): RexError => {
  if (fault === "gone") return goneError(operation)
  if (fault === "unavailable") return new Service.RexUnavailable({ message: "Rex server is restarting" })
  if (fault === "unsupported") return unsupportedError()
  return new Service.RexCallFailed({ operation, message: "request timeout" })
}

const storeError = (fault: Fault, worker: Option.Option<PaneWorker>): Service.StoreFailed | Service.StoreConflict => {
  if (fault === "conflict" && exported("StoreConflict")) {
    const revision = Option.getOrElse(Option.flatMap(worker, (w) => Option.fromUndefinedOr(w.revision)), () => 0)
    return new Service.StoreConflict({
      workerId: Option.match(worker, { onNone: () => "", onSome: (w) => w.id }),
      expectedRevision: revision,
      actualRevision: revision + 1,
      message: "simulated concurrent writer",
    })
  }
  return new Service.StoreFailed({ operation: "store", message: `simulated store ${fault}` })
}

const wakeError = (sessionID: string, letter: WakeLetter): Service.WakeFailed => {
  const fields = { sessionID, deliveryId: letter.id, message: "simulated delivery refusal" }
  if (exported("WakeFailed")) return new Service.WakeFailed(fields)
  return untyped(new Service.RexCallFailed({ operation: "notifier.wake", message: fields.message }))
}

/** What a boundary does with each fault: the effect, its typed failure, and whether a late completion lands after the error. */
interface Call<A, E> {
  readonly boundary: Boundary
  readonly detail: string
  readonly apply: Effect.Effect<A, E>
  readonly fail: (fault: Fault) => Effect.Effect<A, E>
  readonly lands: boolean
}

export interface ProcEnv {
  readonly world: World
  readonly injector: Injector
  readonly clock: TestClock.TestClock
  readonly worldScope: Scope.Scope
  readonly proc: number
}

const sleepVirtual = (env: ProcEnv, ms: number) => env.clock.sleep(Duration.millis(ms))

/**
 * Routes one service call through the fault injector. A dead process never acts again; a crash kills the
 * process before the effect; a late completion answers with a timeout and lands the effect afterwards.
 */
export const guarded = <A, E>(env: ProcEnv, call: Call<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    if (!(yield* env.world.procAlive(env.proc))) return yield* Effect.never
    const record = yield* env.injector.decide(call.boundary, env.proc, call.detail)
    if (!(yield* env.world.procAlive(env.proc))) return yield* Effect.never
    if (record.fault === "ok") return yield* call.apply
    if (record.fault === "crash") {
      yield* env.world.kill(env.proc)
      return yield* Effect.never
    }
    if (record.fault === "defect") return yield* Effect.die(`sim: defect injected at ${call.boundary} #${record.nth}`)
    if (record.fault === "hang") return yield* Effect.never
    if (record.fault === "timeout" || record.fault === "late") {
      yield* sleepVirtual(env, TIMEOUT_MS)
      if (record.fault === "late" && !call.lands) return yield* call.apply
      if (record.fault === "late") {
        yield* Effect.forkIn(Effect.ignore(Effect.andThen(sleepVirtual(env, LATE_LAND_MS), call.apply)), env.worldScope)
      }
      if (!(yield* env.world.procAlive(env.proc))) return yield* Effect.never
      return yield* call.fail("transient")
    }
    return yield* call.fail(record.fault)
  })

const broken = (state: WorldState, name: Break): boolean => state.config.breaks.includes(name)

const LATE_MS = 1_000
const READY: ScreenKind = "ready"

const livePane = (state: WorldState, target: PaneTarget) =>
  Option.filter(findPane(state, target.blockId), (pane) => pane.alive && !pane.closed && pane.sessionId === target.sessionId && !broken(state, "gone-when-alive")).pipe(
    Option.map((pane) => {
      if (broken(state, "ready-over-prompt") && PROMPT_SCREENS.includes(pane.screen)) return { ...pane, screen: READY }
      return pane
    }),
  )

/** A broken store that never answers once the run is late (only for the non-vacuity checks). */
const lateHang = (env: ProcEnv) =>
  Effect.flatMap(env.world.get, (state) => {
    if (broken(state, "hang-late-reads") && state.now >= LATE_MS) return Effect.never
    return Effect.void
  })

const screenDetail = (env: ProcEnv, target: PaneTarget) =>
  Effect.map(env.world.get, (state) =>
    Option.match(findPane(state, target.blockId), { onNone: () => `${target.blockId}:none`, onSome: (pane) => `${target.blockId}:${pane.screen}` }),
  )

const requireLive = (env: ProcEnv, target: PaneTarget, operation: string) =>
  Effect.flatMap(env.world.get, (state) =>
    Option.match(livePane(state, target), { onNone: () => Effect.fail(goneError(operation)), onSome: Effect.succeed }),
  )

const unsupportedError = () =>
  new Service.RexUnsupportedRevision({
    requiredRevision: 18,
    serverRevision: Option.some(19),
    message: Service.formatUnsupportedRevision(18, Option.some(19)),
  })

/** Liveness as each head speaks it: a three-way answer since fca6400f, a boolean (or a typed failure) at 48b4a22b. */
const livenessAnswer = (alive: Option.Option<boolean>): Effect.Effect<PaneLiveness, Service.RexUnsupportedRevision> => {
  if (exported("RexPaneGone")) {
    return Effect.succeed(Option.match(alive, { onNone: () => "unknown", onSome: (value): PaneLiveness => (value && "alive") || "gone" }))
  }
  return Option.match(alive, {
    onNone: () => Effect.fail(untyped<Service.RexUnsupportedRevision>(new Service.RexCallFailed({ operation: "blocks.alive", message: "request timeout" }))),
    onSome: (value) => {
      const flag: ReturnType<typeof JSON.parse> = value
      return Effect.succeed(flag)
    },
  })
}

const aliveFault = (env: ProcEnv, target: PaneTarget): Effect.Effect<PaneLiveness, Service.RexUnsupportedRevision> =>
  Effect.flatMap(screenDetail(env, target), (detail) =>
    guarded(env, {
      boundary: "pane.alive",
      detail,
      apply: Effect.flatMap(env.world.get, (state) => livenessAnswer(Option.some(Option.isSome(livePane(state, target))))),
      fail: (fault) => {
        if (fault === "unsupported") return Effect.fail(unsupportedError())
        if (fault === "gone") return livenessAnswer(Option.some(false))
        return livenessAnswer(Option.none())
      },
      lands: false,
    }),
  )

const rexLayer = (env: ProcEnv) =>
  Layer.succeed(
    Service.RexClient,
    Service.RexClient.of({
      splitRight: (input: SplitRightInput) =>
        guarded(env, {
          boundary: "pane.split",
          detail: input.label,
          apply: env.world.modify((state) => applySplit(state, input, env.proc)),
          fail: (fault) => Effect.fail(rexError(fault, "blocks.splitBeside")),
          lands: true,
        }),
      write: (target, data) =>
        Effect.flatMap(screenDetail(env, target), (detail) =>
          guarded(env, {
            boundary: "pane.write",
            detail,
            apply: Effect.andThen(requireLive(env, target, "terminals.write"), env.world.update((state) => applyWrite(state, target.blockId, data, env.proc))),
            fail: (fault) => Effect.fail(rexError(fault, "terminals.write")),
            lands: true,
          })),
      read: (target) =>
        Effect.flatMap(screenDetail(env, target), (detail) =>
          guarded(env, {
            boundary: "pane.read",
            detail,
            apply: Effect.map(requireLive(env, target, "terminals.read"), render),
            fail: (fault) => Effect.fail(rexError(fault, "terminals.read")),
            lands: false,
          })),
      readTail: (target, maxBytes = 4000) =>
        Effect.flatMap(screenDetail(env, target), (detail) =>
          guarded(env, {
            boundary: "pane.readTail",
            detail,
            apply: Effect.map(requireLive(env, target, "terminals.readTail"), (pane) => render(pane).slice(-maxBytes)),
            fail: (fault) => Effect.fail(rexError(fault, "terminals.readTail")),
            lands: false,
          })),
      waitForQuiet: (target, options) =>
        Effect.flatMap(screenDetail(env, target), (detail) =>
          guarded(env, {
            boundary: "pane.waitForQuiet",
            detail,
            apply: Effect.andThen(
              requireLive(env, target, "terminals.waitForQuiet"),
              env.clock.sleep(Duration.min(Duration.fromInputUnsafe(options.quietFor), Duration.fromInputUnsafe(options.timeout))),
            ),
            fail: (fault) => Effect.fail(rexError(fault, "terminals.waitForQuiet")),
            lands: false,
          })),
      waitForOutput: (target, options) =>
        Effect.flatMap(screenDetail(env, target), (detail) =>
          guarded(env, {
            boundary: "pane.read",
            detail,
            apply: Effect.map(requireLive(env, target, "terminals.waitForOutput"), (pane) => options.pattern.test(render(pane))),
            fail: (fault) => Effect.fail(rexError(fault, "terminals.waitForOutput")),
            lands: false,
          })),
      alive: (target) => aliveFault(env, target),
      close: (target) =>
        Effect.flatMap(screenDetail(env, target), (detail) =>
          guarded(env, {
            boundary: "pane.close",
            detail,
            apply: env.world.update((state) => applyClose(state, target.blockId, env.proc)),
            fail: (fault) => Effect.fail(rexError(fault, "blocks.close")),
            lands: true,
          })),
    }),
  )

/** A broken store that loses the worker's options (only for the non-vacuity checks). */
const droppedOptions = (state: WorldState, worker: PaneWorker): PaneWorker => {
  if (!broken(state, "drop-options")) return worker
  return { ...worker, skipPermissions: worker.skipPermissions === false, addDirs: [] }
}

const upsert = (state: WorldState, given: PaneWorker, expected: Option.Option<number>, proc: number) => {
  const worker = droppedOptions(state, given)
  const existing = Option.fromUndefinedOr(state.store.workers.find((w) => w.id === worker.id))
  const actual = Option.getOrElse(Option.flatMap(existing, (w) => Option.fromUndefinedOr(w.revision)), () => 0)
  if ((Option.isSome(expected) && expected.value !== actual) || (broken(state, "refuse-late-writes") && state.now >= LATE_MS)) {
    const conflict: Option.Option<number> = Option.some(actual)
    return [conflict, state] as const
  }
  const stamped: PaneWorker = { ...worker, revision: actual + 1 }
  const store: StoreSnapshot = { ...state.store, workers: [...state.store.workers.filter((w) => w.id !== worker.id), stamped] }
  const next: WorldState = { ...state, store, storeWrites: [...state.storeWrites, { at: state.now, proc, worker: stamped }] }
  return [Option.none<number>(), next] as const
}

const storeLayer = (env: ProcEnv) =>
  Layer.succeed(
    Service.WorkerStore,
    Service.WorkerStore.of({
      read: () =>
        guarded(env, {
          boundary: "store.read",
          detail: "read",
          apply: Effect.andThen(lateHang(env), Effect.map(env.world.get, (state) => state.store)),
          fail: (fault) => Effect.fail(new Service.StoreFailed({ operation: "read", message: `simulated store ${fault}` })),
          lands: false,
        }),
      write: (snapshot) =>
        guarded(env, {
          boundary: "store.write",
          detail: "write",
          apply: env.world.update((state) => ({
            ...state,
            store: snapshot,
            storeWrites: [...state.storeWrites, ...snapshot.workers.map((worker) => ({ at: state.now, proc: env.proc, worker }))],
          })),
          fail: (fault) => Effect.fail(new Service.StoreFailed({ operation: "write", message: `simulated store ${fault}` })),
          lands: true,
        }),
      upsertWorker: (worker, expectedRevision) =>
        guarded(env, {
          boundary: "store.write",
          detail: `upsert:${worker.id}:${worker.state}`,
          apply: Effect.flatMap(Effect.andThen(lateHang(env), env.world.modify((state) => upsert(state, worker, Option.fromUndefinedOr(expectedRevision), env.proc))), (conflict) =>
            Option.match(conflict, {
              onNone: () => Effect.map(env.world.get, (state) => state.store),
              onSome: (actual) =>
                Effect.fail(
                  storeErrorFor(worker, Option.getOrElse(Option.fromUndefinedOr(expectedRevision), () => 0), actual),
                ),
            })),
          fail: (fault) => Effect.fail(storeError(fault, Option.some(worker))),
          lands: true,
        }),
      saveAnchor: (sessionID: string, anchor: PaneAnchor) =>
        guarded(env, {
          boundary: "store.write",
          detail: `anchor:${sessionID}`,
          apply: Effect.andThen(
            env.world.update((state) => ({ ...state, store: { ...state.store, anchors: { ...state.store.anchors, [sessionID]: anchor } } })),
            Effect.map(env.world.get, (state) => state.store),
          ),
          fail: (fault) => Effect.fail(new Service.StoreFailed({ operation: "saveAnchor", message: `simulated store ${fault}` })),
          lands: true,
        }),
    }),
  )

const storeErrorFor = (worker: PaneWorker, expectedRevision: number, actualRevision: number): Service.StoreFailed | Service.StoreConflict => {
  if (exported("StoreConflict")) {
    return new Service.StoreConflict({
      workerId: worker.id,
      expectedRevision,
      actualRevision,
      message: `Stale write rejected for worker ${worker.id}: expected revision ${expectedRevision}, found ${actualRevision}.`,
    })
  }
  return new Service.StoreFailed({ operation: "upsertWorker", message: "stale revision" })
}

const resultsLayer = (env: ProcEnv) =>
  Layer.succeed(
    Service.ResultFiles,
    Service.ResultFiles.of({
      readComplete: (path, minMtimeMs) =>
        guarded(env, {
          boundary: "results.read",
          detail: path,
          apply: Effect.map(env.world.get, (state) =>
            Option.flatMap(Option.fromUndefinedOr(state.files.get(path)), (entry) => {
              if (entry.mtimeMs < minMtimeMs || entry.content.trim().length === 0) return Option.none<string>()
              return Option.some(entry.content.trim())
            }),
          ),
          fail: () => Effect.fail(new Service.ResultReadFailed({ path, message: "simulated read failure" })),
          lands: false,
        }),
    }),
  )

const notifierLayer = (env: ProcEnv) =>
  Layer.succeed(
    Service.Notifier,
    Service.Notifier.of({
      wake: (sessionID, letter) =>
        guarded(env, {
          boundary: "notifier.wake",
          detail: `${letter.id}`,
          apply: env.world.update((state) => {
            if (broken(state, "drop-done-wakes") && letter.metadata["state"] === "done") return state
            return { ...state, wakes: [...state.wakes, { at: state.now, proc: env.proc, sessionID, letter }] }
          }),
          fail: () => Effect.fail(wakeError(sessionID, letter)),
          lands: true,
        }),
      changed: (sessionID) =>
        guarded(env, {
          boundary: "notifier.changed",
          detail: sessionID,
          apply: Effect.void,
          fail: () => Effect.die("sim: this boundary has no typed failure"),
          lands: false,
        }),
      sessionDirectory: () => Effect.succeed(Option.some("/sim/repo")),
    }),
  )

/** The process's clock: virtual time, its sleeps routed through the injector as the timer boundary. */
export const procClock = (env: ProcEnv): Clock.Clock => ({
  currentTimeMillisUnsafe: () => env.clock.currentTimeMillisUnsafe(),
  currentTimeMillis: env.clock.currentTimeMillis,
  currentTimeNanosUnsafe: () => env.clock.currentTimeNanosUnsafe(),
  currentTimeNanos: env.clock.currentTimeNanos,
  monotonicTimeNanosUnsafe: () => env.clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: env.clock.monotonicTimeNanos,
  sleep: (duration) =>
    guarded(env, {
      boundary: "timer.sleep",
      detail: `${Duration.toMillis(duration)}ms`,
      apply: env.clock.sleep(duration),
      fail: () => Effect.die("sim: this boundary has no typed failure"),
      lands: false,
    }),
})

/** The world doubles for every service tag PaneAgentModel uses, for one process. */
export const servicesLayer = (env: ProcEnv) =>
  Layer.mergeAll(rexLayer(env), storeLayer(env), resultsLayer(env), notifierLayer(env), Layer.succeed(Clock.Clock, procClock(env)))

/**
 * The shell's deadlines (pane-agent-shell-design, "All deadlines are configurable in ModelConfig"), tight for
 * virtual time. The old heads have no such keys and ignore them; the tool-call bounds the invariants hold
 * (SPEC v2: B derived from the deadlines) are computed from these same numbers.
 */
export const DEADLINES_MS = {
  storeDeadline: 100,
  tailDeadline: 50,
  askDeadline: 200,
  readDeadline: 100,
  writeDeadline: 100,
  splitDeadline: 150,
  closeDeadline: 100,
  wakeDeadline: 100,
  changedDeadline: 50,
} as const

const shellDeadlines = {
  storeDeadline: Duration.millis(DEADLINES_MS.storeDeadline),
  tailDeadline: Duration.millis(DEADLINES_MS.tailDeadline),
  askDeadline: Duration.millis(DEADLINES_MS.askDeadline),
  readDeadline: Duration.millis(DEADLINES_MS.readDeadline),
  writeDeadline: Duration.millis(DEADLINES_MS.writeDeadline),
  splitDeadline: Duration.millis(DEADLINES_MS.splitDeadline),
  closeDeadline: Duration.millis(DEADLINES_MS.closeDeadline),
  wakeDeadline: Duration.millis(DEADLINES_MS.wakeDeadline),
  changedDeadline: Duration.millis(DEADLINES_MS.changedDeadline),
}

export const FAST: Model.ModelConfig = {
  quietFor: Duration.millis(5),
  pollTimeout: Duration.millis(15),
  pasteQuiet: Duration.zero,
  retryDelay: Duration.millis(5),
  maxStartupChecks: 5,
  maxTransientErrors: 4,
  ...shellDeadlines,
}

export interface Proc {
  readonly id: number
  readonly scope: Scope.Closeable
  readonly model: Model.PaneAgentModel["Service"]
  readonly clock: Clock.Clock
  readonly random: Random.Random
}

/** Builds PaneAgentModel on the doubles in a fresh scope: one OpenCode server process on the shared world. */
export const spawnProc = Effect.fn("Sim.spawnProc")(function* (env: ProcEnv, seed: number, config: Model.ModelConfig) {
  const scope = yield* Scope.make()
  const random = yield* Random.withSeed(
    Effect.withFiber((fiber) => Effect.succeed(fiber.getRef(Random.Random))),
    `${seed}-${env.proc}`,
  )
  const clock = procClock(env)
  const built = yield* Layer.buildWithScope(Model.layer(config).pipe(Layer.provide(servicesLayer(env))), scope).pipe(
    Effect.provideService(Random.Random, random),
    Effect.provideService(Clock.Clock, clock),
  )
  const proc: Proc = { id: env.proc, scope, model: Context.get(built, Model.PaneAgentModel), clock, random }
  return proc
})
