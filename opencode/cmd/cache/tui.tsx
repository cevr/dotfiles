/**
 * The cache mod's TUI plugin: prompt-cache misses, their cause and cost. The
 * composition root of the TUI half (there is no server half: everything comes
 * from the TUI's session data). It registers a row after each turn's footer
 * slot for the turn's large misses and one after each compaction for its
 * summary request's (`@dotfiles/opencode-cache/tui/row`), and a
 * sidebar line for the session family (`@dotfiles/opencode-cache/tui/sidebar`),
 * both reading one ledger (`@dotfiles/opencode-cache/tui/ledger`).
 */
import { Plugin } from "@opencode/plugin/tui"
import { createLedger } from "@dotfiles/opencode-cache/tui/ledger"
import { MissRows } from "@dotfiles/opencode-cache/tui/row"
import { CacheSidebar } from "@dotfiles/opencode-cache/tui/sidebar"

export default Plugin.define({
  id: "dotfiles-opencode.cache",
  setup(ctx) {
    const ledger = createLedger(ctx)
    // The footer closes a turn; Prime replaces it with nothing, but a claim
    // `after` it still composes, so the rows sit at the end of the turn either way.
    ctx.ui.slot({
      after: "session.message.assistant.footer",
      render: (input) => <MissRows ctx={ctx} ledger={ledger} sessionID={input.sessionID} messageID={input.messageID} />,
    })
    // A compaction's summary request belongs to no turn: its miss sits under
    // the compaction's own row (Prime replaces it, and a claim `after` it still
    // composes), never under a later turn.
    ctx.ui.slot({
      after: "session.message.compaction",
      render: (input) => <MissRows ctx={ctx} ledger={ledger} sessionID={input.sessionID} messageID={input.messageID} />,
    })
    ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => <CacheSidebar ctx={ctx} ledger={ledger} sessionID={input.sessionID} />,
    })
    return () => ledger.dispose()
  },
})
