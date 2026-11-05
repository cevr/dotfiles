/**
 * Background questions' TUI plugin: the tray above the composer and the
 * /answer pane in its place. The composition root of the TUI half: setup.ts
 * registers /answer, the shift+← hotkey and the `session.composer.top` slot;
 * this file draws the dock there (`@dotfiles/opencode-questions/tui/dock`).
 * The slot sits above the composer, so it shows with Prime's prompt footer too.
 */
import { Plugin } from "@opencode/plugin/tui"
import { Dock } from "@dotfiles/opencode-questions/tui/dock"
import { QUESTIONS } from "@dotfiles/opencode-questions/question"
import { setup } from "./setup.ts"

export default Plugin.define({
  id: QUESTIONS.id,
  setup(ctx) {
    setup(ctx, (input) => <Dock ctx={ctx} sessionID={input.sessionID} questions={input.questions} />)
  },
})
