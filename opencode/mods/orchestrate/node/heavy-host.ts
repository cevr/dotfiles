// The heavy-check host as Node's `os` reads it: its cores and its load over
// the last minute, with the heavy agents working on it counted by `working`
// (filestore/heavy-agents.ts reads them from the call log).
import { availableParallelism, loadavg } from "node:os"
import { Array as Arr, Effect, Layer, Option } from "effect"
import { HeavyHost, type HostUnread } from "../service.ts"

const coresNow = Effect.sync(() => Math.max(1, availableParallelism()))

export const layer = (working: (except: Option.Option<string>) => Effect.Effect<number, HostUnread>) =>
  Layer.succeed(
    HeavyHost,
    HeavyHost.of({
      cores: coresNow,
      read: (except) =>
        Effect.gen(function* () {
          const cores = yield* coresNow
          const load = yield* Effect.sync(() => Option.getOrElse(Arr.head(loadavg()), () => 0))
          return { host: { load, cores }, working: yield* working(except) }
        }),
    }),
  )
