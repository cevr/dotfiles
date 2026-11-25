import { Cause, Clock, Data, Deferred, Effect, Exit, Option, Predicate, Random, Ref, Scope } from "effect"
import { TestClock } from "effect/testing"
import type * as Model from "../model.ts"
import type { PaneWorker } from "../worker.ts"
import { FAST, type Proc, type ProcEnv, spawnProc } from "./doubles.ts"
import { type EffectRecord, type Gate, type Injector, makeGate, makeInjector, type PlannedFault, type RandomFaults } from "./faults.ts"
import { ANCHOR, applyEvent, DEFAULT_WORLD, findPane, makeWorld, OWNER_BLOCK, PROMPT_SCREENS, type ScreenKind, tick, type World, type WorldConfig, WorldEvent, type WorldState } from "./world.ts"

export const SESSION = "ses_sim"
export const DIRECTORY = "/sim/repo"
export const TICK_MS = 5

/** A tool call a caller issues, from the first server (proc 1) or a second one on the same store (proc 2). */
export type Command = Data.TaggedEnum<{
  Start: { readonly worker: string; readonly token: string; readonly proc: number; readonly skipPermissions: Option.Option<boolean>; readonly named: boolean }
  FollowUp: { readonly worker: string; readonly token: string; readonly proc: number; readonly steer: boolean; readonly ownFile: boolean }
  Status: { readonly worker: string; readonly proc: number }
  Stop: { readonly worker: string; readonly proc: number; readonly close: boolean }
  Restart: { readonly worker: string; readonly token: string; readonly proc: number }
  Reattach: { readonly proc: number }
  Spawn: { readonly proc: number }
}>
export const Command = Data.taggedEnum<Command>()

/** What else a script does: let time pass, act on the world as the owner, plan faults, crash a server, gate an await point. */
export type Action = Data.TaggedEnum<{
  Wait: { readonly ms: number }
  WaitScreen: { readonly worker: string; readonly screen: ScreenKind; readonly ms: number }
  World: { readonly event: WorldEvent }
  Faults: { readonly faults: ReadonlyArray<PlannedFault> }
  Crash: { readonly proc: number }
  GateNext: { readonly boundary: EffectRecord["boundary"]; readonly detail: Option.Option<string>; readonly commands: ReadonlyArray<Command> }
}>
export const Action = Data.taggedEnum<Action>()

export type Step = Command | Action

export type CommandName = "start" | "follow_up" | "steer" | "status" | "stop" | "stop_close" | "restart" | "reattach"

export type Outcome = "success" | "failure" | "defect" | "hang" | "killed" | "skipped"

/** One tool call as the caller saw it: when it began, whether and how it answered within the bound. */
export interface ToolCall {
  readonly id: number
  readonly proc: number
  readonly command: CommandName
  readonly worker: string
  readonly token: Option.Option<string>
  readonly startedAt: number
  readonly endedAt: Option.Option<number>
  readonly outcome: Outcome
  readonly error: string
  readonly reply: ReadonlyArray<PaneWorker>
  readonly probe: boolean
  readonly skipPermissions: boolean
}

export interface GateAt {
  readonly index: number
  readonly commands: ReadonlyArray<Command>
}

export interface SimConfig {
  readonly seed: number
  readonly name: string
  readonly world: WorldConfig
  readonly model: Model.ModelConfig
  readonly boundMs: number
  readonly quiesceMs: number
  readonly random: Option.Option<RandomFaults>
  readonly crashAt: Option.Option<number>
  readonly faults: ReadonlyArray<PlannedFault>
  readonly probe: boolean
  readonly gateAt: Option.Option<GateAt>
}

export const defaultConfig = (name: string, seed: number): SimConfig => ({
  seed,
  name,
  world: DEFAULT_WORLD,
  model: FAST,
  boundMs: 400,
  quiesceMs: 1_500,
  random: Option.none(),
  crashAt: Option.none(),
  faults: [],
  probe: true,
  gateAt: Option.none(),
})

/** Everything a run leaves: the calls, the final world (with its logs) and the injector's record. */
export interface Trace {
  readonly name: string
  readonly seed: number
  readonly calls: ReadonlyArray<ToolCall>
  readonly world: WorldState
  readonly effects: ReadonlyArray<EffectRecord>
  /** How many effects the script's own steps recorded (await points end here; the probe and final status come after). */
  readonly scriptEffects: number
  readonly fired: ReadonlyArray<PlannedFault>
  readonly coverage: ReadonlyMap<string, number>
  readonly boundMs: number
  readonly workerIds: ReadonlyMap<string, string>
  readonly restarts: number
}

