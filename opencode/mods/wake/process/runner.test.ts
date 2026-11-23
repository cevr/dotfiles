// @reads all
// @reads-reason computed read at mods/wake/process/runner.test.ts: expect(existsSync(root)).toBe(false)
// The process runner over real processes in a scratch directory: a job runs
// detached under its own runner, records its exit, drips whole lines, keeps
// its log, runs niced when heavy, stops at its timeout and on a kill; a
// runner gone without an exit reads lost. On Linux, `systemd-run --user`
// is asked first, and a refusal falls back to a detached runner with a warning.
import { describe, expect, test } from "bun:test"
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Console, Context, Effect, Exit, Layer, Logger, Match, Option, Ref, Result, Schema, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { JobExit, type JobRecord, type JobSpec, type Run } from "../job.ts"
import { RunnerClaim } from "../job-event.ts"
import * as MemoryBackstop from "../memory/backstop.ts"
import * as MemoryChecks from "../memory/checks.ts"
import * as MemoryCourier from "../memory/courier.ts"
import * as MemoryOpener from "../memory/opener.ts"
import * as MemoryStore from "../memory/store.ts"
import * as Model from "../model.ts"
import { type CallAnswer, Changes, Runner, WakeStore } from "../service.ts"
import * as ProcessRunner from "./runner.ts"
import { argvOf, claim, type Disk, FILES, hostOf, NODE_DISK, processStart, ranOf, removeDurable, scopeAvailable, UNSEALED_ROOT, writeAtomic, writeDurable, writeExit } from "./supervise.ts"
import type { Ran } from "../cron/backstop.ts"
import { bounded, notYet, type Observation, type Policy, ready, type TestBounds, testLimitMs, waitFor } from "./readiness.ts"

/** How long a job gets to reach the state a test waits for, probed every 50 ms. */
const PATIENT: Policy = { within: "10 seconds", every: "50 millis" }

/** A module beside this test, as a scratch script imports it. */
const sourceAt = (file: string) => path.join(import.meta.dir, file)
const besideThis = (file: string) => JSON.stringify(sourceAt(file))
const mac = process.platform === "darwin"

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

/** The states of jobs `ids`, as one line. */
const statesOf = (runner: JobRunner, ids: ReadonlyArray<string>) =>
  Effect.map(
    Effect.forEach(ids, (id) => Effect.map(runner.read(id), (record) => `${id} ${Option.match(Option.fromUndefinedOr(record), { onNone: () => "gone", onSome: ({ run }) => run.state })}`)),
    (states) => states.join(", "),
  )

/** What the release saw of the jobs it killed when it removed the directory. */
type Removal = (scratch: string, states: string) => Effect.Effect<void>

/**
 * Releases a scratch directory: each job whose runner is still up is killed through the runner and
 * waited for, all at once and within one wait, until none reads running; only then is the
 * directory removed, so no runner writes into a removed directory. A job that outlasts the wait
 * keeps the directory. `removed` hears the killed jobs' states read just before the removal.
 */
const release = Effect.fn("RunnerTest.release")(function* (scratch: string, runner: JobRunner, removed: Removal) {
  const open = yield* runningJobs(scratch, runner)
  yield* Effect.forEach(open, (id) => runner.kill(id), { discard: true })
  const settled = Effect.map(Effect.forEach(open, (id) => runner.read(id)), (records): Observation<number> => {
    const up = records.filter((record) => Option.exists(Option.fromUndefinedOr(record), ({ run }) => run.state === "running")).length
    if (up === 0) return ready(open.length)
    return notYet(`${up} of ${open.length} running`)
  })
  yield* waitFor(`the killed jobs of ${scratch}`, settled, PATIENT).pipe(
    Effect.andThen(statesOf(runner, open)),
    Effect.tap((states) => removed(scratch, states)),
    Effect.andThen(Effect.sync(() => rmSync(scratch, { recursive: true, force: true }))),
    Effect.catchTag("ReadinessTimeout", (timeout) => Effect.logWarning(`kept ${scratch}: ${timeout.label} still read ${timeout.last}`)),
  )
})

/**
 * A scratch directory with the runner's entry and a runner over it, removed when the test's scope
 * closes. The entry supervises with a kill grace long enough that a loaded machine's SIGTERM ends
 * a plain group within it, and no notify.
 */
const fixtureHeard = (removed: Removal) => Effect.acquireRelease(
  Effect.sync(() => {
    const scratch = mkdtempSync(path.join(tmpdir(), "opencode-job-test-"))
    const script = path.join(scratch, "job.ts")
    writeFileSync(script, `import { supervise } from ${besideThis("supervise.ts")}\nawait supervise(process.argv[2], undefined, 2000)\nprocess.exit(0)\n`)
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
  ({ scratch, runner }) => release(scratch, runner, removed),
)

const fixture = fixtureHeard(() => Effect.void)

/** What a test gets: its scratch directory, a spec maker with ids unique in it, and runners over it. */
interface Fixture {
  readonly scratch: string
  readonly specOf: (command: string, more?: Partial<JobSpec>) => JobSpec
  readonly runnerOf: (config?: Partial<ProcessRunner.Config>) => JobRunner
  readonly runner: JobRunner
}

/** A runner test's bounds: a body of a few waits of `PATIENT` each, and a release of one such wait. */
const BOUNDS: TestBounds = { body: "40 seconds", release: PATIENT.within }

test("a held call's server identity distinguishes this process from another incarnation of its pid", () => {
  const identity = ProcessRunner.serverHere()
  expect(ProcessRunner.serverRuns(identity)).toBe(true)
  expect(ProcessRunner.serverRuns(identity, () => Option.some("not this process's start"))).toBe(false)
  expect(ProcessRunner.serverRuns(identity, () => Option.none())).toBe(true)
})

/** The one Bun test of this file that runs an Effect: bounded below its Bun limit, so its scope closes and its release runs first. */
const limitedTest = <A, E>(name: string, body: Effect.Effect<A, E, Scope.Scope>) => test(name, () => Effect.runPromise(bounded(name, body, BOUNDS)), testLimitMs(BOUNDS))

/** A limited test whose body gets a fixture of its own, released when the test ends. */
const fixtureTest = <A, E>(name: string, body: (fixture: Fixture) => Effect.Effect<A, E, Scope.Scope>) => limitedTest(name, Effect.flatMap(fixture, body))

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

fixtureTest("job root layout matrix on the real filesystem", ({ scratch, runnerOf, specOf }) =>
  Effect.gen(function* () {
    for (const provisioned of [true, false]) {
      for (const readable of [true, false]) {
        for (const peerSynced of [true, false]) {
          const spec = specOf("printf root-layout", { generation: 1 })
          const parent = path.join(scratch, spec.id)
          const root = path.join(parent, "job-state")
          yield* Effect.scoped(Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => mkdirSync(parent, { mode: 0o700 })),
              () => Effect.sync(() => chmodSync(parent, 0o700)),
            )
            if (provisioned) {
              mkdirSync(root)
              NODE_DISK.syncDir(parent)
            }
            if (!readable) {
              // Owner can search and create, not enumerate or open the parent for syncing.
              chmodSync(parent, 0o311)
              const cannotOpen = yield* Effect.exit(Effect.sync(() => NODE_DISK.syncDir(parent)))
              expect(Exit.isFailure(cannotOpen)).toBe(true)
            }
            let peerMade = false
            let parentSyncs = 0
            const peerDir = path.join(root, spec.id)
            const disk: Disk = {
              ...NODE_DISK,
              syncDir: (dir) => {
                if (dir === parent) parentSyncs += 1
                NODE_DISK.syncDir(dir)
              },
              named: (file) => {
                if (file === peerDir && !peerMade && NODE_DISK.named(root)) {
                  peerMade = true
                  // Another writer creates a real name just before this writer looks it up.
                  NODE_DISK.mkdir(peerDir)
                  if (peerSynced) NODE_DISK.syncDir(root)
                }
                return NODE_DISK.named(file)
              },
            }
            const runner = runnerOf({ root, disk })
            const launched = yield* runner.launch(spec).pipe(Effect.result)
            if (provisioned || readable) {
              expect(launched._tag).toBe("Success")
              const run = yield* until(runner, spec.id, ended)
              expect(run.state === "ended" && run.exit.exitCode).toBe(0)
              expect(yield* runner.tail(spec.id, 32)).toBe("root-layout")
              expect(peerMade).toBe(true)
              expect(parentSyncs > 0).toBe(!provisioned)
            } else {
              const refused = Option.getOrThrow(Result.getFailure(launched))
              expect(refused._tag).toBe("JobRefused")
              expect(refused.message).toContain(parent)
              expect(refused.message).toContain("Pre-provision")
              expect(existsSync(root)).toBe(false)
              expect(peerMade).toBe(false)
            }
            const layout = [provisioned && "provisioned" || "new", readable && "readable" || "traverse-only", peerSynced && "peer-synced" || "peer-unsynced"]
            yield* Console.log(`job root layout: ${layout.join(" / ")}: ${launched._tag}`)
          }))
        }
      }
    }
  }),
)

