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
// OS job: the runner calls `due` itself when the command exits, and a timer
// here looks every JOB_POLL_MS for its end and its progress. Its end fires a
// letter as a monitor's match does; `wait` and `kill` take the entry instead,
// since their answer already says how it ended.
import { Clock, Context, Duration, Effect, FiberMap, FiberSet, Layer, Random, Semaphore } from "effect"
import { idOfTitle, minuteOf, type Schedule, scheduleOf, titleOf } from "./backstop.ts"
import { DRIP_MS, JOB_POLL_MS, KILL_WAIT_MS, lastLines, type Launched, LOG_TAIL, over, type Run, settledRun, WAIT_POLL_MS } from "./job.ts"
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
import { Backstop, Changes, Checks, Courier, type DeliveryRefused, Opener, Runner, WakeStore } from "./service.ts"
import {
  type Alarm,
  type AlarmAsk,
  alarmOf,
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
}

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
    readonly jobs: (sessionID: string) => Effect.Effect<{ readonly now: number; readonly jobs: ReadonlyArray<{ readonly job: Job; readonly run: Run }> }>
    /** How a job stands now, with its last progress lines and its log's tail. */
    readonly check: (id: string) => Effect.Effect<Viewed, WakeRejected>
    /** Wait up to `ms` for the job to end; an end it sees takes the entry, so no letter follows. */
    readonly wait: (id: string, ms: number) => Effect.Effect<Viewed & { readonly ended: boolean }, WakeRejected>
    /** Stop the job, and wait a little for its end; an end it sees takes the entry. Whether a running job was asked to stop. */
    readonly kill: (id: string) => Effect.Effect<Viewed & { readonly asked: boolean }, WakeRejected>
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

