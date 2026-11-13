// The server half's handlers: each request a session sends is kept until the
// step it made settles, then judged against the session's request before it
// (request-log.ts), written to the ledger and kept for the TUI's RPC. The
// plugin calls these from the host's hooks and events and nothing else.
//
// - A request goes out (`sent`): its fingerprint waits for its usage. A retry
//   replaces it: the last request is the one the step was billed for. A
//   primary request and a compaction's summary request wait apart: with
//   background compaction on, the host writes a summary while the next step's
//   request is in flight, and each is billed by its own event.
// - The step ends (`stepEnded`, with its assistant message and usage): the
//   waiting primary request is judged and becomes the session's previous one,
//   kept in the ledger too (`RequestLog.keep`). A session this copy judged
//   nothing of is judged against the request the ledger kept, so the first
//   request after a restart names what changed (its line `restored`) instead
//   of `first`.
// - A compaction ends (`compacted`, with its summary requests' usage): the
//   waiting summary request is judged against the request before it went out
//   (a background summary is swapped in steps later), and the next request is
//   marked as after a compaction.
// - The step fails (`stepFailed`): the waiting primary request is dropped; the
//   previous one stays the reference.
//
// The host runs a copy of the plugin per location, and every copy hears every
// session's events, but a session's hooks reach only its own location's copy:
// only the copy holding a waiting request writes a line, so each request gets
// one. A ledger that cannot be written is logged and skipped; the TUI still
// gets the step's cause.
import { Clock, Context, Duration, Effect, FiberMap, Layer, Option } from "effect"
import { kept, MAX_PINGS, nextPing, pingLine, type Snapshot } from "./keepalive.ts"
import { judge, lineOf, type Previous, type Sent, type SessionSteps, type StepCause, type Tokens } from "./request-log.ts"
import { type LedgerUnavailable, Pinger, PingLog, RequestLog } from "./service.ts"

/** How many sessions, and steps of each, are kept for the RPC; the oldest go first. */
export const KEPT_SESSIONS = 500
export const KEPT_STEPS = 2_000

export class Recorder extends Context.Service<
  Recorder,
  {
    /** A request of the session went out; `at` is read from the clock. */
    readonly sent: (sessionID: string, sent: Omit<Sent, "at">) => Effect.Effect<void>
    readonly stepEnded: (sessionID: string, messageID: string, tokens: Tokens) => Effect.Effect<void>
    readonly stepFailed: (sessionID: string) => Effect.Effect<void>
    readonly compacted: (sessionID: string, tokens: Tokens) => Effect.Effect<void>
    /** The session's steps judged since the plugin started, oldest first. */
    readonly steps: (sessionID: string) => Effect.Effect<SessionSteps>
  }
>()("dotfiles-opencode/cache/Recorder") {}

interface SessionState {
  /** The primary request waiting for its step's end. */
  pending?: Sent
  /** The summary request waiting for its compaction's end, with the session's previous request when it went out. */
  summary?: { readonly sent: Sent; readonly against?: Previous }
  previous?: Previous
  compacted: boolean
  /** The ledger's kept request was looked up for this session (once per copy). */
  looked: boolean
  steps: Array<StepCause>
}

