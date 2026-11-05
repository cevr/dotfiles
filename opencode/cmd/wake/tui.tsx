/**
 * Wakes' TUI plugin: the tray line above the composer while the session on
 * screen has alarms or monitors pending, or notices unread
 * (`@dotfiles/opencode-wake/tui/tray`). The slot sits above the composer, so
 * it shows with Prime's prompt footer too.
 */
import { Plugin } from "@opencode/plugin/tui"
import { Tray } from "@dotfiles/opencode-wake/tui/tray"
import { WAKES } from "@dotfiles/opencode-wake/wake"

export default Plugin.define({
  id: WAKES.id,
  setup(ctx) {
    ctx.ui.slot({
      append: "session.composer.top",
      render: (input) => <Tray ctx={ctx} sessionID={input.sessionID} />,
    })
  },
})
