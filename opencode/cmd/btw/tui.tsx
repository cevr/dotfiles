/**
 * The btw mod's TUI plugin: /btw (alias /side) forks the session on screen
 * into a side session and asks it a question in the host's session panel,
 * while the session keeps working. The composition root of
 * @dotfiles/opencode-btw: setup.ts picks the implementations and registers
 * /btw and the panel slot; this file hands it the pane
 * (`@dotfiles/opencode-btw/tui/pane`). It has no server half: every host call
 * it makes is the TUI client's own session API.
 */
import { Pane } from "@dotfiles/opencode-btw/tui/pane"
import { Plugin } from "@opencode/plugin/tui"
import { setup } from "./setup.ts"

export default Plugin.define({
  id: "dotfiles-opencode.btw",
  setup(ctx) {
    return setup(ctx, (input) => <Pane ctx={ctx} sessionID={input.sessionID} panel={input.panel} controller={input.controller} />)
  },
})
