/**
 * Auto-title as an OpenCode server plugin. The composition root: it decodes
 * the options, builds the handlers (`@dotfiles/opencode-auto-title/model`) on
 * OpenCode's sessions and the plugin's storage, and feeds them the host's
 * hooks and events.
 *
 * OpenCode names a root session once, from its first message. A long session
 * (an orchestrator's above all) moves on from that request, so as it goes idle
 * its title is generated again through OpenCode's own title path (the one
 * `/rename` with no argument takes: the original request and the recent
 * conversation) once `afterMinutes` and `afterTurns` have both passed since
 * its last title, and after a compaction with a turn since its last title.
 * `@dotfiles/opencode-auto-title/retitle` has the rule.
 *
 * - `session.execution.succeeded`: a turn ended; decide.
 *   `session.execution.failed`/`interrupted`: decide (no turn).
 * - `session.compaction.ended`: decide, a compaction counting.
 * - The `title` hook: the host is generating the session's title. For a
 *   pinned session that is the owner's `/rename` with no argument: unpinned.
 * - `execute.before` of `opencode_session_rename`: an agent is renaming a
 *   session to that title, which does not pin.
 * - `session.renamed`: generated (a title request ran for it within
 *   `MARK_MS`), an agent's, or else the owner's (`/rename <text>`, the TUI's
 *   dialog), which pins the session: no automatic title until the owner runs
 *   `/rename` with no argument.
 * - `session.deleted`: the session is forgotten.
 *
 * Subagents' sessions are never retitled: their titles are role lines. A busy
 * session waits for its next idle. One title request runs at a time on the
 * host (the copies share one lock on `globalThis`), each on its own fiber, and
 * a failed one is logged at debug and leaves the old title.
 *
 * OpenCode runs a copy of the plugin for each location it serves. Every copy
 * hears every session's events, but a session's hooks reach only its own
 * location's copy, which alone decides for it.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `afterMinutes`: how long after the last title; default 30.
 * - `afterTurns`: how many turns after the last title; default 6.
 */
import { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Schema, Scope, Semaphore, Stream } from "effect"
import * as Model from "@dotfiles/opencode-auto-title/model"
import * as OpenCodeSessions from "@dotfiles/opencode-auto-title/opencode/sessions"
import * as OpenCodeTracks from "@dotfiles/opencode-auto-title/opencode/tracks"
import type { Policy } from "@dotfiles/opencode-auto-title/retitle"
import type { Sessions, Tracks } from "@dotfiles/opencode-auto-title/service"

const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const Options = Schema.Struct({
  afterMinutes: NonNegative.pipe(withDefault(30)),
  afterTurns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(withDefault(6)),
})
export type Options = typeof Options.Type

export const policyOf = (options: Options): Policy => ({ afterMs: options.afterMinutes * 60_000, afterTurns: options.afterTurns })

/** The outside systems the handlers run on. */
export type Externals = Sessions | Tracks

/** The outside systems as OpenCode provides them. */
export const live = (ctx: Plugin.Context): Layer.Layer<Externals> => Layer.merge(OpenCodeSessions.fromContext(ctx), OpenCodeTracks.fromContext(ctx))

/** The host's one title request at a time, shared by every copy of the plugin in the process. */
const LOCK = Symbol.for("dotfiles-opencode.auto-title.lock")
const hostLock = (): Semaphore.Semaphore => {
  const shared: Record<symbol, Semaphore.Semaphore> = globalThis
  shared[LOCK] ||= Semaphore.makeUnsafe(1)
  return shared[LOCK]
}

/** The agent's rename tool, as the registry names it. */
const RENAME_TOOL = "opencode_session_rename"
const RenameInput = Schema.Struct({ sessionID: Schema.optional(Schema.String), title: Schema.String })
const decodeRename = Schema.decodeUnknownOption(RenameInput)

/** The plugin's options do not decode. */
class InvalidOptions extends Schema.TaggedError<InvalidOptions>()("InvalidOptions", { message: Schema.String }) {}

const ENDS = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] as const

export const make = (externals: (ctx: Plugin.Context) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.auto-title",
    effect: Effect.fn("AutoTitle.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new InvalidOptions({ message: `dotfiles-opencode.auto-title: invalid options: ${error.message}` })),
        Effect.orDie,
      )
      const scope = yield* Scope.Scope
      const services = yield* Layer.build(Model.layer(policyOf(options), hostLock(), scope).pipe(Layer.provide(externals(ctx))))
      const titles = Context.get(services, Model.AutoTitle)

      yield* ctx.session.hook("title", (event) => titles.generating(event.sessionID))
      yield* ctx.tool.hook("execute.before", (event) => {
        if (event.tool !== RENAME_TOOL) return Effect.void
        const input = decodeRename(event.input)
        if (input._tag === "None") return Effect.void
        return titles.agentRenaming(input.value.sessionID ?? event.sessionID, input.value.title.trim())
      })

      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: [...ENDS, "session.compaction.ended", "session.renamed", "session.deleted"] }).pipe(
          Stream.runForEach((event) => {
            const sessionID: string = event.data.sessionID
            switch (event.type) {
              case "session.renamed":
                return titles.renamed(sessionID, event.data.title)
              case "session.compaction.ended":
                return titles.compacted(sessionID)
              case "session.deleted":
                return titles.forget(sessionID)
              case "session.execution.succeeded":
                return titles.replied(sessionID)
              default:
                return titles.stopped(sessionID)
            }
          }),
          Effect.ignoreCause,
        ),
        { startImmediately: true },
      )
    }),
  })

export default make(live)
