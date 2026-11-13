// The world's runtime: every fiber of a simulated run on one scheduler, one
// clock and one seed, all of it synchronous.
//
// - The scheduler keeps each fiber's tasks in order. Effect's own scheduler
//   gives each fiber its own dispatcher, so this is the only order Effect
//   promises. The seed chooses which fiber's next task runs among those that
//   are ready, so one seed replays one interleaving and other seeds try
//   others. Nothing runs until the world drains the queue.
// - The clock moves only when `advance` moves it. A sleep is a timer in the
//   world's list. `advance` fires the due timers one at a time, in time order,
//   with timers due at the same instant ordered by the seed, and settles after
//   each one.
// - `settle` drains the scheduler until no fiber has a task left. A fiber that
//   waits on something outside the world (a real timer, a promise, a file, the
//   network) never gets its answer inside a drain, so `run` says it waits
//   instead of hanging.
//
// The plugins see the same clock and a seeded `Random` (Effect's
// `Random.withSeed`); the world's own choices draw from a second generator on
// the same seed, so a plugin's ids do not move when the world draws.
import { Array as Arr, Clock, Context, Data, Duration, Effect, Exit, type Fiber, Logger, Option, Random, References, type Scheduler, Schema } from "effect"

/** A run the world cannot finish: it waits outside the world, it does not settle, or it failed. */
export class SimError extends Data.TaggedError("SimError")<{ readonly message: string }> {}

/** A seeded generator: Effect's `Random` on the seed. */
export const generator = (seed: string | number): Random.Random =>
  Effect.runSync(
    Effect.gen(function* () {
      return yield* Random.Random
    }).pipe(Random.withSeed(seed)),
  )

/** A whole number in [0, n). */
export const below = (random: Random.Random, n: number) => Math.min(n - 1, Math.floor(random.nextDoubleUnsafe() * n))

/** How many tasks one drain may run before the world calls it a livelock. */
export const DRAIN_LIMIT = 2_000_000

class Dispatcher implements Scheduler.SchedulerDispatcher {
  readonly tasks: Array<() => void> = []
  constructor(private readonly scheduler: SimScheduler) {}
  scheduleTask(task: () => void, _priority: number) {
    this.tasks.push(task)
    if (this.tasks.length === 1) this.scheduler.ready.push(this)
  }
  flush() {
    this.scheduler.drain()
  }
}

class SimScheduler implements Scheduler.Scheduler {
  readonly executionMode = "async" as const
  readonly ready: Array<Dispatcher> = []
  constructor(private readonly random: Random.Random) {}
  shouldYield(fiber: Fiber.Fiber<unknown, unknown>) {
    return fiber.currentOpCount >= 2048
  }
  makeDispatcher() {
    return new Dispatcher(this)
  }
  /** Runs ready tasks, one task of a dispatcher the seed picks at a time, until none is left; false past the limit. */
  drain(): boolean {
    for (let ran = 0; this.ready.length > 0; ran += 1) {
      if (ran > DRAIN_LIMIT) return false
      const index = below(this.random, this.ready.length)
      const dispatcher = this.ready[index]
      const task = dispatcher.tasks.shift()
      if (dispatcher.tasks.length === 0) this.ready.splice(index, 1)
      task?.()
    }
    return true
  }
}

interface Timer {
  readonly at: number
  /** The plugin copy whose fiber set it; 0 for the host's own. */
  readonly owner: number
  readonly resume: () => void
}

/** Which plugin copy a fiber works for: the world provides it under each copy's start, and its fibers inherit it. */
export const Owner = Context.Reference<number>("dotfiles-opencode/sim/Owner", { defaultValue: () => 0 })

/** What a log line keeps: no time, the world's trace holds that. */
export interface LogLine {
  readonly level: string
  readonly message: string
  readonly annotations: { readonly [key: string]: Schema.Json }
}

const JsonText = Schema.fromJsonString(Schema.Unknown)
const JsonValue = Schema.fromJsonString(Schema.Json)

/** A value as one line of JSON text; what JSON cannot hold (a bigint, a lone undefined) as its text. */
export const line = <A>(value: A): string =>
  Exit.match(Schema.encodeUnknownExit(JsonText)(value), { onSuccess: (text) => text, onFailure: () => line(String(value)) })

/** A value as plain JSON, as it would cross the wire: what JSON drops dropped. */
export const plain = <A>(value: A): Schema.Json =>
  Exit.match(Schema.decodeUnknownExit(JsonValue)(line(value)), { onSuccess: (json): Schema.Json => json, onFailure: () => "" })

const JsonObject = Schema.Record(Schema.String, Schema.Json)
export type JsonObject = typeof JsonObject.Type

