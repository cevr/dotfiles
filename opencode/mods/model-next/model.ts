// The queued switch's handlers. The plugin calls these from its RPC, the
// host's two awaited hooks and the model-selection event, and nothing else.
//
// - `queue` / `cancel` / `show`: the RPC the TUI (the `/model-next` command
//   and the picker's action), and the agent's `model_next` tool call. A refusal is an
//   answer (pending.ts `Answer`).
// - `compacted` (`experimental.compaction.ended`): a completed compaction of
//   the session. The outgoing model wrote the summary; switch now, before the
//   next request is built.
// - `woke` (`experimental.wake`): an execution of the session starts on input.
//   Past the last request's cache lifetime plus the grace, switch now, before
//   its first request is built. It reads the session's record first and
//   returns at once when nothing is queued: it runs before every turn.
// - `selected` (`session.model.selected`): a selection that moved the session
//   off the model it was queued from ends the queued switch, the mod's own
//   apply included (the value is already gone then).
//
// Metadata is replaced whole by the host, so every write reads the session's
// metadata and changes only `KEY` (`withPending`), and this copy's writes go
// one at a time. A writer of another plugin on the same session in the same
// instant can still lose an update; none was seen (state.md).
//
// A target the catalog no longer offers is not applied: it stays queued and
// the apply point logs it at warning. A hook that fails is logged by the host
// and changes nothing, so every failure here is caught and logged.
import { Clock, Context, Effect, Layer, Option, Semaphore } from "effect"
import {
  type Answer,
  Apply,
  Cancelled,
  atCompaction,
  atWake,
  label,
  type Metadata,
  type ModelRef,
  type Pending,
  pendingOf,
  type Policy,
  present,
  queue as decideQueue,
  Queued,
  Queueing,
  Refused,
  sameModel,
  endedBy,
  type Shown,
  type WaitReason,
  withPending,
} from "./pending.ts"
import { Sessions } from "./service.ts"

const LOG = { Info: Effect.logInfo, Warning: Effect.logWarning, Debug: Effect.logDebug } as const

/** How loud a wait at the wake is: a lost target is news, a warm cache is every turn's answer. */
const WAIT_LEVEL = { "target-gone": "Warning", "no-request": "Debug", compacted: "Debug", uncached: "Debug", "ttl-unknown": "Debug", warm: "Debug" } as const satisfies Record<WaitReason, keyof typeof LOG>

/** One log line with its fields as annotations. */
const note = (level: keyof typeof LOG, message: string, fields: Readonly<Record<string, string | boolean>>) => LOG[level](message).pipe(Effect.annotateLogs(fields))

export class ModelNext extends Context.Service<
  ModelNext,
  {
    readonly queue: (sessionID: string, model: ModelRef) => Effect.Effect<Answer>
    readonly cancel: (sessionID: string) => Effect.Effect<Answer>
    readonly show: (sessionID: string) => Effect.Effect<Shown>
    readonly compacted: (sessionID: string) => Effect.Effect<void>
    readonly woke: (sessionID: string) => Effect.Effect<void>
    readonly selected: (sessionID: string, model: ModelRef) => Effect.Effect<void>
  }
>()("dotfiles-opencode/model-next/ModelNext") {}

