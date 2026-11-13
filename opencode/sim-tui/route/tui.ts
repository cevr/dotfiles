// The harness's own TUI plugin, loaded by the host's loader beside ours: it
// lends the harness the router's navigate, so each seed opens its own session
// in the one app the file booted. It draws nothing and binds nothing.
import { Plugin } from "@opencode/plugin/tui"

const ROUTE = Symbol.for("dotfiles.sim-tui.navigate")

export default Plugin.define({
  id: "dotfiles-opencode.sim-tui-route",
  setup(context) {
    Object.assign(globalThis, { [ROUTE]: (sessionID: string) => context.ui.router.navigate({ type: "session", sessionID }) })
  },
})
