/**
 * Background questions' TUI plugin: the tray above the composer and the
 * /answer pane in its place. The composition root of the TUI half: it
 * registers /answer and the `session.composer.top` slot that draws the dock
 * (`@dotfiles/opencode-questions/tui/dock`). The slot sits above the
 * composer, so it shows with Prime's prompt footer too.
 */
import { Plugin } from "@opencode/plugin/tui"
import { createQuestions, Dock } from "@dotfiles/opencode-questions/tui/dock"
import { QUESTIONS } from "@dotfiles/opencode-questions/question"
import { COMMAND } from "@dotfiles/opencode-questions/tray"

export default Plugin.define({
  id: QUESTIONS.id,
  setup(ctx) {
    const questions = createQuestions()
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: `${QUESTIONS.id}.answer`,
          title: "Answer the agent's background questions",
          slash: { name: COMMAND.slice(1) },
          run() {
            const route = ctx.ui.router.current()
            if (route.type !== "session") return
            if (questions.open(route.sessionID).length === 0) return ctx.ui.toast.show({ message: "No open questions", variant: "info" })
            questions.setPane(route.sessionID)
          },
        },
      ],
    }))
    ctx.ui.slot({
      append: "session.composer.top",
      render: (input) => <Dock ctx={ctx} sessionID={input.sessionID} questions={questions} />,
    })
  },
})
