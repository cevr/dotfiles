// gamut's detached processes and their owner (testbeds/gamut/owner.ts): the terminal host and the sim model,
// started detached as `gamut up` starts them, end once GAMUT_OWNER's process is gone, with no `down`. The owner here
// stands in for a test runner killed past its timeout, whose afterAll (gamut down) never runs.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Schedule, Schema, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { hangGuard } from "./hang-guard.ts"

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

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
        // The program names `dir` (its $0), so `ps` finds it while it runs.
        yield* fs.writeFileString(
          `${dir}/host.json`,
          json({ socket, cwd: dir, command: ["/bin/sh", "-c", "sleep 600; :", dir], env: { PATH: "/usr/bin:/bin" }, cols: 60, rows: 12 }),
        )
        // The runner, and the two processes started detached under its pid, as `gamut up` starts them under GAMUT_OWNER.
        // The scope stops each one still running when the test ends, passed or not.
        const quiet = { stdin: "ignore", stdout: "ignore", stderr: "ignore", forceKillAfter: "1 second" } as const
        const owner = yield* spawner.spawn(ChildProcess.make("sleep", ["600"], quiet))
        const detached = { ...quiet, detached: true, extendEnv: true, env: { GAMUT_OWNER: `${owner.pid}` } }
        const host = yield* spawner.spawn(ChildProcess.make("bun", ["testbeds/gamut/pty-host.ts", `${dir}/host.json`], detached))
        const sim = yield* spawner.spawn(ChildProcess.make("bun", ["testbeds/gamut/sim-model.ts", port], detached))
        yield* until(Effect.map(Effect.all([fs.exists(socket), fs.exists(port)]), (made) => made.every(Boolean)))
        expect(yield* processArgs).toContain(dir)

        yield* owner.kill({ killSignal: "SIGKILL" })
        expect((yield* Effect.all([host.exitCode, sim.exitCode])).map(Number)).toEqual([0, 0])
        yield* until(Effect.map(processArgs, (args) => !args.includes(dir)))
        expect(yield* fs.exists(socket)).toBe(false)
      }).pipe(Effect.scoped),
    hangGuard("local-pair"),
  )
})
