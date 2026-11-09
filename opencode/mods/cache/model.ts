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
import { Clock, Context, Effect, Layer, Option } from "effect"
import { judge, lineOf, type Previous, type Sent, type SessionSteps, type StepCause, type Tokens } from "./request-log.ts"
import { type LedgerUnavailable, RequestLog } from "./service.ts"

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
