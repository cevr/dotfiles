/**
 * The status mod's TUI plugin: /pool, a host-owned panel showing the account
 * pool, the running agents and the orchestrate runs. The composition root of
 * the TUI half: it registers the /pool command and the panel slot that draws
 * the pane (`@dotfiles/opencode-status/tui/pane`).
 */
import { Plugin } from "@opencode/plugin/tui"
import { Pane } from "@dotfiles/opencode-status/tui/pane"

export default Plugin.define({
  id: "dotfiles-opencode.status",
  setup(ctx) {
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "dotfiles-opencode.pool.open",
          title: "Account pool, agents and runs",
          slash: { name: "pool" },
          run() {
            // /pool toggles, as /diff does.
            if (ctx.ui.panel.current()?.name === "pool") ctx.ui.panel.close()
            else ctx.ui.panel.open("pool")
          },
        },
      ],
    }))
    ctx.ui.slot({
      append: "session.panel",
      render: (input) => (input.name === "pool" ? <Pane ctx={ctx} sessionID={input.sessionID} panel={input} /> : null),
    })
  },
})