/** A job id: `j` and six base-36 characters. */
const isJobID = (id: string) => id.startsWith("j")

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
      /** Each running monitor's newest check, for the tray; it goes with the monitor's timer. */
      const lastChecks = new Map<string, LastCheck>()

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

      /**
       * How a job stands: its spec, its run as the wakes read it now, its log's
       * tail, and its progress from byte `from` (a letter's: what is not yet
       * delivered) or all of it (a check's: the last lines). Undefined for an
       * id the runner never launched.
       */
      const viewOf = (id: string, from = 0) =>
        Effect.gen(function* () {
          const record = yield* runner.read(id)
          if (record === undefined) return undefined
          const now = yield* Clock.currentTimeMillis
          const run = settledRun(record.run, record.spec.setAt, now)
          const progress = yield* runner.drip(id, from)
          const view: JobView = {
            spec: record.spec,
            run,
            log: record.log,
            unit: record.unit,
            logTail: yield* runner.tail(id, LOG_TAIL),
            progress: lastLines(progress.text),
          }
          return view
        })

      const jobFire =
        (view: JobView) =>
        (entry: FiredEntry, now: number): Made | undefined =>
          entry.kind === "job" ? { letter: jobLetter(entry, view, now), tick: jobTick(view.run, now) } : undefined

      /** The job's end as its letter reads it, or undefined while it runs. */
      const endOf = (job: Job) =>
        Effect.gen(function* () {
          const view = yield* viewOf(job.id, job.dripped)
          if (view !== undefined) return over(view.run) ? view : undefined
          // The runner has no record of it: it never launched, or its record went.
          const now = yield* Clock.currentTimeMillis
          const run = settledRun(undefined, job.setAt, now)
          if (!over(run)) return undefined
          return { spec: specOf(job), run, log: "", logTail: "", progress: "" } satisfies JobView
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

      /** A job's timer: look for its end every JOB_POLL_MS, delivering its progress meanwhile; fire at the end; a fire recorded before goes again first. */
      const runJob = (id: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (;;) {
            const entry = yield* store.read(id)
            if (entry?.kind !== "job") return
            let fired: Fired
            if (entry.firing !== undefined) fired = yield* fire(id, () => undefined, false)
            else {
              const ended = yield* endOf(entry)
              if (ended === undefined) {
                yield* drip(entry)
                yield* Effect.sleep(Duration.millis(JOB_POLL_MS))
                continue
              }
              fired = yield* fire(id, jobFire(ended), false)
            }
            if (fired === "refused") {
              yield* Effect.sleep(Duration.millis(RETRY_MS))
              continue
            }
            return
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
          yield* changes.changed(taken.sessionID)
        })

      const noJob = (id: string) => new WakeRejected({ reason: `No job ${id}: job({ action: "list" }) lists this session's jobs.` })

      const viewed = (id: string) =>
        Effect.gen(function* () {
          const view = yield* viewOf(id)
          if (view === undefined) return yield* noJob(id)
          return { now: yield* Clock.currentTimeMillis, view }
        })

      /** Look at the job until it is over or `ms` passed. */
      const watch = (id: string, ms: number) =>
        Effect.gen(function* () {
          const by = (yield* Clock.currentTimeMillis) + ms
          for (;;) {
            const read = yield* viewed(id)
            if (over(read.view.run)) {
              yield* take(id)
              return { ...read, ended: true }
            }
            if (read.now >= by) return { ...read, ended: false }
            yield* Effect.sleep(Duration.millis(Math.min(WAIT_POLL_MS, by - read.now)))
          }
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
            return runJob(entry.id)
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
            if (entry.kind === "job") yield* runner.kill(entry.id)
            if (entry.kind === "latch" && cancelledAt !== undefined) yield* courier.mark(entry.child, { ...markOf(entry), cancelledAt } satisfies Mark)
          }
          for (const notice of notices) yield* store.removeNotice(notice.delivery)
          return [...entries.map((entry) => entry.id), ...notices.map((notice) => notice.wakeID)]
        })

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
            yield* changes.changed(sessionID)
            yield* arm(job)
            return { job, launched }
          }),
        jobs: (sessionID) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const kept = ofSessions(yield* store.entries, [sessionID]).filter((entry): entry is Job => entry.kind === "job")
            const jobs = yield* Effect.forEach(kept, (job) =>
              runner.read(job.id).pipe(Effect.map((record) => ({ job, run: settledRun(record?.run, job.setAt, now) }))),
            )
            return { now, jobs: jobs.toSorted((left, right) => left.job.setAt - right.job.setAt) }
          }),
        check: viewed,
        wait: watch,
        kill: (id) =>
          Effect.gen(function* () {
            const before = yield* viewed(id)
            if (over(before.view.run)) {
              yield* take(id)
              return { ...before, asked: false }
            }
            const asked = yield* runner.kill(id)
            const after = yield* watch(id, KILL_WAIT_MS)
            return { now: after.now, view: after.view, asked }
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
            if (entry === undefined) {
              yield* dropJob(id, true)
              return { outcome: "gone" as const }
            }
            if (entry.directory !== config.directory) return { outcome: "pending" as const }
            if (entry.kind === "job") {
              const ended = entry.firing === undefined ? yield* endOf(entry) : undefined
              if (entry.firing === undefined && ended === undefined) {
                yield* arm(entry, true)
                return { outcome: "pending" as const }
              }
              yield* disarm(id)
              const fired = yield* fire(id, ended === undefined ? () => undefined : jobFire(ended), true)
              const after = yield* store.read(id)
              if (after !== undefined) yield* arm(after)
              return { outcome: fired === "done" || fired === "again" ? ("fired" as const) : fired }
            }
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
          const own = (yield* store.entries).filter((entry) => entry.directory === config.directory)
          for (const entry of own) yield* arm(entry)
          if (titles === undefined) return
          for (const title of titles) {
            const id = idOfTitle(title)
            if (id !== undefined && !ids.includes(id)) yield* dropJob(id, false)
          }
          for (const entry of own) if (guarded(entry) && !titles.includes(titleOf(entry.id))) yield* guard(entry)
        }),
        forget: (sessionID) =>
          Effect.gen(function* () {
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
