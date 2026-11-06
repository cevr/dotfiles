// Jobs as processes outside the OpenCode server. `launch` keeps the job's
// files in <root>/<id> (see supervise.ts) and starts its runner,
// `bun <script> <dir>`: under `systemd-run --user` on Linux, so a stop of the
// server's own unit leaves it running, and in its own session and process
// group elsewhere (and on a Linux whose user manager refuses), so the
// server's exit leaves it running. `read` takes the run from the files: an
// exit recorded is `ended`; a runner up and alive `running`; up and gone
// without an exit `lost`; never up `starting`.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import type { Descriptor } from "../backstop.ts"
import { carried } from "../backstop.ts"
import { type JobExit, type JobRecord, type JobSpec, type Launched, type Run, unitOf } from "../job.ts"
import { type Exec } from "../cron/backstop.ts"
import { JobRefused, Runner } from "../service.ts"
import { FILES, type JobFile, writeAtomic } from "./supervise.ts"

export interface Config {
  /** Where each job's directory is kept. */
  readonly root: string
  /** A real bun, by absolute path. */
  readonly bun: string
  /** The runner's entry (cmd/wake/job.ts), by absolute path. */
  readonly script: string
  readonly platform: NodeJS.Platform
  /** The environment a job runs in. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The `opencode` launcher the runner wakes the service with when the job ends; absent: the server's poll finds the end. */
  readonly opencode?: string | undefined
  readonly exec: Exec
}

/** Whether `pid` is a live process. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

const readJson = <A,>(file: string): A | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as A
  } catch {
    return undefined
  }
}

/** The run the files of `dir` record. */
export const runOf = (dir: string): Run => {
  const exit = readJson<JobExit>(path.join(dir, FILES.exit))
  if (exit !== undefined) return { state: "ended", exit }
  const runner = readJson<{ readonly pid: number; readonly startedAt: number }>(path.join(dir, FILES.runner))
  if (runner === undefined) return { state: "starting" }
  if (alive(runner.pid)) return { state: "running", startedAt: runner.startedAt }
  return { state: "lost", startedAt: runner.startedAt, why: "its runner is gone without recording an exit (the machine restarted, or it was killed)" }
}

/** The bytes of `file` from `from` to its end, or none. */
const bytesFrom = (file: string, from: number): Uint8Array => {
  try {
    const all = readFileSync(file)
    return from >= all.length ? new Uint8Array() : all.subarray(from)
  } catch {
    return new Uint8Array()
  }
}

export const layer = (config: Config) => {
  const dirOf = (id: string) => path.join(config.root, id)
  const detached = (dir: string) =>
    Effect.try({
      try: () => Bun.spawn([config.bun, config.script, dir], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref(),
      catch: (cause) => new JobRefused({ message: `its runner did not start: ${cause instanceof Error ? cause.message : String(cause)}` }),
    })

  return Layer.succeed(Runner, {
    launch: (spec: JobSpec) =>
      Effect.gen(function* () {
        const dir = dirOf(spec.id)
        const descriptor: Descriptor | undefined =
          config.opencode === undefined ? undefined : { id: spec.id, title: unitOf(spec.id), directory: spec.directory, opencode: config.opencode, env: carried(config.env) }
        yield* Effect.try({
          try: () => {
            mkdirSync(dir, { recursive: true, mode: 0o700 })
            chmodSync(dir, 0o700)
            writeAtomic(path.join(dir, FILES.job), { spec, ...(descriptor === undefined ? {} : { notify: descriptor }) } satisfies JobFile)
            writeAtomic(path.join(dir, FILES.env), Object.fromEntries(Object.entries(config.env).filter(([, value]) => value !== undefined)))
          },
          catch: (cause) => new JobRefused({ message: `its files were not written in ${dir}: ${cause instanceof Error ? cause.message : String(cause)}` }),
        })
        const where = { log: path.join(dir, FILES.log), drip: path.join(dir, FILES.drip) }
        let warning: string | undefined
        if (config.platform === "linux") {
          const unit = unitOf(spec.id)
          const ran = yield* config.exec(["systemd-run", "--user", "--unit", unit, "--collect", "--quiet", "--", config.bun, config.script, dir])
          if (ran.exitCode === 0) {
            writeAtomic(path.join(dir, FILES.launch), { how: "systemd", unit })
            return { ...where, how: "systemd", unit } satisfies Launched
          }
          warning = `systemd-run --user refused (${(ran.stderr || ran.stdout).trim() || `exit ${ran.exitCode}`}), so it runs in its own process group instead: a stop of the OpenCode service's unit may end it.`
        }
        yield* detached(dir)
        writeAtomic(path.join(dir, FILES.launch), { how: "detached" })
        return { ...where, how: "detached", ...(warning === undefined ? {} : { warning }) } satisfies Launched
      }),
    read: (id) =>
      Effect.sync((): JobRecord | undefined => {
        const dir = dirOf(id)
        const job = readJson<JobFile>(path.join(dir, FILES.job))
        if (job === undefined) return undefined
        const launch = readJson<{ readonly unit?: string }>(path.join(dir, FILES.launch))
        return { spec: job.spec, run: runOf(dir), log: path.join(dir, FILES.log), drip: path.join(dir, FILES.drip), ...(launch?.unit === undefined ? {} : { unit: launch.unit }) }
      }),
    tail: (id, chars) =>
      Effect.sync(() => {
        const file = path.join(dirOf(id), FILES.log)
        try {
          const size = Bun.file(file).size
          return new TextDecoder().decode(bytesFrom(file, Math.max(0, size - chars * 4))).slice(-chars)
        } catch {
          return ""
        }
      }),
    drip: (id, from) =>
      Effect.sync(() => {
        const bytes = bytesFrom(path.join(dirOf(id), FILES.drip), from)
        const end = bytes.lastIndexOf(10) + 1
        if (end === 0) return { text: "", offset: from }
        return { text: new TextDecoder().decode(bytes.subarray(0, end)), offset: from + end }
      }),
    kill: (id) =>
      Effect.sync(() => {
        const dir = dirOf(id)
        if (!existsSync(path.join(dir, FILES.job))) return false
        const run = runOf(dir)
        if (run.state === "starting") {
          writeFileSync(path.join(dir, FILES.stop), "")
          return true
        }
        if (run.state !== "running") return false
        const runner = readJson<{ readonly pid: number }>(path.join(dir, FILES.runner))
        if (runner === undefined) return false
        try {
          process.kill(runner.pid, "SIGTERM")
          return true
        } catch {
          return false
        }
      }),
  })
}
