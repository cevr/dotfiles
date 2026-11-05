import { Effect } from "effect"
import { backstopLaws } from "../laws.ts"
import * as MemoryBackstop from "./backstop.ts"

backstopLaws(
  "memory Backstop",
  Effect.sync(() => {
    const memory = MemoryBackstop.empty()
    return {
      layer: MemoryBackstop.layer(memory),
      plant: (title) => Effect.sync(() => void memory.jobs.set(title, { job: { id: title, title, directory: "/" }, schedule: { cron: "@daily", recurring: true } })),
    }
  }),
)