const runRootHandoff = (root: string) => {
  const script = sourceAt("../../../cmd/wake/job.ts")
  const run = Option.getOrThrow(ranOf(["bun", script, "--seal-root", root]))
  expect(run.exitCode).toBe(0)
}

const expectRootRefusal = (runner: JobRunner, spec: JobSpec, root: string) =>
  Effect.gen(function* () {
    const refusal = Option.getOrThrow(Result.getFailure(yield* Effect.result(runner.launch(spec))))
    expect(refusal._tag).toBe("JobRefused")
    expect(refusal.message).toContain(`'--seal-root' '${root}'`)
    expect(existsSync(path.join(root, spec.id))).toBe(false)
    expect(existsSync(path.join(root, UNSEALED_ROOT))).toBe(true)
  })

fixtureTest("job root permissions handoff after publication cut on the real filesystem", ({ scratch, runnerOf, specOf }) =>
  Effect.gen(function* () {
    for (const [mode, parentSynced] of [[0o555, false], [0o555, true], [0o311, false], [0o311, true]] as const) {
        yield* Effect.scoped(Effect.gen(function* () {
          const spec = specOf("printf handoff", { generation: 1 })
          const parent = path.join(scratch, spec.id)
          const root = path.join(parent, "job-state")
          const marker = path.join(root, UNSEALED_ROOT)
          yield* Effect.acquireRelease(
            Effect.sync(() => mkdirSync(parent, { mode: 0o755 })),
            () => Effect.sync(() => chmodSync(parent, 0o700)),
          )
          let stopped = false
          const first = runnerOf({ root, disk: {
            ...NODE_DISK,
            syncDir: (dir) => {
              if (!parentSynced && dir === parent && NODE_DISK.named(root)) {
                stopped = true
                lost()
              }
              NODE_DISK.syncDir(dir)
            },
            unlink: (file) => {
              if (parentSynced && file === marker) {
                stopped = true
                lost()
              }
              NODE_DISK.unlink(file)
            },
            create: (file, permissions) => {
              if (stopped) lost()
              return NODE_DISK.create(file, permissions)
            },
            mkdir: (dir) => {
              if (stopped) lost()
              NODE_DISK.mkdir(dir)
            },
          } })
          expect(Result.isFailure(yield* Effect.result(first.launch(spec)))).toBe(true)
          expect(stopped && existsSync(marker)).toBe(true)
          chmodSync(parent, mode)
          let viaVolume = false
          const second = runnerOf({ root, disk: {
            ...NODE_DISK,
            syncVolume: (dir) => {
              viaVolume = NODE_DISK.syncVolume(dir)
              return viaVolume
            },
          } })
          if (mode === 0o311 && mac) {
            yield* expectRootRefusal(second, spec, root)
            chmodSync(parent, 0o555)
            runRootHandoff(root)
            expect(existsSync(marker)).toBe(false)
            chmodSync(parent, mode)
          }
          const resumed = runnerOf({ root })
          const active = (mode === 0o311 && mac && resumed) || second
          expect((yield* active.launch(spec)).how).toBe("detached")
          const run = yield* until(active, spec.id, ended)
          expect(run.state === "ended" && run.exit.exitCode).toBe(0)
          expect(viaVolume).toBe(mode === 0o311 && !mac)
          expect(existsSync(marker)).toBe(false)
          yield* Console.log(`job root handoff: parent ${mode.toString(8)}, cut ${parentSynced && "after" || "before"} parent sync, certified via ${viaVolume && "volume" || mode === 0o311 && "operator" || "parent"}`)
        }))
    }
  }),
)

fixtureTest("a certified job root remains usable when marker cleanup fails; the operator can clear it", ({ scratch, runnerOf, specOf }) =>
  Effect.gen(function* () {
    const root = path.join(scratch, "handoff")
    const marker = path.join(root, UNSEALED_ROOT)
    const writer = runnerOf({ root, disk: {
      ...NODE_DISK,
      unlink: (file) => {
        if (file === marker) permissionDenied()
        NODE_DISK.unlink(file)
      },
    } })
    const spec = specOf("true", { generation: 1 })
    const launched = yield* writer.launch(spec)
    expect(launched.how).toBe("detached")
    yield* until(writer, spec.id, ended)
    // A detached supervisor can also certify and clear it. Plant a conservative marker on the already sealed root.
    writeAtomic(marker, {})
    runRootHandoff(root)
    expect(existsSync(marker)).toBe(false)
  }),
)

describe("the process runner", () => {
  fixtureTest("runs the command detached, keeps its log, and records its exit code", ({ runner, specOf }) =>
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
  )

  fixtureTest("names the progress file in $JOB_DRIP and hands back whole lines from an offset", ({ runner, specOf }) =>
    Effect.gen(function* () {
      const spec = specOf('printf "one\\ntwo\\nhalf" >> "$JOB_DRIP"; echo "$JOB_ID"')
      yield* runner.launch(spec)
      yield* until(runner, spec.id, ended)
      const first = yield* runner.drip(spec.id, 0)
      expect(first.text).toBe("one\ntwo\n")
      expect(yield* runner.drip(spec.id, first.offset)).toEqual({ text: "", offset: first.offset })
      expect(yield* runner.tail(spec.id, 100)).toBe(`${spec.id}\n`)
    }),
  )

  fixtureTest("leaves BASH_ENV out of the command's environment and runs a heavy one niced", ({ runner, runnerOf, specOf }) =>
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
      expect(yield* niceness(heavy.id)).toBe(Math.min(mac ? 20 : 19, (yield* niceness(light.id)) + 10))
    }),
  )

  fixtureTest("stops the command at its timeout", ({ runner, specOf }) =>
    Effect.gen(function* () {
      const spec = specOf("sleep 30", { timeoutSeconds: 0.3 })
      yield* runner.launch(spec)
      const run = yield* until(runner, spec.id, ended)
      expect(run.state === "ended" && run.exit).toMatchObject({ exitCode: null, signal: "SIGTERM", timedOut: true, killed: false })
    }),
  )

  fixtureTest("a kill stops the running command's group as killed; an ended job is not asked", ({ runner, specOf }) =>
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
  )

  fixtureTest("a kill records the signal even when the command's shell outlives it and exits 0", ({ runner, specOf }) =>
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
  )

  fixtureTest("a kill ends every process of the group, one that ignores SIGTERM too, before the exit is recorded", ({ runner, specOf }) =>
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
  )

  fixtureTest("a kill the moment the job reads running ends it as killed, never lost", ({ runner, scratch, specOf }) =>
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
  )

  fixtureTest("a runner gone without an exit reads lost; one never up reads starting; an unknown id reads nothing", ({ runner, scratch, specOf }) =>
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
  )

  limitedTest(
    "a test's scope closing on a job still running kills it, and removes the scratch directory only once the runner recorded the kill",
    Effect.gen(function* () {
      const heard = yield* Ref.make<ReadonlyArray<string>>([])
      const left = yield* Effect.scoped(
        Effect.gen(function* () {
          const { runner, scratch, specOf } = yield* fixtureHeard((dir, states) => Ref.update(heard, (seen) => [...seen, `${states}; directory there: ${existsSync(dir)}`]))
          const spec = specOf("sleep 30")
          yield* runner.launch(spec)
          yield* until(runner, spec.id, (run) => run.state === "running")
          const up = Schema.decodeUnknownSync(RunnerFile)(readFileSync(path.join(scratch, "jobs", spec.id, FILES.runner), "utf8"))
          return { scratch, pid: up.pid, id: spec.id }
        }),
      )
      expect(yield* Ref.get(heard)).toEqual([`${left.id} ended; directory there: true`])
      expect(existsSync(left.scratch)).toBe(false)
      yield* waitFor(`the released job's runner ${left.pid} gone`, gone(left.pid), PATIENT)
      expect(ProcessRunner.alive(left.pid)).toBe(false)
    }),
  )

  fixtureTest("on Linux it asks systemd-run --user for a unit, and runs detached with a warning when refused", ({ runner, runnerOf, specOf }) =>
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
  )
})

