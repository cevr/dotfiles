// testbeds/reaper/start.ts: importing it starts, once per process, the reaper (testbeds/reaper/run.ts) that stops what this
// test process started once it is gone, however it went. A test's own cleanup (a scope's finalizer, `owned`'s
// exit hook) runs only when the test process gets to run it; a runner killed with SIGKILL, or a run its
// harness stops at a deadline, ran none of it, and the background services and detached TUIs it started lived
// on under pid 1 (batch cx: two `serve --service` from tests/reconnect-session-booting.test.ts and
// tests/reconnect-session-select-cached.test.ts, and an opencode-drive TUI, found a day later). The reaper is
// the gamut owner pattern (testbeds/gamut/owner.ts) from the outside: the processes need not know their owner.
//
// tests/owned.ts and tests/service.ts import it, so every test that spawns through `owned` or starts a
// background service has one; tests/reaper.test.ts kills a runner mid-run and finds nothing it started left.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Path, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/**
 * Starts the reaper for this process. `sh`'s `$PPID` is this process, the owner the reaper watches. `sh` starts the
 * reaper in the background and exits at once, so this process holds no handle that keeps it running (a plain
 * `bun` script that imports this would otherwise wait on the reaper, which waits on it). The reaper is in `sh`'s
 * process group (`detached`), not this process's, so a harness that stops this process's group leaves it to do its
 * work; the scope is never closed, as a closed one would stop that group.
 */
export const startReaper = Effect.gen(function* () {
  const path = yield* Path.Path
  const program = yield* path.fromFileUrl(new URL("./run.ts", import.meta.url))
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const scope = yield* Scope.make()
  const command = ChildProcess.make("sh", ["-c", 'REAPER_OWNER=$PPID bun "$0" </dev/null >/dev/null 2>&1 &', program], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", forceKillAfter: "1 second" })
  yield* spawner.spawn(command).pipe(Scope.provide(scope))
}).pipe(Effect.provide(BunServices.layer), Effect.ignore)

Effect.runFork(startReaper)
