import { Clock, Effect, Option, Tracer } from "effect"

type Transport = "http" | "websocket"
type Route = { readonly sessionID: string; readonly stepID: string; readonly tracked: boolean; readonly frame: string }
const samples = 1_000
const ms = (duration: bigint) => Number(duration) / 1_000_000
const summarize = (all: ReadonlyArray<number>) => {
  const sorted = all.toSorted((a, b) => a - b)
  const at = (q: number) => sorted[Math.ceil(q * sorted.length) - 1] ?? 0
  return { n: sorted.length, p50: at(0.5), p99: at(0.99) }
}

/** Final-hook cost against the very same hook on an untracked provider. */
export const sendCost = <E>(hook: (transport: Transport, route: Route) => Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    const measure = (transport: Transport, track: boolean, continuing: boolean, concurrency: number) => Effect.gen(function* () {
      const waits: Array<number> = []
      const spans = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          if (options.name === "Pool.checkSend.read") {
            const parent = Option.getOrUndefined(options.parent)
            if (parent?._tag === "Span" && parent.name === "Pool.checkSend") waits.push(ms(span.startTime - parent.status.startTime))
          }
          return span
        },
      })
      const timings = yield* Effect.forEach(Array.from({ length: concurrency }, (_, i) => i), (i) =>
        Effect.forEach(Array.from({ length: samples / concurrency }, (_, n) => n), (n) => Effect.gen(function* () {
          const turn = Option.getOrElse(Option.filter(Option.some(n), () => !continuing), () => 0)
          const frame = Option.getOrElse(Option.filter(Option.some('{"type":"response.create"}'), () => !continuing || n === 0), () => '{"type":"response.cancel"}')
          const route = { sessionID: `ses_cost_${transport}_${i}`, stepID: `${track}/${continuing}/${concurrency}/${i}/${turn}`, tracked: track, frame }
          const start = yield* Clock.currentTimeNanos
          yield* hook(transport, route)
          return ms((yield* Clock.currentTimeNanos) - start)
        })), { concurrency }).pipe(Effect.withTracer(spans))
      return { latencyMs: summarize(timings.flat()), holdLockWaitMs: summarize(waits) }
    })
    return {
      http: { control: yield* measure("http", false, false, 1), tracked: yield* measure("http", true, false, 1) },
      websocket: { control: yield* measure("websocket", false, false, 1), tracked: yield* measure("websocket", true, false, 1),
        oneStream: yield* measure("websocket", true, true, 1), eightSessions: yield* measure("websocket", true, false, 8) },
    }
  })
