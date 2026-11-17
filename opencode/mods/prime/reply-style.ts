// Which sessions are taught the chips (`guidance` in emphasis.ts), and with
// which words: the decision the server half (cmd/prime/server.ts) makes on
// each request that sends a session's conversation.
//
// - A root session gets the section; a subagent's answer is read by its
//   orchestrator, not by the owner, so a subagent gets none.
// - Only a session whose first request the plugin sees: one whose context
//   already holds an answer (or a compaction) began before the plugin did, and
//   gets none, so an install rewrites no live session's cached prefix.
// - What a session got at its first request it keeps for its life (an empty
//   text for none): a later vocabulary reaches new sessions only, so the
//   system prompt stays byte for byte the same and the prompt cache holds.
import { Context, Effect, Option } from "effect"

/** The storage key prefix of a session's kept section: `reply-style:<sessionID>`. */
export const PREFIX = "reply-style:"

/** What the decision reads of a session the first time it sees it. */
export interface Sighting {
  /** It is a subagent's session (it has a parent). */
  readonly child: boolean
  /** Its context already holds an answer or a compaction: it began before the plugin. */
  readonly answered: boolean
}

/**
 * Each session's kept section.
 * - `kept` answers the section a session kept, none when it kept none yet.
 * - `keep` keeps `text` the first time it is asked for a session and answers the kept one ever after.
 * - `forget` drops a deleted session's entry.
 */
export class ReplyStyles extends Context.Service<
  ReplyStyles,
  {
    readonly kept: (sessionID: string) => Effect.Effect<Option.Option<string>>
    readonly keep: (sessionID: string, text: string) => Effect.Effect<string>
    readonly forget: (sessionID: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/prime/ReplyStyles") {}

/** The section a session first seen as `sighting` keeps: `text` for a new root session, none for the rest. */
export const firstSection = (sighting: Sighting, text: string): string => {
  if (sighting.child || sighting.answered) return ""
  return text
}

/**
 * The section `sessionID`'s request carries: the kept one, or, at the first
 * sighting, the one `sight` decides, kept. A sighting that fails keeps nothing
 * and fails, so the next request decides again.
 */
export const sectionOf = <E>(sessionID: string, sight: Effect.Effect<Sighting, E>, text: string) =>
  Effect.gen(function* () {
    const styles = yield* ReplyStyles
    const kept = yield* styles.kept(sessionID)
    if (Option.isSome(kept)) return kept.value
    const sighting = yield* sight
    return yield* styles.keep(sessionID, firstSection(sighting, text))
  })
