/**
 * The escape mod's TUI plugin: the composition root of
 * @dotfiles/opencode-escape. One Escape on a busy session with an empty
 * composer takes back the prompt just sent (within the `grace` option, 5 s by
 * default: the run stops, the session reverts and the prompt is back in the
 * composer) and interrupts after it or over a draft; a pending prompt comes
 * back whatever the grace and the turn it waited behind stops, a press the
 * server does not answer is a toast, and a subagent's view interrupts that
 * subagent. setup.ts registers
 * the keymap layers. It has no server half: it acts through the host's own
 * `session.undo` command and the TUI client's interrupt.
 */
import { Plugin } from "@opencode/plugin/tui"
import { setup } from "./setup.ts"

export default Plugin.define({
  id: "dotfiles-opencode.escape",
  setup(context) {
    setup(context)
  },
})
