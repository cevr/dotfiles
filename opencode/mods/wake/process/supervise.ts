// A job's runner: the process `bun cmd/wake/job.ts <dir>` that the process
// runner launches outside the OpenCode server (a systemd user unit, or its own
// session). It reads the job from <dir>, runs the command under /bin/sh in a
// process group of its own (when heavy, through the guard's launcher: `nice -n
// 10`, `ionice -c3` where it is, and on Linux with a user systemd a scope with `MemoryMax=12G`), its stdout and stderr to
// <dir>/log, `$JOB_DRIP` naming <dir>/drip and `$JOB_ID` the job; stops it at
// its timeout or on SIGTERM (TERM to the group, KILL after a grace to what is
// left of the group, even once its leader is gone; the exit then names the
// signal, whatever the leader exited with); records
// the exit in <dir>/exit.json, atomically, with its typed end (job-event.ts:
// its disposition, generation and sequence), retrying a write that fails;
// then calls `notify` with the job's descriptor, so the wakes reconcile its
// end now. The exit is written before the call: whatever reads the job after
// the call (or after a call that was lost) reads the end.
//
// Before it runs anything the runner claims the job: it writes runner.json
// only if none is there (a link, which fails on an existing file), with its
// pid and its process's start time. A second runner for the same job
// finds the claim and runs nothing, so a launch repeated after a crash never
// runs a command twice; a reader takes the claim's pid as the runner only
// while that pid's start time is the claim's, so a reused pid is not it.
//
// The files of <dir>, which the process runner (runner.ts) writes and reads:
// - job.json: { spec, notify? } (the descriptor, absent when the backstop is off)
// - env.json: the environment the command runs in, 0600; read once and deleted
// - launch.json: { how, unit? }
// - runner.json: the claim, { pid, startedAt, start }, once this runner is up
// - stop: asks a runner not yet up to record a kill instead of running
// - log, drip, exit.json
import { closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Duration, Effect, Option, Schedule, Schema } from "effect"
import { DEFAULT_LIMITS, heavyArgv, type Host, ioniceAvailable, SCOPE_PROBE } from "@dotfiles/opencode-guard/launcher"
import type { Descriptor } from "../backstop.ts"
import { type JobExit, type JobSpec, KILL_GRACE_MS } from "../job.ts"
import { type Disposition, dispositionOfExit, generationOf, RunnerClaim } from "../job-event.ts"
import { STARTUP } from "./checks.ts"

export const FILES = {
  job: "job.json",
  env: "env.json",
  launch: "launch.json",
  runner: "runner.json",
  stop: "stop",
  log: "log",
  drip: "drip",
  exit: "exit.json",
} as const

export interface JobFile {
  readonly spec: JobSpec
  readonly notify?: Descriptor | undefined
}

/** Write `value` as JSON to `file` through a rename, so a reader never sees half of it. */
export const writeAtomic = (file: string, value: unknown, mode = 0o600) => {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode })
  renameSync(temporary, file)
}

/** A process's start time as `ps -o lstart=` prints it (by its own path, in the C locale); none when `ps` could not say (no such process, or no `ps`). */
export const processStart = (pid: number): Option.Option<string> =>
  ranOf(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { LC_ALL: "C" }).pipe(
    Option.filter((ran) => ran.exitCode === 0),
    Option.map((ran) => ran.stdout.toString().trim()),
    Option.filter((start) => start !== ""),
  )

