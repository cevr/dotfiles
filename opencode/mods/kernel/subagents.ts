// A session's own subagents, as the `subagents` tool reads and stops them:
// each one's state, its last words, a wait for it to go idle, and a stop.
//
// A session reaches only its own descendants: a child, a child's child, and
// so on. Any other session is refused, so no session stops another's work.
//
// A stop is the host's own session stop, on each of the subagent's own
// subagents, deepest first, then on it, each waited on to settle: it ends the
// session's turn, the background work it owns (its shells) and its queued
// input, and keeps it from waking on a notice until it is given a new task.
// The host settles a running subagent as cancelled: its parent hears it once,
// in a `<subagent state="cancelled">` notice, and never that it finished,
// even when it is woken later. A second stop changes nothing.
//
// State, from the host's session: `running` while its newest execution has
// not ended (or before its first one), else by that execution's outcome:
// `done` (succeeded), `failed`, or `stopped` (interrupted).
import { Duration, Effect, Option, Schema } from "effect"

export const State = Schema.Literals(["running", "done", "stopped", "failed"])
export type State = typeof State.Type

/** A session's last execution's outcome, as the host records it. */
export type Outcome = "succeeded" | "failed" | "interrupted"

/** A session as the subagents tool reads it. Times are epoch ms. */
export interface Session {
  readonly id: string
  readonly parentID: Option.Option<string>
  readonly agent: string
  readonly description: string
  readonly outcome: Option.Option<Outcome>
  readonly busy: Option.Option<number>
  readonly idle: Option.Option<number>
}

/** The host's sessions: read one, list one's children, stop one, wait for one to go idle, its last words. */
export interface Host {
  readonly get: (sessionID: string) => Effect.Effect<Option.Option<Session>>
  readonly children: (sessionID: string) => Effect.Effect<ReadonlyArray<Session>>
  /** Ends the session's turn, its background work and queued input, and resolves once it settled; whether a turn ran. */
  readonly stop: (sessionID: string) => Effect.Effect<boolean>
  readonly wait: (sessionID: string) => Effect.Effect<void>
  readonly lastWords: (sessionID: string) => Effect.Effect<string>
}

/** One subagent as the tool answers it; `note` says what the call did when it did something worth saying, else "". */
export const View = Schema.Struct({
  sessionID: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  state: State,
  message: Schema.String,
  note: Schema.String,
})
export interface View extends Schema.Schema.Type<typeof View> {}

/** The session's subagents, newest first, without their messages. */
export const Listed = Schema.Struct({ subagents: Schema.Array(View) })
export interface Listed extends Schema.Schema.Type<typeof Listed> {}

/** The call names no session the caller may reach: none such, or not one of its descendants. */
export class Refused extends Schema.TaggedError<Refused>()("SubagentRefused", { message: Schema.String }) {}

/** How far up a parent chain a reach looks, and how many descendants a stop walks. */
const MAX_DEPTH = 32
const MAX_TREE = 200
/** The longest a stop waits for each stopped session to settle. */
const SETTLE = Duration.seconds(30)
/** The most characters of a subagent's last words a view carries: the newest. */
export const MAX_MESSAGE_CHARS = 20_000

const OUTCOMES: Readonly<Record<Outcome, State>> = { succeeded: "done", failed: "failed", interrupted: "stopped" }

/** Whether the session's newest execution still runs: it started after the last one ended, or none ended yet. */
const busy = (session: Session) => Option.exists(session.busy, (busyAt) => Option.match(session.idle, { onNone: () => true, onSome: (idleAt) => busyAt > idleAt }))

/** A session's state: running, else what its last execution came to; one that never ran yet is about to. */
export const stateOf = (session: Session): State => {
  if (busy(session)) return "running"
  return Option.match(session.outcome, { onNone: (): State => "running", onSome: (outcome) => OUTCOMES[outcome] })
}

