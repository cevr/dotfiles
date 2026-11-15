// When a long root session's title is generated again, and whose title it is.
// Pure: the model reads the host and the clock, and these rules decide.
import { Data, Option, Schema } from "effect"

/** When a session is due a new title. */
export interface Policy {
  /** How long after its last title, in ms. */
  readonly afterMs: number
  /** How many turns (assistant replies) after its last title. */
  readonly afterTurns: number
}

/** What the plugin keeps of a root session it titles: stored, so a pin outlives a restart. */
export const Track = Schema.Struct({
  /** The owner set the title: no automatic one until the owner asks for one again. */
  pinned: Schema.Boolean,
  /** When it was last titled (a title landed, or the plugin asked for one), epoch ms. */
  titledAt: Schema.Finite,
  /** Turns ended since then. */
  turns: Schema.Int,
  /** A compaction ran since then. */
  compacted: Schema.Boolean,
})
export type Track = typeof Track.Type

/** A session first seen now: its title counts as new. */
export const fresh = (now: number): Track => ({ pinned: false, titledAt: now, turns: 0, compacted: false })

/** What happened to a session, as the track follows it. */
export type Fact = Data.TaggedEnum<{
  /** A turn ended with the model's reply. */
  TurnEnded: {}
  /** A compaction ended. */
  Compacted: {}
  /**
   * The host started generating its title. For a pinned session that is only the owner's `/rename` with no
   * argument (the host generates on its own only for an untitled session, and the plugin never for a pinned one).
   */
  Generating: {}
  /** A new title that does not pin: a generated one, an agent's, or the plugin's request for one. */
  Titled: {}
  /** The owner set the title. */
  Pinned: {}
}>
export const Fact = Data.taggedEnum<Fact>()

export const evolve = (track: Track, fact: Fact, now: number): Track =>
  Fact.$match(fact, {
    TurnEnded: () => ({ ...track, turns: track.turns + 1 }),
    Compacted: () => ({ ...track, compacted: true }),
    Generating: () => ({ ...track, pinned: false }),
    Titled: () => ({ ...track, titledAt: now, turns: 0, compacted: false }),
    Pinned: () => ({ ...track, pinned: true, titledAt: now, turns: 0, compacted: false }),
  })

/** What the host says of the session as it goes idle. */
export interface Standing {
  /** A subagent's session. */
  readonly child: boolean
  /** An execution of it runs. */
  readonly running: boolean
}

/** Whether to generate the title again now, and why. */
export type Verdict = Data.TaggedEnum<{
  Retitle: { readonly because: "time" | "compaction" }
  Keep: { readonly because: "subagent" | "pinned" | "busy" | "untouched" | "early" }
}>
export const Verdict = Data.taggedEnum<Verdict>()

/**
 * Whether to generate the title again now: a root session, not pinned, idle, after a compaction with a turn since its
 * last title, or once both `afterMs` and `afterTurns` have passed since it.
 */
export const due = (track: Track, standing: Standing, now: number, policy: Policy): Verdict => {
  if (standing.child) return Verdict.Keep({ because: "subagent" })
  if (track.pinned) return Verdict.Keep({ because: "pinned" })
  if (standing.running) return Verdict.Keep({ because: "busy" })
  if (track.turns === 0) return Verdict.Keep({ because: "untouched" })
  if (track.compacted) return Verdict.Retitle({ because: "compaction" })
  if (now - track.titledAt >= policy.afterMs && track.turns >= policy.afterTurns) return Verdict.Retitle({ because: "time" })
  return Verdict.Keep({ because: "early" })
}

/** How long a mark of a title being made waits for its `session.renamed`. */
export const MARK_MS = 120_000

/** What the plugin saw just before a session's title changed. */
export interface Marks {
  /** The host started generating its title (the `title` hook), epoch ms. */
  readonly generating: Option.Option<number>
  /** An agent's `opencode_session_rename` to this title started (its `execute.before`). */
  readonly agent: Option.Option<{ readonly title: string; readonly at: number }>
}

export const noMarks: Marks = { generating: Option.none(), agent: Option.none() }

/** Who set a new title. */
export type Setter = "generated" | "agent" | "owner"

/** What a new title is to the track, by who set it: only the owner's pins. */
export const setBy = { generated: Fact.Titled(), agent: Fact.Titled(), owner: Fact.Pinned() } satisfies { readonly [S in Setter]: Fact }

/**
 * Whose a new title is: generated (the host's title request ran for it), an agent's (its rename tool asked for that
 * title), or else the owner's (`/rename <text>`, the TUI's dialog: `session.update` over HTTP).
 */
export const renamedBy = (marks: Marks, title: string, now: number): Setter => {
  if (Option.exists(marks.generating, (at) => now - at <= MARK_MS)) return "generated"
  if (Option.exists(marks.agent, (agent) => agent.title === title && now - agent.at <= MARK_MS)) return "agent"
  return "owner"
}
