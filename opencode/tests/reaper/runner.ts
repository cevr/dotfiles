// A test runner as tests/reaper.test.ts kills it: it imports testbeds/reaper/start.ts as a test file's helpers do, then
// starts what outlived the batch-cx runs: a background process handed to pid 1 (as `service start` leaves the
// service) and a child leading a process group of its own (as opencode-drive starts a TUI), and one that starts a `sleep 122` on SIGTERM. It prints
// `daemon <pid>`, `respawner <pid>` and `child <pid>`, then waits to be killed. Each sleeps two minutes at most, so a failed run
// leaves nothing for longer.
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Console, Effect, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import "../../testbeds/reaper/start.ts"

/** What the runner's children may print or read: nothing. */
const QUIET = { stdin: "ignore", stderr: "ignore", forceKillAfter: "1 second" } as const

const program = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  // Never closed: a closed scope would stop each spawn's process group, and these outlive the runner.
  const scope = yield* Scope.make()
  // `sh` starts the sleep in the background, waits a second and exits: the sleep is handed to pid 1, as the
  // service is once `service start` (the fork's client, waiting for it to serve, ~1.6 s) ends.
  const sh = yield* spawner.spawn(ChildProcess.make("sh", ["-c", "sleep 120 >/dev/null 2>&1 & echo $!; sleep 1"], QUIET)).pipe(Scope.provide(scope))
  const daemon = yield* sh.stdout.pipe(Stream.decodeText(), Stream.mkString)
  yield* Console.log(`daemon ${daemon.trim()}`)
  const child = yield* spawner.spawn(ChildProcess.make("sleep", ["121"], { ...QUIET, detached: true, stdout: "ignore" })).pipe(Scope.provide(scope))
  // One that starts another when it is told to stop, as a TUI starts a service when its own ends: never asked, never started.
  const respawner = yield* spawner
    .spawn(ChildProcess.make("sh", ["-c", "trap 'sleep 122 & exit' TERM; while :; do sleep 1; done"], { ...QUIET, detached: true, stdout: "ignore" }))
    .pipe(Scope.provide(scope))
  yield* Console.log(`respawner ${respawner.pid}`)
  yield* Console.log(`child ${child.pid}`)
  yield* Effect.never
})

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer), Effect.orDie))
