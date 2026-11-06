// The server half's handlers: each request a session sends is kept until the
// step it made settles, then judged against the session's request before it
// (request-log.ts), written to the ledger and kept for the TUI's RPC. The
// plugin calls these from the host's hooks and events and nothing else.
//
// - A request goes out (`sent`): its fingerprint waits for its usage. A retry
//   replaces it: the last request is the one the step was billed for.
// - The step ends (`stepEnded`, with its assistant message and usage): the
//   waiting request is judged and becomes the session's previous one.
// - A compaction ends (`compacted`, with its summary request's usage): the
//   waiting compaction request is judged, and the next request is marked as
//   after a compaction.
// - The step fails (`stepFailed`): the waiting request is dropped; the
//   previous one stays the reference.
//
// The host runs a copy of the plugin per location, and every copy hears every
// session's events, but a session's hooks reach only its own location's copy:
// only the copy holding a waiting request writes a line, so each request gets
// one. A ledger that cannot be written is logged and skipped; the TUI still
// gets the step's cause.
import { Clock, Context, Effect, Layer } from "effect"
import { judge, lineOf, type Previous, type Sent, type SessionSteps, type StepCause, type Tokens } from "./request-log.ts"
import { RequestLog } from "./service.ts"

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
  pending?: Sent
  previous?: Previous
  compacted: boolean
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
        const state: SessionState = found ?? { compacted: false, steps: [] }
        sessions.delete(sessionID)
        sessions.set(sessionID, state)
        if (sessions.size > KEPT_SESSIONS) {
          const oldest = sessions.keys().next().value
          if (oldest !== undefined) sessions.delete(oldest)
        }
        return state
      }

      const settle = Effect.fn("Recorder.settle")(function* (sessionID: string, messageID: string | undefined, tokens: Tokens) {
        const state = sessions.get(sessionID)
        const sent = state?.pending
        if (state === undefined || sent === undefined) return
        delete state.pending
        const judgement = judge(state.previous, sent, tokens, state.compacted)
        state.previous = { sent, tokens }
        state.compacted = sent.kind === "compaction"
        if (messageID !== undefined) {
          state.steps.push({ messageID, cause: judgement.cause, ...(judgement.change === undefined ? {} : { change: judgement.change }) })
          if (state.steps.length > KEPT_STEPS) state.steps.splice(0, state.steps.length - KEPT_STEPS)
        }
        yield* log
          .append(lineOf({ host, sessionID, ...(messageID === undefined ? {} : { messageID }), sent, tokens, judgement }))
          .pipe(Effect.catchTag("LedgerUnavailable", (error) => Effect.logWarning(`cache ledger: ${error.message}`)))
      })

      return Recorder.of({
        sent: Effect.fn("Recorder.sent")(function* (sessionID, sent) {
          const at = yield* Clock.currentTimeMillis
          stateOf(sessionID).pending = { ...sent, at }
        }),
        stepEnded: (sessionID, messageID, tokens) => settle(sessionID, messageID, tokens),
        stepFailed: (sessionID) =>
          Effect.sync(() => {
            const state = sessions.get(sessionID)
            if (state !== undefined) delete state.pending
          }),
        compacted: (sessionID, tokens) =>
          sessions.get(sessionID)?.pending?.kind === "compaction" ? settle(sessionID, undefined, tokens) : Effect.void,
        steps: (sessionID) => Effect.sync(() => ({ steps: [...(sessions.get(sessionID)?.steps ?? [])] })),
      })
    }),
  )
