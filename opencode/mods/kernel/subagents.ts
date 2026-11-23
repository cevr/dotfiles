// A session's own subagents, as the `subagents` tool reads and stops them:
// each one's state, its last words, and a stop. There is no wait: a subagent
// reports to its parent when it is done.
//
// A session reaches only its own descendants: a child, a child's child, and
// so on. Any other session is refused, so no session stops another's work.
//
// A stop is the host's own session stop, on each of the subagent's own
// subagents, deepest first, then on it, each waited on to settle: it ends the
// session's turn, the background work it owns (its shells) and its queued
// input, and keeps it from waking on a notice until it is given a new task.
// The host owns cancellation and report delivery. An unconfirmed stop is
// not an observed exit, and stopping a local child cannot stop remote work.
//
// The typed observation preserves phases the historical state enum cannot
// express. Its compatibility projection never makes a live phase terminal.
import { Duration, Effect, Option, Schema } from "effect"
import { Observation, Phase, type Outcome } from "./child-lifecycle.ts"
export type { Outcome } from "./child-lifecycle.ts"

export const State = Schema.Literals(["running", "done", "stopped", "failed"])
export type State = typeof State.Type

/** A session as the subagents tool reads it. Times are epoch ms. */
export interface Session {
  readonly id: string
  readonly parentID: Option.Option<string>
  readonly agent: string
  readonly description: string
  readonly outcome: Option.Option<Outcome>
  readonly busy: Option.Option<number>
  readonly idle: Option.Option<number>
  readonly observation?: Observation
}

/** The host's sessions: read one, list one's children, stop one, its last words. */
export interface Host {
  readonly parent?: (sessionID: string) => Effect.Effect<Option.Option<Option.Option<string>>>
  readonly get: (sessionID: string) => Effect.Effect<Option.Option<Session>>
  readonly children: (sessionID: string) => Effect.Effect<ReadonlyArray<Session>>
  /** Ends the session's turn, its background work and queued input, and resolves once it settled; whether a turn ran. */
  readonly stop: (sessionID: string) => Effect.Effect<Option.Option<boolean>>
  readonly lastWords: (sessionID: string) => Effect.Effect<string>
  readonly stopUncertain?: (sessionID: string, after: number) => Effect.Effect<void>
}

