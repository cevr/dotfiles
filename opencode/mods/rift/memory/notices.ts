// Notices held in memory: each wake, in order, for the test to read.
import { Effect, Layer } from "effect"
import { Notices, type Notice } from "../service.ts"

export interface Woken {
  readonly sessionID: string
  readonly notice: Notice
}

export const layer = (woken: Array<Woken>) => Layer.succeed(Notices, Notices.of({ wake: (sessionID, notice) => Effect.sync(() => void woken.push({ sessionID, notice })) }))