type CallExit = Exit.Exit<ReadonlyArray<PaneWorker>, unknown>

interface Open {
  readonly call: ToolCall
  readonly exit: Ref.Ref<Option.Option<CallExit>>
}

interface ArmedGate {
  readonly gate: Gate
  readonly commands: ReadonlyArray<Command>
  readonly releaseAt: Option.Option<number>
}

interface Runner {
  readonly world: World
  readonly injector: Injector
  readonly clock: TestClock.TestClock
  readonly worldScope: Scope.Scope
  readonly config: SimConfig
  readonly procs: Ref.Ref<ReadonlyMap<number, Proc>>
  readonly open: Ref.Ref<ReadonlyArray<Open>>
  readonly calls: Ref.Ref<ReadonlyArray<ToolCall>>
  readonly ids: Ref.Ref<ReadonlyMap<string, string>>
  readonly nextCall: Ref.Ref<number>
  readonly nextProc: Ref.Ref<number>
  readonly restarts: Ref.Ref<number>
  readonly gate: Ref.Ref<Option.Option<ArmedGate>>
}

const errorTag = (cause: Cause.Cause<unknown>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "",
    onSome: (error) => {
      if (Predicate.hasProperty(error, "_tag")) return String(error._tag)
      return "untyped"
    },
  })

const outcomeOf = (exit: CallExit): readonly [Outcome, string, ReadonlyArray<PaneWorker>] =>
  Exit.match(exit, {
    onSuccess: (reply) => ["success", "", reply],
    onFailure: (cause) => {
      if (Cause.hasInterruptsOnly(cause)) return ["killed", "interrupted", []]
      const tag = errorTag(cause)
      if (tag.length > 0) return ["failure", tag, []]
      return ["defect", Cause.pretty(cause).split("\n")[0] ?? "defect", []]
    },
  })

const now = (r: Runner) => Effect.map(r.world.get, (s) => s.now)

const envOf = (r: Runner, proc: number): ProcEnv => ({ world: r.world, injector: r.injector, clock: r.clock, worldScope: r.worldScope, proc })

const spawn = Effect.fn("Sim.spawn")(function* (r: Runner, slot: number) {
  const id = yield* Ref.getAndUpdate(r.nextProc, (n) => n + 1)
  const proc = yield* spawnProc(envOf(r, id), r.config.seed, r.config.model)
  yield* Ref.update(r.procs, (prev) => new Map([...prev, [slot, proc]]))
  return proc
})

interface CallSpec {
  readonly slot: number
  readonly command: CommandName
  readonly worker: string
  readonly token: Option.Option<string>
  readonly probe: boolean
  readonly skipPermissions: boolean
  readonly run: (model: Proc["model"]) => Effect.Effect<ReadonlyArray<PaneWorker>, unknown>
}

const spec = (slot: number, command: CommandName, worker: string, token: Option.Option<string>, run: CallSpec["run"]): CallSpec => ({
  slot,
  command,
  worker,
  token,
  probe: false,
  skipPermissions: true,
  run,
})

/** Forks one tool call into its process's scope, so a crash of the process ends it with the process. */
const issue = Effect.fn("Sim.issue")(function* (r: Runner, call: CallSpec) {
  const proc = Option.fromUndefinedOr((yield* Ref.get(r.procs)).get(call.slot))
  const base: ToolCall = {
    id: yield* Ref.getAndUpdate(r.nextCall, (n) => n + 1),
    proc: Option.match(proc, { onNone: () => -1, onSome: (p) => p.id }),
    command: call.command,
    worker: call.worker,
    token: call.token,
    startedAt: yield* now(r),
    endedAt: Option.none(),
    outcome: "skipped",
    error: "",
    reply: [],
    probe: call.probe,
    skipPermissions: call.skipPermissions,
  }
  if (Option.isNone(proc)) return yield* Ref.update(r.calls, (prev) => [...prev, base])
  const exit = yield* Ref.make<Option.Option<CallExit>>(Option.none())
  const body = call.run(proc.value.model).pipe(
    Effect.provideService(Clock.Clock, proc.value.clock),
    Effect.provideService(Random.Random, proc.value.random),
    Effect.exit,
    Effect.flatMap((e) => Ref.set(exit, Option.some(e))),
  )
  yield* Effect.forkIn(body, proc.value.scope)
  yield* Ref.update(r.open, (prev) => [...prev, { call: base, exit }])
})

