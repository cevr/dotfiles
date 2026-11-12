/**
 * The stall watchdog as an OpenCode server plugin. The composition root: it
 * decodes the options, and in one copy per process builds the watchdog
 * (`@dotfiles/opencode-stall/model`) on the runtime's own inspector, the
 * capture files and the process's memory, and runs it until the copy's scope
 * closes.
 *
 * The server's main thread can stall for seconds (no HTTP answer, no event)
 * with no one there to profile it. The watchdog measures the event loop's lag
 * itself and keeps a CPU profile sampling in rolling windows, so when a lag of
 * `thresholdMs` or more ends, the window that holds the stall is written to
 * `dir` as `stall-<UTC time>-<lag>ms-<pid>.cpuprofile`, after `captureMs` more
 * sampling, with a `.json` summary beside it (the RSS before and after the
 * stall, the memory at the window's end), and one log line names the file. At
 * most one capture per `cooldownMs`, and `keep` captures stay
 * (`@dotfiles/opencode-stall/watch` has the rule).
 *
 * OpenCode runs a copy of the plugin per location, all in one process with one
 * profiler, so the copies take turns: each lists itself on the process (as the
 * git plugin's watcher does), the first listed runs the watchdog, and when it
 * leaves the next one takes over within `turnMs`.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `thresholdMs`: the lag that is a stall; default 2000.
 * - `tickMs`: how often the lag is measured; default 250.
 * - `windowMs`: how long a window samples before it is dropped while no stall happens; default 30000.
 * - `captureMs`: how long a window keeps sampling after a stall; default 10000.
 * - `cooldownMs`: the least time between two captures; default 600000.
 * - `keep`: how many captures stay; default 5.
 * - `intervalUs`: the profiler's sampling interval, in microseconds; default 10000.
 * - `turnMs`: how often a copy that is not running the watchdog looks whether its turn has come; default 5000.
 * - `dir`: where captures go; default OpenCode's log directory, `$XDG_DATA_HOME/opencode/log`
 *   (`~/.local/share/opencode/log`).
 */
import { Plugin } from "@opencode/plugin/effect"
import { Config, Context, Duration, Effect, Layer, Schema } from "effect"
import * as Captures from "@dotfiles/opencode-stall/filestore/captures"
import * as Profiler from "@dotfiles/opencode-stall/inspector/profiler"
import * as Model from "@dotfiles/opencode-stall/model"
import * as Memory from "@dotfiles/opencode-stall/process/memory"
import { DEFAULTS, type Settings } from "@dotfiles/opencode-stall/watch"

const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, A, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

const Positive = Schema.Finite.check(Schema.isGreaterThan(0))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const Options = Schema.Struct({
  thresholdMs: Positive.pipe(withDefault(DEFAULTS.thresholdMs)),
  tickMs: Positive.pipe(withDefault(DEFAULTS.tickMs)),
  windowMs: Positive.pipe(withDefault(DEFAULTS.windowMs)),
  captureMs: Positive.pipe(withDefault(DEFAULTS.captureMs)),
  cooldownMs: Positive.pipe(withDefault(DEFAULTS.cooldownMs)),
  keep: Count.pipe(withDefault(DEFAULTS.keep)),
  intervalUs: Positive.pipe(withDefault(10_000)),
  turnMs: Positive.pipe(withDefault(5_000)),
  dir: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

/** OpenCode's log directory, as the host names it (`@opencode/util/global` `Path.log`). */
const logDir = Effect.gen(function* () {
  const home = yield* Config.String("HOME").pipe(Config.withDefault(""))
  const data = yield* Config.String("XDG_DATA_HOME").pipe(Config.withDefault(`${home}/.local/share`))
  return `${data}/opencode/log`
})

/**
 * The copies of the plugin in this process, in the order they started; the
 * first runs the watchdog. Kept on the process because each location loads
 * the plugin in its own scope.
 */
const HOLDERS = Symbol.for("dotfiles-opencode.stall.holders")
const holders = (): Array<symbol> => {
  const shared: Record<symbol, Array<symbol>> = globalThis
  shared[HOLDERS] ||= []
  return shared[HOLDERS]
}

/** Lists `token` for the scope's life. */
const hold = (token: symbol) =>
  Effect.acquireRelease(
    Effect.sync(() => holders().push(token)),
    () =>
      Effect.sync(() => {
        const list = holders()
        list.splice(list.indexOf(token), 1)
      }),
  )

/** Waits until `token` is the first copy listed, looking every `every`. */
const turn = (token: symbol, every: Duration.Duration) =>
  Effect.gen(function* () {
    while ((yield* Effect.sync(() => holders()[0])) !== token) yield* Effect.sleep(every)
  })

/**
 * One copy of the plugin on its options: it lists itself, and on its turn runs the watchdog in a
 * fiber of the caller's scope. A malformed option is a defect.
 */
export const watch = Effect.fn("Stall.watch")(function* (input: Plugin.Context["options"]) {
  const options = yield* Schema.decodeUnknownEffect(Options)(input).pipe(Effect.orDie)
  const settings: Settings = {
    thresholdMs: options.thresholdMs,
    tickMs: options.tickMs,
    windowMs: options.windowMs,
    captureMs: options.captureMs,
    cooldownMs: options.cooldownMs,
    keep: options.keep,
  }
  const dir = yield* Effect.orDie(Effect.map(logDir, (found) => options.dir || found))
  const token = Symbol("stall watchdog holder")
  yield* hold(token)
  const running = Effect.scoped(
    Effect.gen(function* () {
      yield* turn(token, Duration.millis(options.turnMs))
      const services = yield* Layer.build(
        Model.layer(settings, process.pid).pipe(Layer.provide(Layer.mergeAll(Profiler.layer(options.intervalUs), Captures.layer(dir), Memory.layer))),
      )
      yield* Effect.logInfo(`stall watchdog: watching for event-loop stalls of ${settings.thresholdMs} ms or more; captures go to ${dir}`)
      return yield* Context.get(services, Model.Watchdog).run
    }),
  ).pipe(Effect.catch((error) => Effect.logWarning(`stall watchdog: off, the profiler did not start: ${error.message}`)))
  yield* Effect.forkScoped(running)
})

export default Plugin.define({
  id: "dotfiles-opencode.stall",
  effect: (ctx) => watch(ctx.options),
})
