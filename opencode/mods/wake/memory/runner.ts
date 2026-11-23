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
// missed event); `watches` false is a host out of watches. `launches` and
// `deliveries` are the job's record (job-event.ts): its launch slot, which
// `claim` (a runner) and `retire` (the wakes) race for, and its delivery
// slots, each written only on the version its writer read. The model's tests
// and the plugin's seam test use it.
import { Clock, Effect, Layer, Match, Option } from "effect"
import { type JobExit, type JobRecord, type JobSpec, NEVER_STARTED, type Run, unitOf } from "../job.ts"
import { type Delivery, type Disposition, dispositionOfExit, generationOf, type Slot } from "../job-event.ts"
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
  /** Each job's launch slot: `claimed` by its runner, or `retired` by the wakes; none while accepted. */
  readonly launches: Map<string, "claimed" | "retired">
  /** Each job's delivery record, its slots in order. */
  readonly deliveries: Map<string, Array<Delivery>>
  /** Writes to the records that die (a full disk): after `skip` more go through, the next `fail` die before they write. */
  readonly faults: { skip: number; fail: number }
}

/** The next `count` writes to a job's record die, after `skip` more go through. */
export const failWrites = (memory: MemoryRunner, count: number, skip = 0) => {
  memory.faults.skip = skip
  memory.faults.fail = count
}

/** A record write, unless a fault kills it first. */
const writing = <A>(memory: MemoryRunner, write: () => A): Effect.Effect<A> =>
  Effect.suspend(() => {
    if (memory.faults.skip > 0) memory.faults.skip -= 1
    else if (memory.faults.fail > 0) {
      memory.faults.fail -= 1
      return Effect.die(new Error("the job's record was not written (an injected fault)"))
    }
    return Effect.sync(write)
  })

export const empty = (): MemoryRunner => ({
  jobs: new Map(),
  killed: [],
  how: "detached",
  refusing: undefined,
  killEnds: true,
  reads: 0,
  watched: new Map(),
  watches: true,
  launches: new Map(),
  deliveries: new Map(),
  faults: { skip: 0, fail: 0 },
})

/** The job's runner claims it, as the process runner's does before it spawns: whether it won (false: retired, or claimed before). The command is then up since `startedAt`. */
export const claim = (memory: MemoryRunner, id: string, startedAt: number): boolean => {
  if (memory.launches.has(id)) return false
  memory.launches.set(id, "claimed")
  running(memory, id, startedAt)
  return true
}

/** The job's exit file appeared under its watch: what the process runner's watch does; nothing when it is not watched (a missed event). */
export const announce = (memory: MemoryRunner, id: string) => memory.watched.get(id)?.()

const LOG = (id: string) => `/state/opencode-job/${id}/log`
const DRIP = (id: string) => `/state/opencode-job/${id}/drip`

/** The job as the command left it: up and running since `startedAt` (its runner's claim, unless the test made one). */
export const running = (memory: MemoryRunner, id: string, startedAt: number) =>
  withJob(memory, id, (job) => {
    if (!memory.launches.has(id)) memory.launches.set(id, "claimed")
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
const record = (memory: MemoryRunner, job: MemoryJob, exit: Omit<JobExit, "disposition" | "generation" | "sequence">, disposition: Option.Option<Disposition> = Option.none()) => {
  if (!memory.launches.has(job.spec.id)) memory.launches.set(job.spec.id, "claimed")
  const full: JobExit = { ...exit, generation: generationOf(job.spec), sequence: new TextEncoder().encode(job.drip).length + 1 }
  job.run = { state: "ended", exit: { ...full, disposition: Option.getOrElse(disposition, () => dispositionOfExit(full)) } }
}

/** The job's command exited `exitCode` at `endedAt` (null: a signal ended it). */
export const ended = (memory: MemoryRunner, id: string, exitCode: JobExit["exitCode"], endedAt: number, more: { readonly timedOut?: boolean; readonly killed?: boolean; readonly signal?: string } = {}) =>
  withJob(memory, id, (job) =>
    record(memory, job, {
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
  withJob(memory, id, (job) => record(memory, job, { exitCode: 127, startedAt: endedAt, endedAt, timedOut: false, killed: false }, Option.some("spawn-failed")))

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

/** The newest slot of the job's delivery record, none before the first. */
const slotOf = (memory: MemoryRunner, id: string): Option.Option<Slot> => {
  const slots = memory.deliveries.get(id) ?? []
  return Option.map(Option.fromNullishOr(slots.at(-1)), (delivery) => ({ version: slots.length, delivery }))
}

const recordOf = (memory: MemoryRunner, job: MemoryJob): JobRecord => ({
  spec: job.spec,
  run: Match.value(memory.launches.get(job.spec.id)).pipe(
    Match.when("retired", () => NEVER_STARTED),
    Match.orElse(() => job.run),
  ),
  log: LOG(job.spec.id),
  drip: DRIP(job.spec.id),
  ...(memory.how === "systemd" ? { unit: unitOf(job.spec.id) } : {}),
  ...Option.match(slotOf(memory, job.spec.id), { onNone: () => ({}), onSome: (delivery) => ({ delivery }) }),
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
    retire: (id) =>
      writing(memory, () => {
        if (memory.launches.has(id)) return false
        memory.launches.set(id, "retired")
        return true
      }),
    advance: (id, version, next) =>
      writing(memory, () => {
        const slots = memory.deliveries.get(id) ?? []
        if (slots.length !== version) return false
        memory.deliveries.set(id, [...slots, next])
        return true
      }),
    stabilize: () => Effect.void,
    owed: ({ directory, sessionID } = {}) =>
      Effect.sync(() =>
        [...memory.jobs.values()].flatMap((job) =>
          Option.toArray(
            Option.liftPredicate(
              job.spec.id,
              () => Option.isSome(Option.fromNullishOr(job.spec.generation)) &&
                !Option.exists(Option.fromUndefinedOr(directory), (value) => value !== job.spec.directory) &&
                !Option.exists(Option.fromUndefinedOr(sessionID), (value) => value !== job.spec.sessionID) &&
                !Option.exists(slotOf(memory, job.spec.id), (slot) => slot.delivery.state === "delivered"),
            ),
          ),
        ),
      ),
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
        if (job === undefined || memory.launches.get(id) === "retired" || (job.run.state !== "running" && job.run.state !== "starting")) return false
        memory.killed.push(id)
        if (memory.killEnds) ended(memory, id, null, yield* Clock.currentTimeMillis, { killed: true, signal: "SIGTERM" })
        return true
      }),
})