const closed = (r: Runner, item: Open, at: number, alive: ReadonlySet<number>) =>
  Effect.gen(function* () {
    const exit = yield* Ref.get(item.exit)
    if (Option.isSome(exit)) {
      const [outcome, error, reply] = outcomeOf(exit.value)
      return Option.some<ToolCall>({ ...item.call, endedAt: Option.some(at), outcome, error, reply })
    }
    if (!alive.has(item.call.proc) || !(yield* r.world.procAlive(item.call.proc))) return Option.some<ToolCall>({ ...item.call, outcome: "killed", error: "process crashed" })
    if (at - item.call.startedAt > r.config.boundMs) return Option.some<ToolCall>({ ...item.call, outcome: "hang", error: `no answer within ${r.config.boundMs} ms` })
    return Option.none<ToolCall>()
  })

const settleOpen = Effect.fn("Sim.settleOpen")(function* (r: Runner) {
  const open = yield* Ref.get(r.open)
  const at = yield* now(r)
  const alive = new Set([...(yield* Ref.get(r.procs)).values()].map((p) => p.id))
  const keep: Array<Open> = []
  for (const item of open) {
    const done = yield* closed(r, item, at, alive)
    if (Option.isSome(done)) yield* Ref.update(r.calls, (prev) => [...prev, done.value])
    else keep.push(item)
  }
  yield* Ref.set(r.open, keep)
})

/** Recovers every crashed process: closes its scope, starts a fresh one on the same world, re-attaches. */
function recover(r: Runner): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const [slot, proc] of yield* Ref.get(r.procs)) {
      if (yield* r.world.procAlive(proc.id)) continue
      yield* settleOpen(r)
      yield* Effect.forkIn(Scope.close(proc.scope, Exit.void), r.worldScope)
      yield* Ref.update(r.restarts, (n) => n + 1)
      const fresh = yield* spawn(r, slot)
      const start = yield* r.injector.decide("process.start", fresh.id, "plugin load")
      if (start.fault === "crash") {
        yield* r.world.kill(fresh.id)
        return yield* recover(r)
      }
      if (start.fault === "late") yield* advance(r, 50)
      yield* issue(r, spec(slot, "reattach", "*", Option.none(), (model) => model.reattach(DIRECTORY)))
    }
  })
}

/** Commands injected at one await point (effect index) of the run: the call there waits until they are issued. */
const serviceGate = Effect.fn("Sim.serviceGate")(function* (r: Runner) {
  const armed = yield* Ref.get(r.gate)
  if (Option.isNone(armed)) return
  const { gate, commands, releaseAt } = armed.value
  const at = yield* now(r)
  if (Option.exists(releaseAt, (release) => at >= release)) {
    yield* Ref.set(r.gate, Option.none())
    yield* Deferred.succeed(gate.release, true)
    return
  }
  if (Option.isSome(releaseAt) || !(yield* Deferred.isDone(gate.hit))) return
  yield* Ref.set(r.gate, Option.some({ gate, commands, releaseAt: Option.some(at + 2 * TICK_MS) }))
  for (const command of commands) yield* runStep(r, command, false)
})

/** One scheduler step: the world's agents move, virtual time advances by a tick, fibers run to suspension. */
function stepOnce(r: Runner): Effect.Effect<void> {
  return Effect.gen(function* () {
    const at = r.clock.currentTimeMillisUnsafe() + TICK_MS
    yield* r.world.update((state) => tick(state, at))
    yield* r.clock.adjust(TICK_MS)
    yield* Effect.yieldNow
    yield* Effect.yieldNow
    yield* settleOpen(r)
    yield* recover(r)
    yield* serviceGate(r)
  })
}

function advance(r: Runner, ms: number): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let t = 0; t < ms; t += TICK_MS) yield* stepOnce(r)
  })
}

const awaitOpen = Effect.fn("Sim.awaitOpen")(function* (r: Runner) {
  for (let guard = 0; guard < 10_000; guard++) {
    yield* settleOpen(r)
    if ((yield* Ref.get(r.open)).length === 0) return
    yield* stepOnce(r)
  }
})

