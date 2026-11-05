/**
 * The queue's TUI plugin: the Queue section of the session sidebar. The
 * composition root of the TUI half: it registers the section
 * (`@dotfiles/opencode-queue/tui/sidebar`) on `sidebar.content`.
 */
import { Plugin } from "@opencode/plugin/tui"
import { QueueSection } from "@dotfiles/opencode-queue/tui/sidebar"

export default Plugin.define({
  id: "dotfiles-opencode.queue",
  setup(ctx) {
    ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => <QueueSection ctx={ctx} sessionID={input.sessionID} />,
    })
  },
})
