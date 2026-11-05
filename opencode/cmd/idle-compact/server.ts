/**
 * Idle compaction as an OpenCode server plugin, Claude Code's compaction
 * before the prompt cache expires ported. The composition root: it decodes the
 * options, builds the idle compactor (`@dotfiles/opencode-idle-compact/model`)
 * on OpenCode's sessions, and feeds it the host's hooks and events.
 *
 * While the cache is warm, compacting reads the long prefix from cache; once
 * it expires the next message writes the whole context again at the
 * cache-write rate. So a large main session that has gone idle compacts
 * shortly before its cache expires, through OpenCode's own compaction
 * (`session.compact`), and the next message starts from a short summary.
 * `@dotfiles/opencode-idle-compact/idle` has the rule, `.../cache` the
 * providers' lifetimes.
 *
 * - `model.request` (any request but a title's): the cache's last refresh;
 *   the session's timer is cancelled.
 * - `session.inbox.enqueued`, `session.execution.started`: the timer is cancelled.
 * - `experimental.idle`: the background work still running as the session goes idle.
 * - `session.execution.succeeded`/`failed`/`interrupted`: decide, set the timer.
 * - `session.deleted`: the session is forgotten. Disposing the plugin ends every timer.
 * - At start: the recent main sessions, idle before the plugin ran, are decided.
 *
 * The compaction is OpenCode's requested one (an inbox item the runner runs),
 * asked for with `reason: "auto"` so the compaction message records it as
 * automatic; a host without the fork's `reason` records `manual`
 * (`@dotfiles/opencode-idle-compact/opencode/sessions`). Orchestrate's
 * `compaction` hook still adds what every compaction keeps.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `ttlSeconds`: a cache lifetime for every model, over the providers' own; default none.
 * - `shortMarginSeconds`: how long before a cache of five minutes or less expires to compact; default 60.
 * - `longMarginSeconds`: the same for a longer cache; default 300.
 * - `thresholdRatio`, `thresholdTokens`: compact only when the last request's prompt is above
 *   this share of the model's window or this many tokens, whichever is smaller; default 0.3 and 60000.
 * - `subagents`: true lets a subagent's session compact too; default false.
 */
import { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import * as Model from "@dotfiles/opencode-idle-compact/model"
import * as OpenCodeSessions from "@dotfiles/opencode-idle-compact/opencode/sessions"
import type { Policy } from "@dotfiles/opencode-idle-compact/idle"
import type { Sessions } from "@dotfiles/opencode-idle-compact/service"

/**
 * An option that takes `fallback` when absent. A present value must decode.
 * `undefined` counts as absent: a host passing options in-process leaves an
 * unset one undefined, and a JSON config cannot write it.
 */
const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const Positive = Schema.Number.check(Schema.isGreaterThan(0))

export const Options = Schema.Struct({
  ttlSeconds: Schema.optional(Positive),
  shortMarginSeconds: NonNegative.pipe(withDefault(60)),
  longMarginSeconds: NonNegative.pipe(withDefault(300)),
  thresholdRatio: Positive.pipe(withDefault(0.3)),
  thresholdTokens: NonNegative.pipe(withDefault(60_000)),
  subagents: Schema.Boolean.pipe(withDefault(false)),
})
export type Options = typeof Options.Type

/** The compactor's policy from the options. */
export const policyOf = (options: Options): Policy => ({
  ttl: options.ttlSeconds === undefined ? Option.none() : Option.some(options.ttlSeconds * 1_000),
  margins: { short: options.shortMarginSeconds * 1_000, long: options.longMarginSeconds * 1_000 },
  ratio: options.thresholdRatio,
  cap: options.thresholdTokens,
  subagents: options.subagents,
})

/** The outside systems the compactor runs on. */
export type Externals = Sessions

/** The outside systems as OpenCode provides them. */
export const live = (ctx: Plugin.Context): Layer.Layer<Externals> => OpenCodeSessions.fromContext(ctx)

const WAKES = ["session.inbox.enqueued", "session.execution.started"] as const
const ENDS = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] as const

/** The plugin on `externals`: the live sessions in OpenCode, a stand-in host's in the seam test. */
export const make = (externals: (ctx: Plugin.Context, options: Options) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.idle-compact",
    effect: Effect.fn("IdleCompact.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.idle-compact: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      const services = yield* Layer.build(Model.layer(policyOf(options)).pipe(Layer.provide(externals(ctx, options))))
      const compactor = Context.get(services, Model.IdleCompactor)

      // A title request runs on its own small prompt and leaves the session's cache as it was.
      yield* ctx.session.hook("model.request", (event) => (event.kind === "title" ? Effect.void : compactor.requestStarted(event.sessionID)))
      yield* ctx.session.hook("experimental.idle", (event) =>
        compactor.background(
          event.sessionID,
          event.background.map((job) =>
            job.kind === "subagent" ? `subagent ${job.agent}: ${job.description}` : job.kind === "shell" ? `shell ${job.command}` : `image ${job.path}`,
          ),
        ),
      )

      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: [...WAKES, ...ENDS, "session.deleted"] }).pipe(
          Stream.runForEach((event) => {
            const sessionID: string = event.data.sessionID
            if (event.type === "session.deleted") return compactor.forget(sessionID)
            if ((ENDS as ReadonlyArray<string>).includes(event.type)) return compactor.settled(sessionID)
            return compactor.woke(sessionID)
          }),
          Effect.ignoreCause,
        ),
      )
      yield* Effect.forkScoped(compactor.resume)
    }),
  })

export default make(live)
