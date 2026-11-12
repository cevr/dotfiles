// The stall watchdog's handlers. `tick` takes one measurement, asks the rule
// (`step` in watch.ts) what it means, and acts on the profiler and the capture
// store; `run` starts the first window and ticks forever, measuring the lag
// on the monotonic clock (a host that sleeps is no stall), and drops the
// window when its scope closes.
//
// Every outcome is one log line: a capture written (its path, the lag, the
// RSS before and after the stall and at the window's end), a stall inside the
// cooldown, and a profiler or store failure. A failure never stops the
// server: the watchdog logs it and samples a new window.
import { Clock, Context, Duration, Effect, Layer, Ref, type Scope } from "effect"
import { Captures, Memory, Profiler, type Usage } from "./service.ts"
import { expired, initial, type Settings, type Stall, Step, stem, step, type Watch } from "./watch.ts"

/** One measurement: the monotonic time it ended at, the wall clock, and the lag past the tick's sleep, all in milliseconds. */
export interface Sample {
  readonly now: number
  readonly wall: number
  readonly lagMs: number
}

export class Watchdog extends Context.Service<
  Watchdog,
  {
    /** Act on one measurement; answers what the rule decided. */
    readonly tick: (sample: Sample) => Effect.Effect<Step>
    /** Sample the first window, then measure and tick forever; the window is dropped when the scope closes. */
    readonly run: Effect.Effect<never, never, Scope.Scope>
  }
>()("dotfiles-opencode/stall/Watchdog") {}

const MB = 1024 * 1024
const mb = (bytes: number) => Math.round(bytes / MB)

const usageNote = (usage: Usage) => ({ rssMB: mb(usage.rss), heapUsedMB: mb(usage.heapUsed), heapTotalMB: mb(usage.heapTotal), externalMB: mb(usage.external) })

/** The watchdog for `settings`, in the process `pid`. */
export const layer = (settings: Settings, pid: number) =>
  Layer.effect(
    Watchdog,
    Effect.gen(function* () {
      const profiler = yield* Profiler
      const captures = yield* Captures
      const memory = yield* Memory
      const start = yield* Clock.currentTimeNanos
      const watch = yield* Ref.make<Watch>(initial(Number(start / 1_000_000n)))
      const lastRss = yield* Ref.make(yield* memory.rss)

      const warn = (what: string) => (error: { readonly message: string }) =>
        Effect.logWarning(`stall watchdog: ${what}`).pipe(Effect.annotateLogs({ error: error.message }))

      const restart = profiler.start.pipe(Effect.catch(warn("the profiler did not start a new window")))

      const prune = captures.names.pipe(
        Effect.flatMap((names) => captures.remove(expired(names, settings.keep))),
        Effect.catch(warn("old captures were not pruned")),
      )

      const finish = Effect.fn("Watchdog.finish")(function* (stall: Stall) {
        const end = yield* memory.usage
        const written = yield* profiler.stop.pipe(
          Effect.flatMap((profile) =>
            captures.write(stem(stall, pid), profile, {
              stall,
              pid,
              end,
              settings: { thresholdMs: settings.thresholdMs, captureMs: settings.captureMs, windowMs: settings.windowMs },
            }),
          ),
          Effect.tap((path) =>
            Effect.logWarning(`stall watchdog: a ${Math.round(stall.lagMs)} ms event-loop stall; CPU profile ${path}`).pipe(
              Effect.annotateLogs({
                lagMs: Math.round(stall.lagMs),
                profile: path,
                rssBeforeMB: mb(stall.rssBefore),
                rssAfterMB: mb(stall.rssAfter),
                rssDeltaMB: mb(stall.rssAfter) - mb(stall.rssBefore),
                ...usageNote(end),
              }),
            ),
          ),
          Effect.catch(warn(`the capture of a ${Math.round(stall.lagMs)} ms stall was not written`)),
        )
        yield* prune
        yield* restart
        return written
      })

      const act = (decided: Step) =>
        Step.$match(decided, {
          Wait: () => Effect.void,
          Rotate: () => profiler.discard.pipe(Effect.catch(warn("the profiler did not drop its window")), Effect.andThen(restart)),
          Begin: ({ stall }) =>
            Effect.logInfo(`stall watchdog: a ${Math.round(stall.lagMs)} ms event-loop stall; capturing for ${settings.captureMs} ms more`),
          Skip: ({ lagMs, nextMs }) =>
            Effect.logInfo(`stall watchdog: a ${Math.round(lagMs)} ms event-loop stall; no capture (one per ${settings.cooldownMs} ms, next in ${Math.round(nextMs)} ms)`),
          Finish: ({ stall }) => Effect.asVoid(finish(stall)),
        })

      const tick = Effect.fn("Watchdog.tick")(function* (sample: Sample) {
        const rss = yield* memory.rss
        const rssBefore = yield* Ref.getAndSet(lastRss, rss)
        const [next, decided] = step(yield* Ref.get(watch), { ...sample, rss, rssBefore }, settings)
        yield* Ref.set(watch, next)
        yield* act(decided)
        return decided
      })

      const measure = Effect.gen(function* () {
        const before = yield* Clock.currentTimeNanos
        yield* Effect.sleep(Duration.millis(settings.tickMs))
        const after = yield* Clock.currentTimeNanos
        const wall = yield* Clock.currentTimeMillis
        return { now: Number(after / 1_000_000n), wall, lagMs: Math.max(0, Number(after - before) / 1e6 - settings.tickMs) }
      })

      const run = Effect.acquireRelease(restart, () => profiler.discard.pipe(Effect.ignore)).pipe(
        Effect.andThen(Effect.forever(Effect.flatMap(measure, tick))),
      )

      return Watchdog.of({ tick, run })
    }),
  )
