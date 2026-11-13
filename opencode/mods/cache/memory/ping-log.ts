// The keepalive's log in memory, for the plugin's seam test: the lines it holds.
import { Effect, Layer } from "effect"
import type { PingLine } from "../keepalive.ts"
import { PingLog } from "../service.ts"

export const layer = (lines: Array<PingLine> = []) =>
  Layer.succeed(
    PingLog,
    PingLog.of({
      append: (line) =>
        Effect.sync(() => {
          lines.push(line)
        }),
      read: Effect.sync(() => [...lines]),
    }),
  )
