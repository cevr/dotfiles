// More than one OpenCode server in one simulated run: each host is a world of
// its own (its sessions, its storage, its plugins, its model), all of them on
// the first one's clock, scheduler and seed (`World.make({ beside })`), so one
// seed orders every host's fibers and same-instant timers together. Between
// them runs a memory network (mods/mail/memory/net.ts) that keeps the real
// network's laws (mods/mail/http/net-laws.ts).
//
// `command` runs a process of a host beside its server (the pair command): an
// Effect on the world's clock, run to its end as the clock moves.
import { Effect, Exit, Option } from "effect"
import * as World from "./world.ts"
import { SimError } from "./runtime.ts"

/** A second host beside `first`: its own sessions and model `script`, on `first`'s clock, scheduler and seed. */
export const beside = (first: World.World, options: Omit<World.WorldOptions, "seed" | "beside">) =>
  World.make({ ...options, seed: 0, beside: first })

/**
 * Runs `effect` in `world` as a process beside its server would run: forked onto the world's scheduler and clock,
 * the clock moved in `step` ms until it ends, within `limit` ms of virtual time; its exit.
 */
export const command = <A, E>(world: World.World, effect: Effect.Effect<A, E>, limit = 60_000, step = 10) =>
  Effect.gen(function* () {
    const fiber = world.runtime.fork(effect)
    const done = () => Option.isSome(Option.fromNullishOr(fiber.pollUnsafe()))
    yield* world.until(done, limit, step)
    return yield* Option.match(Option.fromNullishOr(fiber.pollUnsafe()), {
      onNone: (): Effect.Effect<Exit.Exit<A, E>, SimError> => Effect.fail(new SimError({ message: "the command did not end" })),
      onSome: (exit) => Effect.succeed(exit),
    })
  })

/** `command`, its value: a failure of the effect fails the run. */
export const run = <A, E>(world: World.World, effect: Effect.Effect<A, E>, limit = 60_000) =>
  command(world, effect, limit).pipe(Effect.flatMap((exit) => Exit.match(exit, { onSuccess: Effect.succeed, onFailure: Effect.failCause })))
