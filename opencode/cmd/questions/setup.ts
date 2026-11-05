/**
 * The questions TUI plugin's setup, apart from the JSX that draws the dock so
 * the seam test can run it (Bun's test runner has no Solid JSX transform;
 * OpenCode's TUI preloads one). It registers /answer, the shift+← hotkey and
 * the `session.composer.top` slot; `draw` renders the dock there.
 *
 * shift+← is also the composer's `input.select.left` (the fork's
 * packages/tui/src/config/keybind.ts, bound by the managed textarea layer in
 * packages/tui/src/context/keymap.tsx). The hotkey's layer sits in the base
 * mode at priority 1, above that layer's 0, so it sees the key first; it opens
 * the pane only on an empty composer (`opens` in hotkey.ts) and otherwise
 * returns false, which hands the key on to the composer, which selects.
 */
import { HOTKEY, opens } from "@dotfiles/opencode-questions/hotkey"
import { QUESTIONS } from "@dotfiles/opencode-questions/question"
import { createQuestions, type Questions } from "@dotfiles/opencode-questions/tui/questions"
import { COMMAND } from "@dotfiles/opencode-questions/tray"
import type { Plugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"

export type Draw = (input: { readonly sessionID: string; readonly questions: Questions }) => JSX.Element

export const ANSWER = `${QUESTIONS.id}.answer`
export const OPEN = `${QUESTIONS.id}.open`

export const setup = (ctx: Plugin.Context, draw: Draw): Questions => {
  const questions = createQuestions()
  const sessionOnScreen = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }
  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: ANSWER,
        title: "Answer the agent's background questions",
        slash: { name: COMMAND.slice(1) },
        run() {
          const sessionID = sessionOnScreen()
          if (sessionID === undefined) return
          if (questions.open(sessionID).length === 0) return ctx.ui.toast.show({ message: "No open questions", variant: "info" })
          questions.setPane(sessionID)
        },
      },
    ],
  }))
  ctx.keymap.layer(() => ({
    priority: 1,
    commands: [
      {
        id: OPEN,
        title: "Open the background questions",
        group: "Questions",
        bind: HOTKEY,
        run() {
          const sessionID = sessionOnScreen()
          const target = opens({
            sessionID,
            open: sessionID === undefined ? 0 : questions.open(sessionID).length,
            paneOpen: sessionID !== undefined && questions.pane() === sessionID,
            composer: ctx.renderer.currentFocusedEditor?.plainText,
          })
          if (target === undefined) return false
          questions.setPane(target)
        },
      },
    ],
  }))
  ctx.ui.slot({
    append: "session.composer.top",
    render: (input) => draw({ sessionID: input.sessionID, questions }),
  })
  return questions
}
