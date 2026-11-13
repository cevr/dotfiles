// The TUI plugin seam: the composition root's setup (setup.ts) on a stand-in
// TUI and a stand-in host form API. It checks what the host sees: /answer as a
// slash command opening the host's question form for the open questions, and
// shift+← bound in the base mode above the composer's own layer, opening it
// when the composer is empty and handing the key on (run returns false, so
// the composer selects) when the composer has text, no question is open or no
// session shows; the tray drawn in `session.composer.top`, and a click on it
// opening the form when a question is open (questions-tap.sim.test.tsx clicks
// it in the real TUI).
// tests/questions.test.ts runs it in OpenCode.
import { expect, test } from "bun:test"
import type { FormInput } from "@dotfiles/opencode-questions/form"
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
  const forms: Array<readonly [string, FormInput]> = []
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
  const taps = new Map<string, () => void>()
  const questions = setup(
    ctx as unknown as Host,
    (input) => {
      drawn.push(input.sessionID)
      taps.set(input.sessionID, input.open)
      return "dock"
    },
    { pending: () => [], create: (sessionID, input) => Promise.resolve(void forms.push([sessionID, input])), asker: (sessionID) => sessionID },
  )
  const layerOf = (id: string) => layers.find((layer) => layer.commands.some((command) => command.id === id))
  const command = (id: string) => layers.flatMap((layer) => layer.commands).find((candidate) => candidate.id === id)
  const opened = async () => {
    await Bun.sleep(0)
    return forms.map(([sessionID, input]) => [sessionID, input.fields.map((field) => field.key)])
  }
  /** A click on the tray the slot drew for `sessionID`. */
  const tap = (sessionID: string) => taps.get(sessionID)?.()
  return { questions, layerOf, command, slots, drawn, toasts, composer, opened, tap }
}

test("shift+← is bound in the base mode, above the composer's own layer", () => {
  const plugin = start({ type: "session", sessionID: "ses_root" })
  expect(plugin.command(OPEN)?.bind).toBe("shift+left")
  // No mode is the base mode, where the composer's keys live; the textarea layer's priority is 0.
  expect(plugin.layerOf(OPEN)?.mode).toBeUndefined()
  expect(plugin.layerOf(OPEN)?.priority).toBe(1)
})

test("on an empty composer shift+← opens the host's form for the session's questions", async () => {
  const plugin = start({ type: "session", sessionID: "ses_root" })
  plugin.questions.setOpen("ses_root", [asked])
  expect(plugin.command(OPEN)?.run()).toBeUndefined()
  expect(await plugin.opened()).toEqual([["ses_root", ["ask_user_async:q1"]]])
})

test("with text in the composer shift+← goes on to the composer, and no form opens", async () => {
  const plugin = start({ type: "session", sessionID: "ses_root" }, { plainText: "draft" })
  plugin.questions.setOpen("ses_root", [asked])
  expect(plugin.command(OPEN)?.run()).toBe(false)
  expect(await plugin.opened()).toEqual([])
})

test("with no open question or no session on screen, shift+← goes on quietly", () => {
  const empty = start({ type: "session", sessionID: "ses_root" })
  expect(empty.command(OPEN)?.run()).toBe(false)
  expect(empty.toasts).toEqual([])
  const home = start({ type: "home" }, null)
  expect(home.command(OPEN)?.run()).toBe(false)
})

test("/answer opens the form, or says there is nothing to answer", async () => {
  const plugin = start({ type: "session", sessionID: "ses_root" })
  expect(plugin.command(ANSWER)?.slash?.name).toBe("answer")
  plugin.command(ANSWER)?.run()
  expect(plugin.toasts).toEqual(["No open questions"])
  plugin.questions.setOpen("ses_root", [asked])
  plugin.command(ANSWER)?.run()
  expect(await plugin.opened()).toEqual([["ses_root", ["ask_user_async:q1"]]])
})

test("the tray draws above the composer for the session the slot names", () => {
  const plugin = start({ type: "session", sessionID: "ses_root" })
  expect(plugin.slots.map((slot) => slot.append)).toEqual(["session.composer.top"])
  expect(plugin.slots[0]?.render({ sessionID: "ses_root" })).toBe("dock")
  expect(plugin.drawn).toEqual(["ses_root"])
})

/** The plugin with the tray drawn for the session on screen, a draft in the composer, and `open` questions; then a click on the tray. */
const tapped = (open: ReadonlyArray<Question>) => {
  const plugin = start({ type: "session", sessionID: "ses_root" }, { plainText: "draft" })
  plugin.slots[0]?.render({ sessionID: "ses_root" })
  plugin.questions.setOpen("ses_root", open)
  plugin.tap("ses_root")
  return plugin
}

test("a click on the tray opens the form for its session's questions, even with a draft in the composer", () =>
  expect(tapped([asked]).opened()).resolves.toEqual([["ses_root", ["ask_user_async:q1"]]]))

test("with no open question a click on the tray does nothing, and says nothing", () => {
  const plugin = tapped([])
  expect(plugin.toasts).toEqual([])
  return expect(plugin.opened()).resolves.toEqual([])
})
