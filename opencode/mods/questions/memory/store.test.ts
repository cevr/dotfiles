import { Effect } from "effect"
import { storeLaws } from "../laws.ts"
import * as MemoryStore from "./store.ts"

storeLaws(
  "memory QuestionStore",
  Effect.sync(() => {
    const memory = MemoryStore.empty()
    return {
      layer: MemoryStore.layer(memory),
      spoil: (sessionID) => Effect.sync(() => void memory.broken.set(sessionID, "spoiled")),
    }
  }),
)
