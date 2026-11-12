// The checks as real child processes: what a command prints and exits with,
// no shell startup file read, the output kept to its tail, and the whole
// process group killed past the time and on interruption.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Fiber } from "effect"
import { environmentOf, run } from "./checks.ts"
import { notYet, type Policy, ready, waitFor } from "./readiness.ts"

const dir = mkdtempSync(path.join(tmpdir(), "wake-checks-"))
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

describe("a check", () => {
  test("gives the command's exit code, stdout and stderr, run in its directory", async () => {
    const check = await Effect.runPromise(run("pwd; echo oops >&2; exit 3", dir, 5000))
    expect(check.exitCode).toBe(3)
    expect(check.stdout.trim().endsWith(path.basename(dir))).toBe(true)
    expect(check.stderr).toBe("oops\n")
    expect(check.timedOut).toBe(false)
  })

  test("reads no shell startup file: BASH_ENV and ENV are dropped, and stdin is closed", async () => {
    const rc = path.join(dir, "rc.sh")
    writeFileSync(rc, "echo FROM-RC\n")
    const check = await Effect.runPromise(run("echo \"[$BASH_ENV$ENV]\"; cat", dir, 5000, { ...process.env, BASH_ENV: rc, ENV: rc }))
    expect(check.stdout).toBe("[]\n")
    expect(environmentOf({ BASH_ENV: rc, ENV: rc, PATH: "/bin" })).toEqual({ PATH: "/bin" })
  })

  test("keeps the tail of a long output", async () => {
    const check = await Effect.runPromise(run("i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done", dir, 5000, process.env, 100))
    expect(check.stdout.length).toBeLessThanOrEqual(100)
    expect(check.stdout.endsWith("line1999\n")).toBe(true)
  })

  test("past its time is stopped, with its group, and reads as timed out", () =>
    Effect.runPromise(
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
    ))

  test("an interrupted check kills its group", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const pidFile = path.join(dir, "interrupt.pid")
        const fiber = yield* Effect.forkChild(run(`sleep 30 & echo $! > ${pidFile}; wait`, dir, 60_000))
        const pid = yield* waitFor("the running check's pid file", pidIn(pidFile), SOON)
        yield* Fiber.interrupt(fiber)
        yield* waitFor(`the interrupted check's background sleep ${pid} gone`, gone(pid), SOON)
        expect(alive(pid)).toBe(false)
      }),
    ))

  test("a background child left behind does not hold the check open", async () => {
    const started = Date.now()
    const check = await Effect.runPromise(run("sleep 30 & echo done", dir, 10_000))
    expect(check).toEqual({ exitCode: 0, stdout: "done\n", stderr: "", timedOut: false })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test("a command that cannot start reads as a failed check that says why", async () => {
    const check = await Effect.runPromise(run("true", path.join(dir, "missing"), 1000))
    expect(check.exitCode).toBe(127)
    expect(check.stderr).toContain("did not start")
  })
})
