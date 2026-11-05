// Whom a message goes to. An address is a session id (`ses_…`), looked up as
// is, or a title, matched against the server's sessions: an exact title (any
// case) first, else the one title that contains it. A session never writes to
// itself.
import { Effect, Schema } from "effect"
import { nameOf, type SessionCard } from "./directory.ts"

/** No session on this server has that id, or a title that matches. */
export class NoSuchSession extends Schema.TaggedError<NoSuchSession>()("NoSuchSession", { to: Schema.String }) {}

/** More than one session's title matches; the evidence is each match. */
export class AmbiguousTitle extends Schema.TaggedError<AmbiguousTitle>()("AmbiguousTitle", {
  to: Schema.String,
  matches: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
}) {}

/** The address is the sender's own session. */
export class SelfAddressed extends Schema.TaggedError<SelfAddressed>()("SelfAddressed", { sessionID: Schema.String }) {}

/** Whether an address is a session id rather than a title. */
export const isSessionID = (to: string): boolean => /^ses_[A-Za-z0-9]+$/.test(to.trim())

/** The most matches an ambiguity names. */
const NAMED = 5

/** The one session among `cards` whose title `to` names. */
export const byTitle = (to: string, cards: ReadonlyArray<SessionCard>): Effect.Effect<SessionCard, NoSuchSession | AmbiguousTitle> => {
  const wanted = to.trim().toLowerCase()
  const titled = cards.filter((card) => card.title !== undefined && card.title.trim() !== "")
  const exact = titled.filter((card) => card.title?.trim().toLowerCase() === wanted)
  const found = exact.length > 0 ? exact : wanted === "" ? [] : titled.filter((card) => card.title?.toLowerCase().includes(wanted))
  const [only, ...rest] = found
  if (only === undefined) return Effect.fail(new NoSuchSession({ to }))
  if (rest.length > 0)
    return Effect.fail(new AmbiguousTitle({ to, matches: found.slice(0, NAMED).map((card) => ({ id: card.id, title: nameOf(card) })) }))
  return Effect.succeed(only)
}

/** `target`, unless it is the sender's own session. */
export const notSelf = (target: SessionCard, sender: string): Effect.Effect<SessionCard, SelfAddressed> =>
  target.id === sender ? Effect.fail(new SelfAddressed({ sessionID: sender })) : Effect.succeed(target)
