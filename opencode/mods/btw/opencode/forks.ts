// Forks over OpenCode's session API, as the TUI plugin's client calls it
// (packages/client/src/promise/generated/client.ts, the `session` group):
//
// - fork: `session.fork` (packages/core/src/session.ts:340-386). The new
//   session copies the session's settled history (a running turn stays
//   behind, packages/core/src/session/projector.ts:203-206) and its title,
//   agent, model and metadata; its `fork` names the source and it has no
//   parent, so it is a session of its own, not a child. The host fails it with
//   ForkEmptyError for a session with no messages.
// - name: `session.update` with a title.
// - ask: the note, when there is one, as `session.synthetic` with no
//   description and `resume: false` (a hidden message, admitted without
//   waking the session: the prompt composer's own way to send editor context,
//   packages/tui/src/component/prompt/index.tsx:1351-1357), then
//   `session.prompt`, which starts the turn.
// - bringBack: `session.synthetic` delivered as a steer with `resume: true`:
//   a running turn reads it at its next step; an idle session wakes on it.
//
// Every refusal is a HostFailed naming the operation, with the host's message.
import { Effect, Layer } from "effect"
import { Forks, HostFailed } from "../service.ts"

/** The part of OpenCode's session client the side question uses. */
export interface Sessions {
  readonly fork: (input: { readonly sessionID: string }) => Promise<{ readonly id: string; readonly time: { readonly created: number } }>
  readonly update: (input: { readonly sessionID: string; readonly title: string }) => Promise<unknown>
  readonly prompt: (input: { readonly sessionID: string; readonly text: string }) => Promise<unknown>
  readonly synthetic: (input: {
    readonly sessionID: string
    readonly id?: string
    readonly text: string
    readonly description?: string
    readonly delivery?: "steer" | "queue"
    readonly resume: boolean
  }) => Promise<unknown>
}

/** The host's message for a failure: the client's errors carry one, a few nest it under `data`. */
export const messageOf = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null) {
    if ("message" in cause && typeof cause.message === "string" && cause.message.length > 0) return cause.message
    if ("data" in cause && typeof cause.data === "object" && cause.data !== null && "message" in cause.data && typeof cause.data.message === "string")
      return cause.data.message
    if ("_tag" in cause && typeof cause._tag === "string") return cause._tag
  }
  return String(cause)
}

const call = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new HostFailed({ operation, message: messageOf(cause) }) })

export const layer = (sessions: Sessions) =>
  Layer.succeed(
    Forks,
    Forks.of({
      fork: (sessionID) =>
        call("fork", () => sessions.fork({ sessionID })).pipe(Effect.map((made) => ({ sessionID: made.id, createdAt: made.time.created }))),
      name: (sessionID, title) => call("name", () => sessions.update({ sessionID, title })).pipe(Effect.asVoid),
      ask: (sessionID, note, question) =>
        (note === undefined ? Effect.void : call("ask", () => sessions.synthetic({ sessionID, text: note, resume: false }))).pipe(
          Effect.andThen(call("ask", () => sessions.prompt({ sessionID, text: question }))),
          Effect.asVoid,
        ),
      bringBack: (sessionID, notice) =>
        call("bringBack", () =>
          sessions.synthetic({ sessionID, id: notice.id, text: notice.text, description: notice.description, delivery: "steer", resume: true }),
        ).pipe(Effect.asVoid),
    }),
  )
