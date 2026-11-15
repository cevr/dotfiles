/**
 * The Rex mod's server plugin: the composition root of the server half of
 * @dotfiles/opencode-rex. The OpenCode server sits in no Rex pane, yet it
 * inherits the pane variables of wherever it was started (a TUI's pane, a
 * `bun run daily` typed in one), and a session whose environment no TUI set
 * (a subagent, a session no TUI shows) runs its shells in the server's own
 * environment. So the plugin takes `REX_SESSION` and `REX_BLOCK` out of the
 * server's environment at setup: such a shell then names no pane, rather
 * than another session's, and rex-show refuses it instead of drawing there.
 * The TUI half (`tui.tsx`) hands each subagent the pane of the TUI that
 * shows its family.
 */
import { paneVariablesIn } from "@dotfiles/opencode-rex/pane"
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"

/** The plugin over `env`: the server's own environment in OpenCode, a stand-in in the seam test. */
export const make = (env: Partial<Record<string, string>>) =>
  Plugin.define({
    id: "dotfiles-opencode.rex",
    effect: Effect.fn("Rex.plugin")(function* () {
      yield* Effect.sync(() => paneVariablesIn(env).forEach((name) => delete env[name]))
    }),
  })

export default make(process.env)
