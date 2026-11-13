// The keepalive's network in memory, for the plugin's seam test: the pings it
// received, the ones interrupted before an answer came, and how it answers.
import { Effect, Layer } from "effect"
import { type PingAnswer, type PingFailed, Pinger, type PingRequest } from "../service.ts"

export interface MemoryNetwork {
  readonly received: Array<PingRequest>
  /** Pings interrupted while waiting for their answer: aborted. */
  readonly aborted: Array<PingRequest>
  answer: (request: PingRequest) => Effect.Effect<PingAnswer, PingFailed>
}

/** A network that answers every ping 200 with an empty body, until a test says otherwise. */
export const make = (): MemoryNetwork => ({ received: [], aborted: [], answer: () => Effect.succeed({ status: 200, headers: [], text: "" }) })

export const layer = (network: MemoryNetwork) =>
  Layer.succeed(
    Pinger,
    Pinger.of({
      send: (request) =>
        Effect.suspend(() => {
          network.received.push(request)
          return network.answer(request).pipe(Effect.onInterrupt(() => Effect.sync(() => network.aborted.push(request))))
        }),
    }),
  )
