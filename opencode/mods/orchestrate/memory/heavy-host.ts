// The heavy-check host held in memory, for the plugin's seam tests: a host
// whose cores, load and working count the test sets, and may change between
// two prompts, or whose reading fails.
import { Effect, Layer, Option } from "effect"
import { HeavyHost, HostUnread } from "../service.ts"

/** The host as the test holds it: change a field and the next reading sees it. A `failing` reason makes every reading fail. */
export interface MemoryHost {
  cores: number
  load: number
  working: number
  failing: Option.Option<string>
  /** Each reading's `except`, in order. */
  readonly asked: Array<Option.Option<string>>
}

/** A host of `cores` with `working` heavy agents working, whose readings succeed. */
export const host = (cores: number, working: number): MemoryHost => ({ cores, load: 3, working, failing: Option.none(), asked: [] })

const reading = (state: MemoryHost) =>
  Option.match(state.failing, {
    onNone: () => Effect.succeed({ host: { load: state.load, cores: state.cores }, working: state.working }),
    onSome: (reason) => Effect.fail(new HostUnread({ reason })),
  })

export const layer = (state: MemoryHost) =>
  Layer.succeed(
    HeavyHost,
    HeavyHost.of({
      cores: Effect.sync(() => state.cores),
      read: (except) =>
        Effect.suspend(() => {
          state.asked.push(except)
          return reading(state)
        }),
    }),
  )
