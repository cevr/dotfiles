// The TUI plugin seam: the composition root's setup (setup.ts) on a stand-in
// TUI. It checks what the host sees: /answer as a slash command, and shift+←
// bound in the base mode above the composer's own layer, opening the pane of
// the session on screen when its composer is empty and handing the key on
// (run returns false, so the composer selects) when the composer has text,
// no question is open, the pane is open already or no session shows; and the
// dock drawn in `session.composer.top`. tests/questions.test.ts runs it in
// OpenCode.
import { expect, test } from "bun:test"
import type { Question } from "@dotfiles/opencode-questions/question"
import { ANSWER, OPEN, setup } from "./setup.ts"

type Host = Parameters<typeof setup>[0]

interface Command {
  readonly id?: string
  readonly bind?: string | false
  readonly slash?: { readonly name: string }
  readonly run: (input?: string) => unknown
}
interface Layer {
  readonly mode?: string
  readonly priority?: number
  readonly commands: ReadonlyArray<Command>
}

const asked: Question = { id: "q1", sessionID: "ses_root", question: "Which port?", assume: "8080", askedAt: 0 }

/** The plugin set up on a stand-in TUI showing `route`, with `composer` in the focused editor. */
const start = (route: { readonly type: string; readonly sessionID?: string }, composer: { plainText: string } | null = { plainText: "" }) => {
  const layers: Array<Layer> = []
  const slots: Array<{ readonly append: string; readonly render: (input: { readonly sessionID: string }) => unknown }> = []
  const toasts: Array<string> = []
  const ctx = {
    keymap: { layer: (make: () => Layer) => void layers.push(make()) },
    renderer: {
      get currentFocusedEditor() {
        return composer
      },
    },
    ui: {
      router: { current: () => route },
      toast: { show: (toast: { message: string }) => void toasts.push(toast.message) },
      slot: (slot: (typeof slots)[number]) => void slots.push(slot),
    },
  }
  const drawn: Array<string> = []
  const questions = setup(ctx as unknown as Host, (input) => {
    drawn.push(input.sessionID)
    return "dock"
  })
  const layerOf = (id: string) => layers.find((layer) => layer.commands.some((command) => command.id === id))
  const command = (id: string) => layers.flatMap((layer) => layer.commands).find((candidate) => candidate.id === id)
  return { questions, layerOf, command, slots, drawn, toasts, composer }
}

test("shift+← is bound in the base mode, above the composer's own layer", () => {
  const plugin = start({ type: "session", sessionID: "ses_root" })
  expect(plugin.command(OPEN)?.bind).toBe("shift+left")
  // No mode is the base mode, where the composer's keys live; the textarea layer's priority is 0.
  expect(plugin.layerOf(OPEN)?.mode).toBeUndefined()
  expect(plugin.layerOf(OPEN)?.priority).toBe(1)
})

test("on an empty composer shift+← opens the pane of the session on screen", () => {
  const plugin = start({ type: "session", sessionID: "ses_root" })
  plugin.questions.setOpen("ses_root", [asked])
  expect(plugin.command(OPEN)?.run()).toBeUndefined()
  expect(plugin.questions.pane()).toBe("ses_root")
  // Pressed again with the pane open, it hands the key on.
  expect(plugin.command(OPEN)?.run()).toBe(false)
})

test("with text in the composer shift+← goes on to the composer, and the pane stays shut", () => {
  const plugin = start({ type: "session", sessionID: "ses_root" }, { plainText: "draft" })
  plugin.questions.setOpen("ses_root", [asked])
  expect(plugin.command(OPEN)?.run()).toBe(false)
  expect(plugin.questions.pane()).toBeUndefined()
})

test("with no open question or no session on screen, shift+← goes on quietly", () => {
  const empty = start({ type: "session", sessionID: "ses_root" })
  expect(empty.command(OPEN)?.run()).toBe(false)
  expect(empty.questions.pane()).toBeUndefined()
  expect(empty.toasts).toEqual([])
  const home = start({ type: "home" }, null)
  expect(home.command(OPEN)?.run()).toBe(false)
})

test("/answer opens the pane, or says there is nothing to answer", () => {
  const plugin = start({ type: "session", sessionID: "ses_root" })
  expect(plugin.command(ANSWER)?.slash?.name).toBe("answer")
  plugin.command(ANSWER)?.run()
  expect(plugin.toasts).toEqual(["No open questions"])
  plugin.questions.setOpen("ses_root", [asked])
  plugin.command(ANSWER)?.run()
  expect(plugin.questions.pane()).toBe("ses_root")
})

test("the dock draws above the composer for the session the slot names", () => {
  const plugin = start({ type: "session", sessionID: "ses_root" })
  expect(plugin.slots.map((slot) => slot.append)).toEqual(["session.composer.top"])
  expect(plugin.slots[0]?.render({ sessionID: "ses_root" })).toBe("dock")
  expect(plugin.drawn).toEqual(["ses_root"])
})