/** A value as a JSON object: `plain`, and an empty object for anything that is not one. */
export const record = <A>(value: A): JsonObject => Option.getOrElse(Schema.decodeUnknownOption(JsonObject)(plain(value)), () => ({}))

export interface RuntimeOptions {
  readonly seed: number
  /** The epoch ms the clock starts at. */
  readonly start: number
  /** Each log line a fiber writes. */
  readonly log: (line: LogLine) => void
  /** Each timer as it fires, by the copy that set it. */
  readonly fired: (owner: number) => void
}

export const makeRuntime = (options: RuntimeOptions) => {
  const world = generator(`world:${options.seed}`)
  const plugins = generator(options.seed)
  const scheduler = new SimScheduler(world)
  let now = options.start
  const timers = new Set<Timer>()

  const nanos = () => BigInt(now) * 1_000_000n
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) =>
      Effect.withFiber((fiber) => {
        const owner = fiber.getRef(Owner)
        return Effect.callback<void>((resume) => {
          const millis = Duration.toMillis(duration)
          if (!(millis > 0)) return resume(Effect.void)
          if (!Number.isFinite(millis)) return Effect.void
          const timer: Timer = { at: now + millis, owner, resume: () => resume(Effect.void) }
          timers.add(timer)
          return Effect.sync(() => void timers.delete(timer))
        })
      }),
  }

  const logger = Logger.make((entry) => {
    options.log({
      level: entry.logLevel,
      message: Arr.ensure(entry.message).map(String).join(" "),
      annotations: record(entry.fiber.getRef(References.CurrentLogAnnotations)),
    })
  })

  /** The world's services under an effect: its clock, the plugins' seeded random, its logger, every level. */
  const provide = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(Clock.Clock, clock),
      Effect.provideService(Random.Random, plugins),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
      Effect.provide(Logger.layer([logger])),
    )

  /** Runs every fiber until none has work left. */
  const settle = Effect.suspend(() => {
    if (scheduler.drain()) return Effect.void
    return Effect.fail(new SimError({ message: `livelock: ${DRAIN_LIMIT} tasks ran without the world settling` }))
  })

  /** Starts `effect` as a fiber of the world; it runs when the world settles. */
  const fork = <A, E>(effect: Effect.Effect<A, E>) => Effect.runFork(provide(effect), { scheduler })

  /** The exit of `effect` run to its end at this instant, the world settling around it; none while it waits. */
  const exitOf = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const fiber = fork(effect)
      yield* settle
      const exit = Option.fromNullishOr(fiber.pollUnsafe())
      if (Option.isNone(exit)) {
        fiber.interruptUnsafe()
        yield* settle
      }
      return exit
    })

  /** Runs `effect` to its end at this instant; it fails as the effect does, or with a SimError when it waits on time or on the outside. */
  const run = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | SimError> =>
    exitOf(effect).pipe(
      Effect.flatMap(
        Option.match({
          onNone: (): Effect.Effect<A, E | SimError> =>
            Effect.fail(new SimError({ message: "the effect waits on time or on something outside the world: advance the clock, or it reached real I/O" })),
          onSome: (exit: Exit.Exit<A, E>): Effect.Effect<A, E | SimError> => exit,
        }),
      ),
    )

  /** The earliest instant a timer is due at, at or before `target`. */
  const nextDue = (target: number) => {
    let first = Option.none<number>()
    for (const timer of timers)
      if (timer.at <= target && Option.match(first, { onNone: () => true, onSome: (at) => timer.at < at })) first = Option.some(timer.at)
    return first
  }

  /** Fires one of the timers due at `at`, the seed choosing among them. */
  const fire = (at: number) => {
    const due = [...timers].filter((timer) => timer.at === at)
    const timer = due[below(world, due.length)]
    timers.delete(timer)
    now = at
    options.fired(timer.owner)
    timer.resume()
  }

  /** Moves the clock by `ms`, firing each timer due on the way in order, ties by the seed, settling after each. */
  const advance = (ms: number) =>
    Effect.gen(function* () {
      const target = now + Math.max(0, ms)
      yield* settle
      for (let at = nextDue(target); Option.isSome(at); at = nextDue(target)) {
        fire(at.value)
        yield* settle
      }
      now = target
      yield* settle
    })

  return {
    clock,
    /** The plugins' seeded random. */
    random: plugins,
    /** The world's own seeded random: delays, orders. */
    world,
    now: () => now,
    /** The owners of the timers set and not yet fired. */
    timers: () => [...timers].map((timer) => timer.owner),
    provide,
    fork,
    run,
    settle,
    advance,
  }
}

export type Runtime = ReturnType<typeof makeRuntime>
