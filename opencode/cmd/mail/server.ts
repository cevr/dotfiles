/**
 * Session mail as an OpenCode server plugin. The composition root: it builds
 * mail's model (`@dotfiles/opencode-mail/model`) on OpenCode's sessions and
 * the hosts this one is paired with, and registers two direct tools, offered
 * to every session, main and subagent, and reached from a kernel cell as
 * `tools.sessions` and `tools.message`:
 *
 * - `sessions({ search?, children?, limit? })`: the sessions the caller may
 *   write to, this server's and each paired host's, marked `on <host>`
 *   (`@dotfiles/opencode-mail/directory`).
 * - `message({ to, text, wake?, replyTo? })`: a synthetic message into the
 *   session `to` names, under a header naming the sender and the session to
 *   answer (`@dotfiles/opencode-mail/letter`), delivered as a steer and waking
 *   an idle session unless `wake: false`. An id this server lacks goes to the
 *   paired hosts. Each delivery is logged at info.
 *
 * Options:
 * - `listen: { hostname, port? }`: run the mail listener
 *   (`@dotfiles/opencode-mail/http/listener`) on that one address (the host's
 *   Tailscale address; a wildcard is refused), port 4196 unless given, so
 *   paired hosts reach this one. Default none: this host can still write to
 *   its peers, and pairs only by joining.
 *
 * Pairing is the pair command's (`cmd/mail/pair.ts`); the state is in
 * `@dotfiles/opencode-mail/filestore/pairs`.
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Schema } from "effect"
import { MESSAGE_DESCRIPTION, MessageInput, explain, receipt, type Rejection } from "@dotfiles/opencode-mail/letter"
import { SESSIONS_DESCRIPTION, SessionsInput } from "@dotfiles/opencode-mail/directory"
import * as Model from "@dotfiles/opencode-mail/model"
import { DEFAULT_PORT } from "@dotfiles/opencode-mail/peer"
import * as FilePairs from "@dotfiles/opencode-mail/filestore/pairs"
import * as Listener from "@dotfiles/opencode-mail/http/listener"
import * as HttpPeers from "@dotfiles/opencode-mail/http/peers"
import { keyed, tokens } from "@dotfiles/opencode-mail/node/keyed"
import * as OpenCodeSessions from "@dotfiles/opencode-mail/opencode/sessions"
import type { DeliveryRefused, Net, PairStore, Peers, Sessions, SessionsUnreadable, Tokens } from "@dotfiles/opencode-mail/service"

export const Options = Schema.Struct({
  listen: Schema.optional(
    Schema.Struct({
      hostname: Schema.String,
      port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 }))),
    }),
  ),
})
export type Options = typeof Options.Type

/** The outside systems mail runs on. */
export type Externals = Sessions | Peers | PairStore | Net | Tokens

/**
 * The outside systems on `host`'s pairing store, network and tokens, the sessions through OpenCode's context: the
 * peers are that network's.
 */
export const externalsOn = (ctx: Plugin.Context, host: Layer.Layer<PairStore | Net | Tokens>): Layer.Layer<Externals> =>
  Layer.mergeAll(OpenCodeSessions.fromContext(ctx), host, HttpPeers.layer(keyed).pipe(Layer.provide(host)))

/** The outside systems as OpenCode and this host provide them: the sessions, the pairing file, and the peers over HTTP. */
export const live = (ctx: Plugin.Context): Layer.Layer<Externals> =>
  externalsOn(ctx, Layer.mergeAll(FilePairs.layer(FilePairs.fileOf(process.env)), HttpPeers.liveNet, tokens))

/** What the agent reads when a message is not sent. */
const messageOf = (failure: Rejection | SessionsUnreadable | DeliveryRefused) => {
  if (failure._tag === "SessionsUnreadable") return `The sessions could not be read: ${failure.message}`
  if (failure._tag === "DeliveryRefused") return `OpenCode did not take the message into session ${failure.sessionID}: ${failure.message}`
  return explain(failure)
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })

/** The plugin on `externals`: the live sessions and peers in OpenCode, a stand-in host's in the seam test. */
export const make = (externals: (ctx: Plugin.Context) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.mail",
    effect: Effect.fn("Mail.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options ?? {}).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.mail: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      const outside = yield* Layer.build(externals(ctx))
      const services = yield* Layer.build(Model.layer.pipe(Layer.provide(Layer.succeedContext(outside))))
      const mail = Context.get(services, Model.Mail)

      if (options.listen !== undefined) {
        const listen = { hostname: options.listen.hostname, port: options.listen.port ?? DEFAULT_PORT }
        yield* Effect.forkScoped(Listener.serve(listen, { cards: mail.cards, receive: mail.receive }, keyed).pipe(Effect.provideContext(outside)))
      }

      yield* ctx.tool.transform((editor) => {
        // Direct tools beside the others, so they are offered without code mode and reached from a kernel cell.
        editor.add({
          name: "sessions",
          description: SESSIONS_DESCRIPTION,
          input: SessionsInput,
          options: { codemode: false },
          execute: (input, context) =>
            mail.sessions(context.sessionID, input).pipe(
              Effect.map(text),
              Effect.mapError((failure) => new Tool.Error({ message: `The sessions could not be read: ${failure.message}`, error: failure })),
            ),
        })
        editor.add({
          name: "message",
          description: MESSAGE_DESCRIPTION,
          input: MessageInput,
          options: { codemode: false },
          execute: (input, context) =>
            mail.send(context.sessionID, input).pipe(
              Effect.map((sent) => ({
                ...text(receipt(sent.to, sent.delivery)),
                metadata: { to: sent.to.id, delivery: sent.delivery, ...(sent.to.host === undefined ? {} : { host: sent.to.host }) },
              })),
              Effect.mapError((failure) => new Tool.Error({ message: messageOf(failure), error: failure })),
            ),
        })
      })
    }),
  })

export default make(live)
