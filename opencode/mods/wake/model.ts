// The wakes' handlers. Setting an entry stores it, registers its OS job and
// arms a timer in this server; the timer, the OS job (`due`), or the next
// start fires it. A fire is recorded on the entry, with its message's id,
// before it is sent, and settled (the entry removed, or a repeat moved to its
// next tick) once the session took it; a fire that stopped short goes again
// under the same id, and the session's inbox keeps one. Changes to the store
// are serialized; a delivery and a monitor's check run outside the lock. A
// server arms only the entries of its own directory: plugins run once per
// directory, the store is shared.
//
// A latch (latch.ts) is armed the same way, but at its time it asks the
// opener to decide it again, and is settled by the answer: opened goes, held
// waits for its new time, failed goes and tells the parent. Its child's mark
// follows each change.
//
// A job (job.ts) runs under the Runner, outside the server. Its entry has no
// OS job and no timer: the runner records the exit, then calls `due`, and the
// end is reconciled from that record (job-event.ts) at once. The runner also
// watches each live job's own directory (one watch per job, closed once its
// end is delivered) and announces its exit the same way, so a server whose
// runners call no service (the backstop off) hears the end too. The start
// reconciles every job of the directory, and one recovery sweep per server
// (RECOVER_MS while any job is kept) finds what nothing announced: a runner
// gone without an exit, a launch that never came up, an end whose call was
// lost, a fire that failed; it also drips progress. A job's end reaches its
// session once: by its letter, or, for a managed job (one this build
// started), by the owner's own `park`, `wait` or `kill` that returned it.
// A managed job's record (the runner's, shared by every location) decides
// both: a launch overdue and unclaimed is retired by taking its launch slot,
// never by the clock alone; the end is claimed by taking the first delivery
// slot (`delivering`, held by the owner's call or the letter, under one
// delivery id), and only the winner acts. An owner's call stays `delivering`
// until the host committed its answer (`answered`: its `execute.after` hook,
// its tool events, or the session's context read on reconcile); one that
// failed or was stopped hands the end to the letter under the same delivery
// id, which the host's inbox admits once. A check, the owner's stop from the
// TUI or an ancestor's kill take nothing. A legacy job keeps the old rule: a
// `wait` or `kill` that saw the end takes the entry.
import { Clock, Context, Deferred, Duration, Effect, Exit, FiberMap, FiberSet, Layer, Match, Option, Random, Semaphore } from "effect"
import { idOfTitle, minuteOf, type Schedule, scheduleOf, titleOf } from "./backstop.ts"
import {
  BOARD_TAIL,
  DRIP_MS,
  ENDED_SHOWN,
  ENDED_SHOWN_MS,
  endWords,
  jobShownOf,
  type JobShown,
  KILL_WAIT_MS,
  lastLines,
  type Launched,
  LOG_TAIL,
  over,
  RECOVER_MS,
  NEVER_STARTED,
  overdue,
  type JobRecord,
  type JobSpec,
  runOrStarting,
  STARTING,
  type Run,
} from "./job.ts"
import { type Holder, isJobID, type Slot, terminalOf } from "./job-event.ts"
import { type Latch, type LatchAsk, type Mark, markOf } from "./latch.ts"
import {
  alarmLetter,
  dripLetter,
  freshPrompt,
  jobLetter,
  jobTick,
  type JobView,
  latchFailedLetter,
  type Letter,
  monitorLetter,
  type Outcome,
  unguarded,
} from "./message.ts"
import { Backstop, type CallAnswer, Changes, Checks, Courier, type DeliveryRefused, Opener, Runner, WakeStore } from "./service.ts"
import {
  type Alarm,
  type AlarmAsk,
  alarmOf,
  type Board,
  type Check,
  type Due,
  type Entry,
  type Fired as FiredEntry,
  type Firing,
  fires,
  guarded,
  type Job,
  type JobAsk,
  jobOf,
  jobOfSpec,
  type LastCheck,
  lastCheckOf,
  type Monitor,
  type MonitorAsk,
  type MonitorState,
  monitorOf,
  moved,
  nextDueAt,
  type Notice,
  ofSessions,
  type Pending,
  type Place,
  shown,
  shownOf,
  specOf,
  stepOf,
  WakeRejected,
} from "./wake.ts"

/** Where this server is, and its timings. */
export interface Config {
  /** The directory whose entries this server arms. */
  readonly directory: string
  /** How long after an OS job called `due` its job is removed, so the removal does not stop the job's own run. */
  readonly settleMs?: number
  /** How often the recovery sweep looks at this directory's kept jobs; RECOVER_MS by default. */
  readonly recoverMs?: number
  /**
   * How the host's call `call` in `sessionID` went, by the session's own record: the owner's call that took a job's end
   * delivered it only once the host committed its answer. None: every call reads `unknown`.
   */
  readonly answered?: (sessionID: string, call: string, message?: string) => Effect.Effect<CallAnswer>
  /** Whether this location currently hosts the owner of a foreign job. Consulted only for recorded deliveries on startup. */
  readonly ownerHere?: (sessionID: string) => Effect.Effect<boolean>
  /** The server this model runs in, and whether a server (by its id) still runs: a call left running by one that does not can never be committed. None: none is known gone. */
  readonly server?: Server
}

/** A server that runs owners' calls: its id, and whether a server by id still runs (a fact of its process, not a timer). */
export interface Server {
  readonly id: string
  readonly live: (id: string) => Effect.Effect<boolean>
}

/** The host's call an owner's `park`, `wait` or `kill` answers: its call id, and the message it is part of. */
export interface HostCall {
  readonly id: string
  readonly message: string
}

const callKey = (sessionID: string, call: HostCall) => `${sessionID}/${call.message}/${call.id}`

const isDelivering = (record: JobRecord) =>
  Option.exists(Option.fromUndefinedOr(record.delivery), (slot) => slot.delivery.state === "delivering")

/** What a held call's settled fact makes of the end it holds: delivered by the answer, the letter's again, nobody's, or still held. */
type Fate = "answer" | "letter" | "nobody" | "held"

/** A field of the owner's call that holds an end; none while the letter holds it, or when the record names none. */
const heldBy = <A>(holder: Holder, field: (call: Exclude<Holder, { readonly kind: "letter" }>) => A): Option.Option<NonNullable<A>> =>
  Match.value(holder).pipe(
    Match.when({ kind: "letter" }, () => Option.none<NonNullable<A>>()),
    Match.orElse((call) => Option.fromNullishOr(field(call))),
  )


/** A session takes at most this many pending entries. */
export const MAX_PENDING = 20
/** A session runs at most this many jobs at once. */
export const MAX_JOBS = 20
/** A refused fire goes again after this long. */
export const RETRY_MS = 30_000
/** An opener that could not be asked (its plugin still loading, say) is asked again after this long. */
export const OPEN_RETRY_MS = 5_000
/** A latch is asked again no sooner than this after an answer. */
export const MIN_RECHECK_MS = 1_000
/** A monitor's one check is stopped past this long. */
export const CHECK_TIMEOUT_MS = 60_000
/** The longest one sleep: a timer far ahead wakes daily to look again, since the runtime's timers stop at about 24.8 days. */
const LONGEST_SLEEP_MS = 24 * 60 * 60 * 1000

/** What setting an entry gives the tool: the entry, the time it was set, and why it has no OS job, when it has none. */
export interface Placed<E extends Entry> {
  readonly entry: E
  readonly now: number
  readonly warning?: string
}

/** What a session's wakes are, as the `wake_list` tool reads them. */
export interface Listed {
  readonly now: number
  readonly entries: ReadonlyArray<Entry>
  readonly notices: ReadonlyArray<Notice>
}

/** One job as `check`, `wait` and `kill` read it, and the time they read it. */
export interface Viewed {
  readonly now: number
  readonly view: JobView
}

/**
 * What `park`, `wait` and `kill` answer: the job as read, whether it is over, and whether this answer delivered its end
 * (the owner's call on a managed job, or a call that saw a legacy job's end): then no letter follows. An end not
 * delivered here reaches the session once, by its letter.
 */
/** A job of the `job` tool's list: its run, and the owner's call that holds its end while no fact settled it. */
export interface ListedJob {
  readonly job: Job
  readonly run: Run
  readonly held: Option.Option<string>
}

export interface Watched extends Viewed {
  readonly ended: boolean
  readonly delivered: boolean
}

