// Jobs held in memory: each launched spec, its run, its log and its progress
// file, set by the test as the command and its runner would. `ended`, `lost`
// and `spawnFailed` are the runner's own records (its exit written, its
// process gone with none, its command that never started); the test rings
// the wakes' `due` after, as the runner does once its exit is written.
// `refusing` makes launches fail, as a runner that cannot start one; `kill`
// ends a running job as killed at the clock's time, or, with `killEnds`
// false, only asks (the runner's stop takes its grace), the test ending it
// later. `reads` counts every look at a job's run, so a test sees that
// nothing scans a running job. `watched` holds the wakes' watches, and
// `announce` is the exit file's event under one (nothing when unwatched: a
// missed event); `watches` false is a host out of watches. The model's tests and the plugin's seam test
// use it.
import { Clock, Effect, Layer, Match, Option } from "effect"
import { type JobExit, type JobRecord, type JobSpec, type Run, unitOf } from "../job.ts"
import { type Disposition, dispositionOfExit, generationOf } from "../job-event.ts"
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
  /** Whether a kill ends the job at once (the default), or only asks, the test ending it with `ended(..., { killed: true })`. */
  killEnds: boolean
  /** How many times a job's run was read. */
  reads: number
  /** The jobs watched, each with what its watch announces to; `announce` stands in for the file event. */
  readonly watched: Map<string, () => void>
  /** Whether a watch opens (false: a host out of watches). */
  watches: boolean
}

export const empty = (): MemoryRunner => ({ jobs: new Map(), killed: [], how: "detached", refusing: undefined, killEnds: true, reads: 0, watched: new Map(), watches: true })

/** The job's exit file appeared under its watch: what the process runner's watch does; nothing when it is not watched (a missed event). */
export const announce = (memory: MemoryRunner, id: string) => memory.watched.get(id)?.()

const LOG = (id: string) => `/state/opencode-job/${id}/log`
const DRIP = (id: string) => `/state/opencode-job/${id}/drip`

/** The job as the command left it: up and running since `startedAt`. */
export const running = (memory: MemoryRunner, id: string, startedAt: number) =>
  withJob(memory, id, (job) => {
    job.run = { state: "running", startedAt }
  })

/** Do `change` to the job `id`, when the runner has it. */
const withJob = (memory: MemoryRunner, id: string, change: (job: MemoryJob) => void): void => Option.match(Option.fromNullishOr(memory.jobs.get(id)), { onNone: () => {}, onSome: change })

/** When the job's command came up: its running start, none before. */
const upSince = (run: Run): Option.Option<number> =>
  Match.value(run).pipe(
    Match.discriminator("state")("running", (up) => Option.some(up.startedAt)),
    Match.orElse(() => Option.none<number>()),
  )

/** The runner recorded its exit: the end's kind read off its fields, as this build's runner writes it, after every byte of progress. */
const record = (job: MemoryJob, exit: Omit<JobExit, "disposition" | "generation" | "sequence">, disposition: Option.Option<Disposition> = Option.none()) => {
  const full: JobExit = { ...exit, generation: generationOf(job.spec), sequence: new TextEncoder().encode(job.drip).length + 1 }
  job.run = { state: "ended", exit: { ...full, disposition: Option.getOrElse(disposition, () => dispositionOfExit(full)) } }
}

/** The job's command exited `exitCode` at `endedAt` (null: a signal ended it). */
export const ended = (memory: MemoryRunner, id: string, exitCode: JobExit["exitCode"], endedAt: number, more: { readonly timedOut?: boolean; readonly killed?: boolean; readonly signal?: string } = {}) =>
  withJob(memory, id, (job) =>
    record(job, {
      exitCode,
      startedAt: Option.getOrElse(upSince(job.run), () => job.spec.setAt),
      endedAt,
      timedOut: more.timedOut ?? false,
      killed: more.killed ?? false,
      ...Option.match(Option.fromNullishOr(more.signal), { onNone: () => ({}), onSome: (signal) => ({ signal }) }),
    }),
  )

/** The job's command ran past its timeout and the runner's stop ended it. */
export const timedOut = (memory: MemoryRunner, id: string, endedAt: number) => ended(memory, id, null, endedAt, { timedOut: true, signal: "SIGTERM" })

/** The job's command never started (its runner could not spawn it): exit 127, as the process runner records it. */
export const spawnFailed = (memory: MemoryRunner, id: string, endedAt: number) =>
  withJob(memory, id, (job) => record(job, { exitCode: 127, startedAt: endedAt, endedAt, timedOut: false, killed: false }, Option.some("spawn-failed")))

/** The job's runner is gone with no exit recorded (the machine restarted, or it was killed). */
export const lost = (memory: MemoryRunner, id: string) =>
  withJob(memory, id, (job) => {
    job.run = {
      state: "lost",
      ...Option.match(upSince(job.run), { onNone: () => ({}), onSome: (startedAt) => ({ startedAt }) }),
      why: "its runner is gone without recording an exit (the machine restarted, or it was killed)",
      cause: "runner-gone",
    }
  })

const recordOf = (memory: MemoryRunner, job: MemoryJob): JobRecord => ({
  spec: job.spec,
  run: job.run,
  log: LOG(job.spec.id),
  drip: DRIP(job.spec.id),
  ...(memory.how === "systemd" ? { unit: unitOf(job.spec.id) } : {}),
})

export const layer = (memory: MemoryRunner) =>
  Layer.effect(
    Runner,
    Effect.gen(function* () {
      // This server's watches close with it, as the process runner's do; a later server watches again.
      const mine = new Map<string, () => void>()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const [id, announced] of mine) if (memory.watched.get(id) === announced) memory.watched.delete(id)
        }),
      )
      return Runner.of(serviceOf(memory, mine))
    }),
  )

const serviceOf = (memory: MemoryRunner, mine: Map<string, () => void>): Runner["Service"] => ({
    watch: (id, announced) =>
      Effect.sync(() => {
        if (!memory.watches) return false
        memory.watched.set(id, announced)
        mine.set(id, announced)
        if (memory.jobs.get(id)?.run.state === "ended") announced()
        return true
      }),
    unwatch: (id) =>
      Effect.sync(() => {
        memory.watched.delete(id)
        mine.delete(id)
      }),
    watching: Effect.sync(() => [...memory.watched.keys()]),
    launch: (spec) =>
      Effect.suspend(() => {
        if (memory.refusing !== undefined) return Effect.fail(new JobRefused({ message: memory.refusing }))
        memory.jobs.set(spec.id, { spec, run: { state: "starting" }, log: "", drip: "" })
        return Effect.succeed({ log: LOG(spec.id), drip: DRIP(spec.id), how: memory.how, ...(memory.how === "systemd" ? { unit: unitOf(spec.id) } : {}) })
      }),
    read: (id) =>
      Effect.sync(() => {
        memory.reads += 1
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
        if (memory.killEnds) ended(memory, id, null, yield* Clock.currentTimeMillis, { killed: true, signal: "SIGTERM" })
        return true
      }),
})
