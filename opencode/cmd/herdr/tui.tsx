// The herdr reporter's TUI plugin: the composition root of
// @dotfiles/opencode-herdr. Inside a herdr pane it tells herdr, over its
// socket, what the session on screen is doing; anywhere else it does nothing.
// It follows the open background questions over the questions plugin's RPC
// (@dotfiles/opencode-questions), so a session idling on them shows blocked.
// Reports run in the background and never reach the UI; closing the plugin
// releases the pane.
import { decide } from "@dotfiles/opencode-herdr/activity"
import * as SocketHerdr from "@dotfiles/opencode-herdr/herdr/socket"
import { reporter } from "@dotfiles/opencode-herdr/model"
import { followAsked } from "@dotfiles/opencode-herdr/opencode/asked"
import { membersOf, read } from "@dotfiles/opencode-herdr/opencode/view"
import { paneOf } from "@dotfiles/opencode-herdr/report"
import { QUESTIONS } from "@dotfiles/opencode-questions/question"
import { Plugin } from "@opencode/plugin/tui"
import { Effect, Exit, Scope } from "effect"
import { createEffect, createRoot } from "solid-js"

/** How long one request to herdr may take; each is tried twice. */
const TIMEOUT_MILLIS = 500

export default Plugin.define({
  id: "dotfiles-opencode.herdr",
  async setup(context) {
    const pane = paneOf(process.env)
    if (pane === undefined) return
    const scope = Effect.runSync(Scope.make())
    const reporting = await Effect.runPromise(
      reporter({ paneId: pane.paneId }).pipe(
        Effect.provide(SocketHerdr.layer({ path: pane.socketPath, timeoutMillis: TIMEOUT_MILLIS })),
        Scope.provide(scope),
      ),
    )
    const stop = createRoot((dispose) => {
      const route = () => context.ui.router.current()
      const asked = followAsked(
        {
          open: (sessionIDs, signal) => context.client.rpc(QUESTIONS).open({ sessionIDs: [...sessionIDs] }, { location: context.location, signal }),
          listen: context.data.listen,
        },
        () => membersOf(context.data, route()),
      )
      createEffect(() => reporting.show(decide(read(context.data, route(), asked))))
      return dispose
    })
    return async () => {
      stop()
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  },
})
