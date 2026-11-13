/**
 * The escape mod's TUI plugin: the composition root of
 * @dotfiles/opencode-escape. One Escape on a busy session with an empty
 * composer takes back the prompt just sent (within the `grace` option, 5 s by
 * default: the run stops, the session reverts and the prompt is back in the
 * composer) and interrupts after it or over a draft; a pending prompt comes
 * back whatever the grace, with every other waiting prompt (one text, a newline
 * between, attachments and all), and the turn it waited behind stops; Up on
 * the composer's first row takes the waiting prompts back the same way. A press the
 * server does not answer is a toast, and in a subagent's view Escape goes
 * back to the parent, the subagent left running. Ctrl+Enter (or leader+F) on
 * a busy session, a subagent's too, interrupts the turn and sends the draft
 * and every waiting prompt as the next turn. setup.ts registers
 * the keymap layers. It acts through the host's own `session.undo` command,
 * the fork's `ui.composer.takeBack` and the TUI client's interrupt. Its
 * server half (server.ts) delivers the prompts queued for after a turn as one
 * message.
 */
import { Plugin } from "@opencode/plugin/tui"
import { setup } from "./setup.ts"

export default Plugin.define({
  id: "dotfiles-opencode.escape",
  setup(context) {
    setup(context)
  },
})
