// sim-tui's Effect test integration: a bun test whose body is an Effect, with
// its own timeout. sim-tui resolves the fork's Effect (it runs the fork's TUI
// in process), whose types are not those effect-bun-test and sim/seed.ts are
// written against (the root's), so its tests register through this instead;
// so do lint's, which resolves the fork's Effect too.
import * as NodeServices from "@effect/platform-node/NodeServices"
import { test } from "bun:test"
import { Effect, type Layer, type Scope } from "effect"

/** A test whose body is an Effect, with its own timeout: one that plays many seeds outlasts bun's 5 s default. */
export const effectTest = <A, E>(name: string, body: Effect.Effect<A, E>, timeoutMs: number) => test(name, () => Effect.runPromise(Effect.asVoid(body)), timeoutMs)

/** As `effectTest`, with the platform's services (file system, path, child processes) and a scope the test closes. */
export const platformTest = <A, E>(name: string, body: Effect.Effect<A, E, Layer.Success<typeof NodeServices.layer> | Scope.Scope>, timeoutMs: number) =>
  effectTest(name, body.pipe(Effect.scoped, Effect.provide(NodeServices.layer)), timeoutMs)
