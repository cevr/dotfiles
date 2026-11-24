import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Layer, Option, Schema } from "effect"
import { Notifier, type WakeLetter } from "../service.ts"

const SessionID = Schema.String.check(Schema.isStartingWith("ses")).pipe(Schema.brand("SessionID"))
const decodeSessionID = Schema.decodeUnknownOption(SessionID)

/** OpenCode plugin-context implementation of Notifier. */
export const fromContext = (
  ctx: Plugin.Context,
  emitChanged: (sessionID: string) => Effect.Effect<void>,
) =>
  Layer.succeed(
    Notifier,
    Notifier.of({
      wake: Effect.fn("OpenCodeNotifier.wake")(function* (sessionID: string, letter: WakeLetter) {
        const parsed = decodeSessionID(sessionID)
        if (Option.isNone(parsed)) return
        yield* ctx.session
          .synthetic({
            sessionID: parsed.value,
            text: letter.text,
            description: letter.description,
            metadata: { ...letter.metadata, letterId: letter.id },
            delivery: "steer",
            resume: true,
          })
          .pipe(Effect.ignore)
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
