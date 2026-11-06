/**
 * The git mod's server half: an OpenCode server plugin answering the git RPC
 * (`@dotfiles/opencode-git/git`) the sidebar's Git section and the /git pane
 * read, and offering the `pr` tool with its watcher. The composition root: it
 * builds the git model (`@dotfiles/opencode-git/model`) and the pull requests
 * (`@dotfiles/opencode-git/pulls`) on OpenCode's sessions and storage (its
 * `opencode/` implementations) and on git, `gh` and PATH (its `process/`
 * implementations), registers the RPC and the tool, and runs the watcher.
 *
 * Each call names a session; the model reads the checkout at that session's
 * location now, so a session that moves is read where it is. `gh` and hunk
 * are optional programs: without `gh` there is no pull request, without hunk a
 * review pages git's diff.
 *
 * The `pr` tool (status, watch, unwatch, list, create) reads GitHub when it
 * is called. Its watcher is per machine: every directory's plugin in the
 * server process registers, and only the first one alive ticks, every
 * `intervalSeconds`; watches and followed repositories live in the plugin
 * storage every directory shares. A tick probes each watched repository with
 * conditional REST requests (free when nothing moved) and reads it in one
 * GraphQL call on a change or every `refreshSeconds`. There is no webhook
 * source; `Pulls.poke(repo)` is the seam one would call.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `intervalSeconds`: how often the watcher ticks; default 60.
 * - `refreshSeconds`: how often a watched repository is read in full even when its probes say nothing moved; default 300.
 * - `follow`: `owner/name` repositories whose default branch is followed whatever the tool was used on; default none.
 * - `reviewers`: owner (or `owner/name`) → the logins `create` asks for review; default biteinc's three.
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { GIT, ReviewQuery, SessionQuery } from "@dotfiles/opencode-git/git"
import * as Model from "@dotfiles/opencode-git/model"
import * as OpenCodeCourier from "@dotfiles/opencode-git/opencode/courier"
import * as OpenCodeSessionDirectories from "@dotfiles/opencode-git/opencode/session-directories"
import * as OpenCodeWatchStore from "@dotfiles/opencode-git/opencode/watch-store"
import { DESCRIPTION, PrInput } from "@dotfiles/opencode-git/pr"
import * as GitCheckouts from "@dotfiles/opencode-git/process/checkouts"
import * as GhGitHub from "@dotfiles/opencode-git/process/github"
import * as PathPrograms from "@dotfiles/opencode-git/process/programs"
import * as GhPullRequests from "@dotfiles/opencode-git/process/pull-requests"
import * as Pulls from "@dotfiles/opencode-git/pulls"
import type { Checkouts, Courier, GitHub, Programs, PullRequests, SessionDirectories, WatchStore } from "@dotfiles/opencode-git/service"

const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

/** The reviewers `create` asks when the config names none. */
export const DEFAULT_REVIEWERS: Readonly<Record<string, ReadonlyArray<string>>> = { biteinc: ["andrewgoupil", "antwandaher", "narminmolina"] }

const Seconds = Schema.Number.check(Schema.isGreaterThan(0))

export const Options = Schema.Struct({
  intervalSeconds: Seconds.pipe(withDefault(60)),
  refreshSeconds: Seconds.pipe(withDefault(300)),
  follow: Schema.Array(Schema.String).pipe(withDefault<ReadonlyArray<string>>([])),
  reviewers: Schema.Record(Schema.String, Schema.Array(Schema.String)).pipe(withDefault(DEFAULT_REVIEWERS)),
})
export type Options = typeof Options.Type

/** The outside systems the model and the pull requests run on. */
export type Externals = SessionDirectories | Checkouts | PullRequests | Programs | GitHub | WatchStore | Courier

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
    GhGitHub.layer(env),
    OpenCodeWatchStore.fromContext(ctx),
    OpenCodeCourier.fromContext(ctx),
  )

/**
 * The plugins of this process that could run the watcher, in the order they
 * started; the first one ticks. One is per directory's server, and they share
 * one storage, so one watcher serves them all; a plugin leaving hands it on.
 */
const WATCHERS = Symbol.for("dotfiles-opencode.git.watcher")
const watchers = (): Array<symbol> => {
  const global = globalThis as unknown as Record<symbol, Array<symbol> | undefined>
  return (global[WATCHERS] ??= [])
}

const decodeSession = Schema.decodeUnknownOption(SessionQuery)
const decodeReview = Schema.decodeUnknownOption(ReviewQuery)
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })

/** The plugin on `externals`: the live systems in OpenCode, other layers in the seam test. */
export const make = (externals: (ctx: Plugin.Context) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.git",
    effect: Effect.fn("Git.plugin")(function* (ctx) {
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options ?? {}).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.git: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      const settings: Pulls.Settings = { follow: options.follow, reviewers: options.reviewers, refreshMs: options.refreshSeconds * 1000 }
      const services = yield* Layer.build(Layer.merge(Model.layer, Pulls.layer(settings)).pipe(Layer.provide(externals(ctx))))
      const git = Context.get(services, Model.Git)
      const pulls = Context.get(services, Pulls.Pulls)
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

      yield* ctx.tool.transform((editor) => {
        // A direct tool beside the others, offered without code mode.
        editor.add({
          name: "pr",
          description: DESCRIPTION,
          input: PrInput,
          options: { codemode: false },
          execute: (input, context) =>
            pulls.run(context.sessionID, input).pipe(
              Effect.map(text),
              Effect.mapError((refusal) => new Tool.Error({ message: Pulls.refusalText(refusal), error: refusal })),
            ),
        })
      })

      const me = Symbol("git watcher")
      yield* Effect.acquireRelease(
        Effect.sync(() => watchers().push(me)),
        () =>
          Effect.sync(() => {
            const all = watchers()
            all.splice(all.indexOf(me), 1)
          }),
      )
      const pass = Effect.suspend(() => (watchers()[0] === me ? pulls.tick : Effect.void))
      yield* Effect.forkScoped(Effect.forever(pass.pipe(Effect.ignoreCause, Effect.andThen(Effect.sleep(`${options.intervalSeconds} seconds`)))))
    }),
  })

export default make(live)
