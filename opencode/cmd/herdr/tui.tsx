// The herdr reporter's TUI plugin: the composition root of
// @dotfiles/opencode-herdr. Inside a herdr pane it tells herdr, over its
// socket, what the session on screen is doing; anywhere else it does nothing.
// It follows the open background questions over the questions plugin's RPC
// (@dotfiles/opencode-questions), so a session idling on them shows blocked.
// Reports run in the background and never reach the UI; a stop signal, or
// closing the plugin, releases the pane.
import { decide } from "@dotfiles/opencode-herdr/activity"
import * as SocketHerdr from "@dotfiles/opencode-herdr/herdr/socket"
import { reporter } from "@dotfiles/opencode-herdr/model"
import { followAsked, keptView } from "@dotfiles/opencode-herdr/opencode/asked"
import { membersOf } from "@dotfiles/opencode-herdr/opencode/view"
import { paneOf } from "@dotfiles/opencode-herdr/report"
import { QUESTIONS } from "@dotfiles/opencode-questions/question"
import { Plugin } from "@opencode/plugin/tui"
import { Effect, Exit, Scope } from "effect"
import { createEffect, createRoot } from "solid-js"

/** How long one request to herdr may take; each is tried twice. */
const TIMEOUT_MILLIS = 500
/**
 * The signals that start OpenCode's teardown: OpenCode already listens for
 * both, so a listener here changes no default action. A hangup is turned into
 * SIGTERM by OpenCode itself, and is left alone (a listener would override
 * nohup's ignore).
 */
const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const

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
      const kept = keptView(context.data, route, asked)
      createEffect(() => reporting.show(decide(kept.view())))
      return () => {
        kept.dispose()
        dispose()
      }
    })
    // Told to stop, OpenCode tears down for up to 10 s, and whoever stops it may not wait that long (a
    // supervisor's SIGKILL a second later): the pane is released at once, not at the end of the teardown.
    const releaseNow = () => void Effect.runFork(reporting.release)
    for (const signal of STOP_SIGNALS) process.on(signal, releaseNow)
    return async () => {
      for (const signal of STOP_SIGNALS) process.off(signal, releaseNow)
      stop()
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  },
})
