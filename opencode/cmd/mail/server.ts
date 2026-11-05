/**
 * Session mail as an OpenCode server plugin. The composition root: it builds
 * mail's model (`@dotfiles/opencode-mail/model`) on OpenCode's sessions and
 * registers two direct tools, offered to every session, main and subagent, and
 * reached from a kernel cell as `tools.sessions` and `tools.message`:
 *
 * - `sessions({ search?, children?, limit? })`: the server's sessions the
 *   caller may write to (`@dotfiles/opencode-mail/directory`).
 * - `message({ to, text, wake?, replyTo? })`: a synthetic message into the
 *   session `to` names, under a header naming the sender and the session to
 *   answer (`@dotfiles/opencode-mail/letter`), delivered as a steer and waking
 *   an idle session unless `wake: false`. Each delivery is logged at info.
 *
 * No options.
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer } from "effect"
import { MESSAGE_DESCRIPTION, MessageInput, explain, receipt, type Rejection } from "@dotfiles/opencode-mail/letter"
import { SESSIONS_DESCRIPTION, SessionsInput } from "@dotfiles/opencode-mail/directory"
import * as Model from "@dotfiles/opencode-mail/model"
import * as OpenCodeSessions from "@dotfiles/opencode-mail/opencode/sessions"
import type { DeliveryRefused, Sessions, SessionsUnreadable } from "@dotfiles/opencode-mail/service"

/** The outside systems mail runs on. */
export type Externals = Sessions

/** The outside systems as OpenCode provides them. */
export const live = (ctx: Plugin.Context): Layer.Layer<Externals> => OpenCodeSessions.fromContext(ctx)

/** What the agent reads when a message is not sent. */
const messageOf = (failure: Rejection | SessionsUnreadable | DeliveryRefused) => {
  if (failure._tag === "SessionsUnreadable") return `The sessions could not be read: ${failure.message}`
  if (failure._tag === "DeliveryRefused") return `OpenCode did not take the message into session ${failure.sessionID}: ${failure.message}`
  return explain(failure)
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })

/** The plugin on `externals`: the live sessions in OpenCode, a stand-in host's in the seam test. */
export const make = (externals: (ctx: Plugin.Context) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.mail",
    effect: Effect.fn("Mail.plugin")(function* (ctx) {
      const services = yield* Layer.build(Model.layer.pipe(Layer.provide(externals(ctx))))
      const mail = Context.get(services, Model.Mail)

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
                metadata: { to: sent.to.id, delivery: sent.delivery },
              })),
              Effect.mapError((failure) => new Tool.Error({ message: messageOf(failure), error: failure })),
            ),
        })
      })
    }),
  })

export default make(live)