const idOf = (r: Runner, worker: string) => Effect.map(Ref.get(r.ids), (ids) => Option.fromUndefinedOr(ids.get(worker)))

const promptOf = (token: string) => `Do the simulated task ${token} and report what you found.`

const resultFileOf = (worker: string, token: string, own: boolean) => {
  if (own) return `/sim/run/${worker}-file${token.replace(/\D/g, "")}.md`
  return `/sim/run/${worker}.md`
}

const onWorker = Effect.fn("Sim.onWorker")(function* (
  r: Runner,
  call: Omit<CallSpec, "run" | "probe" | "skipPermissions">,
  run: (model: Proc["model"], id: string) => Effect.Effect<PaneWorker, unknown>,
) {
  const id = yield* idOf(r, call.worker)
  if (Option.isNone(id)) return yield* issue(r, spec(-1, call.command, call.worker, call.token, () => Effect.succeed([])))
  yield* issue(r, spec(call.slot, call.command, call.worker, call.token, (model) => Effect.map(run(model, id.value), (w) => [w])))
})

const startInput = (step: Data.TaggedEnum.Value<Command, "Start">): Model.StartInput => {
  const base: Model.StartInput = {
    parentSessionID: SESSION,
    directory: DIRECTORY,
    harness: "agy",
    description: `sim worker ${step.worker}`,
    prompt: promptOf(step.token),
    resultFile: resultFileOf(step.worker, step.token, false),
    addDirs: ["/sim/extra"],
  }
  const withSkip = Option.match(step.skipPermissions, { onNone: () => base, onSome: (skipPermissions) => ({ ...base, skipPermissions }) })
  if (step.named) return { ...withSkip, blockId: OWNER_BLOCK, rexSession: ANCHOR.session }
  return withSkip
}

const startCall = Effect.fn("Sim.startCall")(function* (r: Runner, step: Data.TaggedEnum.Value<Command, "Start">) {
  const input = startInput(step)
  const call: CallSpec = {
    ...spec(step.proc, "start", step.worker, Option.some(step.token), (model) => Effect.map(model.start(input), (w) => [w])),
    skipPermissions: Option.getOrElse(step.skipPermissions, () => true),
  }
  yield* issue(r, call)
  yield* awaitOpen(r)
  const mine = Option.fromUndefinedOr((yield* Ref.get(r.calls)).findLast((done) => done.command === "start" && done.worker === step.worker))
  const reply = Option.flatMap(mine, (done) => Option.fromUndefinedOr(done.reply[0]))
  if (Option.isSome(reply)) yield* Ref.update(r.ids, (prev) => new Map([...prev, [step.worker, reply.value.id]]))
})

const followUpCall = (r: Runner, step: Data.TaggedEnum.Value<Command, "FollowUp">) => {
  const base = { parentSessionID: SESSION, prompt: promptOf(step.token), steer: step.steer }
  return onWorker(r, { slot: step.proc, command: commandNameOf(step.steer, "steer", "follow_up"), worker: step.worker, token: Option.some(step.token) }, (model, id) => {
    if (step.ownFile) return model.followUp({ ...base, id, resultFile: resultFileOf(step.worker, step.token, true) })
    return model.followUp({ ...base, id })
  })
}

const commandNameOf = (flag: boolean, whenTrue: CommandName, whenFalse: CommandName): CommandName => {
  if (flag) return whenTrue
  return whenFalse
}

const stopCall = (r: Runner, step: Data.TaggedEnum.Value<Command, "Stop">) =>
  onWorker(r, { slot: step.proc, command: commandNameOf(step.close, "stop_close", "stop"), worker: step.worker, token: Option.none() }, (model, id) =>
    model.stop({ parentSessionID: SESSION, id, close: step.close }),
  )

const commandCall = (r: Runner, step: Command): Effect.Effect<void> =>
  Command.$match(step, {
    Start: (s) => startCall(r, s),
    FollowUp: (s) => followUpCall(r, s),
    Status: (s) => onWorker(r, { slot: s.proc, command: "status", worker: s.worker, token: Option.none() }, (model, id) => model.status(SESSION, id)),
    Stop: (s) => stopCall(r, s),
    Restart: (s) =>
      onWorker(r, { slot: s.proc, command: "restart", worker: s.worker, token: Option.some(s.token) }, (model, id) =>
        model.restart({ parentSessionID: SESSION, id, prompt: promptOf(s.token) }),
      ),
    Reattach: (s) => issue(r, spec(s.proc, "reattach", "*", Option.none(), (model) => model.reattach(DIRECTORY))),
    Spawn: (s) => Effect.asVoid(spawn(r, s.proc)),
  })