export const layer = (host: string) =>
  Layer.effect(
    Recorder,
    Effect.gen(function* () {
      const log = yield* RequestLog
      // Insertion order is recency: a session touched again moves to the end.
      const sessions = new Map<string, SessionState>()
      const stateOf = (sessionID: string): SessionState => {
        const found = sessions.get(sessionID)
        const state: SessionState = found ?? { compacted: false, looked: false, steps: [] }
        sessions.delete(sessionID)
        sessions.set(sessionID, state)
        if (sessions.size > KEPT_SESSIONS) {
          const oldest = sessions.keys().next().value
          if (oldest !== undefined) sessions.delete(oldest)
        }
        return state
      }

      const unwritten = (error: LedgerUnavailable) => Effect.logWarning(`cache ledger: ${error.message}`)

      /** The request the ledger kept for a session this copy has judged nothing of: the last one another process sent. */
      const restore = Effect.fn("Recorder.restore")(function* (sessionID: string, state: SessionState) {
        if (state.previous !== undefined || state.looked) return false
        state.looked = true
        const kept = yield* log.last(sessionID).pipe(Effect.catchTag("LedgerUnavailable", (error) => unwritten(error).pipe(Effect.as(Option.none()))))
        if (Option.isNone(kept)) return false
        state.previous = { sent: kept.value.sent, tokens: kept.value.tokens }
        state.compacted = kept.value.compacted
        return true
      })

      /** Judges the session's waiting request of the kind: the primary one for a step's end, the summary for a compaction's. */
      const settle = Effect.fn("Recorder.settle")(function* (sessionID: string, kind: Sent["kind"], messageID: string | undefined, tokens: Tokens) {
        const state = sessions.get(sessionID)
        if (state === undefined) return
        const waiting: { readonly sent: Sent; readonly against?: Previous } | undefined =
          kind === "compaction" ? state.summary : state.pending === undefined ? undefined : { sent: state.pending }
        if (waiting === undefined) return
        if (kind === "compaction") delete state.summary
        else delete state.pending
        const { sent, against } = waiting
        const restored = against === undefined ? yield* restore(sessionID, state) : false
        const judgement = judge(against ?? state.previous, sent, tokens, state.compacted)
        state.previous = { sent, tokens }
        state.compacted = sent.kind === "compaction"
        if (messageID !== undefined) {
          state.steps.push({ messageID, cause: judgement.cause, ...(judgement.change === undefined ? {} : { change: judgement.change }) })
          if (state.steps.length > KEPT_STEPS) state.steps.splice(0, state.steps.length - KEPT_STEPS)
        }
        yield* log
          .append(lineOf({ host, sessionID, ...(messageID === undefined ? {} : { messageID }), sent, tokens, judgement, restored }))
          .pipe(Effect.catchTag("LedgerUnavailable", unwritten))
        yield* log.keep(sessionID, { sent, tokens, compacted: state.compacted }).pipe(Effect.catchTag("LedgerUnavailable", unwritten))
      })

      return Recorder.of({
        sent: Effect.fn("Recorder.sent")(function* (sessionID, sent) {
          const at = yield* Clock.currentTimeMillis
          const state = stateOf(sessionID)
          if (sent.kind === "compaction") state.summary = { sent: { ...sent, at }, ...(state.previous === undefined ? {} : { against: state.previous }) }
          else state.pending = { ...sent, at }
        }),
        stepEnded: (sessionID, messageID, tokens) => settle(sessionID, "primary", messageID, tokens),
        stepFailed: (sessionID) =>
          Effect.sync(() => {
            const state = sessions.get(sessionID)
            if (state !== undefined) delete state.pending
          }),
        compacted: (sessionID, tokens) => settle(sessionID, "compaction", undefined, tokens),
        steps: (sessionID) => Effect.sync(() => ({ steps: [...(sessions.get(sessionID)?.steps ?? [])] })),
      })
    }),
  )

/** How many sessions the keepalive holds a request for at once; the oldest go first. */
export const KEPT_ARMED = 200

/**
 * The keepalive's handlers (keepalive.ts has the rules). The plugin calls
 * them from the host's hooks and events:
 *
 * - A request of the session went out (`armed`): the request the next wait
 *   pings, or none when it arms none (a root's, an hour's cache). It ends any
 *   wait: a request means the tools before it returned.
 * - One of its tool calls starts (`toolStarted`): the wait starts with the
 *   first. It ends with the last (`toolEnded`), its ping in flight aborted.
 * - Its execution ends or it is deleted (`ended`): the wait ends and the
 *   request is dropped.
 *
 * Only the copy whose hook saw the request holds it, so only that copy pings,
 * though every copy hears the events. A ping's line that cannot be written is
 * logged and skipped.
 */
