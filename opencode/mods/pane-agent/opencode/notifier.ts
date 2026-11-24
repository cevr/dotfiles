import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Layer, Option, Schema } from "effect"
import { Notifier, WakeFailed, type WakeLetter } from "../service.ts"

const SessionID = Schema.String.check(Schema.isStartingWith("ses")).pipe(Schema.brand("SessionID"))
const MessageID = Schema.String.check(Schema.isStartingWith("msg")).pipe(Schema.brand("Session.Message.ID"))
const decodeSessionID = Schema.decodeUnknownOption(SessionID)
const decodeMessageID = Schema.decodeUnknownOption(MessageID)

/** OpenCode plugin-context implementation of Notifier with idempotent delivery ids and error propagation. */
export const fromContext = (
  ctx: Plugin.Context,
  emitChanged: (sessionID: string) => Effect.Effect<void>,
) =>
  Layer.succeed(
    Notifier,
    Notifier.of({
      wake: Effect.fn("OpenCodeNotifier.wake")(function* (sessionID: string, letter: WakeLetter) {
        const parsedSession = decodeSessionID(sessionID)
        if (Option.isNone(parsedSession)) {
          return yield* new WakeFailed({
            sessionID,
            deliveryId: letter.id,
            message: `Invalid OpenCode session id: ${sessionID}`,
          })
        }
        const parsedMessage = decodeMessageID(letter.id)
        if (Option.isNone(parsedMessage)) {
          return yield* new WakeFailed({
            sessionID,
            deliveryId: letter.id,
            message: `Invalid OpenCode message id: ${letter.id}`,
          })
        }
        yield* ctx.session
          .synthetic({
            sessionID: parsedSession.value,
            id: parsedMessage.value,
            text: letter.text,
            description: letter.description,
            metadata: { ...letter.metadata, letterId: letter.id },
            delivery: "steer",
            resume: true,
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new WakeFailed({
                  sessionID,
                  deliveryId: letter.id,
                  message: String(cause),
                }),
            ),
          )
      }),
      changed: Effect.fn("OpenCodeNotifier.changed")(function* (sessionID: string) {
        yield* emitChanged(sessionID).pipe(Effect.ignore)
      }),
      sessionDirectory: Effect.fn("OpenCodeNotifier.sessionDirectory")(function* (sessionID: string) {
        const parsed = decodeSessionID(sessionID)
        if (Option.isNone(parsed)) return Option.none<string>()
        return yield* ctx.session.get({ sessionID: parsed.value }).pipe(
          Effect.map((info) => Option.some(info.location.directory)),
          Effect.orElseSucceed(() => Option.none<string>()),
        )
      }),
    }),
  )
