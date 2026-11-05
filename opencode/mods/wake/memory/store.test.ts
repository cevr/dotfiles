import { Effect } from "effect"
import { storeLaws } from "../laws.ts"
import * as MemoryStore from "./store.ts"

storeLaws(
  "memory WakeStore",
  Effect.sync(() => {
    const memory = MemoryStore.empty()
    return {
      layer: MemoryStore.layer(memory),
      spoil: (id) =>
        Effect.sync(() => {
          memory.entries.delete(id)
          memory.broken.add(id)
        }),
    }
  }),
)