export class WakesModel extends Context.Service<
  WakesModel,
  {
    readonly wake: (sessionID: string, ask: AlarmAsk) => Effect.Effect<Placed<Alarm>, WakeRejected>
    readonly monitor: (sessionID: string, ask: MonitorAsk) => Effect.Effect<Placed<Monitor>, WakeRejected>
    /** Keep a held subagent start as a latch of `ask.sessionID`, its child made unprompted: the latch's id and child. */
    readonly latch: (ask: LatchAsk) => Effect.Effect<{ readonly id: string; readonly child: string }, WakeRejected>
    /** Start a job for the session (a subagent too) under the runner: the entry, and how it was launched. */
    readonly job: (sessionID: string, ask: JobAsk) => Effect.Effect<{ readonly job: Job; readonly launched: Launched }, WakeRejected>
    /** The session's jobs still kept (running, or not yet reported), and how each stands. */
    readonly jobs: (sessionID: string) => Effect.Effect<{ readonly now: number; readonly jobs: ReadonlyArray<ListedJob> }>
    /** What the TUI's dock and Jobs tab show of the session's jobs: each kept, and each this server saw end within ENDED_SHOWN_MS (at most ENDED_SHOWN), running first. */
    readonly board: (sessionID: string) => Effect.Effect<Board>
    /** The owner stops one of the session's running jobs (the TUI's kill); unlike `kill` it leaves the entry, so the end letter still wakes the session. */
    readonly stop: (sessionID: string, id: string) => Effect.Effect<void, WakeRejected>
    /** How a job of the session (or of a subagent below it) stands now, with its last progress lines and its log's tail. A read: it takes nothing. */
    readonly check: (sessionID: string, id: string) => Effect.Effect<Viewed, WakeRejected>
    /**
     * At once: the job's end if it is over (`delivered` when this answer is its delivery, so no letter follows), else
     * that it runs. `call` is the host's call this answers: the delivery stands once the host committed it
     * (`answered`); with none, once this returns.
     */
    readonly park: (sessionID: string, id: string, call?: HostCall) => Effect.Effect<Watched, WakeRejected>
    /** Wait up to `ms` for the job to end, woken by its end, not by a poll; `delivered` and `call` as for `park`. */
    readonly wait: (sessionID: string, id: string, ms: number, call?: HostCall) => Effect.Effect<Watched, WakeRejected>
    /** Stop the job, and wait a little for its end; `delivered` and `call` as for `park`. Whether a running job was asked to stop. */
    readonly kill: (sessionID: string, id: string, call?: HostCall) => Effect.Effect<Watched & { readonly asked: boolean }, WakeRejected>
    /**
     * A durable host tool event: `committed` (its answer is in the session) or `failed` (the letter takes over).
     */
    readonly answered: (sessionID: string, call: HostCall, outcome: "committed" | "failed") => Effect.Effect<void>
    /**
     * The session is about to be compacted, and `answer` reads each call in the view the compaction replaces: every
     * end a call of it holds is settled by that fact now, while the call is still in view (a compaction keeps the
     * stored part but takes it out of every later read).
     */
    readonly compacting: (sessionID: string, answer: (call: string, message?: string) => Effect.Effect<CallAnswer>) => Effect.Effect<void>
    /** Re-read held calls after a move or committed revert. The event itself proves nothing about a specific call. */
    readonly recheckOwner: (sessionID: string) => Effect.Effect<void>
    /** Cancel `id`, or every entry of the session when none is named; an unread notice named goes too, and a latch's child reads cancelled. A job is not cancelled: it is killed. The ids that went. */
    readonly cancel: (sessionID: string, id?: string) => Effect.Effect<ReadonlyArray<string>, WakeRejected>
    readonly list: (sessionID: string) => Effect.Effect<Listed>
    /** What the trays of `sessionIDs` show. */
    readonly pending: (sessionIDs: ReadonlyArray<string>) => Effect.Effect<Pending>
    /** An OS job's call, or a job runner's when its command exited: fire the entry when it is due here and not yet fired. */
    readonly due: (id: string) => Effect.Effect<Due>
    /** Arm this directory's entries (each one past due fires now, and says how late) and drop the OS jobs whose entry is gone. */
    readonly start: Effect.Effect<void>
    /** A deleted session's entries and notices go, and their OS jobs, and its jobs are killed; so does a latch whose child it was. */
    readonly forget: (sessionID: string) => Effect.Effect<void>
    /** The session read the notice delivered under `delivery`. */
    readonly read: (delivery: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/wake/WakesModel") {}

/** How one fire ended: settled (`done`, or `again` for a repeat's next tick), `gone` (nobody to take it), or `refused` (it goes again). */
type Fired = "done" | "again" | "gone" | "refused"

/** What a fire carries before its ids are minted. */
interface Made {
  readonly letter: Letter
  readonly tick: number
  readonly fresh?: Alarm["newSession"]
  /** A repeating monitor's match: the state its check left, kept with the fire, and the monitor goes on once it settles. */
  readonly again?: MonitorState
}

const SUBAGENT =
  "wake and monitor are for a root session: a subagent hands back when its turn ends, and nothing waits for its wake. Wait in a background shell command instead, which your parent waits on."

/** How far up its ancestors a session's job is reached from: a parent reads its subagent's job, so does the parent's parent. */
const MAX_ANCESTORS = 8

/** A call waiting on a job's end; `takes` when it is the owner's call on a managed job, which takes the end itself. */
/** Whether a job is managed (this build started it): its record, not its entry, decides its end. */
const managed = (spec: Pick<JobSpec, "generation">) => Option.isSome(Option.fromNullishOr(spec.generation))

/** Where a managed job's letter went once sent (its session gone: nobody), and what its reconcile says. */
const SENT_TO = { sent: "letter", gone: "nobody" } as const
const SENT_OUTCOME = { sent: "fired", gone: "gone" } as const

/** A job as its end reads now: its entry (or one made from its spec), its runner's record, if any, and its view. */
interface Ended {
  readonly job: Job
  readonly record: Option.Option<JobRecord>
  readonly view: JobView
}

interface Waiter {
  signal: Deferred.Deferred<void>
  readonly takes: boolean
}

/** The alarm with no fire recorded and `dueAt` moved on. */
const advanced = (alarm: Alarm, dueAt: number): Alarm => ({
  kind: "alarm",
  id: alarm.id,
  sessionID: alarm.sessionID,
  directory: alarm.directory,
  mode: alarm.mode,
  note: alarm.note,
  setAt: alarm.setAt,
  dueAt,
  ...(alarm.everySeconds === undefined ? {} : { everySeconds: alarm.everySeconds }),
  ...(alarm.newSession === undefined ? {} : { newSession: alarm.newSession }),
})

const withFiring = (entry: FiredEntry, firing: Firing): FiredEntry =>
  entry.kind === "alarm" ? { ...entry, firing } : entry.kind === "monitor" ? { ...entry, firing } : { ...entry, firing }

/** The monitor with no fire recorded. */
const unfired = (monitor: Monitor): Monitor => {
  const { firing: _, ...rest } = monitor
  return rest
}

const ID_SPACE = 36 ** 6

export const layer = (config: Config) =>
  Layer.effect(
    WakesModel,
    Effect.gen(function* () {
      const store = yield* WakeStore
      const courier = yield* Courier
      const checks = yield* Checks
      const backstop = yield* Backstop
      const changes = yield* Changes
      const opener = yield* Opener
      const runner = yield* Runner
      const lock = yield* Semaphore.make(1)
      const locked = lock.withPermits(1)
      const timers = yield* FiberMap.make<string>()
      const later = yield* FiberSet.make()
      const settleMs = config.settleMs ?? 5000
      const recoverMs = config.recoverMs ?? RECOVER_MS
      /** Each running monitor's newest check, for the tray; it goes with the monitor's timer. */
      const lastChecks = new Map<string, LastCheck>()
      /** The jobs this server has seen, by id, with their session: the board shows one for a while after its entry went. */
      const seenJobs = new Map<string, string>()

      const sleepUntil = (at: number) =>
        Effect.gen(function* () {
          for (;;) {
            const now = yield* Clock.currentTimeMillis
            if (now >= at) return
            yield* Effect.sleep(Duration.millis(Math.min(at - now, LONGEST_SLEEP_MS)))
          }
        })

      // ── The OS backstop ──

      /** Register the entry's OS job; why not, when it was refused. */
      const guard = (entry: Entry, schedule: Schedule = scheduleOf(entry)) =>
        backstop.register({ id: entry.id, title: titleOf(entry.id), directory: entry.directory }, schedule).pipe(
          Effect.as(undefined),
          Effect.catchTag("BackstopRefused", (refused) =>
            Effect.logWarning("wake: no OS backstop", { id: entry.id, message: refused.message }).pipe(Effect.as(unguarded(refused.message))),
          ),
        )

      /** Drop the entry's OS job; with `defer`, after the job's own run had time to end. A job's entry has none. */
      const dropJob = (id: string, defer: boolean) => {
        if (isJobID(id)) return Effect.void
        const drop = backstop.remove(titleOf(id)).pipe(
          Effect.catchTag("BackstopRefused", (refused) => Effect.logWarning("wake: an OS job was not removed", { id, message: refused.message })),
        )
        return defer ? FiberSet.run(later, Effect.sleep(Duration.millis(settleMs)).pipe(Effect.andThen(drop))).pipe(Effect.asVoid) : drop
      }

      /**
       * Whether a fire's job may be running as it settles: a fire at or past the
       * job's minute (a late one, made by the start the job itself brought up).
       * Removing a running launchd job kills it mid-call, so its removal waits.
       */
      const mayRun = (firing: Firing) => firing.firedAt >= minuteOf(firing.tick)

      // ── Firing ──

      /** Record the fire on the entry (once: a fire recorded before is kept), and a `notify`'s notice, under the lock; undefined when there is no entry or nothing to fire. */
      const record = (id: string, make: (entry: FiredEntry, now: number) => Made | undefined) =>
        locked(
          Effect.gen(function* () {
            const entry = yield* store.read(id)
            if (entry === undefined || !fires(entry)) return undefined
            if (entry.firing !== undefined) return { entry, firing: entry.firing }
            const now = yield* Clock.currentTimeMillis
            const made = make(entry, now)
            if (made === undefined) return undefined
            const delivery = yield* courier.newDelivery
            const session = made.fresh === undefined ? undefined : yield* courier.newSession
            const firing: Firing = {
              delivery,
              ...(session === undefined ? {} : { session }),
              text: made.fresh === undefined || entry.kind !== "alarm" ? made.letter.text : freshPrompt(entry, made.fresh, made.tick, now),
              description: made.letter.description,
              metadata: { ...made.letter.metadata },
              firedAt: now,
              tick: made.tick,
              ...(made.again === undefined ? {} : { again: true }),
            }
            const kept: FiredEntry =
              made.again !== undefined && entry.kind === "monitor" ? { ...entry, ...made.again, fired: (entry.fired ?? 0) + 1 } : entry
            const fired = withFiring(kept, firing)
            yield* store.write(fired)
            // A notice is left before the fire is sent: a running turn may read the message, and say so, before the send returns.
            if (entry.mode === "notify")
              yield* store.writeNotice({
                delivery,
                wakeID: entry.id,
                sessionID: entry.sessionID,
                directory: entry.directory,
                description: firing.description,
                firedAt: now,
              })
            return { entry: fired, firing }
          }),
        )

      /** Send the recorded fire into its session, or start the session it names. */
      const send = (entry: FiredEntry, firing: Firing): Effect.Effect<void, DeliveryRefused> =>
        entry.kind === "alarm" && entry.newSession !== undefined && firing.session !== undefined
          ? courier.start({ sessionID: firing.session, directory: entry.newSession.directory, delivery: firing.delivery, text: firing.text })
          : courier.deliver(entry.sessionID, firing.delivery, { text: firing.text, description: firing.description, metadata: firing.metadata }, entry.mode === "wake")

      /** The fire reached its session: move a repeat on or drop the entry. Only the fire still recorded settles. */
      const settle = (id: string, firing: Firing, defer: boolean) =>
        locked(
          Effect.gen(function* () {
            const entry = yield* store.read(id)
            if (entry === undefined || !fires(entry) || entry.firing?.delivery !== firing.delivery) return "done" as const
            if (entry.kind === "alarm" && entry.everySeconds !== undefined) {
              const next = advanced(entry, nextDueAt(firing.tick, entry.everySeconds, firing.firedAt))
              yield* store.write(next)
              const schedule = scheduleOf(next)
              if (!schedule.recurring) yield* guard(next, schedule)
              yield* changes.changed(entry.sessionID)
              return "again" as const
            }
            if (entry.kind === "monitor" && firing.again === true) {
              yield* store.write(unfired(entry))
              yield* changes.changed(entry.sessionID)
              return "again" as const
            }
            yield* store.remove(id)
            yield* dropJob(id, defer || mayRun(firing))
            yield* changes.changed(entry.sessionID)
            return "done" as const
          }),
        )

      /** Drop an entry whose session is gone, its job, and the notice its fire left. */
      const abandon = (id: string, firing: Firing, defer: boolean) =>
        locked(
          Effect.gen(function* () {
            const entry = yield* store.read(id)
            yield* store.removeNotice(firing.delivery)
            yield* store.remove(id)
            yield* dropJob(id, defer || mayRun(firing))
            if (entry !== undefined) yield* changes.changed(entry.sessionID)
          }),
        )

      /** Record, send and settle one fire. */
      const fire = (id: string, make: (entry: FiredEntry, now: number) => Made | undefined, defer: boolean): Effect.Effect<Fired> =>
        Effect.gen(function* () {
          const recorded = yield* record(id, make)
          if (recorded === undefined) return "gone" as const
          yield* changes.changed(recorded.entry.sessionID)
          const sent = yield* send(recorded.entry, recorded.firing).pipe(
            Effect.as("sent" as const),
            Effect.catchTag("DeliveryRefused", (refused) =>
              refused.gone
                ? abandon(id, recorded.firing, defer).pipe(Effect.as("gone" as const))
                : Effect.logWarning("wake: the session did not take a fire; it goes again", { id, message: refused.message }).pipe(Effect.as("refused" as const)),
            ),
          )
          if (sent !== "sent") return sent
          return yield* settle(id, recorded.firing, defer)
        })

      const alarmFire = (entry: FiredEntry, now: number): Made | undefined => {
        if (entry.kind !== "alarm") return undefined
        const next = entry.everySeconds === undefined ? undefined : nextDueAt(entry.dueAt, entry.everySeconds, now)
        return {
          letter: alarmLetter(entry, entry.dueAt, now, next),
          tick: entry.dueAt,
          ...(entry.newSession === undefined ? {} : { fresh: entry.newSession }),
        }
      }

      const monitorFire =
        (outcome: Outcome, count: number, last: Check | undefined, state?: MonitorState) =>
        (entry: FiredEntry, now: number): Made | undefined =>
          entry.kind === "monitor"
            ? {
                letter: monitorLetter(entry, outcome, count, last, now),
                tick: outcome === "matched" ? now : entry.deadline,
                ...(outcome === "matched" && entry.repeat !== undefined ? { again: state ?? {} } : {}),
              }
            : undefined

      /** Keep what a check that fired nothing left on a repeating monitor; a fire recorded meanwhile keeps its own. */
      const keepState = (id: string, state: MonitorState) =>
        locked(
          Effect.gen(function* () {
            const current = yield* store.read(id)
            if (current?.kind !== "monitor" || current.firing !== undefined) return
            yield* store.write({ ...current, ...state })
          }),
        )

      // ── Jobs ──

      /** How a job's record stands: its run, its log's tail, and its progress from byte `from` (a letter's: what is not yet delivered) or all of it (a check's: the last lines). */
      const viewFrom = (record: JobRecord, from: number) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const progress = yield* runner.drip(record.spec.id, from)
          const view: JobView = {
            spec: record.spec,
            run: record.run,
            log: record.log,
            unit: record.unit,
            logTail: yield* runner.tail(record.spec.id, LOG_TAIL),
            progress: lastLines(progress.text),
            event: terminalOf(record.spec, record.run, now),
          }
          return view
        })

      /** How a job stands now; undefined for an id the runner never launched. */
      const viewOf = (id: string, from = 0) =>
        Effect.gen(function* () {
          const record = yield* runner.read(id)
          if (record === undefined) return undefined
          return yield* viewFrom(record, from)
        })

      const jobFire =
        (view: JobView) =>
        (entry: FiredEntry, now: number): Made | undefined =>
          entry.kind === "job" ? { letter: jobLetter(entry, view, now), tick: jobTick(view.run, now) } : undefined

      /** A fresh id for one write of a job's delivery record (the courier's next message id, never reused). */
      const fresh = courier.newDelivery

      /** The newest slot of a job's delivery record; none before its end was claimed, or for an id the runner never launched. */
      const slotIn = (id: string) => runner.read(id).pipe(Effect.map((record) => Option.flatMapNullishOr(Option.fromNullishOr(record), (found) => found.delivery)))

      /**
       * A job as its end reads now, from its record, or from its entry when the runner has none. A job of this directory
       * still starting past its grace is retired first, unless a runner claimed it before: the launch slot says which,
       * and the grace only says when to try. None for an id with neither.
       */
      const endOf = (id: string, entry: Option.Option<Job>) =>
        Effect.gen(function* () {
          const before = Option.fromNullishOr(yield* runner.read(id))
          const found = Option.orElse(Option.map(before, (record) => record.spec), () => Option.map(entry, specOf))
          if (Option.isNone(found)) return Option.none<Ended>()
          const spec = found.value
          const now = yield* Clock.currentTimeMillis
          const retiring = spec.directory === config.directory && overdue(runOrStarting(Option.map(before, (record) => record.run)), spec.setAt, now)
          const record = yield* Match.value(retiring).pipe(
            Match.when(true, () => runner.retire(id).pipe(Effect.andThen(runner.read(id)), Effect.map(Option.fromNullishOr))),
            Match.orElse(() => Effect.succeed(before)),
          )
          const job = Option.getOrElse(entry, () => jobOfSpec(spec))
          if (Option.isSome(record)) return Option.some<Ended>({ job, record, view: yield* viewFrom(record.value, job.dripped) })
          // The runner has no record of it (its launch never wrote one): retired, it never started, and never will.
          const run = Match.value(retiring).pipe(Match.when(true, () => NEVER_STARTED), Match.orElse(() => STARTING))
          return Option.some<Ended>({ job, record, view: { spec, run, log: "", logTail: "", progress: "", event: terminalOf(spec, run, now) } })
        })

      /** Deliver the progress written since the last delivery, at most once per DRIP_MS, starting no turn. */
      const drip = (job: Job) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          if (now - job.drippedAt < DRIP_MS) return
          const written = yield* runner.drip(job.id, job.dripped)
          const lines = lastLines(written.text)
          if (lines === "") return
          const moved = yield* locked(
            Effect.gen(function* () {
              const current = yield* store.read(job.id)
              if (current?.kind !== "job" || current.firing !== undefined || current.dripped !== job.dripped) return false
              yield* store.write({ ...current, dripped: written.offset, drippedAt: now })
              return true
            }),
          )
          if (!moved) return
          // At most once: progress is moved past before it is sent, so a lost one is not sent twice; the end letter carries what follows.
          const delivery = yield* courier.newDelivery
          yield* courier
            .deliver(job.sessionID, delivery, dripLetter(job, lines, now), false)
            .pipe(Effect.catchTag("DeliveryRefused", (refused) => Effect.logWarning("wake: a job's progress did not reach its session", { id: job.id, message: refused.message })))
        })

      /** Each job's own lock: its end is reconciled, handed to an owner's call and settled one at a time. */
      const jobLocks = new Map<string, Semaphore.Semaphore>()
      const serially =
        (id: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
          Effect.suspend(() => {
            const held = jobLocks.get(id) ?? Semaphore.makeUnsafe(1)
            jobLocks.set(id, held)
            return held.withPermits(1)(effect)
          })

      /**
       * The calls waiting on a job's end in this server (`wait`, a `kill` waiting for the stop), each registered before
       * it reads the job, so an end that comes between the read and the wait still reaches it. An owner's managed wait
       * takes the end itself: while one waits, a reconcile rings it instead of firing the letter.
       */
      const waiters = new Map<string, Set<Waiter>>()
      const ring = (id: string) =>
        Effect.sync(() => {
          for (const waiter of waiters.get(id) ?? []) Deferred.doneUnsafe(waiter.signal, Effect.void)
        })
      const taking = (id: string) => [...(waiters.get(id) ?? [])].some((waiter) => waiter.takes)

      // ── The recovery sweep: one per server ──

      /** Jobs to reconcile again, by when: a refused or failed fire, a call that left. */
      const retries = new Map<string, number>()
      /** When the sweep next looks at this directory's running jobs; none while none runs. */
      let sweepAt = Option.none<number>()
      let kicked = Deferred.makeUnsafe<void>()
      const kick = Effect.sync(() => void Deferred.doneUnsafe(kicked, Effect.void))
      /** Reconcile `id` again `ms` from now (the earliest asked wins), by the sweep's fiber. */
      const again = (id: string, ms: number) =>
        Effect.gen(function* () {
          const at = (yield* Clock.currentTimeMillis) + ms
          if (!Option.exists(Option.fromNullishOr(retries.get(id)), (before) => before <= at)) retries.set(id, at)
          yield* kick
        })

      /**
       * Follow a job of this server's: its runner watches for its exit and announces it, which asks the sweep's fiber to
       * reconcile it at once; then it is reconciled now (an end before the watch opened). The watch only announces: the
       * end is read from the runner's files and delivered by the one path below, so the runner's call, the watch and
       * the sweep in any order deliver it once. A job the host cannot watch is left to the sweep.
       */
      const follow = (id: string) =>
        runner
          .watch(id, () => {
            retries.set(id, 0)
            Deferred.doneUnsafe(kicked, Effect.void)
          })
          .pipe(Effect.andThen(again(id, 0)))

      /** The job's entry goes, its watch closes, and its session's board reads again when an entry went. */
      const tidy = (id: string) =>
        Effect.gen(function* () {
          const gone = yield* locked(
            Effect.gen(function* () {
              const entry = yield* store.read(id)
              if (entry?.kind !== "job") return Option.none<Job>()
              yield* store.remove(id)
              return Option.some(entry)
            }),
          )
          yield* runner.unwatch(id)
          yield* Option.match(gone, { onNone: () => Effect.void, onSome: (entry) => changes.changed(entry.sessionID) })
        })

      /** Whether the host committed the owner's call that took a job's end; `unknown` with no way to ask. */
      const ask = (holder: Exclude<Holder, { readonly kind: "letter" }>, call: string): Effect.Effect<CallAnswer> =>
        Option.match(Option.fromNullishOr(config.answered), { onNone: () => Effect.succeed<CallAnswer>("unknown"), onSome: (answered) => answered(holder.sessionID, call, holder.message) })

      /**
       * Send a managed job's letter under the delivery id its record holds (`version` its slot): the session keeps one
       * message per id, so whoever sends it again sends nothing new. Then the record reads delivered (one writer wins;
       * a loser has nothing left to do) and the entry goes.
       */
      const post = (job: Job, view: JobView, version: number, delivery: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const sent = yield* courier.deliver(job.sessionID, delivery, jobLetter(job, view, now), true).pipe(
            Effect.as("sent" as const),
            Effect.catchTag("DeliveryRefused", (refused) =>
              Match.value(refused.gone).pipe(
                Match.when(true, () => Effect.succeed("gone" as const)),
                Match.orElse(() => Effect.logWarning("wake: the session did not take a job's letter; it goes again", { id: job.id, message: refused.message }).pipe(Effect.as("refused" as const))),
              ),
            ),
          )
          if (sent === "refused") {
            yield* again(job.id, RETRY_MS)
            return "refused" as const
          }
          yield* runner.advance(job.id, version, { state: "delivered", delivery, attempt: yield* fresh, to: SENT_TO[sent] })
          yield* tidy(job.id)
          return SENT_OUTCOME[sent]
        })

      const forgetCall = (holder: Holder) => {
        if (holder.kind === "letter") return
        const key = Option.zipWith(Option.fromUndefinedOr(holder.call), Option.fromUndefinedOr(holder.message), (id, message) => callKey(holder.sessionID, { id, message }))
        for (const each of Option.toArray(key)) calls.delete(each)
      }

      /** Write the job's record delivered at `version` (a loser has nothing to do), and its entry goes. */
      const delivered = (id: string, slot: Slot, to: "answer" | "nobody") =>
        Effect.gen(function* () {
          yield* runner.advance(id, slot.version, { state: "delivered", delivery: slot.delivery.delivery, attempt: yield* fresh, to })
          if (slot.delivery.state === "delivering") forgetCall(slot.delivery.holder)
          yield* tidy(id)
          return "gone" as const
        })

      /**
       * A managed job's end, delivered by its record: whoever acts writes the next slot first, and does nothing when it
       * loses. No slot yet: the letter claims it and goes. The letter holds it: it goes again under its id. The owner's
       * call holds it: the host says how that call went: committed, the end was delivered; failed (or the session gone),
       * the letter takes over under the same delivery id (nobody if deleted). Still running in a live server, missing
       * from a pruned view, or unreadable: keep the obligation and ask again.
       */
      const deliver = (job: Job, view: JobView, slot: Option.Option<Slot>): Effect.Effect<Due["outcome"]> =>
        Effect.gen(function* () {
          if (Option.isNone(slot)) {
            const delivery = yield* courier.newDelivery
            if (!(yield* runner.advance(job.id, 0, { state: "delivering", delivery, attempt: yield* fresh, holder: { kind: "letter" } }))) return "pending" as const
            return yield* post(job, view, 1, delivery)
          }
          const held = slot.value.delivery
          if (held.state === "delivered") {
            yield* runner.stabilize(job.id)
            yield* tidy(job.id)
            return "gone" as const
          }
          const holder = held.holder
          if (holder.kind === "letter") {
            yield* runner.stabilize(job.id)
            return yield* post(job, view, slot.value.version, held.delivery)
          }
          const call = Option.fromNullishOr(holder.call)
          if (Option.isNone(call)) return "pending" as const
          const fate = yield* fateOf(holder, call.value, yield* ask(holder, call.value))
          if (fate === "answer" || fate === "nobody") return yield* delivered(job.id, slot.value, fate)
          if (fate === "held") {
            // A moved session may be the only open location. Keep asking under the same recovery scheduler.
            if (job.directory !== config.directory) yield* again(job.id, recoverMs)
            return "pending" as const
          }
          if (!(yield* toLetter(job.id, slot.value))) return "pending" as const
          return yield* post(job, view, slot.value.version + 1, held.delivery)
        })

      /**
       * The host's fact on the owner's call that holds an end, and what it makes of it: committed, the answer delivered
       * it; failed (an error or a stop), or still running in a server that no longer runs (no answer of it can be
       * committed any more), the letter takes it again under the same delivery id; the session gone, nobody. Running
       * in a live server, or unknown (the call out of the view this read had), it stays held: asked again at the next
       * reconcile, and shown held in the job list. No timer decides it.
       */
      const statedFate = (said: CallAnswer): Fate =>
        Match.value(said).pipe(
          Match.when("committed", (): Fate => "answer"),
          Match.when("failed", (): Fate => "letter"),
          Match.when("missing", (): Fate => "letter"),
          Match.when("gone", (): Fate => "nobody"),
          Match.orElse((): Fate => "held"),
        )

      const fateOf = (holder: Exclude<Holder, { readonly kind: "letter" }>, call: string, said: CallAnswer): Effect.Effect<Fate> =>
        Effect.gen(function* () {
          if (said !== "running" || !(yield* goneServer(holder))) return statedFate(said)
          // The old process might have committed between our first read and its death. Read again after proving death.
          const final = yield* ask(holder, call)
          if (final === "running") return "letter"
          return statedFate(final)
        })

      /** Whether the server that ran a held call is known to run no more. */
      const goneServer = (holder: Holder) =>
        Option.match(
          Option.zipWith(heldBy(holder, (call) => call.server), Option.fromNullishOr(config.server), (id, server) => ({ id, server })),
          { onNone: () => Effect.succeed(false), onSome: ({ id, server }) => Effect.map(server.live(id), (live) => !live) },
        )

      /** The letter takes the end a call held at `slot` again, under its delivery id; whether this write took it. */
      const toLetter = (id: string, slot: Slot) =>
        Effect.gen(function* () {
          const held = slot.delivery
          if (held.state !== "delivering") return false
          const taken = yield* runner.advance(id, slot.version, { state: "delivering", delivery: held.delivery, attempt: yield* fresh, holder: { kind: "letter" } })
          forgetCall(held.holder)
          return taken
        })

      /**
       * Settle by `decide` each end a call of `sessionID` holds, including jobs started before a location move:
       * its fate written now, a letter then sent by the job's reconcile.
       */
      const settleHeld = (sessionID: string, decide: (holder: Exclude<Holder, { readonly kind: "letter" }>, call: string) => Effect.Effect<Fate>) =>
        Effect.gen(function* () {
          const ids = yield* runner.owed({ sessionID })
          yield* Effect.forEach(
            ids,
            (id) =>
              serially(id)(
                Effect.gen(function* () {
                  const slot = yield* slotIn(id)
                  if (Option.isNone(slot) || slot.value.delivery.state !== "delivering") return
                  const holder = slot.value.delivery.holder
                  if (holder.kind === "letter" || holder.sessionID !== sessionID) return
                  const call = Option.fromNullishOr(holder.call)
                  if (Option.isNone(call)) return
                  const fate = yield* decide(holder, call.value)
                  if (fate === "answer" || fate === "nobody") yield* delivered(id, slot.value, fate)
                  if (fate === "letter") yield* toLetter(id, slot.value)
                }),
              ).pipe(
                Effect.catchCause((cause) => Effect.logWarning("wake: a held job end could not settle", { id, cause: String(cause) })),
                Effect.andThen(again(id, 0)),
              ),
            { discard: true },
          )
        })

      /** The owner's call that held a job's end could not hand it over (it failed, or was stopped): the letter takes over under the same delivery id. */
      const handBack = (id: string) =>
        serially(id)(
          Effect.gen(function* () {
            const slot = yield* slotIn(id)
            if (Option.isNone(slot) || slot.value.delivery.state !== "delivering" || slot.value.delivery.holder.kind === "letter") return
            yield* toLetter(id, slot.value)
          }),
        ).pipe(Effect.andThen(again(id, 0)))

      /** A legacy job's end (an older build's entry): its fire on the entry, as that build kept it. */
      const fireLegacy = (id: string, make: (entry: FiredEntry, now: number) => Made | undefined) =>
        Effect.gen(function* () {
          const fired = yield* fire(id, make, false)
          if (fired === "refused") {
            yield* again(id, RETRY_MS)
            return "refused" as const
          }
          return Match.value(fired).pipe(Match.when("gone", () => "gone" as const), Match.orElse(() => "fired" as const))
        })

      /**
       * A job's end, reconciled from what its runner recorded: a managed job's by its record (`deliver`), unless an
       * owner's call here waits to take it; a legacy job's, or one the runner has no record of, by a fire recorded on its
       * entry, which goes again under its id. A failure (a write that died, a session that refused) leaves things as
       * they were and asks again.
       */
      const reconcile = (id: string, look: { readonly drip?: boolean } = {}): Effect.Effect<Due["outcome"]> =>
        serially(id)(
          Effect.gen(function* () {
            const found = Option.fromNullishOr(yield* store.read(id))
            if (Option.exists(found, (each) => each.kind !== "job")) return "pending" as const
            const entry = Option.filter(found, (each): each is Job => each.kind === "job")
            if (Option.exists(entry, (job) => job.directory === config.directory && Option.isSome(Option.fromNullishOr(job.firing)))) return yield* fireLegacy(id, () => undefined)
            const read = yield* endOf(id, entry)
            if (Option.isNone(read)) return "gone" as const
            const ended = read.value
            // A moved owner's held delivery can settle here, but this location must not start attending a foreign job.
            if (ended.view.spec.directory !== config.directory && !Option.exists(ended.record, isDelivering)) return "pending" as const
            if (!over(ended.view.run)) {
              yield* Effect.forEach(Option.toArray(Option.filter(entry, () => look.drip === true)), drip, { discard: true })
              return "pending" as const
            }
            if (taking(id)) {
              yield* ring(id)
              return "pending" as const
            }
            // A managed job's end is its record's to deliver; a legacy job's, its entry's; one with neither is gone.
            const delivery = Option.flatMap(Option.filter(ended.record, () => managed(ended.view.spec)), (record) => Option.some(Option.fromNullishOr(record.delivery)))
            const outcome = yield* Option.match(delivery, {
              onSome: (slot) => deliver(ended.job, ended.view, slot),
              onNone: () => Option.match(entry, { onNone: () => Effect.succeed("gone" as const), onSome: () => fireLegacy(id, jobFire(ended.view)) }),
            })
            yield* ring(id)
            return outcome
          }),
        ).pipe(
          // Its end delivered (or its entry gone): its watch closes.
          Effect.tap((outcome) => runner.unwatch(id).pipe(Effect.when(Effect.succeed(outcome === "fired" || outcome === "gone")))),
          Effect.catchCause((cause) =>
            Effect.logWarning("wake: a job's end did not settle; it is reconciled again", { id, cause: String(cause) }).pipe(
              Effect.andThen(again(id, RETRY_MS)),
              Effect.as("pending" as const),
            ),
          ),
        )

      /** The sweep's one pass: the retries due, then, once a sweep's time came, every job of this directory still kept. */
      const sweep = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        for (const [id, at] of retries) {
          if (at > now) continue
          retries.delete(id)
          yield* reconcile(id, { drip: true })
        }
        const entries = yield* store.entries
        // A watch whose entry went by another path (a store edited under it) closes here.
        const ids = new Set(entries.map((entry) => entry.id))
        for (const id of yield* runner.watching) if (!ids.has(id)) yield* runner.unwatch(id)
        // This directory's jobs still kept, and its managed jobs whose delivery is still owed (an owner's call that took
        // the end and has not handed it over, after its entry went).
        const kept = [
          ...new Set([...entries.filter((entry) => entry.kind === "job" && entry.directory === config.directory).map((entry) => entry.id), ...(yield* runner.owed({ directory: config.directory }))]),
        ]
        if (kept.length === 0) sweepAt = Option.none()
        else if (Option.isNone(sweepAt)) sweepAt = Option.some(now + recoverMs)
        else if (now >= sweepAt.value) {
          sweepAt = Option.some(now + recoverMs)
          for (const id of kept) yield* reconcile(id, { drip: true })
        }
        const next = Math.min(Option.getOrElse(sweepAt, () => Number.POSITIVE_INFINITY), ...retries.values())
        return Option.map(Option.liftPredicate(next, Number.isFinite), (at) => Math.max(0, at - now))
      })

      /** The sweep's fiber: a pass, then sleep until the next one is due or a kick comes; with nothing kept, only a kick wakes it. */
      const recovery = Effect.gen(function* () {
        for (;;) {
          kicked = Deferred.makeUnsafe<void>()
          const signal = kicked
          const delay = yield* sweep.pipe(Effect.catchCause((cause) => Effect.logWarning("wake: the job sweep failed", { cause: String(cause) }).pipe(Effect.as(Option.some(RETRY_MS)))))
          yield* Option.match(delay, {
            onNone: () => Deferred.await(signal),
            onSome: (ms) => Effect.raceFirst(Deferred.await(signal), Effect.sleep(Duration.millis(ms))),
          })
        }
      })

      /** The job's home and the moved owner's destination can resume a recorded delivery at startup. */
      const resumeOwed = (entries: ReadonlyArray<Entry>, own: ReadonlyArray<Entry>) =>
        Effect.gen(function* () {
          const owed = yield* runner.owed({ directory: config.directory })
          for (const id of owed) if (!own.some((entry) => entry.id === id)) yield* again(id, 0)
          for (const ownerHere of Option.toArray(Option.fromUndefinedOr(config.ownerHere))) {
            const local = new Set(owed)
            const candidates = new Set(yield* runner.owed())
            for (const entry of entries) {
              if (entry.kind === "job" && (yield* ownerHere(entry.sessionID))) candidates.add(entry.id)
            }
            for (const id of candidates) {
              if (local.has(id)) continue
              const record = Option.filter(Option.fromUndefinedOr(yield* runner.read(id)), isDelivering)
              if (Option.isSome(record) && (yield* ownerHere(record.value.spec.sessionID))) yield* again(id, 0)
            }
          }
        })

      /** Take a job's entry whose end was read to the caller, so no letter follows; one whose letter is already recorded goes on. */
      const take = (id: string) =>
        Effect.gen(function* () {
          const taken = yield* locked(
            Effect.gen(function* () {
              const entry = yield* store.read(id)
              if (entry?.kind !== "job" || entry.firing !== undefined) return undefined
              yield* store.remove(id)
              return entry
            }),
          )
          if (taken === undefined) return
          yield* disarm(id)
          yield* runner.unwatch(id)
          yield* changes.changed(taken.sessionID)
        })

      const noJob = (id: string) => new WakeRejected({ reason: `No job ${id}: job({ action: "list" }) lists this session's jobs.` })

      /** Whether `sessionID` may read and stop a job of `owner`'s: it is that session, or one of its ancestors (a parent reads its subagent's). */
      const mayReach = (sessionID: string, owner: string) =>
        Effect.gen(function* () {
          let at = Option.some(owner)
          for (let hops = 0; Option.isSome(at) && hops <= MAX_ANCESTORS; hops += 1) {
            if (at.value === sessionID) return true
            at = Option.fromNullishOr(yield* courier.parentOf(at.value))
          }
          return false
        })

      /** The job as `sessionID` may read it now; a job of another session's, or none, reads as no job. */
      const viewed = (sessionID: string, id: string) =>
        Effect.gen(function* () {
          const view = yield* viewOf(id)
          if (view === undefined || !(yield* mayReach(sessionID, view.spec.sessionID))) return yield* noJob(id)
          return { now: yield* Clock.currentTimeMillis, view }
        })

      /** The owner's calls that hold a managed job's end, by the host's call id: the host's word on that call settles it. */
      const calls = new Map<string, string>()

      /**
       * Claim an ended job's end for the call that read it, when that call delivers it: the owner's own call on a
       * managed job, by writing its record's first delivery slot (held by this call, under a fresh delivery id); any
       * `wait` or `kill` that saw a legacy job's end (the old rule), by taking its entry. Whether this call won it.
       */
      const claim = (sessionID: string, view: JobView, call: Option.Option<HostCall>) =>
        Effect.gen(function* () {
          const id = view.spec.id
          if (!managed(view.spec)) {
            const entry = Option.fromNullishOr(yield* store.read(id))
            if (!Option.exists(entry, (each) => each.kind === "job" && Option.isNone(Option.fromNullishOr(each.firing)))) return false
            yield* take(id)
            return true
          }
          if (view.spec.sessionID !== sessionID) return false
          if (Option.isSome(yield* slotIn(id))) return false
          const server = Option.match(Option.fromNullishOr(config.server), { onNone: () => ({}), onSome: (each) => ({ server: each.id }) })
          const holder: Holder = { kind: "answer", sessionID, ...Option.match(call, { onNone: () => ({}), onSome: (each) => ({ call: each.id, message: each.message, ...server }) }) }
          const won = yield* runner.advance(id, 0, { state: "delivering", delivery: yield* courier.newDelivery, attempt: yield* fresh, holder })
          for (const each of Option.toArray(Option.filter(call, () => won))) calls.set(callKey(sessionID, each), id)
          return won
        }).pipe(serially(view.spec.id))

      /**
       * A model call with no host call behind it (the model's own tests) has nothing to wait for: its return is the
       * delivery. A call the host runs is delivered once the host committed its answer (`answered`).
       */
      const returned = (id: string) =>
        serially(id)(
          Effect.gen(function* () {
            const slot = yield* slotIn(id)
            if (Option.isNone(slot) || slot.value.delivery.state !== "delivering" || slot.value.delivery.holder.kind !== "answer" || slot.value.delivery.holder.call !== undefined) return
            yield* runner.advance(id, slot.value.version, { state: "delivered", delivery: slot.value.delivery.delivery, attempt: yield* fresh, to: "answer" })
          }),
        )

      /**
       * Wait up to `ms` for the job's end, woken by its reconcile (the runner's call, the start, the sweep), not by a
       * poll; with `before`, run that first, the wait already registered (a kill). The owner's call on a managed job
       * holds its letter while it waits and takes the end itself; once no call waits, the job is reconciled again, so an
       * end no call took still fires. A call that won the end and then failed or was stopped before its answer hands it
       * back to the letter.
       */
      const watch = (sessionID: string, id: string, ms: number, call: Option.Option<HostCall>, before: Effect.Effect<boolean> = Effect.succeed(false)) =>
        Effect.gen(function* () {
          const first = yield* viewed(sessionID, id)
          const takes = first.view.spec.sessionID === sessionID && managed(first.view.spec)
          const waiter: Waiter = { signal: Deferred.makeUnsafe<void>(), takes }
          const set = waiters.get(id) ?? new Set<Waiter>()
          waiters.set(id, set)
          const leave = Effect.suspend(() => {
            set.delete(waiter)
            if (set.size > 0) return Effect.void
            waiters.delete(id)
            return again(id, 0)
          })
          let held = false
          return yield* Effect.gen(function* () {
            set.add(waiter)
            const asked = yield* before
            const by = (yield* Clock.currentTimeMillis) + ms
            for (;;) {
              const read = yield* viewed(sessionID, id)
              if (over(read.view.run)) {
                held = yield* claim(sessionID, read.view, call)
                if (held && managed(read.view.spec)) {
                  yield* runner.retain(id)
                  yield* tidy(id)
                  yield* returned(id)
                }
                return { ...read, ended: true, asked, delivered: held }
              }
              if (read.now >= by) return { ...read, ended: false, asked, delivered: false }
              yield* Effect.raceFirst(Deferred.await(waiter.signal), Effect.sleep(Duration.millis(by - read.now)))
              waiter.signal = Deferred.makeUnsafe<void>()
            }
          }).pipe(
            Effect.onExit((exit) => Effect.asVoid(Effect.when(handBack(id), Effect.sync(() => Exit.isFailure(exit) && held)))),
            Effect.ensuring(leave),
          )
        })

      // ── Timers ──

      /** An alarm's timer: wait for its time, fire, and go round again for a repeat or a refusal. */
      const runAlarm = (id: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (;;) {
            const entry = yield* store.read(id)
            if (entry?.kind !== "alarm") return
            if (entry.firing === undefined) yield* sleepUntil(entry.dueAt)
            const fired = yield* fire(id, alarmFire, false)
            if (fired === "again") continue
            if (fired === "refused") {
              yield* Effect.sleep(Duration.millis(RETRY_MS))
              continue
            }
            return
          }
        })

      /**
       * A monitor's timer: check, and fire on a match or at the deadline; a fire
       * recorded before goes again first. A repeating one fires on each match
       * its `repeat` counts (`stepOf`) and goes on checking until its deadline,
       * which ends it with a last letter.
       */
      const runMonitor = (id: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          let count = 0
          let last: Check | undefined
          /** Wait out the period before the next check, never past the deadline. */
          const pause = (entry: Monitor) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => Effect.sleep(Duration.millis(Math.max(0, Math.min(entry.intervalSeconds * 1000, entry.deadline - now))))),
            )
          for (;;) {
            const entry = yield* store.read(id)
            if (entry?.kind !== "monitor") return
            let fired: Fired | undefined
            if (entry.firing !== undefined) fired = yield* fire(id, () => undefined, false)
            else {
              const before = yield* Clock.currentTimeMillis
              const check = yield* checks.run(entry.command, entry.cwd, Math.max(1000, Math.min(CHECK_TIMEOUT_MS, entry.deadline - before + 1000)))
              count += 1
              last = check
              const after = yield* Clock.currentTimeMillis
              lastChecks.set(id, lastCheckOf(check, after))
              const step = stepOf(entry, check)
              // A one-shot's match at its deadline still counts; a repeat past its deadline only ends.
              if (step.fire && (entry.repeat === undefined || after < entry.deadline)) fired = yield* fire(id, monitorFire("matched", count, last, step.state), false)
              else if (after >= entry.deadline) fired = yield* fire(id, monitorFire("timed-out", count, last), false)
              else {
                if (moved(entry, step.state)) yield* keepState(id, step.state)
                yield* pause(entry)
                continue
              }
            }
            if (fired === "refused") {
              yield* Effect.sleep(Duration.millis(RETRY_MS))
              continue
            }
            if (fired === "again") {
              yield* pause(entry)
              continue
            }
            return
          }
        }).pipe(Effect.ensuring(Effect.sync(() => void lastChecks.delete(id))))

      // ── Latches ──

      /** What an answer did to a latch, under the lock: it went (`opened`, `failed`), it waits again (`held`), or it was gone already. */
      type Settled =
        | { readonly outcome: "opened"; readonly latch: Latch }
        | { readonly outcome: "held"; readonly latch: Latch; readonly before: Latch }
        | { readonly outcome: "failed"; readonly latch: Latch; readonly message: string }
        | { readonly outcome: "gone" }

      /** A latch's timer: wait for its time, ask the opener, and settle by the answer; held goes round again at its new time. */
      const runLatch = (id: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (;;) {
            const entry = yield* store.read(id)
            if (entry?.kind !== "latch") return
            yield* sleepUntil(entry.recheckAt)
            const opened = yield* opener.open(entry).pipe(
              Effect.catchTag("OpenerUnavailable", (unavailable) =>
                Effect.logWarning("wake: the opener could not be asked; the latch asks again", { id, message: unavailable.message }).pipe(Effect.as(undefined)),
              ),
            )
            if (opened === undefined) {
              yield* Effect.sleep(Duration.millis(OPEN_RETRY_MS))
              continue
            }
            const settled = yield* locked(
              Effect.gen(function* (): Effect.fn.Return<Settled> {
                const current = yield* store.read(id)
                if (current?.kind !== "latch") return { outcome: "gone" }
                if (opened.outcome === "held") {
                  const now = yield* Clock.currentTimeMillis
                  const next: Latch = {
                    ...current,
                    hold: opened.hold,
                    reason: opened.reason,
                    opensAt: opened.opensAt,
                    recheckAt: Math.max(Math.min(opened.recheckAt, opened.opensAt), now + MIN_RECHECK_MS),
                  }
                  yield* store.write(next)
                  return { outcome: "held", latch: next, before: current }
                }
                yield* store.remove(id)
                yield* dropJob(id, opened.outcome === "opened")
                return opened.outcome === "opened" ? { outcome: "opened", latch: current } : { outcome: "failed", latch: current, message: opened.message }
              }),
            )
            if (settled.outcome === "gone") return
            yield* changes.changed(settled.latch.sessionID)
            if (settled.outcome === "held") {
              yield* courier.mark(settled.latch.child, markOf(settled.latch))
              if (minuteOf(settled.latch.opensAt) !== minuteOf(settled.before.opensAt)) yield* guard(settled.latch)
              continue
            }
            if (settled.outcome === "opened") {
              yield* courier.mark(settled.latch.child, undefined)
              return
            }
            yield* courier.mark(settled.latch.child, { ...markOf(settled.latch), failed: settled.message })
            const now = yield* Clock.currentTimeMillis
            const delivery = yield* courier.newDelivery
            yield* courier.deliver(settled.latch.sessionID, delivery, latchFailedLetter(settled.latch, settled.message, now), true).pipe(
              Effect.catchTag("DeliveryRefused", (refused) => Effect.logWarning("wake: a latch's failure did not reach its parent", { id, message: refused.message })),
            )
            return
          }
        })

      const timerOf = (entry: Entry) => {
        switch (entry.kind) {
          case "alarm":
            return runAlarm(entry.id)
          case "monitor":
            return runMonitor(entry.id)
          case "latch":
            return runLatch(entry.id)
          case "job":
            // A job has no timer: its end is reconciled when announced (its runner's call, its watch), at the start, or by the sweep.
            return follow(entry.id)
        }
      }
      const arm = (entry: Entry, onlyIfMissing = false) => FiberMap.run(timers, entry.id, timerOf(entry), { onlyIfMissing }).pipe(Effect.asVoid)
      const disarm = (id: string) => FiberMap.remove(timers, id)

      // ── Setting ──

      const newID = (prefix: "w" | "j") =>
        Effect.gen(function* () {
          for (;;) {
            const id = `${prefix}${(yield* Random.nextIntBetween(0, ID_SPACE - 1)).toString(36).padStart(6, "0")}`
            if ((yield* store.read(id)) === undefined) return id
          }
        })

      /** Store what `make` builds for the calling session, unless the session holds `most` of its kind already. */
      const keep = <E extends Entry>(sessionID: string, prefix: "w" | "j", full: (count: number) => string, make: (place: Place) => E | WakeRejected) =>
        locked(
          Effect.gen(function* () {
            const mine = ofSessions(yield* store.entries, [sessionID]).filter((entry) => fires(entry) && (entry.kind === "job") === (prefix === "j"))
            if (mine.length >= (prefix === "j" ? MAX_JOBS : MAX_PENDING)) return yield* new WakeRejected({ reason: full(mine.length) })
            const made = make({ id: yield* newID(prefix), sessionID, directory: config.directory, now: yield* Clock.currentTimeMillis })
            if (made instanceof WakeRejected) return yield* made
            yield* store.write(made)
            return made
          }),
        )

      /** Set what `make` builds for the calling session: refuse a subagent and a full session, store it, give it an OS job, arm it. */
      const set = <E extends Entry>(sessionID: string, make: (place: Place) => E | WakeRejected) =>
        Effect.gen(function* () {
          if ((yield* courier.parentOf(sessionID)) !== undefined) return yield* new WakeRejected({ reason: SUBAGENT })
          const entry = yield* keep(sessionID, "w", (count) => `this session has ${count} wakes pending, the most it takes; cancel one with wake_cancel first`, make)
          yield* changes.changed(sessionID)
          const warning = yield* guard(entry)
          yield* arm(entry)
          return { entry, now: entry.setAt, ...(warning === undefined ? {} : { warning }) }
        })

      /** Drop entries (their timers and jobs) and notices; the ids that went. With `cancelledAt`, a latch's child reads cancelled. A job dropped is killed. */
      const drop = (entries: ReadonlyArray<Entry>, notices: ReadonlyArray<Notice>, cancelledAt?: number) =>
        Effect.gen(function* () {
          for (const entry of entries) {
            yield* disarm(entry.id)
            yield* store.remove(entry.id)
            if (guarded(entry)) yield* dropJob(entry.id, false)
            if (entry.kind === "job") yield* runner.kill(entry.id).pipe(Effect.andThen(runner.unwatch(entry.id)))
            if (entry.kind === "latch" && cancelledAt !== undefined) yield* courier.mark(entry.child, { ...markOf(entry), cancelledAt } satisfies Mark)
          }
          for (const notice of notices) yield* store.removeNotice(notice.delivery)
          return [...entries.map((entry) => entry.id), ...notices.map((notice) => notice.wakeID)]
        })

      // The sweep's one fiber, for this server's life.
      yield* Effect.forkScoped(recovery)

      return {
        wake: (sessionID, ask) => set(sessionID, (place) => alarmOf(ask, place)),
        monitor: (sessionID, ask) => set(sessionID, (place) => monitorOf(ask, place)),
        latch: (ask) =>
          Effect.gen(function* () {
            const child = yield* courier.newSession
            const latch = yield* locked(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis
                const made: Latch = {
                  kind: "latch",
                  id: yield* newID("w"),
                  sessionID: ask.sessionID,
                  directory: config.directory,
                  setAt: now,
                  child,
                  subagent: ask.subagent,
                  hold: ask.hold,
                  reason: ask.reason,
                  opensAt: ask.opensAt,
                  recheckAt: Math.max(Math.min(ask.recheckAt, ask.opensAt), now + MIN_RECHECK_MS),
                  context: ask.context,
                }
                yield* store.write(made)
                return made
              }),
            )
            // The child is made after the latch is kept: a latch whose child never came reads failed when it opens, and tells the parent.
            const unmade = yield* courier
              .child({
                sessionID: child,
                parentID: ask.sessionID,
                directory: config.directory,
                title: ask.subagent.description,
                agent: ask.subagent.agent,
                model: ask.subagent.model,
                mark: markOf(latch),
              })
              .pipe(
                Effect.as(undefined),
                Effect.catchTag("DeliveryRefused", (refused) => Effect.succeed(refused)),
              )
            if (unmade !== undefined) {
              yield* locked(store.remove(latch.id))
              return yield* new WakeRejected({ reason: `the latched subagent's session could not be made: ${unmade.message}` })
            }
            yield* changes.changed(ask.sessionID)
            yield* guard(latch)
            yield* arm(latch)
            return { id: latch.id, child }
          }),
        job: (sessionID, ask) =>
          Effect.gen(function* () {
            const job = yield* keep(
              sessionID,
              "j",
              (count) => `this session has ${count} jobs kept, the most it takes; wait for one, or stop one with job({ action: "kill", id })`,
              (place) => jobOf(ask, place),
            )
            // The entry is kept before the launch: a runner that calls `due` at once finds it.
            const launched = yield* runner.launch(specOf(job)).pipe(
              Effect.catchTag("JobRefused", (refused) =>
                locked(store.remove(job.id)).pipe(
                  Effect.andThen(Effect.fail(new WakeRejected({ reason: `the job did not start: ${refused.message}` }))),
                ),
              ),
            )
            seenJobs.set(job.id, sessionID)
            yield* changes.changed(sessionID)
            // No timer of its own: its watch announces its end, and the sweep starts counting toward its next look.
            yield* follow(job.id)
            return { job, launched }
          }),
        board: (sessionID) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const kept = new Map(
              ofSessions(yield* store.entries, [sessionID])
                .filter((entry): entry is Job => entry.kind === "job")
                .map((job) => [job.id, job] as const),
            )
            for (const id of kept.keys()) seenJobs.set(id, sessionID)
            const ids = [...seenJobs].flatMap(([id, owner]) => [id].filter(() => owner === sessionID))
            const read = yield* Effect.forEach(ids, (id) =>
              Effect.gen(function* () {
                const record = Option.fromNullishOr(yield* runner.read(id))
                const job = Option.fromNullishOr(kept.get(id))
                // A kept job the runner has no record of yet reads from its entry.
                const spec = record.pipe(
                  Option.map((each) => each.spec),
                  Option.orElse(() => Option.map(job, specOf)),
                )
                const tail = yield* runner.tail(id, BOARD_TAIL)
                return Option.toArray(spec).map((each) => ({
                  shown: jobShownOf(each, runOrStarting(Option.map(record, (found) => found.run)), tail),
                  kept: Option.isSome(job),
                }))
              }),
            )
            const live = (shown: JobShown) => shown.state === "starting" || shown.state === "running"
            const endedAt = (shown: JobShown) => shown.endedAt ?? shown.startedAt ?? shown.setAt
            const newest = (left: JobShown, right: JobShown) => right.setAt - left.setAt
            const all = read.flat()
            const running = all.filter((each) => live(each.shown)).map((each) => each.shown)
            // A kept job (its letter not yet sent) always shows; one whose entry went stays its while.
            const ended = all
              .filter((each) => !live(each.shown) && (each.kept || now - endedAt(each.shown) <= ENDED_SHOWN_MS))
              .map((each) => each.shown)
              .toSorted(newest)
              .slice(0, ENDED_SHOWN)
            const shown = [...running.toSorted(newest), ...ended]
            // What leaves the board is forgotten.
            for (const id of ids) if (!shown.some((each) => each.id === id)) seenJobs.delete(id)
            return { now, jobs: shown }
          }),
        stop: (sessionID, id) =>
          Effect.gen(function* () {
            const found = Option.filter(Option.fromNullishOr(yield* runner.read(id)), (record) => record.spec.sessionID === sessionID)
            if (Option.isNone(found)) return yield* new WakeRejected({ reason: `No job ${id} in this session.` })
            const record = found.value
            const run = record.run
            if (over(run)) return yield* new WakeRejected({ reason: `Job ${id} is not running: ${endWords(jobShownOf(record.spec, run, ""))}.` })
            yield* runner.kill(id)
            yield* changes.changed(sessionID)
            // A stop takes nothing: its end is reconciled now, and fires its letter once recorded.
            yield* again(id, 0)
          }),
        jobs: (sessionID) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const kept = new Map(
              ofSessions(yield* store.entries, [sessionID])
                .filter((entry): entry is Job => entry.kind === "job")
                .map((entry) => [entry.id, entry] as const),
            )
            const ids = new Set([...kept.keys(), ...(yield* runner.owed({ sessionID }))])
            const listed = yield* Effect.forEach(ids, (id) =>
              Effect.gen(function* () {
                const record = Option.fromNullishOr(yield* runner.read(id))
                const run = runOrStarting(Option.map(record, (each) => each.run))
                const slot = Option.flatMapNullishOr(record, (each) => each.delivery)
                const held = Option.flatMap(slot, ({ delivery }) =>
                  Match.value(delivery).pipe(
                    Match.when({ state: "delivering" }, (open) => heldBy(open.holder, (call) => call.call)),
                    Match.orElse(() => Option.none<string>()),
                  ),
                )
                const job = Option.orElse(Option.fromUndefinedOr(kept.get(id)), () => Option.map(Option.filter(record, () => Option.isSome(held)), ({ spec }) => jobOfSpec(spec)))
                return Option.map(job, (each): ListedJob => ({ job: each, run, held }))
              }),
            )
            return { now, jobs: listed.flatMap(Option.toArray).toSorted((left, right) => left.job.setAt - right.job.setAt) }
          }),
        check: viewed,
        compacting: (sessionID, answer) => settleHeld(sessionID, (holder, call) => answer(call, holder.message).pipe(Effect.flatMap((said) => fateOf(holder, call, said)))),
        recheckOwner: (sessionID) => settleHeld(sessionID, (holder, call) => ask(holder, call).pipe(Effect.flatMap((said) => fateOf(holder, call, said)))),
        park: (sessionID, id, call) => watch(sessionID, id, 0, Option.fromNullishOr(call)),
        wait: (sessionID, id, ms, call) => watch(sessionID, id, ms, Option.fromNullishOr(call)),
        kill: (sessionID, id, call) =>
          Effect.gen(function* () {
            const before = yield* viewed(sessionID, id)
            if (over(before.view.run)) return yield* watch(sessionID, id, 0, Option.fromNullishOr(call))
            return yield* watch(sessionID, id, KILL_WAIT_MS, Option.fromNullishOr(call), runner.kill(id))
          }),
        answered: (sessionID, call, outcome) =>
          Effect.gen(function* () {
            const key = callKey(sessionID, call)
            const id = calls.get(key)
            if (id === undefined) return
            calls.delete(key)
            if (outcome === "failed") {
              return yield* handBack(id)
            }
            yield* serially(id)(
              Effect.gen(function* () {
                const slot = yield* slotIn(id)
                if (Option.isNone(slot) || slot.value.delivery.state !== "delivering") return
                const held = slot.value.delivery
                if (held.holder.kind === "letter" || held.holder.sessionID !== sessionID || held.holder.call !== call.id || held.holder.message !== call.message) return
                yield* delivered(id, slot.value, "answer")
              }),
            )
          }),
        cancel: (sessionID, id) =>
          Effect.gen(function* () {
            const gone = yield* locked(
              Effect.gen(function* () {
                const wakes = ofSessions(yield* store.entries, [sessionID]).filter((entry) => entry.kind !== "job")
                const entries = wakes.filter((entry) => id === undefined || entry.id === id)
                const notices = ofSessions(yield* store.notices, [sessionID]).filter((notice) => id === undefined || notice.wakeID === id)
                if (id !== undefined && isJobID(id))
                  return yield* new WakeRejected({ reason: `${id} is a job, which wake_cancel does not stop: job({ action: "kill", id: "${id}" }) stops it.` })
                if (id !== undefined && entries.length === 0 && notices.length === 0) {
                  const pending = wakes.map((entry) => entry.id)
                  return yield* new WakeRejected({ reason: `No pending wake ${id} in this session. Pending: ${pending.length === 0 ? "none" : pending.join(", ")}.` })
                }
                return yield* drop(entries, notices, yield* Clock.currentTimeMillis)
              }),
            )
            if (gone.length > 0) yield* changes.changed(sessionID)
            return [...new Set(gone)]
          }),
        list: (sessionID) =>
          Effect.gen(function* () {
            return {
              now: yield* Clock.currentTimeMillis,
              entries: ofSessions(yield* store.entries, [sessionID]),
              notices: ofSessions(yield* store.notices, [sessionID]),
            }
          }),
        pending: (sessionIDs) =>
          Effect.gen(function* () {
            return {
              now: yield* Clock.currentTimeMillis,
              entries: ofSessions(yield* store.entries, sessionIDs)
                .filter(shown)
                .map((entry) => {
                  const last = lastChecks.get(entry.id)
                  return last === undefined ? shownOf(entry) : { ...shownOf(entry), last }
                })
                .toSorted((left, right) => left.dueAt - right.dueAt),
              notices: ofSessions(yield* store.notices, sessionIDs),
            }
          }),
        due: (id) =>
          Effect.gen(function* () {
            const entry = yield* store.read(id)
            // A job whose entry went may still owe its delivery (an owner's call took the end and did not hand it over): its record says.
            if (entry === undefined && isJobID(id)) return { outcome: yield* reconcile(id) }
            if (entry === undefined) {
              yield* dropJob(id, true)
              return { outcome: "gone" as const }
            }
            if (entry.directory !== config.directory) return { outcome: "pending" as const }
            // A job's runner announces its end once its exit is recorded: reconcile it from that record now.
            if (entry.kind === "job") return { outcome: yield* reconcile(id) }
            const now = yield* Clock.currentTimeMillis
            if (entry.kind !== "alarm" || (entry.firing === undefined && entry.dueAt > now + 1000)) {
              yield* arm(entry, true)
              return { outcome: "pending" as const }
            }
            yield* disarm(id)
            const fired = yield* fire(id, alarmFire, true)
            const after = yield* store.read(id)
            if (after !== undefined) yield* arm(after)
            return { outcome: fired === "done" || fired === "again" ? ("fired" as const) : fired }
          }),
        start: Effect.gen(function* () {
          // Titles first, then the entries: an entry is stored before its job is registered, so a job listed has its entry listed unless it truly went.
          const titles = yield* backstop.titles.pipe(
            Effect.catchTag("BackstopRefused", (refused) => Effect.logWarning("wake: the OS jobs could not be listed", { message: refused.message }).pipe(Effect.as(undefined))),
          )
          const ids = yield* store.ids
          const entries = yield* store.entries
          const own = entries.filter((entry) => entry.directory === config.directory)
          for (const entry of own) yield* (entry.kind === "job" ? follow(entry.id) : arm(entry))
          yield* resumeOwed(entries, own)
          if (titles === undefined) return
          for (const title of titles) {
            const id = idOfTitle(title)
            if (id !== undefined && !ids.includes(id)) yield* dropJob(id, false)
          }
          for (const entry of own) if (guarded(entry) && !titles.includes(titleOf(entry.id))) yield* guard(entry)
        }),
        forget: (sessionID) =>
          Effect.gen(function* () {
            yield* settleHeld(sessionID, () => Effect.succeed("nobody"))
            for (const [id, owner] of seenJobs) if (owner === sessionID) seenJobs.delete(id)
            const gone = yield* locked(
              Effect.gen(function* () {
                const entries = yield* store.entries
                const children = entries.filter((entry) => entry.kind === "latch" && entry.child === sessionID && entry.sessionID !== sessionID)
                return {
                  owners: [...new Set(children.map((entry) => entry.sessionID))],
                  ids: yield* drop([...ofSessions(entries, [sessionID]), ...children], ofSessions(yield* store.notices, [sessionID])),
                }
              }),
            )
            if (gone.ids.length > 0) yield* changes.changed(sessionID)
            for (const owner of gone.owners) yield* changes.changed(owner)
          }),
        read: (delivery) =>
          Effect.gen(function* () {
            const notice = yield* locked(
              Effect.gen(function* () {
                const found = (yield* store.notices).find((candidate) => candidate.delivery === delivery)
                if (found !== undefined) yield* store.removeNotice(delivery)
                return found
              }),
            )
            if (notice !== undefined) yield* changes.changed(notice.sessionID)
          }),
      }
    }),
  )
