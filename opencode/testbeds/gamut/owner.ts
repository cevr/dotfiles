/**
 * The owner of gamut's detached processes: `GAMUT_OWNER`, a pid, inherited
 * from the `gamut up` that started them. The terminal host and the sim model
 * run until `down`; with an owner they also end once that process is gone, so
 * a test runner killed mid-run (its `down` never run) leaves no orphan.
 *
 * @module
 */
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, Option, Schedule } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** How often a detached process looks whether its owner is still there. */
const EVERY = "500 millis"

/** Whether process `pid` exists, as `ps` lists it: no signal is sent. */
const alive = (pid: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const ps = yield* spawner.spawn(ChildProcess.make("ps", ["-p", `${pid}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore", forceKillAfter: "1 second" }))
    return (yield* ps.exitCode) === 0
  }).pipe(Effect.scoped)

/** Ends once the owner's process is gone; never without an owner. */
export const ownerGone = Effect.gen(function* () {
  const owner = Option.filter(yield* Config.option(Config.Int("GAMUT_OWNER")), (pid) => pid > 1)
  if (Option.isNone(owner)) return yield* Effect.never
  yield* Effect.repeat(alive(owner.value), { while: (up) => up, schedule: Schedule.spaced(EVERY) })
}).pipe(Effect.provide(BunServices.layer), Effect.orDie)

/** Runs `gone` once the owner's process is gone, in the background. */
export const whenOwnerGone = (gone: () => void): void => {
  Effect.runFork(Effect.andThen(ownerGone, Effect.sync(gone)))
}
