// Sessions held in memory, each with the messages it received. The model's
// tests and the plugin's seam test use it; `refuse` makes the next deliveries
// to a session fail, as a host that would not take them.
import { Effect, Layer } from "effect"
import type { Letter } from "../reply.ts"
import { Courier, DeliveryRefused } from "../service.ts"

export interface MemorySessions {
  /** Each open session's messages, in the order they arrived. */
  readonly inboxes: Map<string, Array<{ readonly id: string; readonly letter: Letter }>>
  /** Sessions that refuse what is delivered, with why. */
  readonly refusing: Map<string, string>
  minted: number
}

export const empty = (...sessionIDs: ReadonlyArray<string>): MemorySessions => ({
  inboxes: new Map(sessionIDs.map((sessionID) => [sessionID, []])),
  refusing: new Map(),
  minted: 0,
})

export const layer = (memory: MemorySessions) =>
  Layer.succeed(Courier, {
    newDelivery: Effect.sync(() => {
      memory.minted += 1
      return `msg_${String(memory.minted).padStart(12, "0")}`
    }),
    deliver: (sessionID, delivery, letter) =>
      Effect.suspend(() => {
        const inbox = memory.inboxes.get(sessionID)
        const refusing = memory.refusing.get(sessionID)
        if (inbox === undefined) return Effect.fail(new DeliveryRefused({ sessionID, message: `no session ${sessionID}`, gone: true }))
        if (refusing !== undefined) return Effect.fail(new DeliveryRefused({ sessionID, message: refusing, gone: false }))
        if (!inbox.some((message) => message.id === delivery)) inbox.push({ id: delivery, letter })
        return Effect.void
      }),
  })
