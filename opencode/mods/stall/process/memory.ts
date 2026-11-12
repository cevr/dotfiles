// The Memory over this process's own figures (`process.memoryUsage`). The RSS
// alone is read on every tick, through the runtime's cheap `rss()`.
import { Effect, Layer } from "effect"
import { Memory } from "../service.ts"

export const layer = Layer.succeed(
  Memory,
  Memory.of({
    rss: Effect.sync(() => process.memoryUsage.rss()),
    usage: Effect.sync(() => {
      const usage = process.memoryUsage()
      return { rss: usage.rss, heapUsed: usage.heapUsed, heapTotal: usage.heapTotal, external: usage.external }
    }),
  }),
)
