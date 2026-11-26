// The kernel model's handlers: each gathers what one moment of a session's
// kernel needs from the outside systems (the session, its tools, its worker,
// its stored bindings), has the KernelSession aggregate decide it, and keeps
// what was recorded. A call's answer is the CellAnswer view of what that call
// recorded, with the images its cell attached read through Files. The
// aggregate is the one decision entry point, so the stories run exactly what
// these do. The plugin calls these and nothing else.
import { Clock, Context, Effect, FiberMap, Layer, Option, Semaphore, SynchronizedRef } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { CellAnswer, read, type Answer } from "./answer.ts"
import { imageOf, MAX_IMAGE_BYTES, replyOf, type Reply } from "./attachment.ts"
import type { SnapshotBinding } from "./frame.ts"
import { answerOf, CellTime, CellTimed, CellTimeNoticed, NOTICE_DESCRIPTION, noticeDue, noticeText, type CellTimeState, type TimeAnswer } from "./cell-time.ts"
import { KernelSession, LoseKernel, RecordCell, ResetKernel, StartKernel, StopKernel, type Command, type Event, KernelSessionId, type KernelSessionState, type StopReason } from "./session.ts"
import { CellTimes, Files, Notices, Sessions, Snapshots, Toolbox, Workers, type SessionUnreadable } from "./service.ts"

/** The kernel's settings, from the plugin's options. */
export interface Config {
  /** A session's worker is stopped after this long without a call, in ms. */
  readonly idleMs: number
  /** The characters of output the model sees per call. */
  readonly viewChars: number
}

/** What a call interrupted under its cell records: the worker was killed with it. */
export const ABORTED = "Aborted: the kernel worker was stopped and its state since the last call is lost"

/**
 * What a restore lost: each name the last snapshot stored that the new worker
 * did not define, once, in the snapshot's order. A bare import has no name.
 */
export const lostOf = (stored: ReadonlyArray<SnapshotBinding>, restored: ReadonlyArray<string>): ReadonlyArray<string> => {
  const kept = new Set(restored)
  return [...new Set(stored.map((binding) => binding.name))].filter((name) => name !== "" && !kept.has(name))
}

/** One kernel call, as the model takes it. */
export interface Call {
  readonly session: KernelSessionId
  /** The agent the call runs as: its rules filter the cell's tools. */
  readonly agent: string
  readonly code: string
  readonly reset: boolean
  /** The cell's header, when the call gave one: the hour's longest cells are named by it. */
  readonly description: Option.Option<string>
}

/** A call's time, named by its header when it had one. */
const cellTimed = (fields: Omit<CellTimed, "_tag" | "description">, description: Option.Option<string>): CellTimed =>
  Option.match(description, {
    onNone: () => CellTimed.make(fields),
    onSome: (header) => CellTimed.make({ ...fields, description: header }),
  })

export class Kernel extends Context.Service<
  Kernel,
  {
    /**
     * Runs one cell in the session's kernel, starting a worker from the stored
     * bindings when none runs. A session's calls run one at a time. The cell's
     * tools are the call's own (Toolbox). The reply carries the images the cell
     * attached; a path it could not attach is a line in its text.
     */
    readonly run: (call: Call) => Effect.Effect<Reply, SessionUnreadable, Toolbox>
    /** The session was deleted: its worker stops and its stored bindings go. */
    readonly deleted: (session: KernelSessionId) => Effect.Effect<void>
    /** Each session's last hour in cells (cell-time.ts), as the `time` RPC answers it. */
    readonly time: (sessionIDs: ReadonlyArray<string>) => Effect.Effect<TimeAnswer>
  }
>()("dotfiles-opencode/kernel/Kernel") {}

/** A session's kernel state, and what keeps its calls in order. */
interface Entry {
  readonly state: SynchronizedRef.SynchronizedRef<KernelSessionState>
  readonly calls: Semaphore.Semaphore
}

