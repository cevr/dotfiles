// The harness's own TUI plugin, loaded by the host's loader beside ours: it
// lends the harness the router's navigate (registry.ts), so each seed opens its
// own session in the one app the file booted. It draws nothing and binds nothing.
import { Plugin } from "@opencode/plugin/tui"
import { Option } from "effect"
import { router } from "./registry.ts"

export default Plugin.define({
  id: "dotfiles-opencode.sim-tui-route",
  setup(context) {
    router().navigate = Option.some((sessionID: string) => context.ui.router.navigate({ type: "session", sessionID }))
  },
})