/** A scratch directory of the test's, removed when its scope closes. */
const scratchDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), prefix))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )

/** What the runner logged, by message, kept for the test to read. */
const logged: Array<unknown> = []
const KEEP_LOGS = Logger.layer([Logger.make(({ message }) => void logged.push(message))])

/** A live process's pid that is not this one's: launchd's or init's. */
const OTHER_LIVE = 1
/** A pid no process has. */
const NO_PROCESS = 2 ** 22 + 12_345

describe("the runner's claim and its exit", () => {
  limitedTest(
    "the first claim wins and a second finds it; the claim names its process with that process's start",
    Effect.gen(function* () {
      const dir = yield* scratchDir("opencode-job-claim-")
      expect([claim(dir, 7, OTHER_LIVE), claim(dir, 8, OTHER_LIVE)]).toEqual([true, false])
      const held = Schema.decodeUnknownSync(Schema.fromJsonString(RunnerClaim))(readFileSync(path.join(dir, FILES.runner), "utf8"))
      expect({ pid: held.pid, startedAt: held.startedAt, start: Option.fromNullishOr(held.start) }).toEqual({ pid: OTHER_LIVE, startedAt: 7, start: processStart(OTHER_LIVE) })
      expect(Option.isSome(processStart(OTHER_LIVE))).toBe(true)
      // No temporary claim is left behind.
      expect(readdirSync(dir)).toEqual([FILES.runner])
    }),
  )

  test("a claim is the process only while its start matches: a reused pid is not it; a start ps cannot read holds it", () => {
    const own = { pid: OTHER_LIVE, startedAt: 1, start: "then" }
    expect([
      ProcessRunner.claimed(own, () => Option.some("then")),
      ProcessRunner.claimed(own, () => Option.some("another time")),
      ProcessRunner.claimed(own, () => Option.none()),
      ProcessRunner.claimed({ pid: OTHER_LIVE, startedAt: 1 }, () => Option.some("anything")),
      ProcessRunner.claimed({ pid: NO_PROCESS, startedAt: 1, start: "then" }, () => Option.some("then")),
    ]).toEqual([true, false, true, true, false])
  })

  fixtureTest("a process out of open files: the real fs.watch refuses with EMFILE, the job is not watched and the refusal is logged with that code; with files again it is", ({ scratch, runner, specOf }) =>
    Effect.gen(function* () {
      const id = specOf("true").id
      mkdirSync(path.join(scratch, "jobs", id), { recursive: true })
      // Every descriptor this process may open, held while the watch opens, then closed.
      const held: Array<number> = []
      const open = Option.liftThrowable(() => openSync("/dev/null", "r"))
      const refused = yield* Effect.sync(() => {
        for (let fd = open(); Option.isSome(fd); fd = open()) held.push(fd.value)
      }).pipe(
        Effect.andThen(runner.watch(id, () => {})),
        Effect.ensuring(Effect.sync(() => held.splice(0).forEach((fd) => closeSync(fd)))),
      )
      expect({ refused, watching: yield* runner.watching, logged }).toEqual({ refused: false, watching: [], logged: [["wake: a job is not watched; the sweep finds its end", { id, code: "EMFILE" }]] })
      expect(yield* runner.watch(id, () => {})).toBe(true)
      expect(yield* runner.watching).toEqual([id])
      yield* runner.unwatch(id)
    }).pipe(Effect.provide(KEEP_LOGS)),
  )

  limitedTest(
    "an exit write that fails is tried again; one that never goes through says so",
    Effect.gen(function* () {
      const dir = yield* scratchDir("opencode-job-exit-")
      // Inject a one-time failure at the writer port, not a missing directory (the writer now creates it).
      const late = path.join(dir, "late")
      const tries = { count: 0 }
      const transient = (file: string, value: JobExit) => {
        tries.count += 1
        if (tries.count === 1) lost()
        writeAtomic(file, value)
      }
      const exit: JobExit = { exitCode: 0, startedAt: 1, endedAt: 2, timedOut: false, killed: false, disposition: "succeeded", generation: 1, sequence: 1 }
      expect(yield* writeExit(late, exit, transient)).toBe(true)
      expect(tries.count).toBe(2)
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(JobExit))(readFileSync(path.join(late, FILES.exit), "utf8"))).toEqual(exit)
      expect(yield* writeExit(late, exit, () => lost())).toBe(false)
    }),
  )
})

/**
 * A writer of a job's record that kills itself (SIGKILL, as a crash would) at `barrier` of its one write: `write` is
 * `claim` (the supervisor's launch claim), `retire` (a sweep's retirement) or `advance` (delivery slot 1). The script
 * is written into the scratch directory and run by this bun.
 */
const killedAt = (scratch: string, dir: string, write: "claim" | "retire" | "advance", barrier: "temp" | "named") => {
  const script = path.join(scratch, "writer.ts")
  writeFileSync(
    script,
    [
      `import { claim } from ${besideThis("supervise.ts")}`,
      `import { advanceIn, retireIn } from ${besideThis("runner.ts")}`,
      `const [dir, write, barrier] = process.argv.slice(2)`,
      `const stop = (at: string) => { if (at === barrier) process.kill(process.pid, "SIGKILL") }`,
      `if (write === "claim") claim(dir, 1, process.pid, stop)`,
      `if (write === "retire") retireIn(dir, 1, stop)`,
      `if (write === "advance") advanceIn(dir, 0, { state: "delivering", delivery: "msg_d1", attempt: "a1", holder: { kind: "letter" } }, stop)`,
      `console.log("not killed")`,
    ].join("\n"),
  )
  return Option.getOrElse(
    Option.map(ranOf([process.execPath, script, dir, write, barrier]), (ran) => ran.signalCode),
    () => "did not start",
  )
}

/** A run as the outcomes name it: its state, and why when it is lost. */
const said = (run: Run) =>
  Match.value(run).pipe(
    Match.when({ state: "lost" }, (lost) => `lost: ${lost.cause}`),
    Match.orElse((other) => other.state),
  )

describe("a record write killed at each barrier, then reopened", () => {
  limitedTest(
    "killed after its temporary file synced, a write took nothing: the next writer wins the slot; killed after it took the name, it holds the slot whole and the next writer loses",
    Effect.gen(function* () {
      const scratch = yield* scratchDir("opencode-job-barrier-")
      const outcomes: Array<unknown> = []
      for (const barrier of ["temp", "named"] as const) {
        // The supervisor's claim, then a sweep's retirement against it.
        const launch = path.join(scratch, `claim-${barrier}`)
        mkdirSync(launch)
        const claimed = killedAt(scratch, launch, "claim", barrier)
        outcomes.push({ write: "claim", barrier, signal: claimed, run: said(ProcessRunner.runOf(launch)), retired: ProcessRunner.retireIn(launch, 2) })
        // A sweep's retirement, then the supervisor's claim against it.
        const fence = path.join(scratch, `retire-${barrier}`)
        const retiredBy = killedAt(scratch, fence, "retire", barrier)
        outcomes.push({ write: "retire", barrier, signal: retiredBy, run: said(ProcessRunner.runOf(fence)), claimed: claim(fence, 2, OTHER_LIVE) })
        // A delivery claim, then another location's claim of the same slot.
        const delivery = path.join(scratch, `advance-${barrier}`)
        mkdirSync(delivery)
        const advanced = killedAt(scratch, delivery, "advance", barrier)
        const reopened = Option.map(ProcessRunner.slotOf(delivery), (slot) => ({ version: slot.version, attempt: slot.delivery.attempt }))
        const next = ProcessRunner.advanceIn(delivery, 0, { state: "delivering", delivery: "msg_d1", attempt: "a2", holder: { kind: "letter" } })
        outcomes.push({ write: "advance", barrier, signal: advanced, reopened, next })
      }
      expect(outcomes).toEqual([
        // At `temp`: the stray temporary file is no claim; the job reads starting, and the retirement wins.
        { write: "claim", barrier: "temp", signal: "SIGKILL", run: "starting", retired: true },
        { write: "retire", barrier: "temp", signal: "SIGKILL", run: "starting", claimed: true },
        { write: "advance", barrier: "temp", signal: "SIGKILL", reopened: Option.none(), next: true },
        // At `named`: the claim is whole; its runner is dead, so it reads lost, and the retirement loses.
        { write: "claim", barrier: "named", signal: "SIGKILL", run: "lost: runner-gone", retired: false },
        { write: "retire", barrier: "named", signal: "SIGKILL", run: "lost: never-started", claimed: false },
        { write: "advance", barrier: "named", signal: "SIGKILL", reopened: Option.some({ version: 1, attempt: "a1" }), next: false },
      ])
    }),
  )
})

