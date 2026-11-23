// gamut's detached processes and their owner (testbeds/gamut/owner.ts): the terminal host and the sim model,
// started detached as `gamut up` starts them, end once GAMUT_OWNER's process is gone, with no `down`. The owner here
// stands in for a test runner killed past its timeout, whose afterAll (gamut down) never runs.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Schedule, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { checkoutBunCommand } from "./scratch-child.ts"
import { scratchInput } from "./read-path.ts"

/** Every process's arguments, as `ps` lists them. */
const processArgs = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const ps = yield* spawner.spawn(ChildProcess.make("ps", ["-axo", "args="], { stdin: "ignore", stderr: "ignore", forceKillAfter: "1 second" }))
  return yield* ps.stdout.pipe(Stream.decodeText(), Stream.mkString)
}).pipe(Effect.scoped)

/** `check` again every 20 ms until it holds; the test's timeout bounds it. */
const until = <E, R>(check: Effect.Effect<boolean, E, R>) => Effect.repeat(check, { until: (holds) => holds, schedule: Schedule.spaced("20 millis") })

describe("gamut's detached processes and their owner", () => {
  it.live.layer(BunServices.layer)(
    "the owner (a test runner) killed mid-run, no down: the host, its program and the sim model end with it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gamut-owner-" })
        const socket = `${dir}/host.sock`
        const port = `${dir}/sim.port`
        // The runner, and the two processes started detached under its pid, as `gamut up` starts them under GAMUT_OWNER.
        // The scope stops each one still running when the test ends, passed or not.
        const quiet = { stdin: "ignore", stdout: "ignore", stderr: "ignore", forceKillAfter: "1 second" } as const
        const owner = yield* spawner.spawn(ChildProcess.make("sleep", ["600"], quiet))
        const detached = { detached: true, stdout: "ignore", stderr: "ignore", forceKillAfter: "1 second" } as const
        const scratch = { HOME: dir, TMPDIR: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir }
        const values = { GAMUT_OWNER: `${owner.pid}` }
        const host = yield* spawner.spawn(checkoutBunCommand("tests/gamut-owner/host.ts", { scratchArgs: [dir], scratch, external: {}, values }, detached))
        const sim = yield* spawner.spawn(checkoutBunCommand("tests/gamut-owner/model.ts", { scratchArgs: [port], scratch, external: {}, values }, detached))
        yield* until(Effect.map(Effect.all([fs.exists(scratchInput(socket)), fs.exists(scratchInput(port))]), (made) => made.every(Boolean)))
        expect(yield* processArgs).toContain(dir)

        yield* owner.kill({ killSignal: "SIGKILL" })
        expect((yield* Effect.all([host.exitCode, sim.exitCode])).map(Number)).toEqual([0, 0])
        yield* until(Effect.map(processArgs, (args) => !args.includes(dir)))
        expect(yield* fs.exists(scratchInput(socket))).toBe(false)
      }).pipe(Effect.scoped),
    20_000,
  )
})
