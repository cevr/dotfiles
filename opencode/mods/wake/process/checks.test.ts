// The checks as real child processes: what a command prints and exits with,
// no shell startup file read, the output kept to its tail, and the whole
// process group killed past the time and on interruption.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Fiber, type Scope } from "effect"
import { environmentOf, run } from "./checks.ts"
import { bounded, notYet, type Policy, ready, type TestBounds, testLimitMs, waitFor } from "./readiness.ts"

/** A scratch directory of the test's own, removed when its scope closes. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), "wake-checks-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** How long a real process gets to show a change the test waits on, probed every 10 ms. */
const SOON: Policy = { within: "5 seconds", every: "10 millis" }

/** The pid a check's command wrote to `file`, once it has written one. */
const pidIn = (file: string) =>
  Effect.sync(() => {
    if (!existsSync(file)) return notYet(`${path.basename(file)} not written`)
    const pid = Number(readFileSync(file, "utf8"))
    if (pid > 0) return ready(pid)
    return notYet(`${path.basename(file)} holds no pid`)
  })

/** Ready once `pid` names no live process. */
const gone = (pid: number) =>
  Effect.sync(() => {
    if (alive(pid)) return notYet(`${pid} alive`)
    return ready(pid)
  })

/** A checks test's bounds: a body of a check and two waits of `SOON`, and a release that removes a directory. */
const BOUNDS: TestBounds = { body: "30 seconds", release: "1 second" }

/** The one Bun test of this file that runs an Effect: in a scratch directory of its own, bounded below its Bun limit, so its scope closes first. */
const scratchTest = <A, E>(name: string, body: (dir: string) => Effect.Effect<A, E, Scope.Scope>) =>
  test(name, () => Effect.runPromise(bounded(name, Effect.flatMap(scratch, body), BOUNDS)), testLimitMs(BOUNDS))

describe("a check", () => {
  scratchTest("gives the command's exit code, stdout and stderr, run in its directory", (dir) =>
    Effect.gen(function* () {
      const check = yield* run("pwd; echo oops >&2; exit 3", dir, 5000)
      expect(check.exitCode).toBe(3)
      expect(check.stdout.trim().endsWith(path.basename(dir))).toBe(true)
      expect(check.stderr).toBe("oops\n")
      expect(check.timedOut).toBe(false)
    }),
  )

  scratchTest("reads no shell startup file: BASH_ENV and ENV are dropped, and stdin is closed", (dir) =>
    Effect.gen(function* () {
      const rc = path.join(dir, "rc.sh")
      writeFileSync(rc, "echo FROM-RC\n")
      const check = yield* run("echo \"[$BASH_ENV$ENV]\"; cat", dir, 5000, { ...process.env, BASH_ENV: rc, ENV: rc })
      expect(check.stdout).toBe("[]\n")
      expect(environmentOf({ BASH_ENV: rc, ENV: rc, PATH: "/bin" })).toEqual({ PATH: "/bin" })
    }),
  )

  scratchTest("keeps the tail of a long output", (dir) =>
    Effect.gen(function* () {
      const check = yield* run("i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done", dir, 5000, process.env, 100)
      expect(check.stdout.length).toBeLessThanOrEqual(100)
      expect(check.stdout.endsWith("line1999\n")).toBe(true)
    }),
  )

  scratchTest("past its time is stopped, with its group, and reads as timed out", (dir) =>
    Effect.gen(function* () {
      const pidFile = path.join(dir, "timeout.pid")
      const started = Date.now()
      const check = yield* run(`sleep 30 & echo $! > ${pidFile}; echo waiting; wait`, dir, 300)
      expect(check.timedOut).toBe(true)
      expect(check.stdout).toBe("waiting\n")
      expect(Date.now() - started).toBeLessThan(5000)
      const pid = yield* waitFor("the timed-out check's pid file", pidIn(pidFile), SOON)
      yield* waitFor(`the timed-out check's background sleep ${pid} gone`, gone(pid), SOON)
      expect(alive(pid)).toBe(false)
    }),
  )

  scratchTest("an interrupted check kills its group", (dir) =>
    Effect.gen(function* () {
      const pidFile = path.join(dir, "interrupt.pid")
      const fiber = yield* Effect.forkChild(run(`sleep 30 & echo $! > ${pidFile}; wait`, dir, 60_000))
      const pid = yield* waitFor("the running check's pid file", pidIn(pidFile), SOON)
      yield* Fiber.interrupt(fiber)
      yield* waitFor(`the interrupted check's background sleep ${pid} gone`, gone(pid), SOON)
      expect(alive(pid)).toBe(false)
    }),
  )

  scratchTest("a background child left behind does not hold the check open", (dir) =>
    Effect.gen(function* () {
      const started = Date.now()
      const check = yield* run("sleep 30 & echo done", dir, 10_000)
      expect(check).toEqual({ exitCode: 0, stdout: "done\n", stderr: "", timedOut: false })
      expect(Date.now() - started).toBeLessThan(5000)
    }),
  )

  scratchTest("a command that cannot start reads as a failed check that says why", (dir) =>
    Effect.gen(function* () {
      const check = yield* run("true", path.join(dir, "missing"), 1000)
      expect(check.exitCode).toBe(127)
      expect(check.stderr).toContain("did not start")
    }),
  )
})