const actionRun = (r: Runner, step: Action): Effect.Effect<void> =>
  Action.$match(step, {
    Wait: (s) => advance(r, s.ms),
    WaitScreen: (s) => waitScreen(r, s),
    World: (s) => r.world.update((state) => applyEvent(state, s.event)),
    Faults: (s) => r.injector.planNext(s.faults),
    Crash: (s) => crashNow(r, s.proc),
    GateNext: (s) => gated(r, s),
  })

const isCommand = (step: Step): step is Command => ["Start", "FollowUp", "Status", "Stop", "Restart", "Reattach", "Spawn"].includes(step._tag)

function runStep(r: Runner, step: Step, wait: boolean): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!isCommand(step)) return yield* actionRun(r, step)
    yield* commandCall(r, step)
    if (wait) yield* awaitOpen(r)
  })
}

const crashNow = Effect.fn("Sim.crashNow")(function* (r: Runner, slot: number) {
  const proc = Option.fromUndefinedOr((yield* Ref.get(r.procs)).get(slot))
  if (Option.isSome(proc)) yield* r.world.kill(proc.value.id)
  yield* recover(r)
})

export const blockOf = (state: WorldState, id: Option.Option<string>): Option.Option<string> =>
  Option.flatMap(id, (wid) => Option.map(Option.fromUndefinedOr(state.store.workers.find((w) => w.id === wid)), (w) => w.blockId))

const waitScreen = Effect.fn("Sim.waitScreen")(function* (r: Runner, step: Data.TaggedEnum.Value<Action, "WaitScreen">) {
  for (let t = 0; t < step.ms; t += TICK_MS) {
    const state = yield* r.world.get
    const block = blockOf(state, yield* idOf(r, step.worker))
    if (Option.exists(Option.flatMap(block, (b) => findPane(state, b)), (pane) => pane.screen === step.screen)) return
    yield* stepOnce(r)
  }
})

/** Holds the next matching boundary call, issues the commands at that await point, then releases the call. */
const gated = Effect.fn("Sim.gated")(function* (r: Runner, step: Data.TaggedEnum.Value<Action, "GateNext">) {
  const gate: Gate = yield* makeGate(Option.none(), Option.some(step.boundary), step.detail)
  yield* r.injector.setGate(Option.some(gate))
  for (let t = 0; t < r.config.boundMs && !(yield* Deferred.isDone(gate.hit)); t += TICK_MS) yield* stepOnce(r)
  yield* r.injector.setGate(Option.none())
  if (!(yield* Deferred.isDone(gate.hit))) return
  for (const command of step.commands) yield* runStep(r, command, false)
  yield* advance(r, 2 * TICK_MS)
  yield* Deferred.succeed(gate.release, true)
  yield* awaitOpen(r)
})

const probeAll = Effect.fn("Sim.probeAll")(function* (r: Runner) {
  for (const [worker, id] of yield* Ref.get(r.ids)) {
    const state = yield* r.world.get
    const row = Option.fromUndefinedOr(state.store.workers.find((w) => w.id === id))
    const live = Option.exists(Option.flatMap(row, (w) => findPane(state, w.blockId)), (pane) => pane.alive && !pane.closed && !PROMPT_SCREENS.includes(pane.screen))
    if (!live || !Option.exists(row, (w) => w.state === "done")) continue
    const token = `TK-probe${worker}-1`
    const call = spec(1, "follow_up", worker, Option.some(token), (model) => Effect.map(model.followUp({ parentSessionID: SESSION, id, prompt: promptOf(token) }), (w) => [w]))
    yield* issue(r, { ...call, probe: true })
  }
  yield* awaitOpen(r)
  yield* advance(r, r.config.quiesceMs)
})

const finalStatus = Effect.fn("Sim.finalStatus")(function* (r: Runner) {
  for (const [worker, id] of yield* Ref.get(r.ids)) {
    yield* issue(r, { ...spec(1, "status", worker, Option.none(), (model) => Effect.map(model.status(SESSION, id), (w) => [w])), probe: true })
  }
  yield* awaitOpen(r)
})

