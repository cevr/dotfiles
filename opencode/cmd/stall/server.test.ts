// The plugin seam: two copies of the plugin in this process (as two locations
// load it), on the real profiler and a scratch capture directory, their log
// lines read as they come. A stall of this test's own main thread is captured
// once, by the first copy alone; once that copy's scope closes, the second
// takes over and captures the next one. tests/stall.test.ts runs it in a real
// OpenCode service.
import { describe, expect, test } from "bun:test"
import { file, nanoseconds, spawnSync } from "bun"
import { Duration, Effect, Exit, Logger, Queue, Schema, Scope } from "effect"
import { watch } from "./server.ts"

const OPTIONS = { thresholdMs: 300, tickMs: 20, windowMs: 5_000, captureMs: 100, cooldownMs: 60_000, keep: 5, intervalUs: 1_000, turnMs: 50 }
const WAIT = Duration.seconds(10)

function holdTheSeamTestLoop(ms: number) {
  const end = nanoseconds() + ms * 1_000_000
  let turns = 0
  while (nanoseconds() < end) turns++
  return turns
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
  const next = (text: string) => Queue.take(lines).pipe(Effect.repeat({ until: (line) => line.includes(text) }), Effect.timeout(WAIT))
  const count = (text: string) => Effect.sync(() => all.filter((line) => line.includes(text)).length)
  return { loggers: new Set([logger]), next, count }
})

describe("the stall plugin", () => {
  test("two copies in one process: the first captures a stall once; when it leaves, the second captures the next", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* scratchDir
          const log = yield* logLines
          /** One copy of the plugin, started in a scope of its own; answers that scope. */
          const copy = Effect.gen(function* () {
            const scope = yield* Scope.make()
            yield* watch({ ...OPTIONS, dir }).pipe(Scope.provide(scope), Effect.provideService(Logger.CurrentLoggers, log.loggers))
            return scope
          })
          const first = yield* copy
          const second = yield* copy
          yield* log.next("watching")

          yield* Effect.sync(() => holdTheSeamTestLoop(600))
          const written = yield* log.next("CPU profile")
          expect(yield* log.count("watching")).toBe(1)
          const path = written.slice(written.indexOf("CPU profile ") + "CPU profile ".length)
          expect(path).toMatch(/\/stall-\d{8}T\d{9}Z-\d+ms-\d+\.cpuprofile$/)
          expect(Number(/-(\d+)ms-/.exec(path)?.[1])).toBeGreaterThanOrEqual(OPTIONS.thresholdMs)
          const profile = yield* decodeProfile(yield* Effect.promise(() => file(path).text()))
          expect(profile.nodes.map((node) => node.callFrame.functionName)).toContain("holdTheSeamTestLoop")

          yield* Scope.close(first, Exit.void)
          yield* log.next("watching")
          yield* Effect.sync(() => holdTheSeamTestLoop(600))
          const again = yield* log.next("CPU profile")
          expect(again).not.toContain(path)
          expect(yield* log.count("CPU profile")).toBe(2)
          yield* Scope.close(second, Exit.void)
        }),
      ),
    ), 20_000)

  test("a malformed option stops the plugin", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(Effect.scoped(watch({ thresholdMs: "soon" })))
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ))
})
