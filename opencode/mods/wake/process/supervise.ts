// A job's runner: the process `bun cmd/wake/job.ts <dir>` that the process
// runner launches outside the OpenCode server (a systemd user unit, or its own
// session). It reads the job from <dir>, runs the command under /bin/sh in a
// process group of its own (`nice -n 10` when heavy), its stdout and stderr to
// <dir>/log, `$JOB_DRIP` naming <dir>/drip and `$JOB_ID` the job; stops it at
// its timeout or on SIGTERM (TERM to the group, KILL after a grace); records
// the exit in <dir>/exit.json, atomically; then calls `notify` with the job's
// descriptor, so the wakes fire its letter now instead of at the next poll.
//
// The files of <dir>, which the process runner (runner.ts) writes and reads:
// - job.json: { spec, notify? } (the descriptor, absent when the backstop is off)
// - env.json: the environment the command runs in, 0600; read once and deleted
// - launch.json: { how, unit? }
// - runner.json: { pid, startedAt }, once this runner is up
// - stop: asks a runner not yet up to record a kill instead of running
// - log, drip, exit.json
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Descriptor } from "../backstop.ts"
import { type JobExit, type JobSpec, KILL_GRACE_MS } from "../job.ts"
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

/** The argv a job's command runs as. */
export const argvOf = (spec: Pick<JobSpec, "command" | "heavy">): ReadonlyArray<string> =>
  spec.heavy ? ["nice", "-n", "10", "/bin/sh", "-c", spec.command] : ["/bin/sh", "-c", spec.command]

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal)
  } catch {
    // The group is already gone.
  }
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

/** Run the job in `dir` to its end, record it, and call `notify` with its descriptor. */
export const supervise = async (dir: string, notify?: (descriptor: Descriptor) => Promise<void>, grace = KILL_GRACE_MS): Promise<JobExit> => {
  const job = JSON.parse(readFileSync(path.join(dir, FILES.job), "utf8")) as JobFile
  const env = readEnv(dir)
  const startedAt = Date.now()
  writeAtomic(path.join(dir, FILES.runner), { pid: process.pid, startedAt })

  const record = async (exit: JobExit) => {
    writeAtomic(path.join(dir, FILES.exit), exit)
    if (job.notify !== undefined && notify !== undefined) await notify(job.notify).catch(() => undefined)
    return exit
  }

  if (existsSync(path.join(dir, FILES.stop)))
    return record({ exitCode: null, signal: "SIGTERM", startedAt, endedAt: Date.now(), timedOut: false, killed: true })

  const log = openSync(path.join(dir, FILES.log), "a", 0o600)
  const drip = path.join(dir, FILES.drip)
  writeFileSync(drip, "", { flag: "a", mode: 0o600 })
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !(STARTUP as ReadonlyArray<string>).includes(name)))
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([...argvOf(job.spec)], {
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
    return record({ exitCode: 127, startedAt, endedAt: Date.now(), timedOut: false, killed: false })
  }
  closeSync(log)

  let timedOut = false
  let killed = false
  let hard: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    signalGroup(child.pid, "SIGTERM")
    hard ??= setTimeout(() => signalGroup(child.pid, "SIGKILL"), grace)
  }
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, job.spec.timeoutSeconds * 1000)
  const onSignal = () => {
    killed = true
    stop()
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, onSignal)
  // A kill that came while this runner was coming up.
  if (existsSync(path.join(dir, FILES.stop))) onSignal()

  const exitCode = await child.exited
  clearTimeout(timer)
  if (hard !== undefined) clearTimeout(hard)
  const signal = child.signalCode == null ? undefined : String(child.signalCode)
  return record({
    exitCode: signal === undefined ? exitCode : null,
    ...(signal === undefined ? {} : { signal }),
    startedAt,
    endedAt: Date.now(),
    timedOut,
    killed: killed && !timedOut,
  })
}
