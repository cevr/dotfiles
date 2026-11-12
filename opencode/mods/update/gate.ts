import { resumesAt } from "@dotfiles/opencode-orchestrate/sabbath"
import { Data, DateTime, Option } from "effect"

/** A root session (one with no parent) as the restart gate reads it. */
export interface Root {
  readonly id: string
  /** A turn of it runs. */
  readonly busy: boolean
  /** A compaction of it runs. */
  readonly compacting: boolean
}

/** A session as the host lists it: its parent, if any, and what of it runs. */
export interface SessionView extends Root {
  readonly parentID: Option.Option<string>
}

/** The root sessions among `sessions`: a subagent (a session with a parent) is none of them. */
export const rootsOf = (sessions: ReadonlyArray<SessionView>): ReadonlyArray<Root> =>
  sessions.flatMap((session) => Option.toArray(Option.liftPredicate({ id: session.id, busy: session.busy, compacting: session.compacting }, () => Option.isNone(session.parentID))))

/** Whether the service may restart now, and if not, what holds it. */
export type Gate = Data.TaggedEnum<{
  /** Every root session is idle, and it is not the Sabbath rest. */
  Open: {}
  /** The Sabbath rest: no restart until `until` (epoch ms). */
  Sabbath: { readonly until: number }
  /** These root sessions run a turn or a compaction. */
  Busy: { readonly roots: ReadonlyArray<string> }
}>
export const Gate = Data.taggedEnum<Gate>()

/**
 * The restart gate at `now`. The service restarts only when every root session is idle: no turn
 * of it runs and no compaction. A subagent never holds it; a restart cuts it like an interrupt
 * and it resumes after. There is no deadline: the gate holds as long as a root works. Over the
 * Sabbath rest (orchestrate's `sabbath.ts`) it never opens.
 */
export const gate = (now: number, roots: ReadonlyArray<Root>): Gate => {
  const rest = Option.fromNullishOr(resumesAt(now))
  if (Option.isSome(rest)) return Gate.Sabbath({ until: rest.value })
  const holding = roots.flatMap((root) => Option.toArray(Option.liftPredicate(root.id, () => root.busy || root.compacting)))
  if (holding.length > 0) return Gate.Busy({ roots: holding })
  return Gate.Open()
}

/** An instant in a log line. */
export const iso = (at: number): string => DateTime.formatIso(DateTime.makeUnsafe(at))

/** The gate in a log line. */
export const describeGate = (held: Gate): string =>
  Gate.$match(held, {
    Open: () => "every root session is idle",
    Sabbath: ({ until }) => `the Sabbath rest, until ${iso(until)}`,
    Busy: ({ roots }) => `root sessions at work: ${roots.join(", ")}`,
  })