export class Keepalive extends Context.Service<
  Keepalive,
  {
    readonly armed: (sessionID: string, request: Option.Option<Omit<Snapshot, "at">>) => Effect.Effect<void>
    readonly toolStarted: (sessionID: string, callID: string) => Effect.Effect<void>
    readonly toolEnded: (sessionID: string, callID: string) => Effect.Effect<void>
    readonly ended: (sessionID: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/cache/Keepalive") {}

interface Waiting {
  snapshot: Snapshot
  readonly running: Set<string>
  /** The pings the current wait sent. */
  sent: number
}

export const keepaliveLayer = (host: string) =>
  Layer.effect(
    Keepalive,
    Effect.gen(function* () {
      const log = yield* PingLog
      const pinger = yield* Pinger
      const loops = yield* FiberMap.make<string>()
      // Insertion order is recency: a session armed again moves to the end.
      const sessions = new Map<string, Waiting>()
      const waitingOf = (sessionID: string) => Option.fromUndefinedOr(sessions.get(sessionID))

      const unwritten = (error: LedgerUnavailable) => Effect.logWarning(`cache keepalive: ${error.message}`)

      /** The wait's next ping, when one is due (nextPing): sent and logged; whether the wait goes on. */
      const ping = Effect.fn("Keepalive.ping")(function* (sessionID: string, waiting: Waiting) {
        const { snapshot, sent } = waiting
        const delay = nextPing(snapshot.at, snapshot.ttlMs, yield* Clock.currentTimeMillis, sent)
        if (Option.isNone(delay)) return false
        yield* Effect.sleep(Duration.millis(delay.value))
        const at = yield* Clock.currentTimeMillis
        // Counted as it goes out, so a wait's tool call that starts the loop again sends no fifth.
        waiting.sent = sent + 1
        const outcome = yield* Effect.result(pinger.send({ url: snapshot.url, method: snapshot.method, headers: snapshot.headers, body: snapshot.body }))
        yield* log.append(pingLine({ host, sessionID, snapshot, at, ping: sent + 1, outcome })).pipe(Effect.catchTag("LedgerUnavailable", unwritten))
        // A refused or failed ping would fail again within the wait: the wait's pings end.
        if (!kept(outcome)) {
          waiting.sent = MAX_PINGS
          return false
        }
        waiting.snapshot = { ...snapshot, at }
        return true
      })

      /** One wait's pings, each due `INTERVAL_MS` after the request or ping before, until none is. */
      const wait = Effect.fn("Keepalive.wait")(function* (sessionID: string) {
        let going = true
        while (going) going = yield* Option.match(waitingOf(sessionID), { onNone: () => Effect.succeed(false), onSome: (waiting) => ping(sessionID, waiting) })
      })

      const stop = (sessionID: string) => FiberMap.remove(loops, sessionID)

      return Keepalive.of({
        armed: Effect.fn("Keepalive.armed")(function* (sessionID, request) {
          yield* stop(sessionID)
          sessions.delete(sessionID)
          if (Option.isNone(request)) return
          sessions.set(sessionID, { snapshot: { ...request.value, at: yield* Clock.currentTimeMillis }, running: new Set(), sent: 0 })
          if (sessions.size <= KEPT_ARMED) return
          const [oldest] = sessions.keys()
          if (oldest === sessionID) return
          sessions.delete(oldest)
          yield* stop(oldest)
        }),
        toolStarted: Effect.fn("Keepalive.toolStarted")(function* (sessionID, callID) {
          const found = waitingOf(sessionID)
          if (Option.isNone(found)) return
          // The first call of a wait starts it afresh.
          if (found.value.running.size === 0) found.value.sent = 0
          found.value.running.add(callID)
          yield* FiberMap.run(loops, sessionID, wait(sessionID), { onlyIfMissing: true })
        }),
        toolEnded: Effect.fn("Keepalive.toolEnded")(function* (sessionID, callID) {
          const found = waitingOf(sessionID)
          if (Option.isNone(found) || !found.value.running.delete(callID) || found.value.running.size > 0) return
          yield* stop(sessionID)
        }),
        ended: Effect.fn("Keepalive.ended")(function* (sessionID) {
          sessions.delete(sessionID)
          yield* stop(sessionID)
        }),
      })
    }),
  )
