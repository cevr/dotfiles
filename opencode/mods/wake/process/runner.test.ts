// The process runner over real processes in a scratch directory: a job runs
// detached under its own runner, records its exit, drips whole lines, keeps
// its log, runs niced when heavy, stops at its timeout and on a kill; a
// runner gone without an exit reads lost. On Linux, `systemd-run --user`
// is asked first, and a refusal falls back to a detached runner with a warning.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import type { JobSpec, Run } from "../job.ts"
import { Runner } from "../service.ts"
import * as ProcessRunner from "./runner.ts"
import { FILES, writeAtomic } from "./supervise.ts"
import type { Ran } from "../cron/backstop.ts"

const scratch = mkdtempSync(path.join(tmpdir(), "opencode-job-test-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** The runner's entry: supervise with a short kill grace and no notify. */
const SCRIPT = path.join(scratch, "job.ts")
writeFileSync(SCRIPT, `import { supervise } from ${JSON.stringify(path.join(import.meta.dir, "supervise.ts"))}\nawait supervise(process.argv[2], undefined, 300)\nprocess.exit(0)\n`)

let counter = 0
const specOf = (command: string, more: Partial<JobSpec> = {}): JobSpec => ({
  id: `j${String(++counter).padStart(6, "0")}`,
  sessionID: "ses_a",
  directory: scratch,
  command,
  cwd: scratch,
  note: "n",
  heavy: false,
  timeoutSeconds: 60,
  setAt: Date.now(),
  ...more,
})

const runnerOf = (config: Partial<ProcessRunner.Config> = {}) =>
  Context.get(
    Effect.runSync(
      Effect.scoped(
        Layer.build(
          ProcessRunner.layer({ root: path.join(scratch, "jobs"), bun: process.execPath, script: SCRIPT, platform: "darwin", env: process.env, exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" }), ...config }),
        ),
      ),
    ),
    Runner,
  )

const runner = runnerOf()

const until = async (id: string, done: (run: Run) => boolean, ms = 10_000): Promise<Run> => {
  const deadline = Date.now() + ms
  for (;;) {
    const record = await Effect.runPromise(runner.read(id))
    if (record !== undefined && done(record.run)) return record.run
    if (Date.now() > deadline) throw new Error(`job ${id} stayed ${record?.run.state}`)
    await Bun.sleep(50)
  }
}
const ended = (run: Run) => run.state === "ended"

describe("the process runner", () => {
  test("runs the command detached, keeps its log, and records its exit code", async () => {
    const spec = specOf("echo out; echo err >&2; exit 3")
    const launched = await Effect.runPromise(runner.launch(spec))
    expect(launched.how).toBe("detached")
    const run = await until(spec.id, ended)
    expect(run.state === "ended" && run.exit).toMatchObject({ exitCode: 3, timedOut: false, killed: false })
    expect(await Effect.runPromise(runner.tail(spec.id, 100))).toBe("out\nerr\n")
    expect(await Effect.runPromise(runner.tail(spec.id, 4))).toBe("err\n")
    expect((await Effect.runPromise(runner.read(spec.id)))?.spec).toEqual(spec)
  })

  test("names the progress file in $JOB_DRIP and hands back whole lines from an offset", async () => {
    const spec = specOf('printf "one\\ntwo\\nhalf" >> "$JOB_DRIP"; echo "$JOB_ID"')
    await Effect.runPromise(runner.launch(spec))
    await until(spec.id, ended)
    const first = await Effect.runPromise(runner.drip(spec.id, 0))
    expect(first.text).toBe("one\ntwo\n")
    expect(await Effect.runPromise(runner.drip(spec.id, first.offset))).toEqual({ text: "", offset: first.offset })
    expect(await Effect.runPromise(runner.tail(spec.id, 100))).toBe(`${spec.id}\n`)
  })

  test("leaves BASH_ENV out of the command's environment and runs a heavy one niced", async () => {
    const env = { ...process.env, BASH_ENV: "/nonexistent/loop-probe-x" }
    const niced = runnerOf({ env })
    const command = 'echo "env=${BASH_ENV:-none}"; ps -o nice= -p $$'
    const light = specOf(command)
    const heavy = specOf(command, { heavy: true })
    await Effect.runPromise(niced.launch(light))
    await Effect.runPromise(niced.launch(heavy))
    await until(light.id, ended)
    await until(heavy.id, ended)
    const niceness = async (id: string) => {
      const [env, nice] = (await Effect.runPromise(runner.tail(id, 100))).trim().split("\n")
      expect(env).toBe("env=none")
      return Number(nice)
    }
    // The test may itself run niced: heavy is ten more than the same command run light, up to the ceiling.
    expect(await niceness(heavy.id)).toBe(Math.min(process.platform === "darwin" ? 20 : 19, (await niceness(light.id)) + 10))
  })

  test("stops the command at its timeout", async () => {
    const spec = specOf("sleep 30", { timeoutSeconds: 0.3 })
    await Effect.runPromise(runner.launch(spec))
    const run = await until(spec.id, ended)
    expect(run.state === "ended" && run.exit).toMatchObject({ exitCode: null, signal: "SIGTERM", timedOut: true, killed: false })
  })

  test("a kill stops the running command's group as killed; an ended job is not asked", async () => {
    const spec = specOf("sleep 30 & sleep 30; wait")
    await Effect.runPromise(runner.launch(spec))
    await until(spec.id, (run) => run.state === "running")
    expect(await Effect.runPromise(runner.kill(spec.id))).toBe(true)
    const run = await until(spec.id, ended)
    expect(run.state === "ended" && run.exit).toMatchObject({ exitCode: null, timedOut: false, killed: true })
    expect(await Effect.runPromise(runner.kill(spec.id))).toBe(false)
    expect(await Effect.runPromise(runner.kill("jnone00"))).toBe(false)
  })

  test("a runner gone without an exit reads lost; one never up reads starting; an unknown id reads nothing", async () => {
    const dir = path.join(scratch, "jobs", "jlost00")
    const spec = specOf("true", { id: "jlost00" })
    await Effect.runPromise(runner.launch(spec))
    await until(spec.id, ended)
    rmSync(path.join(dir, FILES.exit))
    // A pid no process has: the runner died without recording.
    writeAtomic(path.join(dir, FILES.runner), { pid: 2 ** 22 + 1, startedAt: 5 })
    expect(ProcessRunner.runOf(dir)).toMatchObject({ state: "lost", startedAt: 5 })
    rmSync(path.join(dir, FILES.runner))
    expect(ProcessRunner.runOf(dir)).toEqual({ state: "starting" })
    expect(await Effect.runPromise(runner.read("jnone00"))).toBeUndefined()
  })

  test("on Linux it asks systemd-run --user for a unit, and runs detached with a warning when refused", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const accepting = runnerOf({ platform: "linux", exec: (argv) => Effect.sync((): Ran => (asked.push(argv), { exitCode: 0, stdout: "", stderr: "" })) })
    const spec = specOf("true")
    const launched = await Effect.runPromise(accepting.launch(spec))
    expect(launched).toMatchObject({ how: "systemd", unit: `opencode-job-${spec.id}` })
    expect(asked[0]?.slice(0, 7)).toEqual(["systemd-run", "--user", "--unit", `opencode-job-${spec.id}`, "--collect", "--quiet", "--"])
    expect((await Effect.runPromise(accepting.read(spec.id)))?.unit).toBe(`opencode-job-${spec.id}`)

    const refusing = runnerOf({ platform: "linux", exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "Failed to connect to bus" }) })
    const other = specOf("exit 0")
    const fallback = await Effect.runPromise(refusing.launch(other))
    expect(fallback.how).toBe("detached")
    expect(fallback.warning).toContain("Failed to connect to bus")
    expect(await until(other.id, ended)).toMatchObject({ state: "ended", exit: { exitCode: 0 } })
  })
})