describe("a heavy job's command goes through the guard's launcher", () => {
  test("on a systemd host it runs niced in the idle I/O class and a user scope with MemoryMax=12G; a light one runs as is", () => {
    const linux = () => ({ scope: true, ionice: true })
    expect(argvOf({ command: "bun test", heavy: true }, linux)).toEqual([
      "nice", "-n", "10",
      "ionice", "-c3",
      "systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", "MemoryMax=12G", "-p", "CPUWeight=20", "--",
      "/bin/sh", "-c", "bun test",
    ])
    expect(argvOf({ command: "bun test", heavy: false }, () => expect.unreachable("a light job asks no host"))).toEqual(["/bin/sh", "-c", "bun test"])
  })

  test("on the Mac it runs niced alone", () => {
    expect(argvOf({ command: "bun test", heavy: true }, () => ({ scope: false, ionice: false }))).toEqual(["nice", "-n", "10", "/bin/sh", "-c", "bun test"])
    expect(hostOf("darwin")).toEqual({ scope: false, ionice: false })
  })

  test("a scope is available only on Linux, when the probe exits 0", () => {
    expect(scopeAvailable("darwin", ["true"])).toBe(false)
    expect(scopeAvailable("linux", ["true"])).toBe(true)
    expect(scopeAvailable("linux", ["false"])).toBe(false)
    expect(scopeAvailable("linux", ["/nonexistent/loop-probe-x"])).toBe(false)
  })
})

// ── A power loss at every step of every record transition ──
//
// The record is written through `Disk` (supervise.ts). `crashDisk` is a disk a power loss can hit: a file's data is
// kept only once `sync` returned on it (else it is lost or torn to a prefix: the model takes the empty one, one byte,
// half and all but its last byte, and the whole), a name made, replaced or removed in a directory (create, link,
// rename, unlink, mkdir) only once `syncDir` returned on that directory (else each such operation may or may not
// survive: every subset, applied in order), and a name under a directory that did not survive is gone with it. The
// wakes run on it through the process runner and the model, with two actors outside the disk that act only on what a
// call returned: the job's supervisor, which runs its command once its claim won, and the host, which keeps the answer
// the model gave its owner's call. Each history runs once to count its disk calls, then once with the power lost
// before each of them; every state that loss may leave is reopened by a new server over it (its start and sweeps) and
// a supervisor that comes late. Then: one launcher, no command run once its job was announced never started, the end
// given once (one committed answer or one letter) and never lost, with the kind the exit said when the supervisor
// saw it written, and no torn file read as a record.

/** The power went: every disk call from here fails. */
class PowerLost extends Schema.TaggedError<PowerLost>()("PowerLost", {}) {}

interface Inode {
  data: string
  synced: string
}

/** A name operation not yet synced into its directory: it may or may not survive a loss. */
interface NameOp {
  readonly dir: string
  readonly apply: (names: Map<string, number>, dirs: Set<string>) => void
}

interface Crash {
  readonly disk: Disk
  /** The disk calls made so far. */
  readonly calls: () => number
  /** Every state a loss now may leave, as fresh disks; each state once. */
  readonly outcomes: () => Iterable<Crash>
  /** Every whole content a writer gave a file: a record read from the disk must be one of these. */
  readonly written: Set<string>
  /** The first process stopped, not the disk; another writer can still see its unsynced names. */
  readonly resume: () => void
}

/** Every byte-prefix of the model's ASCII wire fixtures, including loss and the whole write. */
const tornOf = (data: string) => Array.from({ length: data.length + 1 }, (_, at) => data.slice(0, at))

/** The Cartesian product, streamed so a broken write protocol can stop at its first counterexample. */
function* selections<A>(choices: ReadonlyArray<ReadonlyArray<A>>, index = 0, prefix: ReadonlyArray<A> = []): IterableIterator<ReadonlyArray<A>> {
  if (index === choices.length) {
    yield prefix
    return
  }
  for (const each of got(choices[index])) yield* selections(choices, index + 1, [...prefix, each])
}

/** Every ordered subset, without building every pending name tree at once. */
const subsets = <A>(items: ReadonlyArray<A>): Iterable<ReadonlyArray<A>> =>
  (function* () {
    for (const each of selections(items.map((item) => [Option.none<A>(), Option.some(item)]))) yield each.flatMap(Option.toArray)
  })()

const lost = <A>(): A => Option.getOrThrowWith(Option.none<A>(), () => new PowerLost())
const got = <A>(value: A): NonNullable<A> => Option.getOrThrow(Option.fromNullishOr(value))

