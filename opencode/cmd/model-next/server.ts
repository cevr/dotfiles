/**
 * A model switch queued for the next compaction, the server half: the
 * composition root of `@dotfiles/opencode-model-next`. It decodes the options,
 * builds the handlers (`/model`) on OpenCode's sessions (`/opencode/sessions`),
 * and feeds them the host's RPC, its two awaited hooks and its model-selection
 * event.
 *
 * - RPC `queue({ sessionID, model })`, `cancel({ sessionID })`, `show({ sessionID })`
 *   (`MODEL_NEXT` in `/pending`): the TUI's `/model-next` command and model
 *   picker action, `cmd/model-next/cli.ts` and an agent through it.
 * - `experimental.compaction.ended`: a completed compaction applies the queued
 *   switch before the next request is built; the outgoing model wrote the summary.
 * - `experimental.wake`: an execution starting on input applies it once the
 *   cache the last request wrote has expired (its start, plus its lifetime,
 *   plus `graceSeconds`). It does not run for a steer into a running turn, a
 *   continuation or restart recovery: none of those starts a request that
 *   writes a long context after the expiry anew, so a switch there would gain
 *   nothing over the next wake or compaction (the follow-up for a cache that
 *   expires during a long tool call is in the README).
 * - `session.model.selected`: a selection that moves the session off the model
 *   the switch was queued from drops it.
 *
 * Neither apply point is an event or a timer: a request could come between
 * (the Quint model, `mods/model-next/model_next.qnt`, `--main=evented`).
 *
 * Options (all optional; a malformed one stops the plugin):
 * - `ttlSeconds`: a cache lifetime for every model, over the providers' own (as idle compaction's); default none.
 * - `graceSeconds`: how long past the lifetime the cache counts as expired; default 60.
 */
import { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import * as Model from "@dotfiles/opencode-model-next/model"
import * as OpenCodeSessions from "@dotfiles/opencode-model-next/opencode/sessions"
import { GRACE_SECONDS, MODEL_NEXT, ModelRef, type Policy } from "@dotfiles/opencode-model-next/pending"
import type { Sessions } from "@dotfiles/opencode-model-next/service"

const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const Positive = Schema.Number.check(Schema.isGreaterThan(0))

export const Options = Schema.Struct({
  ttlSeconds: Schema.optional(Positive),
  graceSeconds: NonNegative.pipe(withDefault(GRACE_SECONDS)),
})
export type Options = typeof Options.Type

export const policyOf = (options: Options): Policy => ({
  ttl: options.ttlSeconds === undefined ? Option.none() : Option.some(options.ttlSeconds * 1_000),
  grace: options.graceSeconds * 1_000,
})

const QueueInput = Schema.Struct({ sessionID: Schema.String, model: ModelRef })
const SessionInput = Schema.Struct({ sessionID: Schema.String })
const Selected = Schema.Struct({ sessionID: Schema.String, model: ModelRef })

export type Externals = Sessions

export const live = (ctx: Plugin.Context): Layer.Layer<Externals> => OpenCodeSessions.fromContext(ctx)

export const make = (externals: (ctx: Plugin.Context) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: MODEL_NEXT.id,
    effect: Effect.fn("ModelNext.plugin")(function* (ctx) {
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`${MODEL_NEXT.id}: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      const services = yield* Layer.build(Model.layer(policyOf(options)).pipe(Layer.provide(externals(ctx))))
      const next = Context.get(services, Model.ModelNext)

      yield* ctx.session.hook("experimental.compaction.ended", (event) => next.compacted(event.sessionID))
      yield* ctx.session.hook("experimental.wake", (event) => next.woke(event.sessionID))

      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["session.model.selected"] }).pipe(
          Stream.runForEach((event) =>
            Schema.decodeUnknownEffect(Selected)(event.data).pipe(
              Effect.flatMap(({ sessionID, model }) => next.selected(sessionID, model)),
              Effect.ignore,
            ),
          ),
          Effect.ignoreCause,
        ),
        { startImmediately: true },
      )

      yield* ctx.rpc.register(MODEL_NEXT, {
        queue: (input) =>
          Schema.decodeUnknownEffect(QueueInput)(input).pipe(
            Effect.flatMap(({ sessionID, model }) => next.queue(sessionID, model)),
            Effect.orElseSucceed(() => ({ _tag: "Refused" as const, reason: "no-session" as const })),
          ),
        cancel: (input) =>
          Schema.decodeUnknownEffect(SessionInput)(input).pipe(
            Effect.flatMap(({ sessionID }) => next.cancel(sessionID)),
            Effect.orElseSucceed(() => ({ _tag: "Refused" as const, reason: "no-session" as const })),
          ),
        show: (input) =>
          Schema.decodeUnknownEffect(SessionInput)(input).pipe(
            Effect.flatMap(({ sessionID }) => next.show(sessionID)),
            Effect.orElseSucceed(() => ({})),
          ),
      }).pipe(Effect.orDie)
    }),
  })

export default make(live)
