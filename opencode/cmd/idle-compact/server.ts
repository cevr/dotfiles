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
 * - `experimental.idle`: the background work still running as the session
 *   goes idle, logged with the decision. It does not hold the timer back: its
 *   notice would wake the session after the cache expired, so the session
 *   compacts on time, and a notice that comes first cancels the timer.
 * - `session.execution.succeeded`/`failed`/`interrupted`: decide, set the timer.
 * - `session.deleted`: the session is forgotten. Disposing the plugin ends every timer.
 * - At start, and on `provider.updated`, `model.updated` or `agent.updated`, once
 *   the catalog has been quiet for `SETTLE`: the recent main sessions are decided
 *   (again). A session's lifetime comes from the catalog's settings, which a
 *   reload rebuilds: OpenCode loads its config plugins after ours
 *   (packages/core/src/plugin/internal.ts `post`), so while it reloads ours, a
 *   provider reads without its configured `cache.ttl` and the lifetime falls back
 *   to the provider's default (5 minutes for Anthropic instead of the config's
 *   hour). Waiting for the catalog to settle keeps the first look out of that
 *   window, and the catalog's events, published once the reload is applied
 *   (packages/core/src/state.ts `batch`), correct any decision made in it.
 *
 * It compacts only when compacting costs less than letting the cache expire,
 * at the model's catalog prices (`.../price`), and not again after a
 * compaction until a request beyond the first on top of its summary.
 *
 * OpenCode runs a copy of the plugin for each location (directory and
 * workspace) it serves. Every copy hears every session's events, but a
 * session's hooks reach only its own location's copy, so that copy alone
 * decides for it (`Sessions.serves`); the others drop it without a word.
 *
 * Each decision is logged: scheduled, compacting, or not and why, with what
 * compacting costs and avoids; at info, but at debug for a session that could not
 * compact whatever its cache (no request, too small, uncached) or sits at or
 * below the threshold.
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
import { Context, Duration, Effect, Layer, Option, Queue, Schema, Stream } from "effect"
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
/** The catalog changed: a model's or provider's settings, or an agent's, which name a request's cache lifetime. */
const CATALOG = ["provider.updated", "model.updated", "agent.updated"] as const
/** How long the catalog stays quiet before the recent sessions are decided: a reload publishes a burst of changes. */
export const SETTLE = Duration.seconds(2)

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

      // The start, then each catalog change: the recent sessions are decided once they stop coming.
      const looks = yield* Queue.unbounded<"resume" | "catalog">()
      // Subscribed before the first look, so a change published after it is not missed.
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: [...WAKES, ...ENDS, "session.deleted", ...CATALOG] }).pipe(
          Stream.runForEach((event) => {
            if (event.type === "provider.updated" || event.type === "model.updated" || event.type === "agent.updated")
              return Queue.offer(looks, "catalog")
            const sessionID: string = event.data.sessionID
            if (event.type === "session.deleted") return compactor.forget(sessionID)
            if ((ENDS as ReadonlyArray<string>).includes(event.type)) return compactor.settled(sessionID)
            return compactor.woke(sessionID)
          }),
          Effect.ignoreCause,
        ),
        { startImmediately: true },
      )
      yield* Queue.offer(looks, "resume")
      // The first look is the start's even when a change came within its settle; later ones are the catalog's.
      let started = false
      yield* Effect.forkScoped(
        Stream.fromQueue(looks).pipe(
          Stream.debounce(SETTLE),
          Stream.runForEach(() => {
            const trigger = started ? "catalog" : "resume"
            started = true
            return compactor.resume(trigger)
          }),
        ),
      )
    }),
  })

export default make(live)
