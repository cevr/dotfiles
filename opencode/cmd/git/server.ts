/**
 * The git mod's server half: an OpenCode server plugin answering the git RPC
 * (`@dotfiles/opencode-git/git`) the sidebar's Git section and the /git pane
 * read. The composition root: it builds the git model
 * (`@dotfiles/opencode-git/model`) on OpenCode's sessions (its `opencode/`
 * implementation) and on git, `gh` and PATH (its `process/` implementations),
 * and registers the RPC. The TUI runs no program to read the checkout.
 *
 * Each call names a session; the model reads the checkout at that session's
 * location now, so a session that moves is read where it is. `gh` and hunk
 * are optional programs: without `gh` there is no pull request, without hunk a
 * review pages git's diff.
 *
 * The plugin takes no options.
 */
import { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { GIT, ReviewQuery, SessionQuery } from "@dotfiles/opencode-git/git"
import * as Model from "@dotfiles/opencode-git/model"
import * as OpenCodeSessionDirectories from "@dotfiles/opencode-git/opencode/session-directories"
import * as GitCheckouts from "@dotfiles/opencode-git/process/checkouts"
import * as PathPrograms from "@dotfiles/opencode-git/process/programs"
import * as GhPullRequests from "@dotfiles/opencode-git/process/pull-requests"
import type { Checkouts, Programs, PullRequests, SessionDirectories } from "@dotfiles/opencode-git/service"

/** The outside systems the model runs on. */
export type Externals = SessionDirectories | Checkouts | PullRequests | Programs

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

type Env = Readonly<Record<string, string | undefined>>

/** The outside systems as OpenCode and the programs on `env`'s PATH provide them. */
export const live = (ctx: Plugin.Context, env: Env = process.env): Layer.Layer<Externals> =>
  Layer.mergeAll(
    OpenCodeSessionDirectories.layer((sessionID) =>
      ctx.session.get({ sessionID: sessionID as SessionID }).pipe(Effect.map((session) => session.location.directory)),
    ),
    GitCheckouts.layer(env),
    GhPullRequests.layer(env),
    PathPrograms.layer(env),
  )

const decodeSession = Schema.decodeUnknownOption(SessionQuery)
const decodeReview = Schema.decodeUnknownOption(ReviewQuery)

/** The plugin on `externals`: the live systems in OpenCode, other layers in the seam test. */
export const make = (externals: (ctx: Plugin.Context) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.git",
    effect: Effect.fn("Git.plugin")(function* (ctx) {
      const services = yield* Layer.build(Model.layer.pipe(Layer.provide(externals(ctx))))
      const git = Context.get(services, Model.Git)
      // The host checks each input against the definition's schema first, so
      // a question that does not decode here is answered, not failed.
      const unasked = "the question names no session"
      // Each call reads afresh: the answer says what could not be read rather
      // than failing. An RPC that cannot be registered stops the plugin.
      yield* ctx.rpc
        .register(GIT, {
          checkout: (input) =>
            Option.match(decodeSession(input), { onNone: () => Effect.succeed({ error: unasked }), onSome: (query) => git.checkout(query.sessionID) }),
          pullRequest: (input) =>
            Option.match(decodeSession(input), { onNone: () => Effect.succeed({ note: unasked }), onSome: (query) => git.pullRequest(query.sessionID) }),
          review: (input) =>
            Option.match(decodeReview(input), {
              onNone: () => Effect.succeed({ note: unasked }),
              onSome: (query) => git.review(query.sessionID, query.path),
            }),
        })
        .pipe(Effect.orDie)
    }),
  })

export default make(live)
