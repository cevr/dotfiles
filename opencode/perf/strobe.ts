// The bridge from strobe's runner to Effect: strobe calls a bench's `setup`, `run` and `reset` and awaits
// the Promise each returns, and it has no Effect integration, so a bench's steps are Effects this edge
// runs, the way BunRuntime.runMain runs a CLI's.
import { Effect } from "effect"

/** A strobe page call (a press, a wait), as an Effect. */
export const page = (call: () => Promise<void>): Effect.Effect<void> => Effect.promise(call)

/** A bench step for strobe's runner: the Effect run to the Promise strobe awaits. */
export const step = (effect: Effect.Effect<void>): Promise<void> => Effect.runPromise(effect)
