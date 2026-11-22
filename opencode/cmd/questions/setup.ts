/**
 * The questions TUI plugin's setup, apart from the JSX that draws the tray so
 * the seam test can run it (Bun's test runner has no Solid JSX transform;
 * OpenCode's TUI preloads one). It registers /answer, the shift+← hotkey and
 * the `session.composer.top` slot; `draw` renders the tray there. /answer, the
 * hotkey and a click on the tray (`open`) open the host's own question form for
 * the questions open at that moment (`@dotfiles/opencode-questions/opencode/form`,
 * `opener`): read from the server then, never the tray's last reading, and once
 * per session while the form opens or shows, however many times they are used.
 *
 * shift+← is also the composer's `input.select.left` (the fork's
 * packages/tui/src/config/keybind.ts, bound by the managed textarea layer in
 * packages/tui/src/context/keymap.tsx). The hotkey's layer sits in the base
 * mode at priority 1, above that layer's 0, so it sees the key first; it opens
 * the form only on an empty composer (`opens` in hotkey.ts) and otherwise
 * returns false, which hands the key on to the composer, which selects.
 */
import { HOTKEY, opens } from "@dotfiles/opencode-questions/hotkey"
import { type FormHost, fromContext, opener } from "@dotfiles/opencode-questions/opencode/form"
import { QUESTIONS } from "@dotfiles/opencode-questions/question"
import { createQuestions, type Questions } from "@dotfiles/opencode-questions/tui/questions"
import { COMMAND } from "@dotfiles/opencode-questions/tray"
import type { Plugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import { Effect } from "effect"

export type Draw = (input: {
  readonly sessionID: string
  readonly questions: Questions
  /** A click on the tray: opens the form for the session's open questions, as shift+← on an empty composer does; with none open, nothing. */
  readonly open: () => void
}) => JSX.Element

export const ANSWER = `${QUESTIONS.id}.answer`
export const OPEN = `${QUESTIONS.id}.open`

export const setup = (ctx: Plugin.Context, draw: Draw, host: FormHost = fromContext(ctx)): Questions => {
  const questions = createQuestions()
  const forms = opener(host)
  const sessionOnScreen = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }
  /**
   * Open the form of the questions open in the session now (read from the server, not the tray's last reading);
   * again while it opens or shows, nothing more. Say so when it could not open, or nothing was left to answer.
   */
  const answer = (sessionID: string) =>
    Effect.runFork(
      forms.open(sessionID).pipe(
        Effect.map((done) => {
          if (done === "failed") ctx.ui.toast.show({ message: "The questions did not open", variant: "error" })
          if (done === "unread") ctx.ui.toast.show({ message: "The questions could not be read; try again", variant: "error" })
          if (done === "none") ctx.ui.toast.show({ message: "Already answered", variant: "info" })
        }),
      ),
    )
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
          void answer(sessionID)
        },
      },
    ],
  }))
  ctx.keymap.layer(() => ({
    priority: 1,
    commands: [
      {
        id: OPEN,
        title: "Answer the background questions",
        group: "Questions",
        bind: HOTKEY,
        run() {
          const sessionID = sessionOnScreen()
          const target = opens({
            sessionID,
            open: sessionID === undefined ? 0 : questions.open(sessionID).length,
            composer: ctx.renderer.currentFocusedEditor?.plainText,
          })
          if (target === undefined) return false
          void answer(target)
        },
      },
    ],
  }))
  ctx.ui.slot({
    append: "session.composer.top",
    render: (input) =>
      draw({
        sessionID: input.sessionID,
        questions,
        open: () => {
          // A click takes no key from the composer, so it opens as shift+← on an empty composer does, whatever the composer holds.
          if (questions.open(input.sessionID).length > 0) void answer(input.sessionID)
        },
      }),
  })
  return questions
}