/** A disk whose power goes before its call number `lossAt`, starting from `files` and `dirs`, all of them on disk. */
const crashDisk = (lossAt: number, files: ReadonlyMap<string, string>, dirs: ReadonlySet<string>): Crash => {
  const inodes: Array<Inode> = []
  const names = new Map<string, number>()
  const present = new Set(dirs)
  const durable = { names: new Map<string, number>(), dirs: new Set(dirs) }
  for (const [file, data] of files) {
    inodes.push({ data, synced: data })
    names.set(file, inodes.length - 1)
    durable.names.set(file, inodes.length - 1)
  }
  const pending: Array<NameOp> = []
  const fds = new Map<number, number>()
  const written = new Set<string>(files.values())
  const state = { calls: 0, fds: 2, lossAt, stages: 0 }
  const call = <A>(run: () => A): A => {
    state.calls += 1
    if (state.calls >= state.lossAt) return lost<A>()
    return run()
  }
  const named = (dir: string, apply: NameOp["apply"]) => {
    apply(names, present)
    pending.push({ dir, apply })
  }
  const inodeOf = (fd: number) => got(inodes[got(fds.get(fd))])
  const disk: Disk = {
    create: (file) =>
      call(() => {
        inodes.push({ data: "", synced: "" })
        const inode = inodes.length - 1
        named(path.dirname(file), (into) => void into.set(file, inode))
        state.fds += 1
        fds.set(state.fds, inode)
        return state.fds
      }),
    write: (fd, data) =>
      call(() => {
        const inode = inodeOf(fd)
        inode.data += data
        written.add(inode.data)
      }),
    sync: (fd) =>
      call(() => {
        const inode = inodeOf(fd)
        inode.synced = inode.data
      }),
    close: (fd) => call(() => void fds.delete(fd)),
    syncDir: (dir) =>
      call(() => {
        for (const op of pending.filter((each) => each.dir === dir)) op.apply(durable.names, durable.dirs)
        pending.splice(0, pending.length, ...pending.filter((each) => each.dir !== dir))
      }),
    link: (from, to) =>
      call(() => {
        if (names.has(to)) return false
        const inode = got(names.get(from))
        named(path.dirname(to), (into) => void into.set(to, inode))
        return true
      }),
    rename: (from, to) =>
      call(() => {
        const inode = got(names.get(from))
        named(path.dirname(to), (into) => {
          into.delete(from)
          into.set(to, inode)
        })
      }),
    unlink: (file) => call(() => named(path.dirname(file), (into) => void into.delete(file))),
    mkdir: (dir) =>
      call(() => {
        if (!present.has(dir)) named(path.dirname(dir), (_into, made) => void made.add(dir))
      }),
    read: (file) => call(() => Option.map(Option.fromNullishOr(names.get(file)), (inode) => got(inodes[inode]).data)),
    list: (dir) =>
      call(() => [...new Set([...names.keys(), ...present].flatMap((each) => Option.toArray(Option.liftPredicate(each, (one) => one !== dir && path.dirname(one) === dir)).map((one) => path.basename(one))))]),
    named: (name) => call(() => names.has(name) || present.has(name)),
    stage: (parent) => call(() => {
      const dir = path.join(parent, `.wake-stage-${++state.stages}`)
      named(parent, (_into, made) => void made.add(dir))
      return dir
    }),
    publish: (from, to) => call(() => {
      if (present.has(to) || names.has(to)) return false
      const children = [...names.keys()].filter((name) => name.startsWith(`${from}/`))
      named(path.dirname(to), (into, made) => {
        made.delete(from)
        made.add(to)
        for (const child of children) {
          for (const inode of Option.toArray(Option.fromUndefinedOr(into.get(child)))) into.set(`${to}${child.slice(from.length)}`, inode)
          into.delete(child)
        }
      })
      return true
    }),
    syncVolume: () => call(() => {
      for (const op of pending) op.apply(durable.names, durable.dirs)
      pending.length = 0
      return true
    }),
  }
  function* outcomes(): IterableIterator<Crash> {
    const seen = new Set<string>()
    for (const kept of subsets(pending)) {
      const keptNames = new Map(durable.names)
      const keptDirs = new Set(durable.dirs)
      for (const op of kept) op.apply(keptNames, keptDirs)
      // A directory, and every name under it, is there only when each directory above it is.
      const reachable = (dir: string): boolean => dirs.has(dir) || (keptDirs.has(dir) && reachable(path.dirname(dir)))
      const live = [...keptNames].filter(([file]) => reachable(path.dirname(file)))
      // A file whose data was not synced is left at any of its prefixes. Linked names share that same inode.
      const choices = [...new Set(live.map(([, inode]) => inode))].map((inode) => {
        const node = got(inodes[inode])
        return Match.value(node.data === node.synced).pipe(
          Match.when(true, () => [[inode, node.data] as const]),
          Match.orElse(() => tornOf(node.data).map((data) => [inode, data] as const)),
        )
      })
      const keptDirList = [...keptDirs].filter(reachable).toSorted()
      for (const tree of selections(choices)) {
        const bytes = new Map(tree)
        const files = live.map(([file, inode]) => [file, got(bytes.get(inode))] as const)
        const key = [...files.map(([file, data]) => `${file}=${data}`).toSorted(), "|", ...keptDirList].join("\n")
        if (seen.has(key)) continue
        seen.add(key)
        yield crashDisk(Number.POSITIVE_INFINITY, new Map(files), new Set(keptDirList))
      }
    }
  }
  return { disk, calls: () => state.calls, outcomes, written, resume: () => { state.lossAt = Number.POSITIVE_INFINITY } }
}

const CRASH_ROOT = "/r/jobs"
const CRASH_DIRS = new Set(["/", "/r", CRASH_ROOT])
const CRASH_OWNER = "ses_crash"
const CRASH_HOME = "/work/crash"
const CRASH_DESTINATION = "/work/moved"

const permissionDenied = () => Option.getOrThrowWith(Option.none<never>(), () => ({ code: "EACCES" }))

const parentMode = (disk: Disk, mode: number, supported: boolean): Disk => ({
  ...disk,
  stage: (parent) => {
    if (mode === 0o555) permissionDenied()
    return disk.stage(parent)
  },
  syncDir: (dir) => {
    if (dir === "/r" && mode === 0o311) permissionDenied()
    disk.syncDir(dir)
  },
  syncVolume: (dir) => supported && disk.syncVolume(dir),
})

const checkReopenedRoot = (image: Disk, original: boolean, peer: boolean, rootExists: boolean) => {
  if (original) expect(image.read(path.join(CRASH_ROOT, "first.json"))).toEqual(Option.some('{"actor":1}'))
  if (peer) expect(image.read(path.join(CRASH_ROOT, "peer.json"))).toEqual(Option.some('{"actor":2}'))
  // Refusal before publication never made a root.
  if (!rootExists && !peer) expect(image.named(CRASH_ROOT)).toBe(false)
}

limitedTest("a peer can arrive at every job root creation cut under changed permissions",
  Effect.gen(function* () {
    const file = path.join(CRASH_ROOT, "first.json")
    const peer = path.join(CRASH_ROOT, "peer.json")
    const directories = new Set(["/", "/r"])
    const newDisk = (cut: number) => crashDisk(cut, new Map(), directories)
    const first = (disk: Disk) => writeAtomic(file, { actor: 1 }, 0o600, disk, CRASH_ROOT)
    const counted = newDisk(Number.POSITIVE_INFINITY)
    first(counted.disk)
    const cuts = counted.calls() + 1
    let recovered = 0
    for (let cut = 1; cut <= cuts; cut++) {
      for (const [mode, supported] of [[0o755, true], [0o555, true], [0o311, true], [0o311, false]] as const) {
        const crash = newDisk(cut)
        const { disk } = crash
        const original = yield* Effect.exit(Effect.sync(() => first(disk)))
        crash.resume()
        const rootExists = disk.named(CRASH_ROOT)
        const firstUnsealed = disk.named(path.join(CRASH_ROOT, UNSEALED_ROOT))
        const second = parentMode(disk, mode, supported)
        const ack = yield* Effect.exit(Effect.sync(() => writeAtomic(peer, { actor: 2 }, 0o600, second, CRASH_ROOT)))
        const canUse = mode === 0o755 || (rootExists && (mode === 0o555 || supported || !firstUnsealed))
        expect({ cut, mode, supported, acknowledged: Exit.isSuccess(ack) }).toEqual({ cut, mode, supported, acknowledged: canUse })
        for (const { disk: image } of crash.outcomes()) {
          checkReopenedRoot(image, Exit.isSuccess(original), canUse, rootExists)
          recovered += 1
        }
      }
    }
    expect(recovered).toBeGreaterThan(cuts * 4)
    yield* Console.log(`job root power loss: ${cuts} writer cuts, 4 permission/capability cases per cut, ${recovered} recovered trees`)
  }),
)

/** What the actors outside the disk did: they survive a power loss of the disk. */
interface Acted {
  /** A supervisor won the claim and ran the command. */
  ran: number
  /** The supervisor saw its exit written (exit 0): the end is that one. */
  exited: boolean
  /** The owner's calls as the host records them: running until the host committed its answer; a call the host lost to the power loss reads failed after it. */
  readonly calls: Map<string, "running" | "committed">
  /** The kinds those answers said. */
  readonly answers: Array<string>
}