export const layer = (policy: Policy) =>
  Layer.effect(
    ModelNext,
    Effect.gen(function* () {
      const sessions = yield* Sessions
      const one = yield* Semaphore.make(1)
      const serial = <A, E>(effect: Effect.Effect<A, E>) => one.withPermits(1)(effect)

      /** The session's queued switch and its metadata as read now; none when the session is gone. */
      const read = (sessionID: string) =>
        sessions.record(sessionID).pipe(Effect.map(Option.map((record) => ({ record, pending: pendingOf(sessionID, Option.some(record.metadata)) }))))

      /** The session's metadata with `pending` set or taken out, every other key as read. */
      const write = (sessionID: string, metadata: Metadata, pending: Option.Option<Pending>) => sessions.setMetadata(sessionID, withPending(Option.some(metadata), pending))

      /** Switch to the queued model: the value goes first, so the selection event finds nothing to end. */
      const apply = (sessionID: string, metadata: Metadata, pending: Pending, at: "compaction" | "wake") =>
        Effect.gen(function* () {
          yield* write(sessionID, metadata, Option.none())
          yield* sessions.switchModel(sessionID, pending.model)
          yield* note("Info", "model-next: switched", { sessionID, at, from: Option.match(Option.fromUndefinedOr(pending.from), { onNone: () => "", onSome: label }), to: label(pending.model) })
        })

      const logged = (what: string, sessionID: string) => <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.asVoid,
          Effect.catchCause((cause) => note("Warning", `model-next: ${what} failed`, { sessionID, cause: String(cause) })),
        )

      const queue = (sessionID: string, model: ModelRef) =>
        serial(
          Effect.gen(function* () {
            const found = yield* read(sessionID)
            if (Option.isNone(found)) return Refused.make({ reason: "no-session" })
            const current = found.value.record.model
            const [target, own] = yield* Effect.all([sessions.entry(sessionID, model), sessions.entry(sessionID, current)])
            const decided = decideQueue(sessionID, model, { current: Option.some(current), target, own }, yield* Clock.currentTimeMillis)
            return yield* Queueing.$match(decided, {
              Refuse: ({ reason }) => Effect.succeed<Answer>(Refused.make({ reason })),
              Keep: ({ pending }) =>
                write(sessionID, found.value.record.metadata, Option.some(pending)).pipe(
                  Effect.tap(() => note("Info", "model-next: queued", { sessionID, from: label(current), to: label(model) })),
                  Effect.as<Answer>(Queued.make({ model, from: current })),
                ),
            })
          }),
        ).pipe(
          // A host that could not be read or written answers as no session: the TUI says so, nothing is queued.
          Effect.catchCause((cause) =>
            note("Warning", "model-next: queue failed", { sessionID, cause: String(cause) }).pipe(Effect.as<Answer>(Refused.make({ reason: "no-session" }))),
          ),
        )

      const cancel = (sessionID: string) =>
        serial(
          Effect.gen(function* () {
            const found = yield* read(sessionID)
            if (Option.isNone(found)) return Refused.make({ reason: "no-session" })
            const had = Option.isSome(found.value.pending)
            if (had) yield* write(sessionID, found.value.record.metadata, Option.none())
            return Cancelled.make({ had })
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            note("Warning", "model-next: cancel failed", { sessionID, cause: String(cause) }).pipe(Effect.as<Answer>(Refused.make({ reason: "no-session" }))),
          ),
        )

      const show = (sessionID: string) =>
        read(sessionID).pipe(
          Effect.map(
            Option.match({
              onNone: (): Shown => ({}),
              onSome: ({ record, pending }): Shown =>
                Option.match(pending, { onNone: (): Shown => ({ current: record.model }), onSome: (value): Shown => ({ current: record.model, pending: value }) }),
            }),
          ),
          Effect.orElseSucceed((): Shown => ({})),
        )

      const compacted = (sessionID: string) =>
        serial(
          Effect.gen(function* () {
            const found = yield* read(sessionID)
            if (Option.isNone(found) || Option.isNone(found.value.pending)) return
            const pending = found.value.pending.value
            const decided = atCompaction(pending, present(pending.model, yield* sessions.entry(sessionID, pending.model)))
            yield* Apply.$match(decided, {
              Switch: () => apply(sessionID, found.value.record.metadata, pending, "compaction"),
              Wait: ({ reason }) => note("Warning", "model-next: not switched at the compaction", { sessionID, reason, to: label(pending.model) }),
            })
          }),
        ).pipe(logged("the compaction's switch", sessionID))

      const woke = (sessionID: string) =>
        serial(
          Effect.gen(function* () {
            const found = yield* read(sessionID)
            // The cheap read, before every turn: nothing queued, nothing more read.
            if (Option.isNone(found) || Option.isNone(found.value.pending)) return
            const pending = found.value.pending.value
            const [cache, entry] = yield* Effect.all([sessions.cache(sessionID), sessions.entry(sessionID, pending.model)])
            const decided = atWake(pending, cache, policy, present(pending.model, entry), yield* Clock.currentTimeMillis)
            yield* Apply.$match(decided, {
              Switch: () => apply(sessionID, found.value.record.metadata, pending, "wake"),
              Wait: ({ reason }) => note(WAIT_LEVEL[reason], "model-next: not switched at the wake", { sessionID, reason, to: label(pending.model) }),
            })
          }),
        ).pipe(logged("the wake's switch", sessionID))

      const selected = (sessionID: string, model: ModelRef) =>
        serial(
          Effect.gen(function* () {
            const found = yield* read(sessionID)
            if (Option.isNone(found) || Option.isNone(found.value.pending)) return
            const pending = found.value.pending.value
            if (!endedBy(pending, model)) return
            yield* write(sessionID, found.value.record.metadata, Option.none())
            const reached = sameModel(pending.model, model)
            yield* note("Info", "model-next: dropped by a model selection", { sessionID, selected: label(model), queued: label(pending.model), reached })
          }),
        ).pipe(logged("the selection's drop", sessionID))

      return ModelNext.of({ queue, cancel, show, compacted, woke, selected })
    }),
  )
