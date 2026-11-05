// Latches over OpenCode: the wakes keep a latch (their `latch` RPC, mods/wake
// latch.ts), and a latched child starts through the subagent tool's own
// execute, which the plugin hands in. No wakes plugin, a failure, a timeout
// or an answer that is not one refuses the latch, and the call is denied
// instead. Opening comes back the other way, over `OPENER`, which the plugin
// serves.
import { Cause, Effect, Layer, Schema } from "effect"
import { type LatchAsk, Latched } from "@dotfiles/opencode-wake/latch"
import { LatchRefused, Latches, type LatchStart, StartFailed } from "../service.ts"

/** The wakes' `latch` method, as the plugin's RPC client calls it. */
export type Latch = (ask: LatchAsk) => Effect.Effect<unknown, unknown>

/** The latched child's start: the subagent tool, run in the background on the child. */
export type Start = (start: LatchStart) => Effect.Effect<void, unknown>

/** How long the wakes have to keep the latch: they make the child session too. */
const TIMEOUT = "15 seconds"

const decode = Schema.decodeUnknownOption(Latched)
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause))

export const layer = (latch: Latch, start: Start) =>
  Layer.succeed(Latches, {
    latch: (request) =>
      Effect.suspend(() =>
        latch({
          sessionID: request.parent,
          subagent: {
            agent: request.agent,
            description: request.description,
            prompt: request.prompt,
            ...(request.model === undefined ? {} : { model: request.model }),
            from: request.from,
            messageID: request.messageID,
            callID: request.callID,
          },
          hold: request.hold,
          reason: request.why,
          opensAt: request.opensAt,
          recheckAt: request.recheckAt,
          context: request.context,
        }),
      ).pipe(
        Effect.timeoutOption(TIMEOUT),
        Effect.catchCause((cause) => Effect.fail(new LatchRefused({ reason: `the wakes could not be asked: ${messageOf(Cause.squash(cause))}` }))),
        Effect.flatMap((answer) => {
          if (answer._tag === "None") return Effect.fail(new LatchRefused({ reason: "the wakes did not answer in time" }))
          const latched = decode(answer.value)
          if (latched._tag === "None") return Effect.fail(new LatchRefused({ reason: "the wakes' answer is not one" }))
          return latched.value.outcome === "latched"
            ? Effect.succeed({ id: latched.value.id, child: latched.value.child })
            : Effect.fail(new LatchRefused({ reason: latched.value.reason }))
        }),
      ),
    start: (request) =>
      Effect.suspend(() => start(request)).pipe(Effect.catchCause((cause) => Effect.fail(new StartFailed({ message: messageOf(Cause.squash(cause)) })))),
  })
