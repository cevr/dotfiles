// The Rex mod's TUI plugin: the composition root of the TUI half of
// @dotfiles/opencode-rex. The host's TUI sets the environment of the session
// it shows to its own (its pane's REX_SESSION and REX_BLOCK among it); the
// subagents of that session's family get none from it, so their shells ran
// in the server's environment and named whatever pane the server started in.
// This plugin hands them the same environment the host sends, when each
// appears and each time it starts to run again (`@dotfiles/opencode-rex/family`),
// so `rex-show` from a subagent draws beside the TUI that shows its family.
// Like the host, it does so only when the TUI runs on the server's machine:
// attached to another (`--server`), its pane means nothing there.
import { followFamily } from "@dotfiles/opencode-rex/opencode/family"
import { sessionVariables } from "@dotfiles/opencode-rex/pane"
import { Plugin } from "@opencode/plugin/tui"
import { createRoot } from "solid-js"

/** Whether this TUI was told to attach to a server elsewhere, as the host's `--server` (or `attach`) does. */
const attached = (argv: ReadonlyArray<string>) => argv.some((arg) => arg === "attach" || arg === "--server" || arg.startsWith("--server="))

export default Plugin.define({
  id: "dotfiles-opencode.rex",
  setup(context) {
    if (attached(process.argv.slice(2))) return
    const variables = sessionVariables(process.env)
    return createRoot((dispose) => {
      followFamily(
        context.data,
        () => context.ui.router.current(),
        (sessionID) =>
          void context.client.session
            .environment({ sessionID, variables })
            .catch((error: unknown) => context.ui.toast.show({ title: "Rex pane not handed to a subagent", message: String(error), variant: "warning" })),
      )
      return dispose
    })
  },
})