export const layer = (config: Config) =>
  Layer.effect(
    Kernel,
    Effect.gen(function* () {
      const workers = yield* Workers
      const snapshots = yield* Snapshots
      const sessions = yield* Sessions
      const files = yield* Files
      const cellTimes = yield* CellTimes
      const notices = yield* Notices
      /** Each session's last hour in cells, read from the store at its first use: a restart keeps it. */
      const times = yield* SynchronizedRef.make<ReadonlyMap<KernelSessionId, CellTimeState>>(new Map())
      /** The sessions' views, each read once; the map with any read now. */
      const viewsOf = Effect.fnUntraced(function* (held: ReadonlyMap<KernelSessionId, CellTimeState>, sessions: ReadonlyArray<KernelSessionId>) {
        const map = new Map(held)
        for (const session of sessions) if (!map.has(session)) map.set(session, yield* cellTimes.load(session))
        return map
      })

      /**
       * Folds one cell's time into its session's view and keeps it; a session now over the bound and not told within
       * the hour is told once, without a turn. Recording never fails the call.
       */
      const timed = (session: KernelSessionId, event: CellTimed) =>
        SynchronizedRef.modifyEffect(times, (held) =>
          Effect.gen(function* () {
            const map = yield* viewsOf(held, [session])
            const recorded = CellTime.evolve(map.get(session) ?? CellTime.initial, event)
            const due = noticeDue(recorded, session, event.endedAt)
            const next = Option.match(due, {
              onNone: () => recorded,
              onSome: () => CellTime.evolve(recorded, CellTimeNoticed.make({ session, at: event.endedAt })),
            })
            yield* cellTimes.save(session, next)
            return [due, new Map(map).set(session, next)] as const
          }),
        ).pipe(
          Effect.flatMap((due) =>
            Option.match(due, {
              onNone: () => Effect.void,
              onSome: (reading) => notices.tell(session, { text: noticeText(reading), description: NOTICE_DESCRIPTION }),
            }),
          ),
          Effect.catchCause((cause) => Effect.logWarning("kernel: could not record a cell's time", { session, cause })),
        )
      /** Each session's idle timer; a new call or a deletion cancels it. */
      const idle = yield* FiberMap.make<KernelSessionId>()
      const entries = new Map<KernelSessionId, Entry>()

      const entryOf = (session: KernelSessionId) =>
        Effect.gen(function* () {
          const existing = entries.get(session)
          if (existing !== undefined) return existing
          const created: Entry = { state: yield* SynchronizedRef.make(KernelSession.initial), calls: yield* Semaphore.make(1) }
          entries.set(session, created)
          return created
        })

      /** Have the aggregate decide a command against the session's state, and fold what it records in. */
      const send = (entry: Entry, command: Command) =>
        SynchronizedRef.modifyEffect(entry.state, (state) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => KernelSession.decide(state, command, now)),
            Effect.map((events): readonly [ReadonlyArray<Event>, KernelSessionState] => [events, fold(KernelSession, events, state)]),
          ),
        )

      const stop = (session: KernelSessionId, reason: StopReason) =>
        Effect.gen(function* () {
          yield* workers.stop(session)
          const entry = entries.get(session)
          if (entry !== undefined) yield* send(entry, StopKernel.make({ session, reason }))
        })

      const run = Effect.fn("Kernel.run")(function* (call: Call) {
        const { session } = call
        // The cell's time counts from the call's arrival: waiting behind the session's earlier call is in it.
        const startedAt = yield* Clock.currentTimeMillis
        const toolbox = yield* Toolbox
        yield* FiberMap.remove(idle, session)
        const entry = yield* entryOf(session)
        return yield* entry.calls.withPermits(1)(
          Effect.gen(function* () {
            const recorded: Array<Event> = []
            const record = (command: Command) =>
              send(entry, command).pipe(Effect.tap((events) => Effect.sync(() => recorded.push(...events))))

            if (call.reset) {
              yield* workers.stop(session)
              yield* snapshots.drop(session)
              yield* record(ResetKernel.make({ session }))
            }
            const scope = yield* sessions.scope(session, call.agent)
            const tools = yield* toolbox.reach(scope.rules)

            yield* Effect.gen(function* () {
              if (!(yield* workers.alive(session))) {
                yield* workers.start(session, scope.directory)
                const stored = yield* snapshots.load(session)
                const restored = stored.length === 0 ? [] : yield* workers.restore(session, stored)
                yield* record(StartKernel.make({ session, stored: stored.length, restored, lost: lostOf(stored, restored) }))
              }
              const result = yield* workers
                .evaluate(session, { source: call.code, tools: tools.listing, call: tools.call })
                .pipe(Effect.onInterrupt(() => record(LoseKernel.make({ session, message: ABORTED }))))
              const cell = {
                session,
                ok: result.ok,
                output: result.output,
                display: result.display,
                bindings: result.bindings,
                attached: result.attached,
              }
              if (!(yield* workers.alive(session))) return yield* record(RecordCell.make(cell))
              const snapshot = yield* workers.snapshot(session)
              yield* snapshots.save(session, snapshot.bindings)
              yield* record(RecordCell.make({ ...cell, omitted: snapshot.omitted }))
              yield* FiberMap.run(idle, session, Effect.sleep(config.idleMs).pipe(Effect.andThen(stop(session, "idle"))))
            }).pipe(
              // The worker is gone; the next call starts a new one from the stored bindings.
              Effect.catchTag("WorkerLost", (lost) =>
                workers.stop(session).pipe(Effect.andThen(record(LoseKernel.make({ session, message: lost.message })))),
              ),
            )
            return read(fold(CellAnswer, recorded), config.viewChars)
          }),
        ).pipe(
          Effect.flatMap(attach),
          // Every call's time is kept, a failed or interrupted one too. No cell is cut yet: nothing of it counts as waited.
          Effect.onExit(() =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((endedAt) =>
                timed(session, cellTimed({ session, startedAt, endedAt, waitedMs: 0, computeMs: Math.max(0, endedAt - startedAt), cut: false }, call.description)),
              ),
            ),
          ),
        )
      })

      const time = Effect.fn("Kernel.time")(function* (sessionIDs: ReadonlyArray<string>) {
        const sessions = sessionIDs.map((id) => KernelSessionId.make(id))
        // A session this server has not timed is read from the store and not held: only sessions that run cells are.
        const map = yield* viewsOf(yield* SynchronizedRef.get(times), sessions)
        const now = yield* Clock.currentTimeMillis
        // Each session's view holds its own cells alone, so the answer for one reads its view.
        return { times: sessions.flatMap((session) => answerOf(map.get(session) ?? CellTime.initial, [session], now).times) }
      })

      /** The answer with each file its cell attached: read, then taken as an image or refused. */
      const attach = Effect.fn("Kernel.attach")(function* (answer: Answer) {
        const attached = yield* Effect.forEach(answer.attached ?? [], (path) =>
          files.read(path, MAX_IMAGE_BYTES).pipe(
            Effect.map((bytes) => imageOf(path, bytes)),
            Effect.catch((refused) => Effect.succeed(refused)),
          ),
        )
        return replyOf(answer, attached)
      })

      const deleted = Effect.fn("Kernel.deleted")(function* (session: KernelSessionId) {
        yield* FiberMap.remove(idle, session)
        yield* stop(session, "deleted")
        entries.delete(session)
        yield* snapshots.drop(session)
        yield* SynchronizedRef.update(times, (held) => {
          const kept = new Map(held)
          kept.delete(session)
          return kept
        })
        yield* cellTimes.drop(session)
      })

      return Kernel.of({ run, deleted, time })
    }),
  )