const makeRunner = Effect.fn("Sim.makeRunner")(function* (config: SimConfig) {
  const world = yield* makeWorld(config.world)
  const injector = yield* makeInjector(config.random, Effect.map(world.get, (state) => state.now))
  yield* injector.plan(config.faults)
  if (Option.isSome(config.crashAt)) yield* injector.crashAt(config.crashAt.value)
  const r: Runner = {
    world,
    injector,
    clock: yield* TestClock.make({ warningDelay: "10 minutes" }),
    worldScope: yield* Effect.scope,
    config,
    procs: yield* Ref.make<ReadonlyMap<number, Proc>>(new Map()),
    open: yield* Ref.make<ReadonlyArray<Open>>([]),
    calls: yield* Ref.make<ReadonlyArray<ToolCall>>([]),
    ids: yield* Ref.make<ReadonlyMap<string, string>>(new Map()),
    nextCall: yield* Ref.make(1),
    nextProc: yield* Ref.make(1),
    restarts: yield* Ref.make(0),
    gate: yield* Ref.make<Option.Option<ArmedGate>>(Option.none()),
  }
  return r
})

const armGate = Effect.fn("Sim.armGate")(function* (r: Runner, at: GateAt) {
  const gate = yield* makeGate(Option.some(at.index), Option.none(), Option.none())
  yield* r.injector.setGate(Option.some(gate))
  yield* Ref.set(r.gate, Option.some({ gate, commands: at.commands, releaseAt: Option.none() }))
})

/** Adjudication 3a: a gate that has not fired by the end of the script is disarmed (one that fired is released). */
const disarmGate = Effect.fn("Sim.disarmGate")(function* (r: Runner) {
  const armed = yield* Ref.get(r.gate)
  yield* r.injector.setGate(Option.none())
  yield* Ref.set(r.gate, Option.none())
  if (Option.isSome(armed)) yield* Deferred.succeed(armed.value.gate.release, true)
})

/**
 * Adjudication 2a: when faults stop, the owner answers every prompt still showing (a correct shell holds turns
 * behind a prompt and types them once it clears), then time passes; repeated while new prompts appear.
 */
const ownerClears = Effect.fn("Sim.ownerClears")(function* (r: Runner) {
  for (let round = 0; round < 3; round++) {
    const prompted = (yield* r.world.get).panes.filter((pane) => pane.alive && !pane.closed && PROMPT_SCREENS.includes(pane.screen))
    if (prompted.length === 0 && round > 0) return
    for (const pane of prompted) yield* r.world.update((state) => applyEvent(state, WorldEvent.ClearPrompt({ blockId: Option.some(pane.blockId) })))
    yield* advance(r, r.config.quiesceMs)
  }
})

/** Runs a script on a fresh world: steps, then faults off, the owner's prompt answers, quiescence, the progress probe and a final status. */
export const runScript = (config: SimConfig, steps: ReadonlyArray<Step>): Effect.Effect<Trace> =>
  Effect.scoped(
    Effect.gen(function* () {
      const r = yield* makeRunner(config)
      yield* spawn(r, 1)
      yield* issue(r, spec(1, "reattach", "*", Option.none(), (model) => Effect.as(model.bindPane(SESSION, ANCHOR), [])))
      yield* awaitOpen(r)
      yield* Ref.set(r.calls, [])
      if (Option.isSome(config.gateAt)) yield* armGate(r, config.gateAt.value)
      for (const step of steps) yield* runStep(r, step, true)
      yield* awaitOpen(r)
      const scriptEffects = (yield* r.injector.trace).length
      yield* disarmGate(r)
      yield* r.injector.setFaultsOn(false)
      yield* ownerClears(r)
      if (config.probe) yield* probeAll(r)
      yield* finalStatus(r)
      const trace: Trace = {
        name: config.name,
        seed: config.seed,
        calls: [...(yield* Ref.get(r.calls))].sort((a, b) => a.id - b.id),
        world: yield* r.world.get,
        effects: yield* r.injector.trace,
        scriptEffects,
        fired: yield* r.injector.fired,
        coverage: yield* r.injector.coverage,
        boundMs: config.boundMs,
        workerIds: yield* Ref.get(r.ids),
        restarts: yield* Ref.get(r.restarts),
      }
      return trace
    }),
  )
