// The real profiler of this test's own process: a window that holds a busy
// function's run names it, and a dropped window can be followed by another.
import { describe, expect, test } from "bun:test"
import { nanoseconds } from "bun"
import { Effect, Schema } from "effect"
import { Profiler } from "../service.ts"
import { layer } from "./profiler.ts"

function spinTheProfilerProbe(ms: number) {
  const end = nanoseconds() + ms * 1_000_000
  let turns = 0
  while (nanoseconds() < end) turns++
  return turns
}

/** As much of a `.cpuprofile` as the test reads. */
const CpuProfile = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ callFrame: Schema.Struct({ functionName: Schema.String }) })),
  samples: Schema.Array(Schema.Finite),
  startTime: Schema.Finite,
  endTime: Schema.Finite,
})
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(CpuProfile))

const run = <A, E>(body: Effect.Effect<A, E, Profiler>) => Effect.runPromise(Effect.scoped(Effect.provide(body, layer(1_000))))

describe("the inspector profiler", () => {
  test("a stopped window is a .cpuprofile that names the function that ran in it", () =>
    run(
      Effect.gen(function* () {
        const profiler = yield* Profiler
        yield* profiler.start
        yield* Effect.sync(() => spinTheProfilerProbe(300))
        const profile = yield* decodeProfile(yield* profiler.stop)
        expect(profile.samples.length).toBeGreaterThan(0)
        expect(profile.endTime).toBeGreaterThan(profile.startTime)
        expect(profile.nodes.map((node) => node.callFrame.functionName)).toContain("spinTheProfilerProbe")
      }),
    ))

  test("a dropped window leaves the profiler ready for the next", () =>
    run(
      Effect.gen(function* () {
        const profiler = yield* Profiler
        yield* profiler.start
        yield* profiler.discard
        yield* profiler.start
        const profile = yield* decodeProfile(yield* profiler.stop)
        expect(profile.endTime).toBeGreaterThanOrEqual(profile.startTime)
      }),
    ))

  test("stopping a profiler that is not sampling is a ProfilerFailed, not a crash", () =>
    run(
      Effect.gen(function* () {
        const error = yield* Effect.flip(Profiler.use((profiler) => profiler.stop))
        expect(error._tag).toBe("ProfilerFailed")
        expect(error.step).toBe("Profiler.stop")
      }),
    ))
})