/** A server of the wakes over `disk`: the process runner (its launch goes through a systemd stand-in, so no process starts) and the model. */
const crashServer = (
  disk: Disk, store: MemoryStore.MemoryWakes, inbox: MemoryCourier.MemorySessions, acted: Acted,
  options: {
    readonly root?: string
    readonly directory?: string
    readonly beforeLaunch?: (job: JobSpec) => Effect.Effect<void>
    readonly observeDrop?: (phase: "before" | "after") => void
  } = {},
) =>
  Effect.gen(function* () {
    const runner = ProcessRunner.layer({
      root: options.root ?? CRASH_ROOT,
      bun: "/nonexistent/loop-probe-bun",
      script: "/nonexistent/loop-probe-script",
      platform: "linux",
      env: {},
      exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      watch: () => Option.getOrThrowWith(Option.none<never>(), () => ({ code: "ENOSPC" })),
      disk,
    })
    const beforeLaunch = Option.fromUndefinedOr(options.beforeLaunch)
    const hooked = Option.match(beforeLaunch, {
      onNone: () => runner,
      onSome: (onLaunch) => Layer.effect(Runner, Effect.gen(function* () {
        const inner = yield* Runner
        return Runner.of({ ...inner, launch: (spec) => onLaunch(spec).pipe(Effect.andThen(inner.launch(spec))) })
      })).pipe(Layer.provide(runner)),
    })
    const storeLayer = MemoryStore.layer(store)
    const withDrop = Option.match(Option.fromUndefinedOr(options.observeDrop), {
      onNone: () => storeLayer,
      onSome: (drop) => Layer.effect(WakeStore, Effect.gen(function* () {
        const inner = yield* WakeStore
        return WakeStore.of({
          ...inner,
          remove: (id) => Effect.sync(() => drop("before")).pipe(
            Effect.andThen(inner.remove(id)),
            Effect.tap(() => Effect.sync(() => drop("after"))),
          ),
        })
      })).pipe(Layer.provide(storeLayer)),
    })
    const answered = (_sessionID: string, call: string) =>
      Effect.succeed(
        Option.getOrElse(Option.fromNullishOr(acted.calls.get(call)), (): CallAnswer => "failed"),
      )
    const layer = Model.layer({ directory: options.directory ?? CRASH_HOME, ownerHere: () => Effect.succeed(true), recoverMs: 60_000, answered }).pipe(
      Layer.provide(Layer.mergeAll(hooked, withDrop, MemoryCourier.layer(inbox), MemoryChecks.layer(MemoryChecks.empty()), MemoryBackstop.layer(MemoryBackstop.empty()), MemoryOpener.layer(MemoryOpener.empty()))),
      Layer.provide(Layer.succeed(Changes, Changes.of({ changed: () => Effect.void }))),
    )
    return Context.get(yield* Layer.build(layer), Model.WakesModel)
  })

type Wakes = Effect.Success<ReturnType<typeof crashServer>>

/** Let every fiber that can run, run. */
const yieldAll = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })

type Transition = (model: Wakes, disk: Disk, acted: Acted, id: string) => Effect.Effect<void, unknown>

/** The job's supervisor comes up: its claim, and only when that won, its command (which exits 0), its exit written, and with `ringing` its call to the wakes. */
const supervisor =
  (ringing: boolean): Transition =>
  (model, disk, acted, id) =>
    Effect.gen(function* () {
      const dir = path.join(CRASH_ROOT, id)
      if (!claim(dir, 1, NO_PROCESS, () => {}, disk)) return
      acted.ran += 1
      const exit: JobExit = { exitCode: 0, startedAt: 1, endedAt: 2, timedOut: false, killed: false, disposition: "succeeded", generation: 1, sequence: 1 }
      writeAtomic(path.join(dir, FILES.exit), exit, 0o600, disk)
      acted.exited = true
      if (ringing) yield* Effect.exit(model.due(id))
    })

interface History {
  readonly name: string
  readonly before: Transition
}

const HISTORIES: ReadonlyArray<History> = [
  { name: "the supervisor claims, runs, writes its exit and rings: the letter", before: supervisor(true) },
  {
    name: "the supervisor ends the job unannounced; the owner's wait takes the end and the host commits its answer",
    before: (model, disk, acted, id) =>
      Effect.gen(function* () {
        yield* supervisor(false)(model, disk, acted, id)
        const call = `call_${id}`
        acted.calls.set(call, "running")
        const waited = yield* model.wait(CRASH_OWNER, id, 0, { id: call, message: "msg_crash" })
        if (!waited.delivered) return
        acted.calls.set(call, "committed")
        acted.answers.push(Option.getOrElse(Option.map(Option.flatten(Option.fromNullishOr(waited.view.event)), (event) => event.disposition), () => "no event"))
        yield* model.answered(CRASH_OWNER, { id: call, message: "msg_crash" }, "committed")
      }),
  },
  {
    name: "no supervisor in its grace: the wakes retire the launch and announce never-started; then a supervisor comes",
    before: (model, disk, acted, id) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("31 seconds")
        yield* Effect.exit(model.due(id))
        yield* supervisor(true)(model, disk, acted, id)
      }),
  },
]

/** The end letters `inbox` holds for job `id` (the host keeps one per message id), by the kind each says. */
const endsIn = (inbox: MemoryCourier.MemorySessions, id: string) =>
  Option.getOrElse(Option.fromNullishOr(inbox.inboxes.get(CRASH_OWNER)), (): ReadonlyArray<MemoryCourier.Received> => [])
    .filter((received) => received.letter.metadata["id"] === id && received.letter.metadata["progress"] !== true)
    .map((received) =>
      Option.getOrElse(
        Option.map(Schema.decodeUnknownOption(Schema.Struct({ disposition: Schema.String }))(received.letter.metadata["event"]), (event) => event.disposition),
        () => "no event",
      ),
    )

const isJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** One history with the power lost before disk call `lossAt`: what each state the loss may leave broke, and the disk calls it made. */
const crashRun = (history: History, lossAt: number) =>
  Effect.gen(function* () {
    const crash = crashDisk(lossAt, new Map(), CRASH_DIRS)
    const store = MemoryStore.empty()
    const inbox = MemoryCourier.empty(CRASH_OWNER)
    const acted: Acted = { ran: 0, exited: false, calls: new Map(), answers: [] }
    const broken: Array<unknown> = []
    const id = yield* Effect.scoped(
      Effect.gen(function* () {
        const model = yield* crashServer(crash.disk, store, inbox, acted)
        const placed = yield* Effect.exit(model.job(CRASH_OWNER, { command: "true", note: "crash" }))
        if (Exit.isFailure(placed)) return Option.none<string>()
        yield* yieldAll
        yield* Effect.exit(Effect.suspend(() => history.before(model, crash.disk, acted, placed.value.job.id)))
        yield* yieldAll
        return Option.some(placed.value.job.id)
      }),
    )
    let states = 0
    const tornNames = (disk: Disk, dir: string, written: Set<string>) =>
      disk.list(dir).filter((name) => Option.exists(disk.read(path.join(dir, name)), (data) => Option.isSome(isJson(data)) && !crash.written.has(data) && !written.has(data)))
    const calls = crash.calls()
    const reopenedStates = Match.value(Number.isFinite(lossAt)).pipe(
      Match.when(true, () => crash.outcomes()),
      Match.orElse(() => [crash]),
    )
    const keptId = Option.orElse(id, () => Option.fromUndefinedOr([...store.entries.keys()][0]))
    const before = { ran: acted.ran, exited: acted.exited, calls: new Map(acted.calls), answers: [...acted.answers] }
    for (const reopened of reopenedStates) {
      states += 1
      const after = reopened.disk
      const torn = after.list(CRASH_ROOT).filter((name) => name.startsWith("j")).flatMap((name) => tornNames(after, path.join(CRASH_ROOT, name), new Set()))
      if (torn.length > 0) broken.push({ history: history.name, lossAt, problems: [`a torn record was visible on reopening: ${torn.join(", ")}`] })
      if (Option.isNone(id) && acted.ran > 0) broken.push({ history: history.name, lossAt, problems: ["a command ran before its admission returned"] })
      if (broken.length > 0) break
      for (const each of Option.toArray(keptId)) {
        const seen: Acted = { ran: before.ran, exited: before.exited, calls: new Map([...before.calls].filter(([, said]) => said === "committed")), answers: [...before.answers] }
        const keptStore: MemoryStore.MemoryWakes = { entries: new Map(store.entries), notices: new Map(store.notices), broken: new Set(store.broken) }
        const keptInbox: MemoryCourier.MemorySessions = { ...inbox, inboxes: new Map([...inbox.inboxes].map(([key, value]) => [key, [...value]])) }
        yield* Effect.scoped(
          Effect.gen(function* () {
            const model = yield* crashServer(after, keptStore, keptInbox, seen)
            yield* Effect.exit(model.start)
            for (const _ of [1, 2, 3]) {
              yield* yieldAll
              yield* TestClock.adjust("90 seconds")
            }
            // A supervisor that comes after the reopening claims too: it must not win a launch retired or claimed.
            yield* Effect.exit(supervisor(true)(model, after, seen, each))
            for (const _ of [1, 2, 3]) {
              yield* yieldAll
              yield* TestClock.adjust("90 seconds")
            }
            yield* yieldAll
          }),
        )
        const dir = path.join(CRASH_ROOT, each)
        // What a reader takes as a record is a whole file some writer wrote: a torn one never decodes.
        const torn = tornNames(after, dir, reopened.written)
        const ends = endsIn(keptInbox, each)
        const kinds = [...ends, ...seen.answers]
        const problems = [
          kinds.length !== 1 && `given ${kinds.length}: letters ${ends.join(",")}, answers ${seen.answers.join(",")}`,
          seen.ran > 0 && kinds.includes("never-started") && "its command ran, and its end said never-started",
          seen.ran > 1 && "two supervisors won its launch",
          before.exited && kinds.some((kind) => kind !== "succeeded") && `its exit was seen written, and its end said ${kinds.join(",")}`,
          torn.length > 0 && `a torn file read as a record: ${torn.join(", ")}`,
        ].filter((problem) => problem !== false)
        if (problems.length > 0) broken.push({ history: history.name, lossAt, problems, files: after.list(dir) })
      }
      if (broken.length > 0) break
    }
    return { broken, calls, placed: Option.isSome(id), states }
  })

