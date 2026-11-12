// The watchdog's handlers over test Layers declared here: a profiler that
// records what it was asked (and can refuse to start), a capture store in
// memory, and a memory whose RSS the case sets; driven one measurement at a
// time.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { type Sample, Watchdog, layer } from "./model.ts"
import { Captures, Memory, Profiler, ProfilerFailed, Summary } from "./service.ts"
import { DEFAULTS, type Settings } from "./watch.ts"

const settings: Settings = { ...DEFAULTS, thresholdMs: 2_000, windowMs: 30_000, captureMs: 10_000, cooldownMs: 600_000, keep: 2 }
const PID = 4242
const WALL = Date.UTC(2026, 10, 12, 16, 0, 0, 0)
const MB = 1024 * 1024
const decodeSummary = Schema.decodeUnknownSync(Schema.fromJsonString(Summary))
const encodeSummary = Schema.encodeSync(Schema.fromJsonString(Summary))

/** What the case sees: the profiler's calls, the capture files by name, the RSS the next tick reads. */
interface World {
  readonly calls: Ref.Ref<ReadonlyArray<string>>
  readonly files: Ref.Ref<ReadonlyMap<string, string>>
  readonly rss: Ref.Ref<number>
}

const call = (world: World, name: string) => Ref.update(world.calls, (calls) => [...calls, name])

const startOf = (world: World, refuses: boolean) => {
  if (refuses) return call(world, "start").pipe(Effect.andThen(Effect.fail(new ProfilerFailed({ step: "Profiler.start", message: "refused" }))))
  return call(world, "start")
}

const profilerOf = (world: World, refuses: boolean) =>
  Profiler.of({
    start: startOf(world, refuses),
    stop: call(world, "stop").pipe(Effect.as('{"nodes":[{"callFrame":{"functionName":"spin"}}]}')),
    discard: call(world, "discard"),
  })

const capturesOf = (world: World) =>
  Captures.of({
    write: (stem, profile, summary) =>
      Ref.update(world.files, (files) => new Map([...files, [`${stem}.json`, encodeSummary(summary)], [`${stem}.cpuprofile`, profile]])).pipe(
        Effect.as(`memory/${stem}.cpuprofile`),
      ),
    names: Effect.map(Ref.get(world.files), (files) => [...files.keys()]),
    remove: (names) => Ref.update(world.files, (files) => new Map(Arr.filter([...files], ([name]) => !names.includes(name)))),
  })

const memoryOf = (world: World) =>
  Memory.of({
    rss: Ref.get(world.rss),
    usage: Effect.map(Ref.get(world.rss), (rss) => ({ rss, heapUsed: 10 * MB, heapTotal: 20 * MB, external: MB })),
  })

/** One measurement `now` ms after the watchdog was built, with its lag and the RSS (in MB) the tick reads. */
interface At {
  readonly now: number
  readonly lagMs: number
  readonly rssMB: number
}
const at = (now: number, lagMs = 0, rssMB = 100): At => ({ now, lagMs, rssMB })

/** What a run leaves: the steps' tags, the profiler's calls and the capture files. */
interface Result {
  readonly tags: ReadonlyArray<string>
  readonly calls: ReadonlyArray<string>
  readonly files: ReadonlyMap<string, string>
}

/** Builds the watchdog, runs `ticks` in order, and checks what they left. */
const run = (ticks: ReadonlyArray<At>, refuses: boolean, check: (result: Result) => void) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const world: World = { calls: yield* Ref.make<ReadonlyArray<string>>([]), files: yield* Ref.make<ReadonlyMap<string, string>>(new Map()), rss: yield* Ref.make(100 * MB) }
        const externals = Layer.mergeAll(Layer.succeed(Profiler, profilerOf(world, refuses)), Layer.succeed(Captures, capturesOf(world)), Layer.succeed(Memory, memoryOf(world)))
        const dog = Context.get(yield* Layer.build(layer(settings, PID).pipe(Layer.provide(externals))), Watchdog)
        // The first window starts on the monotonic clock as the layer is built: the measurements count from then.
        const base = Number((yield* Clock.currentTimeNanos) / 1_000_000n)
        const tags = yield* Effect.forEach(ticks, (each) => {
          const sample: Sample = { now: base + each.now, wall: WALL + each.now, lagMs: each.lagMs }
          return Ref.set(world.rss, each.rssMB * MB).pipe(
            Effect.andThen(dog.tick(sample)),
            Effect.map((step) => step._tag),
          )
        })
        check({ tags, calls: yield* Ref.get(world.calls), files: yield* Ref.get(world.files) })
      }),
    ),
  )

const names = (files: ReadonlyMap<string, string>) => [...files.keys()].sort()
const fileText = (files: ReadonlyMap<string, string>, name: string) => Option.getOrElse(Option.fromUndefinedOr(files.get(name)), () => "")

describe("the watchdog", () => {
  test("a stall writes one capture: the profile of the window it fell in, and a summary with the RSS around it", () =>
    run([at(1_000, 0, 100), at(4_000, 3_000, 2_600), at(9_000), at(14_000, 0, 900)], false, ({ tags, calls, files }) => {
      expect(tags).toEqual(["Wait", "Begin", "Wait", "Finish"])
      expect(calls).toEqual(["stop", "start"])
      const stem = `stall-20261112T160004000Z-3000ms-${PID}`
      expect(names(files)).toEqual([`${stem}.cpuprofile`, `${stem}.json`])
      expect(fileText(files, `${stem}.cpuprofile`)).toContain("spin")
      const summary = decodeSummary(fileText(files, `${stem}.json`))
      expect(summary.stall).toEqual({ at: WALL + 4_000, lagMs: 3_000, rssBefore: 100 * MB, rssAfter: 2_600 * MB })
      expect(summary.end.rss).toBe(900 * MB)
      expect(summary.pid).toBe(PID)
    }))

  test("a second stall inside the cooldown writes nothing more", () =>
    run([at(1_000, 3_000), at(11_000), at(30_000, 5_000), at(35_000), at(41_000)], false, ({ tags, files }) => {
      expect(tags).toEqual(["Begin", "Finish", "Skip", "Wait", "Rotate"])
      expect(files.size).toBe(2)
    }))

  test("an old window with no stall is dropped and a new one started", () =>
    run([at(30_000), at(30_250)], false, ({ tags, calls, files }) => {
      expect(tags).toEqual(["Rotate", "Wait"])
      expect(calls).toEqual(["discard", "start"])
      expect(files.size).toBe(0)
    }))

  test("only the newest captures stay", () => {
    const cooldown = settings.cooldownMs
    const ticks = [at(1_000, 3_000), at(11_000), at(cooldown + 1_000, 4_000), at(cooldown + 11_000), at(2 * cooldown + 1_000, 5_000), at(2 * cooldown + 11_000)]
    return run(ticks, false, ({ files }) => {
      expect(names(files).map((name) => name.split("-")[2])).toEqual(["4000ms", "4000ms", "5000ms", "5000ms"])
    })
  })

  test("a profiler that will not start is logged and the watchdog goes on", () =>
    run([at(30_000), at(60_000)], true, ({ tags, calls }) => {
      expect(tags).toEqual(["Rotate", "Rotate"])
      expect(calls).toEqual(["discard", "start", "discard", "start"])
    }))
})
