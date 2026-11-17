/**
 * The Prime look's server plugin (`dotfiles-opencode.prime`): it teaches a
 * root session the chips the TUI half draws (`guidance` in
 * `@dotfiles/opencode-prime/emphasis`, the same table that draws them).
 *
 * - The `context`, `compaction` and `generate` hooks (every request that sends
 *   the session's conversation) add the section to the system prompt, the same
 *   bytes on every request of the session, so the cached prefix holds. A title
 *   request, on a prompt of its own, gets none.
 * - Who gets it, and which words, is decided once per session at its first
 *   sighting and kept in the plugin's storage (`@dotfiles/opencode-prime/reply-style`):
 *   a root session whose first request the plugin sees gets it; a subagent,
 *   and a session that began before the plugin (its context already holds an
 *   answer), get none, so an install rewrites no live session's prompt.
 * - `scripts/daily.ts` lists it before memory, whose digest stays last.
 * - A deleted session's entry goes.
 *
 * Options: `rules` (default true); `false` sends the section to no session.
 */
import { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { guidance } from "@dotfiles/opencode-prime/emphasis"
import * as OpenCodeReplyStyles from "@dotfiles/opencode-prime/opencode/reply-style"
import { ReplyStyles, sectionOf, type Sighting } from "@dotfiles/opencode-prime/reply-style"

/** A session's id, as the hooks give it and the host's session calls take it. */
type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

/** The plugin's options do not decode: a mistake in the config, so the plugin does not start, and says which. */
export class InvalidOptions extends Schema.TaggedError<InvalidOptions>()("InvalidOptions", { message: Schema.String }) {}

export const Options = Schema.Struct({
  rules: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(true))),
})
export type Options = typeof Options.Type

/** What a session's first sighting reads of the host: whether it has a parent, and whether its context holds an answer. */
export const sightingOf = (ctx: Plugin.Context, sessionID: SessionID): Effect.Effect<Sighting, unknown> =>
  Effect.gen(function* () {
    const session = yield* ctx.session.get({ sessionID })
    if (Option.isSome(Option.fromNullishOr(session.parentID))) return { child: true, answered: false }
    const messages = yield* ctx.session.context({ sessionID })
    return { child: false, answered: messages.some((message) => message.type === "assistant" || message.type === "compaction") }
  })

/**
 * The plugin on `styles` (the plugin's storage in OpenCode and in the seam test), teaching the section `words` writes
 * when a copy starts (`guidance`; the seam test changes it to show a live session keeps the words it began with).
 */
export const make = (styles: (ctx: Plugin.Context) => Layer.Layer<ReplyStyles>, words: () => string = guidance) =>
  Plugin.define({
    id: "dotfiles-opencode.prime",
    effect: Effect.fn("Prime.plugin")(function* (ctx) {
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options ?? {}).pipe(
        Effect.mapError((error) => new InvalidOptions({ message: `dotfiles-opencode.prime: invalid options: ${error.message}` })),
        Effect.orDie,
      )
      if (!options.rules) return
      const services = yield* Layer.build(styles(ctx))
      const kept = Context.get(services, ReplyStyles)
      const text = words()

      // Pushed where the hook runs, before memory's digest (daily lists Prime first), so the digest stays last.
      const withSection = (event: { readonly sessionID: SessionID; readonly system: Array<{ type: "text"; text: string }> }) =>
        sectionOf(event.sessionID, sightingOf(ctx, event.sessionID), text).pipe(
          Effect.provideService(ReplyStyles, kept),
          Effect.map((section) => {
            if (section !== "") event.system.push({ type: "text", text: section })
          }),
          Effect.catchCause((cause) => Effect.logWarning("prime: no reply style for the session", { sessionID: event.sessionID, cause })),
        )
      yield* ctx.session.hook("context", withSection)
      yield* ctx.session.hook("compaction", withSection)
      yield* ctx.session.hook("generate", withSection)

      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["session.deleted"] }).pipe(
          Stream.runForEach((event) => kept.forget(event.data.sessionID)),
          Effect.ignoreCause,
        ),
      )
    }),
  })

/** The plugin's storage, as the kept sections use it. */
export const live = (ctx: Plugin.Context) => OpenCodeReplyStyles.layer(ctx.storage)

export default make(live)
