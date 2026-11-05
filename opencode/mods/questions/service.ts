// The contracts the questions need from outside: somewhere to keep each
// session's sheet, and a way to hand an answer to a session. What every
// implementation owes is in laws.ts.
import { Context, type Effect, Schema } from "effect"
import type { Sheet } from "./question.ts"
import type { Letter } from "./reply.ts"

/** A session's stored sheet exists but could not be read. */
export class QuestionsUnreadable extends Schema.TaggedError<QuestionsUnreadable>()("QuestionsUnreadable", { message: Schema.String }) {}

/** The host would not take the answer into the session; `gone` when the session no longer exists. */
export class DeliveryRefused extends Schema.TaggedError<DeliveryRefused>()("DeliveryRefused", {
  sessionID: Schema.String,
  message: Schema.String,
  gone: Schema.Boolean,
}) {}

/**
 * Each session's sheet, keyed by its session id. A session with none reads as
 * `EMPTY`; a write replaces it whole; `remove` forgets it, and removing none is
 * no failure; `sessions` lists the sessions that have one, so the answers a
 * restart left unsent can be found.
 */
export class QuestionStore extends Context.Service<
  QuestionStore,
  {
    readonly read: (sessionID: string) => Effect.Effect<Sheet, QuestionsUnreadable>
    readonly write: (sessionID: string, sheet: Sheet) => Effect.Effect<void>
    readonly remove: (sessionID: string) => Effect.Effect<void>
    readonly sessions: Effect.Effect<ReadonlyArray<string>>
  }
>()("dotfiles-opencode/questions/QuestionStore") {}

/**
 * The way into a session.
 * - `newDelivery`: an id for one answer's message, minted before it is sent.
 *   Ids are distinct, and later ones sort after earlier ones.
 * - `deliver`: the letter into the session as a message under that id: a steer
 *   a running session reads at its next step, and an idle one wakes to read.
 *   Delivering an id twice puts one message in the session. A session that
 *   does not exist refuses with `gone`.
 */
export class Courier extends Context.Service<
  Courier,
  {
    readonly newDelivery: Effect.Effect<string>
    readonly deliver: (sessionID: string, delivery: string, letter: Letter) => Effect.Effect<void, DeliveryRefused>
  }
>()("dotfiles-opencode/questions/Courier") {}

/** Word that a session's questions changed, so whatever shows them reads again. */
export class Changes extends Context.Service<Changes, { readonly changed: (sessionID: string) => Effect.Effect<void> }>()(
  "dotfiles-opencode/questions/Changes",
) {}
