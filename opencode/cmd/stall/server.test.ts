// The plugin seam: two copies of the plugin in this process (as two locations
// load it), on the real profiler and a scratch capture directory, their log
// lines read as they come. A stall of this test's own main thread is captured
// once, by the first copy alone; once that copy's scope closes, the second
// takes over and captures the next one. tests/stall.test.ts runs it in a real
// OpenCode service.
import { file, spawnSync } from "bun"
import { Clock, Duration, Effect, Exit, Latch, Logger, Queue, Ref, Schema, Scope } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { TestClock } from "effect/testing"
import { watch } from "./server.ts"

const OPTIONS = { thresholdMs: 300, tickMs: 20, windowMs: 5_000, captureMs: 100, cooldownMs: 60_000, keep: 5, intervalUs: 1_000, turnMs: 50 }
// Only a hang guard. No scheduler or inspector operation has a performance deadline here.
const HANG_GUARD_MS = 120_000

function holdTheSeamTestLoop() {
  // Give the real inspector JavaScript to sample, regardless of time spent descheduled.
  let checksum = 1
  for (let turn = 0; turn < 60_000_000; turn++) checksum = Math.imul(checksum, 31) + turn
  return checksum
}

const CpuProfile = Schema.Struct({ nodes: Schema.Array(Schema.Struct({ callFrame: Schema.Struct({ functionName: Schema.String }) })) })
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(CpuProfile))

/** A scratch directory for the case's captures, removed with its scope. */
const scratchDir = Effect.acquireRelease(
  Effect.sync(() => spawnSync(["mktemp", "-d", "-t", "stall-seam"]).stdout.toString().trim()),
  (dir) => Effect.sync(() => void spawnSync(["rm", "-rf", dir])),
)

/** The watchdog's log lines: every one so far, and a queue the case reads them from as they come. */
const logLines = Effect.gen(function* () {
  const lines = yield* Queue.unbounded<string>()
  const all: Array<string> = []
  const logger = Logger.make(({ message }) => {
    const text = String(message)
    if (!text.startsWith("stall watchdog")) return
    all.push(text)
    Queue.offerUnsafe(lines, text)
  })
  /** The next line that holds `text`. */
  const next = (text: string) => Queue.take(lines).pipe(Effect.repeat({ until: (line) => line.includes(text) }))
  const count = (text: string) => Effect.sync(() => all.filter((line) => line.includes(text)).length)
  return { loggers: new Set([logger]), next, count }
})

/**
 * The clock lets the first measurement sleep tell the test when the real profiler has started.
 * End that measurement late, after running real JS for the sampler, then end the capture's next
 * tick. The lag measured by the watchdog is independent of the host scheduler.
 */
const ticks = Effect.gen(function* () {
  const clock = yield* Clock.Clock
  const now = yield* Ref.make(0)
  const currentTimeNanos = Effect.map(Ref.get(now), (ms) => BigInt(ms) * 1_000_000n)
  const requests = yield* Queue.unbounded<Latch.Latch>()
  const waitingForTurn = yield* Latch.make()
  const sleep = (duration: Duration.Duration) => {
    if (Duration.toMillis(duration) !== OPTIONS.tickMs) return Effect.andThen(waitingForTurn.open, clock.sleep(duration))
    return Effect.gen(function* () {
      const done = yield* Latch.make()
      yield* Queue.offer(requests, done)
      yield* done.await
    })
  }
  const endTick = (ms: number, work: Effect.Effect<unknown> = Effect.void) =>
    Effect.gen(function* () {
      const done = yield* Queue.take(requests)
      yield* work
      yield* Ref.update(now, (time) => time + ms)
      yield* done.open
    })
  return { clock: { ...clock, currentTimeNanos, sleep }, endTick, waitingForTurn: waitingForTurn.await }
})

describe("the stall plugin", () => {
  it.scoped(
    "two copies in one process: the first captures a stall once; when it leaves, the second captures the next",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratchDir
        const log = yield* logLines
        // Each copy owns its requests, so the first's interrupted tick can't wake the second.
        const copy = Effect.gen(function* () {
          const scope = yield* Scope.fork(yield* Scope.Scope)
          const tick = yield* ticks
          yield* watch({ ...OPTIONS, dir }).pipe(
            Scope.provide(scope),
            Effect.provideService(Clock.Clock, tick.clock),
            Effect.provideService(Logger.CurrentLoggers, log.loggers),
          )
          return { scope, ...tick }
        })
        const stall = Effect.sync(() => expect(holdTheSeamTestLoop()).not.toBe(1))
        const capture = (tick: Effect.Success<typeof ticks>, lag: number) =>
          tick.endTick(lag + OPTIONS.tickMs, stall).pipe(Effect.andThen(tick.endTick(OPTIONS.captureMs)))
        const first = yield* copy
        const second = yield* copy
        yield* log.next("watching")
        yield* second.waitingForTurn

        yield* capture(first, OPTIONS.thresholdMs)
        const written = yield* log.next("CPU profile")
        expect(yield* log.count("watching")).toBe(1)
        const path = written.slice(written.indexOf("CPU profile ") + "CPU profile ".length)
        expect(path).toMatch(/\/stall-\d{8}T\d{9}Z-\d+ms-\d+\.cpuprofile$/)
        expect(Number(/-(\d+)ms-/.exec(path)?.[1])).toBe(OPTIONS.thresholdMs)
        const profile = yield* decodeProfile(yield* Effect.promise(() => file(path).text()))
        expect(profile.nodes.map((node) => node.callFrame.functionName)).toContain("holdTheSeamTestLoop")

        yield* Scope.close(first.scope, Exit.void)
        yield* TestClock.adjust(OPTIONS.turnMs)
        yield* log.next("watching")
        yield* capture(second, OPTIONS.thresholdMs * 10)
        const again = yield* log.next("CPU profile")
        expect(again).not.toContain(path)
        expect(again).toContain(`-${OPTIONS.thresholdMs * 10}ms-`)
        expect(yield* log.count("CPU profile")).toBe(2)
        yield* Scope.close(second.scope, Exit.void)
      }),
    HANG_GUARD_MS,
  )

  it.scoped("a malformed option stops the plugin", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(watch({ thresholdMs: "soon" }))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
