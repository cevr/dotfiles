// The wakes' handlers. Setting an entry stores it, registers its OS job and
// arms a timer in this server; the timer, the OS job (`due`), or the next
// start fires it. A fire is recorded on the entry, with its message's id,
// before it is sent, and settled (the entry removed, or a repeat moved to its
// next tick) once the session took it; a fire that stopped short goes again
// under the same id, and the session's inbox keeps one. Changes to the store
// are serialized; a delivery and a monitor's check run outside the lock. A
// server arms only the entries of its own directory: plugins run once per
// directory, the store is shared.
import { Clock, Context, Duration, Effect, FiberMap, FiberSet, Layer, Random, Semaphore } from "effect"
import { idOfTitle, minuteOf, type Schedule, scheduleOf, titleOf } from "./backstop.ts"
import { alarmLetter, freshPrompt, type Letter, monitorLetter, type Outcome, unguarded } from "./message.ts"
import { Backstop, Changes, Checks, Courier, type DeliveryRefused, WakeStore } from "./service.ts"
import {
  type Alarm,
  type AlarmAsk,
  alarmOf,
  type Check,
  type Due,
  type Entry,
  type Firing,
  matched,
  type Monitor,
  type MonitorAsk,
  monitorOf,
  nextDueAt,
  type Notice,
  ofSessions,
  type Pending,
  shownOf,
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
/** A refused fire goes again after this long. */
export const RETRY_MS = 30_000
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

export class WakesModel extends Context.Service<
  WakesModel,
  {
    readonly wake: (sessionID: string, ask: AlarmAsk) => Effect.Effect<Placed<Alarm>, WakeRejected>
    readonly monitor: (sessionID: string, ask: MonitorAsk) => Effect.Effect<Placed<Monitor>, WakeRejected>
    /** Cancel `id`, or every entry of the session when none is named; an unread notice named goes too. The ids that went. */
    readonly cancel: (sessionID: string, id?: string) => Effect.Effect<ReadonlyArray<string>, WakeRejected>
    readonly list: (sessionID: string) => Effect.Effect<Listed>
    /** What the trays of `sessionIDs` show. */
    readonly pending: (sessionIDs: ReadonlyArray<string>) => Effect.Effect<Pending>
    /** An OS job's call: fire the entry when it is due here and not yet fired. */
    readonly due: (id: string) => Effect.Effect<Due>
    /** Arm this directory's entries (each one past due fires now, and says how late) and drop the OS jobs whose entry is gone. */
    readonly start: Effect.Effect<void>
    /** A deleted session's entries and notices go, and their OS jobs. */
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
}

const SUBAGENT =
  "wake and monitor are for a root session: a subagent hands back when its turn ends, and nothing waits for its wake. Wait in a background shell command instead, which your parent waits on."

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

const withFiring = (entry: Entry, firing: Firing): Entry => (entry.kind === "alarm" ? { ...entry, firing } : { ...entry, firing })

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
      const lock = yield* Semaphore.make(1)
      const locked = lock.withPermits(1)
      const timers = yield* FiberMap.make<string>()
      const later = yield* FiberSet.make()
      const settleMs = config.settleMs ?? 5000

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

      /** Drop the entry's OS job; with `defer`, after the job's own run had time to end. */
      const dropJob = (id: string, defer: boolean) => {
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
      const record = (id: string, make: (entry: Entry, now: number) => Made | undefined) =>
        locked(
          Effect.gen(function* () {
            const entry = yield* store.read(id)
            if (entry === undefined) return undefined
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
            }
            const fired = withFiring(entry, firing)
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
      const send = (entry: Entry, firing: Firing): Effect.Effect<void, DeliveryRefused> =>
        entry.kind === "alarm" && entry.newSession !== undefined && firing.session !== undefined
          ? courier.start({ sessionID: firing.session, directory: entry.newSession.directory, delivery: firing.delivery, text: firing.text })
          : courier.deliver(entry.sessionID, firing.delivery, { text: firing.text, description: firing.description, metadata: firing.metadata }, entry.mode === "wake")

      /** The fire reached its session: move a repeat on or drop the entry. Only the fire still recorded settles. */
      const settle = (id: string, firing: Firing, defer: boolean) =>
        locked(
          Effect.gen(function* () {
            const entry = yield* store.read(id)
            if (entry === undefined || entry.firing?.delivery !== firing.delivery) return "done" as const
            if (entry.kind === "alarm" && entry.everySeconds !== undefined) {
              const next = advanced(entry, nextDueAt(firing.tick, entry.everySeconds, firing.firedAt))
              yield* store.write(next)
              const schedule = scheduleOf(next)
              if (!schedule.recurring) yield* guard(next, schedule)
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
      const fire = (id: string, make: (entry: Entry, now: number) => Made | undefined, defer: boolean): Effect.Effect<Fired> =>
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

      const alarmFire = (entry: Entry, now: number): Made | undefined => {
        if (entry.kind !== "alarm") return undefined
        const next = entry.everySeconds === undefined ? undefined : nextDueAt(entry.dueAt, entry.everySeconds, now)
        return {
          letter: alarmLetter(entry, entry.dueAt, now, next),
          tick: entry.dueAt,
          ...(entry.newSession === undefined ? {} : { fresh: entry.newSession }),
        }
      }

      const monitorFire =
        (outcome: Outcome, count: number, last: Check | undefined) =>
        (entry: Entry, now: number): Made | undefined =>
          entry.kind === "monitor" ? { letter: monitorLetter(entry, outcome, count, last, now), tick: outcome === "matched" ? now : entry.deadline } : undefined

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

      /** A monitor's timer: check, and fire on a match or at the deadline; a fire recorded before goes again first. */
      const runMonitor = (id: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          let count = 0
          let last: Check | undefined
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
              if (matched(entry, check)) fired = yield* fire(id, monitorFire("matched", count, last), false)
              else if (after >= entry.deadline) fired = yield* fire(id, monitorFire("timed-out", count, last), false)
              else {
                yield* Effect.sleep(Duration.millis(Math.max(0, Math.min(entry.intervalSeconds * 1000, entry.deadline - after))))
                continue
              }
            }
            if (fired === "refused") {
              yield* Effect.sleep(Duration.millis(RETRY_MS))
              continue
            }
            return
          }
        })

      const timerOf = (entry: Entry) => (entry.kind === "alarm" ? runAlarm(entry.id) : runMonitor(entry.id))
      const arm = (entry: Entry, onlyIfMissing = false) => FiberMap.run(timers, entry.id, timerOf(entry), { onlyIfMissing }).pipe(Effect.asVoid)
      const disarm = (id: string) => FiberMap.remove(timers, id)

      // ── Setting ──

      const newID = Effect.gen(function* () {
        for (;;) {
          const id = `w${(yield* Random.nextIntBetween(0, ID_SPACE - 1)).toString(36).padStart(6, "0")}`
          if ((yield* store.read(id)) === undefined) return id
        }
      })

      /** Set what `make` builds for the calling session: refuse a subagent and a full session, store it, give it an OS job, arm it. */
      const set = <E extends Entry>(sessionID: string, make: (place: { id: string; sessionID: string; directory: string; now: number }) => E | WakeRejected) =>
        Effect.gen(function* () {
          if ((yield* courier.parentOf(sessionID)) !== undefined) return yield* new WakeRejected({ reason: SUBAGENT })
          const entry = yield* locked(
            Effect.gen(function* () {
              const mine = ofSessions(yield* store.entries, [sessionID])
              if (mine.length >= MAX_PENDING)
                return yield* new WakeRejected({ reason: `this session has ${mine.length} wakes pending, the most it takes; cancel one with wake_cancel first` })
              const made = make({ id: yield* newID, sessionID, directory: config.directory, now: yield* Clock.currentTimeMillis })
              if (made instanceof WakeRejected) return yield* made
              yield* store.write(made)
              return made
            }),
          )
          yield* changes.changed(sessionID)
          const warning = yield* guard(entry)
          yield* arm(entry)
          return { entry, now: entry.setAt, ...(warning === undefined ? {} : { warning }) }
        })

      /** Drop entries (their timers and jobs) and notices; the ids that went. */
      const drop = (entries: ReadonlyArray<Entry>, notices: ReadonlyArray<Notice>) =>
        Effect.gen(function* () {
          for (const entry of entries) {
            yield* disarm(entry.id)
            yield* store.remove(entry.id)
            yield* dropJob(entry.id, false)
          }
          for (const notice of notices) yield* store.removeNotice(notice.delivery)
          return [...entries.map((entry) => entry.id), ...notices.map((notice) => notice.wakeID)]
        })

      return {
        wake: (sessionID, ask) => set(sessionID, (place) => alarmOf(ask, place)),
        monitor: (sessionID, ask) => set(sessionID, (place) => monitorOf(ask, place)),
        cancel: (sessionID, id) =>
          Effect.gen(function* () {
            const gone = yield* locked(
              Effect.gen(function* () {
                const entries = ofSessions(yield* store.entries, [sessionID]).filter((entry) => id === undefined || entry.id === id)
                const notices = ofSessions(yield* store.notices, [sessionID]).filter((notice) => id === undefined || notice.wakeID === id)
                if (id !== undefined && entries.length === 0 && notices.length === 0) {
                  const pending = ofSessions(yield* store.entries, [sessionID]).map((entry) => entry.id)
                  return yield* new WakeRejected({ reason: `No pending wake ${id} in this session. Pending: ${pending.length === 0 ? "none" : pending.join(", ")}.` })
                }
                return yield* drop(entries, notices)
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
                .map(shownOf)
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
            const now = yield* Clock.currentTimeMillis
            if (entry.kind === "monitor" || (entry.firing === undefined && entry.dueAt > now + 1000)) {
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
          for (const entry of own) if (!titles.includes(titleOf(entry.id))) yield* guard(entry)
        }),
        forget: (sessionID) =>
          Effect.gen(function* () {
            const gone = yield* locked(
              Effect.gen(function* () {
                return yield* drop(ofSessions(yield* store.entries, [sessionID]), ofSessions(yield* store.notices, [sessionID]))
              }),
            )
            if (gone.length > 0) yield* changes.changed(sessionID)
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
