/**
 * The queued switch's TUI plugin: `/model-next` and the host model picker's
 * `at next compaction` action (setup.ts). Prime draws the queued switch beside
 * the tray's model (mods/prime/chrome.ts `queuedOf`).
 */
import { Plugin } from "@opencode/plugin/tui"
import { MODEL_NEXT } from "@dotfiles/opencode-model-next/pending"
import { setup } from "./setup.ts"

export default Plugin.define({
  id: MODEL_NEXT.id,
  setup(ctx) {
    return setup(ctx)
  },
})