/** The words of a view of `session` with its last words and a note. */
const viewOf = (session: Session, message: string, note: string): View => ({
  sessionID: session.id,
  description: session.description,
  agent: session.agent,
  state: stateOf(session),
  message: message.slice(-MAX_MESSAGE_CHARS),
  note,
})

/** The subagents tool's reads and its stop, over the host's sessions. */
export const make = (host: Host) => {
  /** `target` when it is a descendant of `caller`; refused otherwise. */
  const own = Effect.fn("Subagents.own")(function* (caller: string, target: string) {
    const found = yield* host.get(target)
    if (Option.isNone(found)) return yield* new Refused({ message: `No session ${target}.` })
    let above = found.value.parentID
    for (let depth = 0; Option.isSome(above) && depth < MAX_DEPTH; depth++) {
      if (above.value === caller) return found.value
      above = Option.flatMap(yield* host.get(above.value), (session) => session.parentID)
    }
    return yield* new Refused({ message: `${target} is not a subagent of this session: a session reaches only its own subagents.` })
  })

  /** The session as it stands now, else as it was read. */
  const fresh = (session: Session) => Effect.map(host.get(session.id), Option.getOrElse(() => session))

  const view = (session: Session, note: string) => Effect.map(host.lastWords(session.id), (words) => viewOf(session, words, note))

  /** Every descendant of `root`, breadth first, up to `MAX_TREE`. */
  const below = Effect.fn("Subagents.below")(function* (root: string) {
    const found: Array<Session> = []
    const queue = [root]
    // An array's iterator reads its length at each step, so the children pushed are walked too.
    for (const next of queue) {
      if (found.length >= MAX_TREE) break
      const children = yield* host.children(next)
      found.push(...children)
      queue.push(...children.map((child) => child.id))
    }
    return found.slice(0, MAX_TREE)
  })

  /** Stops the session, whether or not its turn runs (its shells may), up to SETTLE; whether a turn ran (or still settles). */
  const halt = (session: Session) =>
    host.stop(session.id).pipe(
      Effect.timeoutOption(SETTLE),
      Effect.map(Option.getOrElse(() => true)),
    )

  return {
    /** The caller's own subagents, newest first. */
    list: Effect.fn("Subagents.list")(function* (caller: string) {
      const children = yield* host.children(caller)
      return { subagents: children.map((child) => viewOf(child, "", "")) } satisfies Listed
    }),

    /** One of the caller's subagents, with its last words. */
    get: Effect.fn("Subagents.get")(function* (caller: string, target: string) {
      return yield* view(yield* own(caller, target), "")
    }),

    /** Waits up to `ms` for one of the caller's subagents to go idle; the note says when it still runs. */
    wait: Effect.fn("Subagents.wait")(function* (caller: string, target: string, ms: number) {
      const session = yield* own(caller, target)
      if (stateOf(session) !== "running") return yield* view(session, "")
      const ended = yield* host.wait(session.id).pipe(Effect.timeoutOption(Duration.millis(ms)))
      const now = yield* fresh(session)
      return yield* view(now, Option.match(ended, { onNone: () => `still running after ${ms} ms`, onSome: () => "" }))
    }),

    /**
     * Stops one of the caller's subagents: its own subagents first, deepest first, then it, each through the host's
     * stop and waited on to settle. One whose turn does not run keeps its state; its background work stops all the same.
     */
    stop: Effect.fn("Subagents.stop")(function* (caller: string, target: string) {
      const session = yield* own(caller, target)
      const tree = yield* below(session.id)
      const nested = (yield* Effect.forEach(tree.toReversed(), halt)).filter(Boolean).length
      const ran = yield* halt(session)
      const now = yield* fresh(session)
      const notes: Array<string> = []
      if (ran) notes.push("stopped")
      else notes.push(`it was not running (${stateOf(now)})`)
      if (nested > 0) notes.push(`stopped ${nested} of its own subagents too`)
      return yield* view(now, notes.join("; "))
    }),
  }
}

export type Subagents = ReturnType<typeof make>
