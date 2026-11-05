// The checks as real child processes: what a command prints and exits with,
// no shell startup file read, the output kept to its tail, and the whole
// process group killed past the time and on interruption.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Fiber } from "effect"
import { environmentOf, run } from "./checks.ts"

const dir = mkdtempSync(path.join(tmpdir(), "wake-checks-"))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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

  test("past its time is stopped, with its group, and reads as timed out", async () => {
    const pidFile = path.join(dir, "timeout.pid")
    const started = Date.now()
    const check = await Effect.runPromise(run(`sleep 30 & echo $! > ${pidFile}; echo waiting; wait`, dir, 300))
    expect(check.timedOut).toBe(true)
    expect(check.stdout).toBe("waiting\n")
    expect(Date.now() - started).toBeLessThan(5000)
    const pid = Number(await Bun.file(pidFile).text())
    await Bun.sleep(100)
    expect(alive(pid)).toBe(false)
  })

  test("an interrupted check kills its group", async () => {
    const pidFile = path.join(dir, "interrupt.pid")
    const pid = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(run(`sleep 30 & echo $! > ${pidFile}; wait`, dir, 60_000))
        yield* Effect.sleep(300)
        yield* Fiber.interrupt(fiber)
        return Number(yield* Effect.promise(() => Bun.file(pidFile).text()))
      }),
    )
    await Bun.sleep(100)
    expect(alive(pid)).toBe(false)
  })

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
