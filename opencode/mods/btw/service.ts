// The contracts the btw model needs from outside, with their failures: the
// host's sessions (fork one, name it, ask it, bring a message into one), what
// a fork reads as now, and where each session's side question is kept. What
// every implementation owes is in laws.ts.
import { Context, type Effect, Schema } from "effect"
import type { OpenFork, SideQuestionState } from "./side-question.ts"
import type { Turn } from "./turns.ts"

/** The host refused or failed one operation on a session. */
export class HostFailed extends Schema.TaggedError<HostFailed>()("HostFailed", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** A fork the host made. */
export interface MadeFork {
  readonly sessionID: string
  /** When the host made it, epoch ms. */
  readonly createdAt: number
}

/** A synthetic message for a session's model, shown as a notice row. */
export interface Notice {
  /** Its message id: the host admits one message per id, the first time. */
  readonly id: string
  readonly text: string
  readonly description: string
}

/** The host's sessions, as the side question uses them. */
export class Forks extends Context.Service<
  Forks,
  {
    /**
     * A new session holding the session's settled history, run by the
     * session's agent and model. The session itself is not touched.
     */
    readonly fork: (sessionID: string) => Effect.Effect<MadeFork, HostFailed>
    /** Titles a session. */
    readonly name: (sessionID: string, title: string) => Effect.Effect<void, HostFailed>
    /**
     * Asks a session a question: `note`, when given, as a message only its
     * model reads, then `question` as the reader's prompt, which starts its turn.
     */
    readonly ask: (sessionID: string, note: string | undefined, question: string) => Effect.Effect<void, HostFailed>
    /** Brings a notice into a session: a running turn reads it at its next step; an idle session wakes on it. */
    readonly bringBack: (sessionID: string, notice: Notice) => Effect.Effect<void, HostFailed>
  }
>()("dotfiles-opencode/btw/Forks") {}

/** A fork as it reads now. */
export interface Reading {
  readonly turns: ReadonlyArray<Turn>
  /** The fork is answering now. */
  readonly replying: boolean
}

/** What each fork says. */
export class ForkReadings extends Context.Service<
  ForkReadings,
  {
    /** The fork's own exchanges (what came after the history it copied) and whether it replies now. */
    readonly read: (fork: OpenFork) => Effect.Effect<Reading>
  }
>()("dotfiles-opencode/btw/ForkReadings") {}

/** Each session's side question, kept across restarts. */
export class SideQuestions extends Context.Service<
  SideQuestions,
  {
    /** The session's side question; the initial state for a session that has none. */
    readonly get: (sessionID: string) => Effect.Effect<SideQuestionState>
    readonly set: (sessionID: string, state: SideQuestionState) => Effect.Effect<void, HostFailed>
  }
>()("dotfiles-opencode/btw/SideQuestions") {}
