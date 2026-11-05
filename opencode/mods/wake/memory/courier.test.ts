import { Effect } from "effect"
import { courierLaws } from "../laws.ts"
import * as MemoryCourier from "./courier.ts"

courierLaws(
  "memory Courier",
  Effect.sync(() => {
    const memory = MemoryCourier.empty()
    return {
      layer: MemoryCourier.layer(memory),
      open: (sessionID, parentID) =>
        Effect.sync(() => {
          memory.inboxes.set(sessionID, [])
          if (parentID !== undefined) memory.parents.set(sessionID, parentID)
        }),
      received: (sessionID) => Effect.sync(() => memory.inboxes.get(sessionID) ?? []),
      started: (sessionID) => Effect.sync(() => memory.started.get(sessionID)),
    }
  }),
)