limitedTest("a power loss before any disk call of each record transition leaves a state that reopens to one launcher, one end of its kind, and no torn record read",
  Effect.gen(function* () {
    const broken: Array<unknown> = []
    const states = { cuts: 0, trees: 0, placed: 0 }
    cases: for (const history of HISTORIES) {
      const counted = yield* crashRun(history, Number.POSITIVE_INFINITY)
      broken.push(...counted.broken)
      if (broken.length > 0) break
      for (const lossAt of Array.from({ length: counted.calls + 1 }, (_, at) => at + 1)) {
        const run = yield* crashRun(history, lossAt)
        states.cuts += 1
        states.trees += run.states
        states.placed += Number(run.placed)
        broken.push(...run.broken)
        if (broken.length > 0) break cases
      }
    }
    expect({ broken: broken.slice(0, 2), count: broken.length, kinds: [...new Set(broken.flatMap((each) => Schema.decodeUnknownOption(Schema.Struct({ problems: Schema.Array(Schema.String) }))(each).pipe(Option.map((found) => found.problems.map((problem) => problem.slice(0, 40))), Option.getOrElse(() => []))))] }).toEqual({ broken: [], count: 0, kinds: [] })
    expect(states.placed).toBeGreaterThan(30)
    expect(states.trees).toBeGreaterThan(500)
    yield* Console.log(`power-loss model: ${states.cuts} cuts, ${states.trees} disk trees, ${states.placed} acknowledged cuts`)
  }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))),
)

limitedTest("a second location makes a visible but unsynced letter slot durable before admitting it",
  Effect.gen(function* () {
    const crash = crashDisk(Number.POSITIVE_INFINITY, new Map(), CRASH_DIRS)
    const store = MemoryStore.empty()
    const inbox = MemoryCourier.empty(CRASH_OWNER)
    const acted: Acted = { ran: 0, exited: false, calls: new Map(), answers: [] }
    const id = yield* Effect.scoped(
      Effect.gen(function* () {
        const model = yield* crashServer(crash.disk, store, inbox, acted)
        const { job } = yield* model.job(CRASH_OWNER, { command: "true", note: "cross-location crash" })
        yield* yieldAll
        yield* supervisor(false)(model, crash.disk, acted, job.id)
        return job.id
      }),
    )
    const delivery = "msg_cross_location_letter"
    const dir = path.join(CRASH_ROOT, id)
    // Writer A is stopped just before the directory sync. Writer B sees the link, but does not get to seal its
    // terminal acknowledgement: the power fails after the letter goes and before B writes the next slot.
    const first = yield* Effect.exit(Effect.sync(() =>
      ProcessRunner.advanceIn(dir, 0, { state: "delivering", delivery, attempt: "msg_cross_location_attempt", holder: { kind: "letter" } }, (barrier) => {
        if (barrier === "named") lost()
      }, crash.disk),
    ))
    expect(Exit.isFailure(first)).toBe(true)
    const beforeAck: Disk = {
      ...crash.disk,
      create: (file, mode) => {
        if (path.basename(file).startsWith("delivery.2.json")) return lost()
        return crash.disk.create(file, mode)
      },
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        const model = yield* crashServer(beforeAck, store, inbox, acted)
        yield* model.due(id)
      }),
    )
    const received = () => (inbox.inboxes.get(CRASH_OWNER) ?? []).map((letter) => letter.id)
    expect(received()).toEqual([delivery])
    for (const reopened of crash.outcomes()) {
      expect(Option.map(ProcessRunner.slotOf(dir, reopened.disk), (slot) => slot.delivery.delivery)).toEqual(Option.some(delivery))
      yield* Effect.scoped(
        Effect.gen(function* () {
          const model = yield* crashServer(reopened.disk, store, inbox, acted)
          yield* model.due(id)
        }),
      )
    }
    expect(received()).toEqual([delivery])
  }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))),
)

/** A stopped peer really enters the production disk adapter, but dies after the chosen name becomes visible. */
const stoppedPeer = (disk: Disk, stopAfter: { readonly operation: "mkdir" | "publish" | "rename" | "link"; readonly name: string }, write: (peer: Disk) => void) =>
  Effect.exit(Effect.sync(() => {
    const stop = (operation: typeof stopAfter.operation, name: string) => {
      if (stopAfter.operation === operation && stopAfter.name === name) lost()
    }
    write({
      ...disk,
      mkdir: (dir) => {
        disk.mkdir(dir)
        stop("mkdir", dir)
      },
      rename: (from, to) => {
        disk.rename(from, to)
        stop("rename", to)
      },
      publish: (from, to) => {
        const took = disk.publish(from, to)
        if (took) stop("publish", to)
        return took
      },
      link: (from, to) => {
        const took = disk.link(from, to)
        if (took) stop("link", to)
        return took
      },
    })
  }))

const peerCases = ["ancestor", "inside", "root", "job-dir", "index", "spec", "env", "exit", "marker", "held"] as const
type PeerCase = typeof peerCases[number]
const DEEP_ROOT = "/r/shared/instance/jobs"
const markerAt = (root: string, id: string) => path.join(root, ".owed", id)

/** The original delivery ID must survive loss of either actor, and home or the moved destination can recover alone. */
const reopenAt = (disks: () => Iterable<Crash>, store: MemoryStore.MemoryWakes, acted: Acted, id: string, delivery: string) =>
  Effect.gen(function* () {
    let reopenedCount = 0
    // Enumerate fresh disks for each location so recovery in one never repairs the other's disk.
    for (const location of [CRASH_HOME, CRASH_DESTINATION]) {
      for (const { disk } of disks()) {
        const kept: MemoryStore.MemoryWakes = { entries: new Map(store.entries), notices: new Map(store.notices), broken: new Set(store.broken) }
        const inbox = MemoryCourier.empty(CRASH_OWNER)
        // Reopening must use the recorded id, not coincidentally mint the same first id in a fresh courier.
        inbox.minted = 1000
        yield* Effect.scoped(Effect.gen(function* () {
          const model = yield* crashServer(disk, kept, inbox, acted, { root: DEEP_ROOT, directory: location })
          yield* model.start
          yield* yieldAll
          for (const _ of [1, 2, 3]) {
            yield* TestClock.adjust("61 seconds")
            yield* yieldAll
          }
        }))
        expect((inbox.inboxes.get(CRASH_OWNER) ?? []).map(({ id: message }) => message)).toEqual([delivery])
        expect(endsIn(inbox, id)).toEqual(["succeeded"])
        const final = ProcessRunner.slotOf(path.join(DEEP_ROOT, id), disk)
        expect(Option.map(final, (slot) => slot.delivery.state)).toEqual(Option.some("delivered"))
        expect(Option.map(final, (slot) => slot.delivery.delivery)).toEqual(Option.some(delivery))
        expect(claim(path.join(DEEP_ROOT, id), 3, NO_PROCESS, () => {}, { ...disk })).toBe(false)
        expect(acted.ran).toBe(1)
        reopenedCount += 1
      }
    }
    return reopenedCount
  })

const pauseAtDirectory = (which: PeerCase, id: string) => Match.value(which).pipe(
  Match.when("ancestor", () => Option.some("/r/shared")),
  Match.when("inside", () => Option.some("/r/shared/instance")),
  Match.when("root", () => Option.some(DEEP_ROOT)),
  Match.when("job-dir", () => Option.some(path.join(DEEP_ROOT, id))),
  Match.when("index", () => Option.some(path.join(DEEP_ROOT, ".owed"))),
  Match.orElse(() => Option.none<string>()),
)

