/**
 * The status mod's TUI plugin: /pool, a host-owned panel showing the account
 * pool, the running agents and the orchestrate runs, and the session
 * sidebar's Pool section, the account the session is on, and the pool's
 * alerts (a login to sign in again, failing refreshes) as toasts. The
 * composition root of the TUI half: it registers the /pool command, the panel
 * slot that draws the pane (`@dotfiles/opencode-status/tui/pane`), the
 * sidebar slot that draws the section (`@dotfiles/opencode-status/tui/sidebar`),
 * and starts the alerts' watcher (`@dotfiles/opencode-status/tui/alerts`).
 */
import { Plugin } from "@opencode/plugin/tui"
import { Pane } from "@dotfiles/opencode-status/tui/pane"
import { watchAlerts } from "@dotfiles/opencode-status/tui/alerts"
import { PoolSidebar } from "@dotfiles/opencode-status/tui/sidebar"

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
    // Below the host's Context, MCP and todo sections, under the session's title.
    // One watcher of the pool's alerts per TUI: it toasts, the sidebar draws.
    const alerts = watchAlerts(ctx)
    ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => <PoolSidebar ctx={ctx} sessionID={input.sessionID} alerts={alerts} />,
    })
    return alerts.stop
  },
})
