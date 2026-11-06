// Jobs held in memory: each launched spec, its run, its log and its progress
// file, set by the test as the command would. `refusing` makes launches fail,
// as a runner that cannot start one; `kill` ends a running job as killed at
// the clock's time. The model's tests and the plugin's seam test use it.
import { Clock, Effect, Layer } from "effect"
import { type JobRecord, type JobSpec, type Run, unitOf } from "../job.ts"
import { JobRefused, Runner } from "../service.ts"

export interface MemoryJob {
  readonly spec: JobSpec
  run: Run
  log: string
  drip: string
}

export interface MemoryRunner {
  readonly jobs: Map<string, MemoryJob>
  readonly killed: Array<string>
  /** How launches go: `systemd` names a unit, `detached` none. */
  how: "systemd" | "detached"
  refusing: string | undefined
}

export const empty = (): MemoryRunner => ({ jobs: new Map(), killed: [], how: "detached", refusing: undefined })

const LOG = (id: string) => `/state/opencode-job/${id}/log`
const DRIP = (id: string) => `/state/opencode-job/${id}/drip`

/** The job as the command left it: up and running since `startedAt`. */
export const running = (memory: MemoryRunner, id: string, startedAt: number) => {
  const job = memory.jobs.get(id)
  if (job !== undefined) job.run = { state: "running", startedAt }
}

/** The job's command exited `exitCode` at `endedAt`. */
export const ended = (memory: MemoryRunner, id: string, exitCode: number | null, endedAt: number, more: { readonly timedOut?: boolean; readonly killed?: boolean; readonly signal?: string } = {}) => {
  const job = memory.jobs.get(id)
  if (job === undefined) return
  const startedAt = job.run.state === "running" ? job.run.startedAt : job.spec.setAt
  job.run = {
    state: "ended",
    exit: { exitCode, startedAt, endedAt, timedOut: more.timedOut ?? false, killed: more.killed ?? false, ...(more.signal === undefined ? {} : { signal: more.signal }) },
  }
}

const recordOf = (memory: MemoryRunner, job: MemoryJob): JobRecord => ({
  spec: job.spec,
  run: job.run,
  log: LOG(job.spec.id),
  drip: DRIP(job.spec.id),
  ...(memory.how === "systemd" ? { unit: unitOf(job.spec.id) } : {}),
})

export const layer = (memory: MemoryRunner) =>
  Layer.succeed(Runner, {
    launch: (spec) =>
      Effect.suspend(() => {
        if (memory.refusing !== undefined) return Effect.fail(new JobRefused({ message: memory.refusing }))
        memory.jobs.set(spec.id, { spec, run: { state: "starting" }, log: "", drip: "" })
        return Effect.succeed({ log: LOG(spec.id), drip: DRIP(spec.id), how: memory.how, ...(memory.how === "systemd" ? { unit: unitOf(spec.id) } : {}) })
      }),
    read: (id) =>
      Effect.sync(() => {
        const job = memory.jobs.get(id)
        return job === undefined ? undefined : recordOf(memory, job)
      }),
    tail: (id, chars) => Effect.sync(() => (memory.jobs.get(id)?.log ?? "").slice(-chars)),
    drip: (id, from) =>
      Effect.sync(() => {
        const bytes = new TextEncoder().encode(memory.jobs.get(id)?.drip ?? "")
        const end = bytes.lastIndexOf(10) + 1
        if (end <= from) return { text: "", offset: from }
        return { text: new TextDecoder().decode(bytes.slice(from, end)), offset: end }
      }),
    kill: (id) =>
      Effect.gen(function* () {
        const job = memory.jobs.get(id)
        if (job === undefined || (job.run.state !== "running" && job.run.state !== "starting")) return false
        memory.killed.push(id)
        ended(memory, id, null, yield* Clock.currentTimeMillis, { killed: true, signal: "SIGTERM" })
        return true
      }),
  })