const pauseAtLaunch = (which: PeerCase, id: string) => Match.value(which).pipe(
  Match.when("spec", () => Option.some(path.join(DEEP_ROOT, id, FILES.job))),
  Match.when("env", () => Option.some(path.join(DEEP_ROOT, id, FILES.env))),
  Match.orElse(() => Option.none<string>()),
)

/** Before the dependent writer runs, check that the exact name, not just some unrelated name, can be lost. */
const uncommitted = (crash: Crash, parent: string, name: string) => {
  const survived = new Set<boolean>()
  for (const { disk } of crash.outcomes()) {
    survived.add(disk.list(parent).includes(name))
    if (survived.size === 2) break
  }
  expect(survived).toEqual(new Set([false, true]))
}

const peerPowerLoss = (phase: "before" | "after") =>
  Effect.gen(function* () {
    let checked = 0
    for (const which of peerCases) {
      const crash = crashDisk(Number.POSITIVE_INFINITY, new Map(), new Set(["/", "/r"]))
      const { disk } = crash
      const store = MemoryStore.empty()
      const acted: Acted = { ran: 0, exited: false, calls: new Map(), answers: [] }
      const before = MemoryCourier.empty(CRASH_OWNER)
      const atDrop: Array<{ readonly disk: ReadonlyArray<Crash>; readonly wakes: MemoryStore.MemoryWakes }> = []
      const { id, delivery } = yield* Effect.scoped(Effect.gen(function* () {
        const model = yield* crashServer(disk, store, before, acted, {
          root: DEEP_ROOT,
          observeDrop: (at) => {
            if (at !== phase) return
            const wakes = { entries: new Map(store.entries), notices: new Map(store.notices), broken: new Set(store.broken) }
            atDrop.push({ disk: [...crash.outcomes()], wakes }, { disk: [...crash.outcomes()], wakes })
          },
          beforeLaunch: (spec) => Effect.gen(function* () {
            // Ensure that creating .owed later cannot incidentally flush the job's parent directory.
            if (which === "job-dir") writeAtomic(path.join(DEEP_ROOT, ".owed", "peer.json"), {}, 0o600, { ...disk }, DEEP_ROOT)
            const launch = (peer: Disk) => ProcessRunner.writeLaunch(DEEP_ROOT, spec, { spec }, {}, peer)
            for (const name of Option.toArray(pauseAtDirectory(which, spec.id))) {
              const operation = (name === path.join(DEEP_ROOT, spec.id) || name === path.join(DEEP_ROOT, ".owed")) && "mkdir" || "publish"
              const result = yield* stoppedPeer(disk, { operation, name }, launch)
              expect(Exit.isFailure(result)).toBe(true)
              uncommitted(crash, path.dirname(name), path.basename(name))
              if (which === "root") {
                // The parent may become unreadable after the first writer made its root but before it sealed it.
                // The durable intent, not the current permissions, still makes that name ours.
                const parent = path.dirname(name)
                const blocked = yield* Effect.exit(Effect.sync(() => launch({
                  ...disk,
                  syncDir: (dir) => {
                    if (dir === parent) permissionDenied()
                    disk.syncDir(dir)
                  },
                  syncVolume: () => false,
                })))
                expect(Exit.isFailure(blocked)).toBe(true)
                expect(disk.list(name)).not.toContain(spec.id)
              }
            }
            for (const name of Option.toArray(pauseAtLaunch(which, spec.id))) {
              const result = yield* stoppedPeer(disk, { operation: "rename", name }, launch)
              expect(Exit.isFailure(result)).toBe(true)
              uncommitted(crash, path.dirname(name), path.basename(name))
            }
          }),
        })
        const { job: { id } } = yield* model.job(CRASH_OWNER, { command: "true", note: "two disk writers" })
        yield* yieldAll
        const dir = path.join(DEEP_ROOT, id)
        const supervisor = { ...disk }
        expect(claim(dir, 1, NO_PROCESS, () => {}, supervisor)).toBe(true)
        expect(claim(dir, 1, NO_PROCESS, () => {}, { ...disk })).toBe(false)
        acted.ran += 1
        const exitPath = path.join(dir, FILES.exit)
        const writeEnd = (writer: Disk) =>
          writeAtomic(exitPath, { exitCode: 0, startedAt: 1, endedAt: 2, timedOut: false, killed: false, disposition: "succeeded", generation: 1, sequence: 1 }, 0o600, writer, DEEP_ROOT)
        if (which === "exit") {
          const result = yield* stoppedPeer(disk, { operation: "rename", name: exitPath }, writeEnd)
          expect(Exit.isFailure(result)).toBe(true)
          uncommitted(crash, dir, FILES.exit)
        } else writeEnd(supervisor)
        const marker = markerAt(DEEP_ROOT, id)
        if (which === "marker") {
          // A r4-era obstacle left no durable index, and a competing writer has only renamed its replacement.
          removeDurable(marker, disk, DEEP_ROOT)
          const result = yield* stoppedPeer(disk, { operation: "rename", name: marker }, (peer) => writeAtomic(marker, {}, 0o600, peer, DEEP_ROOT))
          expect(Exit.isFailure(result)).toBe(true)
          uncommitted(crash, path.dirname(marker), id)
        }
        if (which === "held") {
          const found = "msg_peer_letter"
          const name = path.join(dir, "delivery.1.json")
          const result = yield* stoppedPeer(disk, { operation: "link", name }, (peer) => {
            writeDurable(name, { state: "delivering", delivery: found, attempt: "msg_peer_attempt", holder: { kind: "answer", sessionID: CRASH_OWNER, call: "call_a", message: "msg_a" } }, { exclusive: true, disk: peer, root: DEEP_ROOT })
          })
          expect(Exit.isFailure(result)).toBe(true)
          uncommitted(crash, dir, path.basename(name))
          // Persist a follow-up write in the exit's directory while the peer has not returned.
          writeAtomic(path.join(dir, FILES.launch), { how: "systemd" }, 0o600, { ...disk }, DEEP_ROOT)
          return { id, delivery: found }
        }
        expect((yield* model.wait(CRASH_OWNER, id, 0, { id: "call_test", message: "msg_test" })).delivered).toBe(true)
        expect(store.entries.has(id)).toBe(false)
        const slot = Option.getOrThrow(ProcessRunner.slotOf(dir, disk))
        return { id, delivery: slot.delivery.delivery }
      }))
      if (which === "held") {
        checked += yield* reopenAt(crash.outcomes, store, acted, id, delivery)
      } else {
        expect(atDrop).toHaveLength(2)
        const saved = got(atDrop[0])
        expect(saved.wakes.entries.has(id)).toBe(phase === "before")
        checked += yield* reopenAt(() => got(atDrop.shift()).disk, saved.wakes, acted, id, delivery)
      }
    }
    expect(checked).toBeGreaterThanOrEqual(peerCases.length * 2)
    yield* Console.log(`peer power loss ${phase} wake removal: ${peerCases.length} name pauses, ${checked} independently reopened locations`)
  }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([])))

limitedTest("peer power loss before wake removal recovers the original delivery at home or destination", peerPowerLoss("before"))
limitedTest("peer power loss after wake removal recovers the original delivery at home or destination", peerPowerLoss("after"))

test("each writer seals an existing path once, but flushes the containing directory for every write", () => {
  const { disk } = crashDisk(Number.POSITIVE_INFINITY, new Map(), new Set(["/", "/r", "/r/cache", "/r/cache/job"]))
  const writer = () => {
    const flushed: Array<string> = []
    const port: Disk = { ...disk, syncDir: (dir) => {
      disk.syncDir(dir)
      flushed.push(dir)
    } }
    writeAtomic("/r/cache/job/first.json", {}, 0o600, port, "/r")
    writeAtomic("/r/cache/job/second.json", {}, 0o600, port, "/r")
    return flushed
  }
  const expected = ["/r", "/r/cache", "/r/cache/job", "/r/cache/job"]
  expect(writer()).toEqual(expected)
  expect(writer()).toEqual(expected)
})
