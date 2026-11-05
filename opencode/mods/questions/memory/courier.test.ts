import { Effect } from "effect"
import { courierLaws } from "../laws.ts"
import * as MemoryCourier from "./courier.ts"

courierLaws(
  "memory Courier",
  Effect.sync(() => {
    const memory = MemoryCourier.empty()
    return {
      layer: MemoryCourier.layer(memory),
      open: (sessionID) => Effect.sync(() => void memory.inboxes.set(sessionID, [])),
      received: (sessionID) => Effect.sync(() => memory.inboxes.get(sessionID) ?? []),
    }
  }),
)
