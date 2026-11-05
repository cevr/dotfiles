/**
 * The git mod's TUI plugin: the session sidebar's Git section (the branch,
 * the changed files and the pull request) and /git, a host-owned panel
 * listing the changed files, where Enter reviews one with hunk. The
 * composition root of the TUI half: it registers the /git command, the panel
 * slot that draws the pane (`@dotfiles/opencode-git/tui/pane`) and the
 * sidebar slot that draws the section (`@dotfiles/opencode-git/tui/sidebar`).
 */
import { Plugin } from "@opencode/plugin/tui"
import { Pane } from "@dotfiles/opencode-git/tui/pane"
import { GitSidebar } from "@dotfiles/opencode-git/tui/sidebar"

export default Plugin.define({
  id: "dotfiles-opencode.git",
  setup(ctx) {
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "dotfiles-opencode.git.open",
          title: "Git changes and pull request",
          slash: { name: "git" },
          run() {
            // /git toggles, as /diff does.
            if (ctx.ui.panel.current()?.name === "git") ctx.ui.panel.close()
            else ctx.ui.panel.open("git")
          },
        },
      ],
    }))
    ctx.ui.slot({
      append: "session.panel",
      render: (input) => (input.name === "git" ? <Pane ctx={ctx} sessionID={input.sessionID} panel={input} /> : null),
    })
    // Below the host's Context, MCP and todo sections, under the session's title.
    ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => <GitSidebar ctx={ctx} sessionID={input.sessionID} />,
    })
  },
})
