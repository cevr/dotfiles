// The staleness sweep: one pass reads this location's recently active root
// sessions' queues, finds the items that look stale (`stale.ts`) against what
// the host says now, and sends a short note to a session whose queue needs a
// look, so its agent checks each item and sets it done, removes it or
// restates it. It never changes a queue. The plugin runs a pass every
// SWEEP_EVERY; a session hears at most one note an hour (GAP_MS), the same
// ask again only after REPEAT_MS, and one pass sends at most PER_PASS notes.
import { Array as Arr, Clock, Context, Effect, Layer, Option, Ref } from "effect"
import { type Linked, due, GAP_MS, keyOf, noteOf, openOf, type Sent, staleOf } from "./stale.ts"
import { QueueHost, QueueStore, type Root } from "./service.ts"

/** How often the plugin sweeps, and how long after it starts the first pass runs. */
export const SWEEP_EVERY = "10 minutes"
export const FIRST_AFTER = "5 minutes"
/** A root session that has not changed in this long is left alone: nobody is reading its queue. */
export const ACTIVE_MS = 24 * 60 * 60_000
/** At most this many notes in one pass, the most recently active sessions first. */
export const PER_PASS = 3

/** A note one pass sent. */
export interface Noted {
  readonly sessionID: string
  /** The ids of the items it named as stale. */
  readonly stale: ReadonlyArray<string>
  readonly open: number
  /** Whether it woke the session (it was idle) or waits for its next turn. */
  readonly woke: boolean
}

export class Freshness extends Context.Service<
  Freshness,
  {
    /** One pass: the notes it sent. */
    readonly sweep: Effect.Effect<ReadonlyArray<Noted>>
  }
>()("dotfiles-opencode/queue/Freshness") {}

const distinct = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)]

export const layer = Layer.effect(
  Freshness,
  Effect.gen(function* () {
    const store = yield* QueueStore
    const host = yield* QueueHost
    /** The last note each session got. */
    const sent = yield* Ref.make(new Map<string, Sent>())
    /** Every wake id each session was seen to have pending: one seen and pending no more has ended. */
    const seen = yield* Ref.make(new Map<string, ReadonlySet<string>>())

    /** The wake ids each session had pending before and has no more, remembering what is pending now. */
    const endedWakes = (sessionIDs: ReadonlyArray<string>) =>
      host.wakes(sessionIDs).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(new Map<string, ReadonlySet<string>>()),
            onSome: (pending) =>
              Ref.modify(seen, (before) => {
                const after = new Map(before)
                const ended = new Map<string, ReadonlySet<string>>()
                for (const sessionID of sessionIDs) {
                  const now = new Set(Option.getOrElse(Option.fromNullishOr(pending.get(sessionID)), Arr.empty))
                  const known = Option.getOrElse(Option.fromNullishOr(before.get(sessionID)), () => new Set<string>())
                  ended.set(sessionID, new Set([...known].filter((id) => !now.has(id))))
                  after.set(sessionID, new Set([...known, ...now]))
                }
                return [ended, after]
              }),
          }),
        ),
      )

    const linkedOf = (sessionIDs: ReadonlyArray<string>) =>
      Effect.forEach(
        sessionIDs,
        (id) => host.linked(id).pipe(Effect.map(Option.match({ onNone: () => [], onSome: (state): ReadonlyArray<readonly [string, Linked]> => [[id, state]] }))),
        { concurrency: 4 },
      ).pipe(Effect.map((found) => new Map(found.flat())))

    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const roots = (yield* host.roots).filter((root) => now - root.updated < ACTIVE_MS)
      const queued = yield* Effect.forEach(roots, (root) =>
        store.read(root.id).pipe(
          Effect.map((snapshot) => [{ root, snapshot }]),
          Effect.orElseSucceed(() => []),
        ),
      ).pipe(Effect.map((all) => all.flat().filter(({ snapshot }) => openOf(snapshot.items) > 0)))
      if (queued.length === 0) return []
      const ids = queued.map(({ root }) => root.id)
      const ended = yield* endedWakes(ids)
      const questions = yield* host.questions(ids)
      const last = yield* Ref.get(sent)
      const wanted: Array<{ readonly root: Root; readonly key: string; readonly text: string; readonly noted: Noted }> = []
      for (const { root, snapshot } of queued) {
        if (wanted.length >= PER_PASS) break
        const previous = Option.fromNullishOr(last.get(root.id))
        // Within the gap nothing is sent, so nothing is read.
        if (Option.exists(previous, (sent) => now - sent.at < GAP_MS)) continue
        const open = openOf(snapshot.items)
        const sessions = distinct(
          Arr.flatMap(snapshot.items, (item) => Arr.filter(Option.toArray(Option.fromNullishOr(item.session)), () => item.state !== "done")),
        )
        const stale = staleOf(snapshot.items, {
          now,
          touched: Option.getOrElse(Option.fromNullishOr(snapshot.touched), () => ({})),
          linked: yield* linkedOf(sessions),
          openQuestions: Option.map(questions, (counts) => Option.getOrElse(Option.fromNullishOr(counts.get(root.id)), () => 0)),
          endedWakes: Option.getOrElse(Option.fromNullishOr(ended.get(root.id)), () => new Set<string>()),
        })
        const key = keyOf(stale, open)
        if (!due(key, previous, now)) continue
        wanted.push({ root, key, text: noteOf(stale, open), noted: { sessionID: root.id, stale: stale.map((each) => each.id), open, woke: !root.busy } })
      }
      return yield* Effect.forEach(wanted, ({ root, key, text, noted }) =>
        host.note(root.id, text, `Queue check: ${noted.stale.length} stale of ${noted.open} open`, !root.busy).pipe(
          Effect.andThen(Ref.update(sent, (before) => new Map(before).set(root.id, { at: now, key }))),
          Effect.as([noted]),
          Effect.catchTag("NoteRefused", (refused) =>
            Effect.logWarning("queue: a staleness note did not reach its session", { sessionID: refused.sessionID, message: refused.message }).pipe(Effect.as([])),
          ),
        ),
      ).pipe(Effect.map((all) => all.flat()))
    }).pipe(Effect.withSpan("Freshness.sweep"))

    return Freshness.of({ sweep })
  }),
)