/** A short program run to its end, its output kept; none when it could not start. `env` set replaces the runner's. */
const ranOf = (argv: ReadonlyArray<string>, env?: Record<string, string>) =>
  Option.liftThrowable(() => Bun.spawnSync([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore", ...Option.match(Option.fromNullishOr(env), { onNone: () => ({}), onSome: (set) => ({ env: set }) }) }))()

const encodeClaim = Schema.encodeSync(Schema.fromJsonString(RunnerClaim))

/** Claim the job in `dir` for this runner, as the process `pid`: true when no runner claimed it before. */
export const claim = (dir: string, startedAt: number, pid: number = process.pid): boolean => {
  const file = path.join(dir, FILES.runner)
  const temporary = `${file}.${pid}.claim`
  const own: RunnerClaim = { pid, startedAt, ...Option.match(processStart(pid), { onNone: () => ({}), onSome: (start) => ({ start }) }) }
  writeFileSync(temporary, encodeClaim(own), { mode: 0o600 })
  // A link fails on an existing file: of two runners, one claims it.
  const linked = Option.isSome(Option.liftThrowable(() => linkSync(temporary, file))())
  rmSync(temporary, { force: true })
  return linked
}

/** How many times the runner tries to write the exit, and how long it waits between. */
export const EXIT_WRITES = 5
export const EXIT_RETRY_MS = 200

/** Write the exit, trying again on a failure (a full disk, a transient error); whether it was written. */
export const writeExit = (dir: string, exit: JobExit, write: (file: string, value: JobExit) => void = writeAtomic): Effect.Effect<boolean> =>
  Effect.try(() => write(path.join(dir, FILES.exit), exit)).pipe(
    Effect.retry({ times: EXIT_WRITES - 1, schedule: Schedule.spaced(Duration.millis(EXIT_RETRY_MS)) }),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

/** Whether a heavy job can run in a systemd scope: on Linux, when the guard's probe exits 0; never elsewhere. */
export const scopeAvailable = (platform: string = process.platform, probe: ReadonlyArray<string> = SCOPE_PROBE): boolean => {
  if (platform !== "linux") return false
  return Option.exists(ranOf(probe), (ran) => ran.exitCode === 0)
}

/** What this machine offers a heavy job beyond `nice`: a scope (the guard's probe) and `ionice`. */
export const hostOf = (platform: string = process.platform): Host => ({ scope: scopeAvailable(platform), ionice: ioniceAvailable(platform) })

/**
 * The argv a job's command runs as: a heavy one through the guard's launcher (`nice`, `ionice -c3`
 * where the host has it, and in a scope under its memory cap where it has one). The host is asked
 * only for a heavy job: its scope probe starts a process.
 */
export const argvOf = (spec: Pick<JobSpec, "command" | "heavy">, host: () => Host): ReadonlyArray<string> => {
  const argv = ["/bin/sh", "-c", spec.command]
  return spec.heavy ? heavyArgv(argv, DEFAULT_LIMITS, host()) : argv
}

/** Signal the process group `pid` leads; false when the group is already gone. */
const signalGroup = (pid: number, signal: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

/** Resolves once the group `pid` leads is empty, or at `until` (epoch ms), whichever comes first. */
const groupGone = async (pid: number, until: number) => {
  while (signalGroup(pid, 0) && Date.now() < until) await Bun.sleep(20)
}

const readEnv = (dir: string): Record<string, string> => {
  const file = path.join(dir, FILES.env)
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>
  } catch {
    return Object.fromEntries(Object.entries(process.env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const])))
  } finally {
    rmSync(file, { force: true })
  }
}

/** The bytes of progress written so far: the end's sequence follows them. */
const dripped = (dir: string): number => Option.getOrElse(Option.liftThrowable(() => statSync(path.join(dir, FILES.drip)).size)(), () => 0)

/**
 * Run the job in `dir` to its end, record it, and call `notify` with its descriptor. None, running nothing, when
 * another runner claimed the job first. `write` is how the exit is written (a test makes it fail).
 */
export const supervise = async (
  dir: string,
  notify?: (descriptor: Descriptor) => Promise<void>,
  grace = KILL_GRACE_MS,
  write: (file: string, value: JobExit) => void = writeAtomic,
): Promise<Option.Option<JobExit>> => {
  const job = JSON.parse(readFileSync(path.join(dir, FILES.job), "utf8")) as JobFile
  const startedAt = Date.now()

  let child: ReturnType<typeof Bun.spawn> | undefined
  let timedOut = false
  let killed = false
  /** The strongest signal this runner delivered to the command's group while the group was there. */
  let sent: "SIGTERM" | "SIGKILL" | undefined
  /** When a stop's grace ends: the SIGKILL then reaches what is left of the group. */
  let hardAt: number | undefined
  let hard: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    const pid = child?.pid
    // No group left: the command ended by itself before the stop reached it.
    if (pid === undefined || !signalGroup(pid, "SIGTERM")) return
    sent ??= "SIGTERM"
    if (hard !== undefined) return
    hardAt = Date.now() + grace
    hard = setTimeout(() => {
      if (signalGroup(pid, "SIGKILL")) sent = "SIGKILL"
    }, grace)
  }
  const onSignal = () => {
    killed = true
    stop()
  }
  // The handlers come before runner.json: once it is written the job reads
  // running and a kill sends SIGTERM here, and without a handler that signal
  // ends this runner with no exit recorded (the job reads lost) and leaves
  // the command's group running.
  const handlers = (method: "on" | "off") => {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process[method](signal, onSignal)
  }
  handlers("on")
  // Another runner of this job claimed it first: this one runs nothing and records nothing.
  if (!claim(dir, startedAt)) {
    handlers("off")
    return Option.none()
  }
  const env = readEnv(dir)

  const record = (fields: Omit<JobExit, "disposition" | "generation" | "sequence">, disposition: Option.Option<Disposition> = Option.none()) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const exit: JobExit = { ...fields, generation: generationOf(job.spec), sequence: dripped(dir) + 1 }
        const typed: JobExit = { ...exit, disposition: Option.getOrElse(disposition, () => dispositionOfExit(exit)) }
        // The end is on disk before anyone is told of it; one never written reads lost, and is not announced.
        const written = yield* writeExit(dir, typed, write)
        const told = Option.all({ descriptor: Option.fromNullishOr(job.notify), call: Option.fromNullishOr(notify) }).pipe(Option.filter(() => written))
        yield* Option.match(told, { onNone: () => Effect.void, onSome: ({ descriptor, call }) => Effect.promise(() => call(descriptor).catch(() => {})) })
        return Option.some(typed)
      }),
    )

  if (killed || existsSync(path.join(dir, FILES.stop)))
    return record({ exitCode: null, signal: "SIGTERM", startedAt, endedAt: Date.now(), timedOut: false, killed: true })

  const log = openSync(path.join(dir, FILES.log), "a", 0o600)
  const drip = path.join(dir, FILES.drip)
  writeFileSync(drip, "", { flag: "a", mode: 0o600 })
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !(STARTUP as ReadonlyArray<string>).includes(name)))
  let spawned: ReturnType<typeof Bun.spawn>
  try {
    spawned = Bun.spawn([...argvOf(job.spec, hostOf)], {
      cwd: job.spec.cwd,
      env: { ...childEnv, JOB_DRIP: drip, JOB_ID: job.spec.id },
      stdin: "ignore",
      stdout: log,
      stderr: log,
      detached: true,
    })
  } catch (cause) {
    writeFileSync(log, `job: the command did not start in ${job.spec.cwd}: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    closeSync(log)
    return record({ exitCode: 127, startedAt, endedAt: Date.now(), timedOut: false, killed: false }, Option.some("spawn-failed"))
  }
  closeSync(log)
  child = spawned

  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, job.spec.timeoutSeconds * 1000)
  // A kill that came while this runner was coming up.
  if (killed || existsSync(path.join(dir, FILES.stop))) onSignal()

  const exitCode = await spawned.exited
  clearTimeout(timer)
  // A stop ends the whole group, not just its leader: the leader can end at
  // the SIGTERM while a member that ignores it runs on, so what is left at the
  // grace's end gets the SIGKILL, before the exit is recorded.
  if (hard !== undefined && hardAt !== undefined) {
    await groupGone(spawned.pid, hardAt)
    clearTimeout(hard)
    if (signalGroup(spawned.pid, "SIGKILL")) sent = "SIGKILL"
  }
  // A stop that reached the group ended the job, whatever its leader made of
  // the signal (a shell that traps SIGTERM, or whose children die of it, can
  // exit 0): the exit names the signal, as the memory runner's does. A stop
  // that found no group came after the command had ended by itself, so its
  // own exit stands and it is neither killed nor timed out.
  return record(endOf({ exitCode, signalCode: spawned.signalCode, sent: Option.fromNullishOr(sent), timedOut, killed, startedAt, endedAt: Date.now() }))
}

/** The exit a run that went its course records: the signal that ended it, whether its own or one this runner sent, wins over its code. */
const endOf = (run: {
  readonly exitCode: number
  readonly signalCode: ReturnType<typeof Bun.spawn>["signalCode"]
  readonly sent: Option.Option<"SIGTERM" | "SIGKILL">
  readonly timedOut: boolean
  readonly killed: boolean
  readonly startedAt: number
  readonly endedAt: number
}): Omit<JobExit, "disposition" | "generation" | "sequence"> => {
  const stopped = Option.isSome(run.sent)
  return {
    ...Option.match(Option.orElse(Option.map(Option.fromNullishOr(run.signalCode), String), () => run.sent), {
      onNone: () => ({ exitCode: run.exitCode }),
      onSome: (signal) => ({ exitCode: null, signal }),
    }),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    timedOut: run.timedOut && stopped,
    killed: run.killed && !run.timedOut && stopped,
  }
}
