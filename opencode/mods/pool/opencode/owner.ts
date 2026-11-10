// The owner, through the questions plugin's RPC (`dotfiles-opencode.questions`:
// `askFor`, `asked`, `withdrawFor`, and its `changed` event), as the pool
// plugin. A question goes to the root session of the start that waits, found
// by walking the host's sessions up their parents, so it shows in the tray
// the owner reads, beside the agents' own `ask_user_async` questions. Each
// answer is untyped JSON, checked here; a failure is no question, no answers.
import { Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import { Owner, type OwnerAnswer } from "../service.ts"

/** The plugin id the pool asks as: the questions it asked are read back under it. */
export const ASKER = "dotfiles-opencode.pool"

/** The questions RPC and the host's sessions, as the pool's plugin reaches them. */
export interface Host {
  readonly askFor: (input: {
    readonly sessionID: string
    readonly plugin: string
    readonly key: string
    readonly question: string
    readonly header: string
    readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>
    readonly assume: string
  }) => Effect.Effect<unknown, unknown>
  readonly asked: (input: { readonly plugin: string }) => Effect.Effect<unknown, unknown>
  readonly withdrawFor: (input: { readonly plugin: string; readonly key: string }) => Effect.Effect<unknown, unknown>
  /** The questions' `changed` events. */
  readonly changed: Stream.Stream<unknown, unknown>
  /** A session's parent, when it has one; a session the host does not have fails. */
  readonly parentOf: (sessionID: string) => Effect.Effect<string | undefined, unknown>
}

const decodeReply = Schema.decodeUnknownOption(Schema.Struct({ ok: Schema.Boolean }))
const decodeAsked = Schema.decodeUnknownOption(
  Schema.Struct({ questions: Schema.Array(Schema.Struct({ key: Schema.String, answer: Schema.optional(Schema.String) })) }),
)

/** How long a broken subscription waits before it subscribes again. */
const RESUBSCRIBE = "5 seconds"

/** The root of a session's tree; the session itself when the host cannot say more. */
const rootOf = (host: Host, sessionID: string) =>
  Effect.gen(function* () {
    const seen = new Set([sessionID])
    let current = sessionID
    for (;;) {
      const parent = yield* host.parentOf(current).pipe(Effect.orElseSucceed(() => undefined))
      if (parent === undefined || seen.has(parent)) return current
      seen.add(parent)
      current = parent
    }
  })

export const layer = (host: Host) =>
  Layer.succeed(Owner, {
    ask: (question) =>
      rootOf(host, question.sessionID).pipe(
        Effect.flatMap((root) => host.askFor({ ...question, sessionID: root, plugin: ASKER })),
        Effect.map((reply) => Option.match(decodeReply(reply), { onNone: () => false, onSome: ({ ok }) => ok })),
        Effect.orElseSucceed(() => false),
      ),
    answers: host.asked({ plugin: ASKER }).pipe(
      Effect.map((answer) =>
        Option.match(decodeAsked(answer), {
          onNone: () => undefined,
          onSome: ({ questions }) => questions.map((row): OwnerAnswer => ({ key: row.key, ...(row.answer === undefined ? {} : { answer: row.answer }) })),
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    ),
    withdraw: (key) => host.withdrawFor({ plugin: ASKER, key }).pipe(Effect.ignore),
    changes: host.changed.pipe(
      Stream.map(() => undefined),
      Stream.retry(Schedule.spaced(RESUBSCRIBE)),
      Stream.catchCause(() => Stream.empty),
    ),
  })
