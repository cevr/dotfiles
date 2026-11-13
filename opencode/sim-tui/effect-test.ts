// sim-tui's Effect test integration: a bun test whose body is an Effect, with
// its own timeout. sim-tui resolves the fork's Effect (it runs the fork's TUI
// in process), whose types are not those effect-bun-test and sim/seed.ts are
// written against (the root's), so its tests register through this instead.
import { test } from "bun:test"
import { Effect } from "effect"

/** A test whose body is an Effect, with its own timeout: one that plays many seeds outlasts bun's 5 s default. */
export const effectTest = <A, E>(name: string, body: Effect.Effect<A, E>, timeoutMs: number) => test(name, () => Effect.runPromise(Effect.asVoid(body)), timeoutMs)