/** One subagent as the tool answers it; `note` says what the call did when it did something worth saying, else "". */
export const View = Schema.Struct({
  sessionID: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  state: State,
  message: Schema.String,
  note: Schema.String,
  observation: Schema.optionalKey(Observation),
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

export const observedState = ({ phase, basis }: Observation): State => {
  if (basis === "as-of-last-observation" || phase._tag !== "Settled") return "running"
  return OUTCOMES[phase.outcome]
}

/** Whether the session's newest execution still runs: it started after the last one ended, or none ended yet. */
const busy = (session: Session) => Option.exists(session.busy, (busyAt) => Option.match(session.idle, { onNone: () => true, onSome: (idleAt) => busyAt > idleAt }))

/** A session's state: running, else what its last execution came to; one that never ran yet is about to. */
export const stateOf = (session: Session): State => {
  if (session.observation) return observedState(session.observation)
  if (busy(session)) return "running"
  return Option.match(session.outcome, { onNone: (): State => "running", onSome: (outcome) => OUTCOMES[outcome] })
}

/** The words of a view of `session` with its last words and a note. */
const viewOf = (session: Session, message: string, note: string): View => {
  const view = {
    sessionID: session.id,
    description: session.description,
    agent: session.agent,
    state: stateOf(session),
    message: message.slice(-MAX_MESSAGE_CHARS),
    note,
  }
  if (session.observation) return { ...view, observation: session.observation }
  return view
}

/** The subagents tool's reads and its stop, over the host's sessions. */
export const make = (host: Host) => {
  const link = host.parent ?? ((id: string) => host.get(id).pipe(Effect.map(Option.map(({ parentID }) => parentID))))
  const authority = Effect.fn("Subagents.authority")(function* (caller: string, target: string) {
    const found = yield* link(target)
    if (Option.isNone(found)) return yield* new Refused({ message: `No session ${target}.` })
    const parent = found.value
    let above = parent
    for (let depth = 0; Option.isSome(above) && depth < MAX_DEPTH; depth++) {
      if (above.value === caller) return parent
      above = Option.flatten(yield* link(above.value))
    }
    return yield* new Refused({ message: `${target} is not a subagent of this session: a session reaches only its own subagents.` })
  })
  /** Do not carry a target observation through ancestor reads. Get it after checking ownership. */
  const own = Effect.fn("Subagents.own")(function* (caller: string, target: string) {
    const parent = yield* authority(caller, target)
    const observed = yield* host.get(target)
    if (Option.isSome(observed) && Option.contains(Option.zipWith(parent, observed.value.parentID, (a, b) => a === b), true)) return observed.value
    return yield* new Refused({ message: `No session ${target}.` })
  })

  /** The session as it stands now, else as it was read. */
  const unobserved = (session: Session): Session => ({
    ...session,
    observation: { version: 1, child: session.id, phase: Phase.cases.Unknown.make({}) },
  })

  /** Every descendant of `root`, breadth first, up to `MAX_TREE`. */
  const below = Effect.fn("Subagents.below")(function* (root: string) {
    const found: Array<string> = []
    const queue = [root]
    // An array's iterator reads its length at each step, so the children pushed are walked too.
    for (const next of queue) {
      if (found.length >= MAX_TREE) break
      const children = yield* host.children(next)
      const ids = children.map((child) => child.id)
      found.push(...ids)
      queue.push(...ids)
    }
    return found.slice(0, MAX_TREE)
  })

  const stopAfter = (view: Session) => {
    const phase = view.observation?.phase
    if (phase?._tag === "Latched") return Option.none()
    if (phase?._tag === "Settled" && phase.terminal) return Option.some(phase.terminal.seq)
    return Option.some(-1)
  }
  /** Stops the session even if only its background work currently runs. */
  const halt = Effect.fn("Subagents.halt")(function* (caller: string, target: string) {
    const inScope = yield* Effect.option(Effect.map(own(caller, target), stopAfter))
    if (Option.isNone(inScope)) return "unknown"
    const after = inScope.value
    if (Option.isNone(after)) return "idle"
    const stopped = yield* host.stop(target).pipe(Effect.timeoutOption(SETTLE), Effect.map(Option.flatten))
    if (Option.contains(stopped, true)) return "stopped"
    if (Option.contains(stopped, false)) return "idle"
    if (host.stopUncertain) yield* host.stopUncertain(target, after.value)
    return "unknown"
  })

  return {
    /** The caller's own subagents, newest first. */
    list: Effect.fn("Subagents.list")(function* (caller: string) {
      const children = yield* host.children(caller)
      return { subagents: children.map((child) => viewOf(child, "", "")) } satisfies Listed
    }),

    /** One of the caller's subagents, with its last words. */
    get: Effect.fn("Subagents.get")(function* (caller: string, target: string) {
      yield* authority(caller, target)
      const words = yield* host.lastWords(target)
      return viewOf(yield* own(caller, target), words, "")
    }),

    /**
     * Stops one of the caller's subagents: its own subagents first, deepest first, then it, each through the host's
     * stop and waited on to settle. One whose turn does not run keeps its state; its background work stops all the same.
     */
    stop: Effect.fn("Subagents.stop")(function* (caller: string, target: string) {
      const initial = yield* own(caller, target).pipe(Effect.map(unobserved))
      const tree = yield* below(target)
      const nested = (yield* Effect.forEach(tree.toReversed(), (each) => halt(caller, each))).filter((result) => result === "stopped").length
      const ran = yield* halt(caller, target)
      const stillOwned = yield* Effect.option(authority(caller, target))
      const words = yield* Option.match(stillOwned, { onNone: () => Effect.succeed(""), onSome: () => host.lastWords(target) })
      const verified = yield* Effect.option(own(caller, target))
      let now = Option.getOrElse(verified, () => initial)
      if (ran === "unknown" && !host.stopUncertain) now = unobserved(now)
      const notes: Array<string> = []
      if (ran === "stopped") notes.push("stopped")
      else if (ran === "unknown") notes.push("stop not confirmed")
      else if (now.observation?.phase._tag === "Latched") notes.push("still latched; cancel with wake_cancel")
      else notes.push(`it was not running (${stateOf(now)})`)
      if (nested > 0) notes.push(`stopped ${nested} of its own subagents too`)
      return viewOf(now, Option.getOrElse(Option.as(verified, words), () => ""), notes.join("; "))
    }),
  }
}

export type Subagents = ReturnType<typeof make>
