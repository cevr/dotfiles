// The process runner over real processes in a scratch directory: a job runs
// detached under its own runner, records its exit, drips whole lines, keeps
// its log, runs niced when heavy, stops at its timeout and on a kill; a
// runner gone without an exit reads lost. On Linux, `systemd-run --user`
// is asked first, and a refusal falls back to a detached runner with a warning.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Context, Effect, Layer, Option, Schema, type Scope } from "effect"
import type { JobRecord, JobSpec, Run } from "../job.ts"
import { Runner } from "../service.ts"
import * as ProcessRunner from "./runner.ts"
import { argvOf, FILES, scopeAvailable, writeAtomic } from "./supervise.ts"
import type { Ran } from "../cron/backstop.ts"
import { notYet, type Observation, type Policy, ready, waitFor } from "./readiness.ts"

/** How long a job gets to reach the state a test waits for, probed every 50 ms. */
const PATIENT: Policy = { within: "10 seconds", every: "50 millis" }

/** The runner a test drives, with the scratch directory its jobs live in. */
const runnerIn = (scratch: string, script: string, config: Partial<ProcessRunner.Config> = {}) =>
  Context.get(
    Effect.runSync(
      Effect.scoped(
        Layer.build(
          ProcessRunner.layer({ root: path.join(scratch, "jobs"), bun: process.execPath, script, platform: "darwin", env: process.env, exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" }), ...config }),
        ),
      ),
    ),
    Runner,
  )
type JobRunner = ReturnType<typeof runnerIn>

const ended = (run: Run) => run.state === "ended"

/** The run a record holds once `done` holds for it, or the state it is in instead. */
const runWhere =
  (done: (run: Run) => boolean) =>
  (record: JobRecord | undefined): Observation<Run> =>
    Option.match(Option.fromUndefinedOr(record), {
      onNone: () => notYet("no record"),
      onSome: ({ run }) => Option.match(Option.liftPredicate(run, done), { onNone: () => notYet(run.state), onSome: ready }),
    })

/** The run of job `id` once `done` holds for it. */
const until = (runner: JobRunner, id: string, done: (run: Run) => boolean) => waitFor(`job ${id}`, Effect.map(runner.read(id), runWhere(done)), PATIENT)

/** The jobs of a scratch directory whose runner is up and alive. */
const runningJobs = Effect.fn("RunnerTest.runningJobs")(function* (scratch: string, runner: JobRunner) {
  const root = path.join(scratch, "jobs")
  const ids = yield* Effect.sync(() => Option.match(Option.liftPredicate(root, existsSync), { onNone: () => [], onSome: (dir) => readdirSync(dir) }))
  const records = yield* Effect.forEach(ids, (id) => Effect.map(runner.read(id), (record) => ({ id, running: record?.run.state === "running" })))
  return records.filter((record) => record.running).map((record) => record.id)
})

/**
 * Releases a scratch directory: each job whose runner is still up is killed through the runner and
 * waited for until it records its exit or reads lost, and only then is the directory removed, so
 * no runner writes into a removed directory. A job that outlasts the wait keeps the directory.
 */
const release = Effect.fn("RunnerTest.release")(function* (scratch: string, runner: JobRunner) {
  const open = yield* runningJobs(scratch, runner)
  yield* Effect.forEach(open, (id) => runner.kill(id), { discard: true })
  yield* Effect.forEach(open, (id) => until(runner, id, (run) => run.state !== "running"), { discard: true }).pipe(
    Effect.andThen(Effect.sync(() => rmSync(scratch, { recursive: true, force: true }))),
    Effect.catchTag("ReadinessTimeout", (timeout) => Effect.logWarning(`kept ${scratch}: ${timeout.label} still read ${timeout.last}`)),
  )
})

/**
 * A scratch directory with the runner's entry and a runner over it, removed when the test's scope
 * closes. The entry supervises with a kill grace long enough that a loaded machine's SIGTERM ends
 * a plain group within it, and no notify.
 */
const fixture = Effect.acquireRelease(
  Effect.sync(() => {
    const scratch = mkdtempSync(path.join(tmpdir(), "opencode-job-test-"))
    const script = path.join(scratch, "job.ts")
    writeFileSync(script, `import { supervise } from ${JSON.stringify(path.join(import.meta.dir, "supervise.ts"))}\nawait supervise(process.argv[2], undefined, 2000)\nprocess.exit(0)\n`)
    const ids = { next: 0 }
    const specOf = (command: string, more: Partial<JobSpec> = {}): JobSpec => ({
      id: `j${String(++ids.next).padStart(6, "0")}`,
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
    const runnerOf = (config: Partial<ProcessRunner.Config> = {}) => runnerIn(scratch, script, config)
    return { scratch, specOf, runnerOf, runner: runnerOf() }
  }),
  ({ scratch, runner }) => release(scratch, runner),
)

/** What a test gets: its scratch directory, a spec maker with ids unique in it, and runners over it. */
interface Fixture {
  readonly scratch: string
  readonly specOf: (command: string, more?: Partial<JobSpec>) => JobSpec
  readonly runnerOf: (config?: Partial<ProcessRunner.Config>) => JobRunner
  readonly runner: JobRunner
}

/** The bridge from a Bun test to its Effect. */
const runTest = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

/** Runs a test's body in its own scope, with its fixture released at the end. */
const withFixture = <A, E>(body: (fixture: Fixture) => Effect.Effect<A, E, Scope.Scope>) => runTest(Effect.scoped(Effect.flatMap(fixture, body)))

/** The whole lines job `id`'s command has dripped so far, once there are `count`. */
const dripped = (runner: JobRunner, id: string, count: number) =>
  waitFor(
    `job ${id}'s drip`,
    Effect.map(runner.drip(id, 0), (drip): Observation<ReadonlyArray<string>> => {
      const lines = drip.text.split("\n").filter((line) => line !== "")
      if (lines.length >= count) return ready(lines)
      return notYet(`${lines.length} lines`)
    }),
    PATIENT,
  )

/** The runner's record that it is up: its pid. */
const RunnerFile = Schema.fromJsonString(Schema.Struct({ pid: Schema.Number }))

/** Ready once `pid` names no live process. */
const gone = (pid: number) =>
  Effect.sync((): Observation<number> => {
    if (ProcessRunner.alive(pid)) return notYet(`${pid} alive`)
    return ready(pid)
  })

describe("the process runner", () => {
  test("runs the command detached, keeps its log, and records its exit code", () =>
    withFixture(({ runner, specOf }) =>
      Effect.gen(function* () {
        const spec = specOf("echo out; echo err >&2; exit 3")
        const launched = yield* runner.launch(spec)
        expect(launched.how).toBe("detached")
        const run = yield* until(runner, spec.id, ended)
        expect(run.state === "ended" && run.exit).toMatchObject({ exitCode: 3, timedOut: false, killed: false })
        expect(yield* runner.tail(spec.id, 100)).toBe("out\nerr\n")
        expect(yield* runner.tail(spec.id, 4)).toBe("err\n")
        expect((yield* runner.read(spec.id))?.spec).toEqual(spec)
      }),
    ))

  test("names the progress file in $JOB_DRIP and hands back whole lines from an offset", () =>
    withFixture(({ runner, specOf }) =>
      Effect.gen(function* () {
        const spec = specOf('printf "one\\ntwo\\nhalf" >> "$JOB_DRIP"; echo "$JOB_ID"')
        yield* runner.launch(spec)
        yield* until(runner, spec.id, ended)
        const first = yield* runner.drip(spec.id, 0)
        expect(first.text).toBe("one\ntwo\n")
        expect(yield* runner.drip(spec.id, first.offset)).toEqual({ text: "", offset: first.offset })
        expect(yield* runner.tail(spec.id, 100)).toBe(`${spec.id}\n`)
      }),
    ))

  test("leaves BASH_ENV out of the command's environment and runs a heavy one niced", () =>
    withFixture(({ runner, runnerOf, specOf }) =>
      Effect.gen(function* () {
        const env = { ...process.env, BASH_ENV: "/nonexistent/loop-probe-x" }
        const niced = runnerOf({ env })
        const command = 'echo "env=${BASH_ENV:-none}"; ps -o nice= -p $$'
        const light = specOf(command)
        const heavy = specOf(command, { heavy: true })
        yield* niced.launch(light)
        yield* niced.launch(heavy)
        yield* until(runner, light.id, ended)
        yield* until(runner, heavy.id, ended)
        const niceness = Effect.fn("RunnerTest.niceness")(function* (id: string) {
          const [env, nice] = (yield* runner.tail(id, 100)).trim().split("\n")
          expect(env).toBe("env=none")
          return Number(nice)
        })
        // The test may itself run niced: heavy is ten more than the same command run light, up to the ceiling.
        expect(yield* niceness(heavy.id)).toBe(Math.min(process.platform === "darwin" ? 20 : 19, (yield* niceness(light.id)) + 10))
      }),
    ))

  test("stops the command at its timeout", () =>
    withFixture(({ runner, specOf }) =>
      Effect.gen(function* () {
        const spec = specOf("sleep 30", { timeoutSeconds: 0.3 })
        yield* runner.launch(spec)
        const run = yield* until(runner, spec.id, ended)
        expect(run.state === "ended" && run.exit).toMatchObject({ exitCode: null, signal: "SIGTERM", timedOut: true, killed: false })
      }),
    ))

  test("a kill stops the running command's group as killed; an ended job is not asked", () =>
    withFixture(({ runner, specOf }) =>
      Effect.gen(function* () {
        const spec = specOf("sleep 30 & sleep 30; wait")
        yield* runner.launch(spec)
        yield* until(runner, spec.id, (run) => run.state === "running")
        expect(yield* runner.kill(spec.id)).toBe(true)
        const run = yield* until(runner, spec.id, ended)
        expect(run.state === "ended" && run.exit).toMatchObject({ exitCode: null, timedOut: false, killed: true })
        expect(yield* runner.kill(spec.id)).toBe(false)
        expect(yield* runner.kill("jnone00")).toBe(false)
      }),
    ))

  test("a kill records the signal even when the command's shell outlives it and exits 0", () =>
    withFixture(({ runner, specOf }) =>
      Effect.gen(function* () {
        // The shell traps SIGTERM and exits 0 once its children die of it: the
        // kill still ended the job, so its exit is the signal, not that 0.
        // The background child drips itself, from a fresh sh: a SIGTERM that
        // reaches a child of the trapping shell between its fork and its exec is
        // taken as a pending trap and lost at the exec (bash 3.2, ~1 in 8 under
        // load), and that sleep then rightly dies of the SIGKILL instead.
        const spec = specOf(`trap 'exit 0' TERM; sh -c 'echo up >> "$JOB_DRIP"; exec sleep 30' & wait`)
        yield* runner.launch(spec)
        yield* dripped(runner, spec.id, 1)
        expect(yield* runner.kill(spec.id)).toBe(true)
        const run = yield* until(runner, spec.id, ended)
        expect(run.state === "ended" && run.exit).toMatchObject({ exitCode: null, signal: "SIGTERM", timedOut: false, killed: true })
      }),
    ))

  test("a kill ends every process of the group, one that ignores SIGTERM too, before the exit is recorded", () =>
    withFixture(({ runner, specOf }) =>
      Effect.gen(function* () {
        // The leader dies of the SIGTERM at once; a member that ignores it is left for the SIGKILL at the grace's end.
        const spec = specOf(`sh -c 'trap "" TERM; echo $$ >> "$JOB_DRIP"; exec sleep 30' & sleep 30`)
        yield* runner.launch(spec)
        const stubborn = Number((yield* dripped(runner, spec.id, 1))[0])
        yield* Effect.gen(function* () {
          expect(ProcessRunner.alive(stubborn)).toBe(true)
          expect(yield* runner.kill(spec.id)).toBe(true)
          const run = yield* until(runner, spec.id, ended)
          expect(run.state === "ended" && run.exit).toMatchObject({ exitCode: null, signal: "SIGTERM", timedOut: false, killed: true })
          // Killed by the time the exit is recorded; its parent is gone, so pid 1 may take a moment to reap it.
          yield* waitFor(`the stubborn member ${stubborn} reaped`, gone(stubborn), { within: "2 seconds", every: "20 millis" })
          expect(ProcessRunner.alive(stubborn)).toBe(false)
        }).pipe(
          // Left running only when the runner failed to end it: still this test's process then.
          Effect.ensuring(Effect.sync(() => ProcessRunner.alive(stubborn) && process.kill(stubborn, "SIGKILL"))),
        )
      }),
    ))

  test("a kill the moment the job reads running ends it as killed, never lost", () =>
    withFixture(({ runner, scratch, specOf }) =>
      Effect.gen(function* () {
        const specs = Array.from({ length: 5 }, () => specOf("sleep 30"))
        for (const spec of specs) {
          yield* runner.launch(spec)
          // runner.json makes the job read running; kill on the first poll that sees it.
          const file = path.join(scratch, "jobs", spec.id, FILES.runner)
          yield* waitFor(`job ${spec.id}'s ${FILES.runner}`, Effect.sync(() => Option.match(Option.liftPredicate(file, existsSync), { onNone: () => notYet("absent"), onSome: ready })), { within: "10 seconds", every: "1 millis" })
          expect(yield* runner.kill(spec.id)).toBe(true)
        }
        for (const spec of specs) {
          const run = yield* until(runner, spec.id, (run) => run.state !== "running")
          expect(run.state === "ended" && run.exit).toMatchObject({ exitCode: null, timedOut: false, killed: true })
        }
      }),
    ))

  test("a runner gone without an exit reads lost; one never up reads starting; an unknown id reads nothing", () =>
    withFixture(({ runner, scratch, specOf }) =>
      Effect.gen(function* () {
        const dir = path.join(scratch, "jobs", "jlost00")
        const spec = specOf("true", { id: "jlost00" })
        yield* runner.launch(spec)
        yield* until(runner, spec.id, ended)
        rmSync(path.join(dir, FILES.exit))
        // A pid no process has: the runner died without recording.
        writeAtomic(path.join(dir, FILES.runner), { pid: 2 ** 22 + 1, startedAt: 5 })
        expect(ProcessRunner.runOf(dir)).toMatchObject({ state: "lost", startedAt: 5 })
        rmSync(path.join(dir, FILES.runner))
        expect(ProcessRunner.runOf(dir)).toEqual({ state: "starting" })
        expect(yield* runner.read("jnone00")).toBeUndefined()
      }),
    ))

  test("a test's scope closing on a job still running kills it, and removes the scratch directory only once the runner is done", () =>
    runTest(
      Effect.gen(function* () {
        const left = yield* Effect.scoped(
          Effect.gen(function* () {
            const { runner, scratch, specOf } = yield* fixture
            const spec = specOf("sleep 30")
            yield* runner.launch(spec)
            yield* until(runner, spec.id, (run) => run.state === "running")
            const up = Schema.decodeUnknownSync(RunnerFile)(readFileSync(path.join(scratch, "jobs", spec.id, FILES.runner), "utf8"))
            return { scratch, pid: up.pid }
          }),
        )
        expect(existsSync(left.scratch)).toBe(false)
        yield* waitFor(`the released job's runner ${left.pid} gone`, gone(left.pid), PATIENT)
        expect(ProcessRunner.alive(left.pid)).toBe(false)
      }),
    ))

  test("on Linux it asks systemd-run --user for a unit, and runs detached with a warning when refused", () =>
    withFixture(({ runner, runnerOf, specOf }) =>
      Effect.gen(function* () {
        const asked: Array<ReadonlyArray<string>> = []
        const accepting = runnerOf({ platform: "linux", exec: (argv) => Effect.sync((): Ran => (asked.push(argv), { exitCode: 0, stdout: "", stderr: "" })) })
        const spec = specOf("true")
        const launched = yield* accepting.launch(spec)
        expect(launched).toMatchObject({ how: "systemd", unit: `opencode-job-${spec.id}` })
        expect(asked[0]?.slice(0, 7)).toEqual(["systemd-run", "--user", "--unit", `opencode-job-${spec.id}`, "--collect", "--quiet", "--"])
        expect((yield* accepting.read(spec.id))?.unit).toBe(`opencode-job-${spec.id}`)

        const refusing = runnerOf({ platform: "linux", exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "Failed to connect to bus" }) })
        const other = specOf("exit 0")
        const fallback = yield* refusing.launch(other)
        expect(fallback.how).toBe("detached")
        expect(fallback.warning).toContain("Failed to connect to bus")
        expect(yield* until(runner, other.id, ended)).toMatchObject({ state: "ended", exit: { exitCode: 0 } })
      }),
    ))
})

describe("a heavy job's command goes through the guard's launcher", () => {
  test("on a systemd host it runs niced in a user scope with MemoryMax=12G; a light one runs as is", () => {
    expect(argvOf({ command: "bun test", heavy: true }, true)).toEqual([
      "nice", "-n", "10",
      "systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", "MemoryMax=12G", "-p", "CPUWeight=20", "--",
      "/bin/sh", "-c", "bun test",
    ])
    expect(argvOf({ command: "bun test", heavy: false }, true)).toEqual(["/bin/sh", "-c", "bun test"])
  })

  test("on the Mac it runs niced alone", () => {
    expect(argvOf({ command: "bun test", heavy: true }, false)).toEqual(["nice", "-n", "10", "/bin/sh", "-c", "bun test"])
  })

  test("a scope is available only on Linux, when the probe exits 0", () => {
    expect(scopeAvailable("darwin", ["true"])).toBe(false)
    expect(scopeAvailable("linux", ["true"])).toBe(true)
    expect(scopeAvailable("linux", ["false"])).toBe(false)
    expect(scopeAvailable("linux", ["/nonexistent/loop-probe-x"])).toBe(false)
  })
})
