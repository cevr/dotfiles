// The plugin seam: setup.ts on a stand-in TUI. It checks the layers it adds
// (base mode above the host's session.interrupt, and the composer mode only in
// a subagent's view) and what one Escape does there: the host's session.undo
// within the grace, the client's interrupt after it, nothing on a draft, the
// host's own handling when the session is idle. tests/prime-escape.test.ts
// runs it in OpenCode.
import { describe, expect, test } from "bun:test"
import type { Message } from "@dotfiles/opencode-escape/opencode/view"
import { type Host, type Layer, setup, UNDO } from "./setup.ts"

interface Session {
  parentID?: string
  status: "idle" | "running"
  messages: Array<Message>
  pending: Array<{ id: string; type: string }>
}

const SENT = 1_000_000

/** The plugin set up on a stand-in TUI showing `sessionID`, with `options`. */
const start = (options: Record<string, unknown> = {}) => {
  const sessions: Record<string, Session> = {
    ses_root: { status: "running", messages: [{ id: "msg_1", type: "user", text: "Rename the helper.", time: { created: SENT } }], pending: [] },
    ses_child: { parentID: "ses_root", status: "running", messages: [], pending: [] },
  }
  const state = { now: SENT, sessionID: "ses_root", editor: { plainText: "" } as { plainText: string } | null }
  const layers: Array<Layer> = []
  const dispatched: Array<string> = []
  const interrupts: Array<{ sessionID: string; resume?: boolean }> = []
  const toasts: Array<{ message: string; variant: string; duration?: number }> = []
  const host: Host = {
    options,
    data: {
      session: {
        get: (id) => sessions[id],
        family: (id) => (id === "ses_root" ? Object.keys(sessions) : [id]),
        status: (id) => sessions[id]?.status ?? "idle",
        pending: { list: (id) => sessions[id]?.pending ?? [] },
        permission: { list: () => [] },
        form: { list: () => [] },
        message: { list: (id) => sessions[id]?.messages ?? [] },
      },
    },
    renderer: {
      get currentFocusedEditor() {
        return state.editor
      },
    },
    client: {
      session: {
        interrupt: async (input) => {
          interrupts.push(input)
        },
      },
    },
    keymap: { layer: (factory) => void layers.push(factory()), dispatch: (id) => void dispatched.push(id) },
    ui: {
      router: { current: () => ({ type: "session", sessionID: state.sessionID }) },
      toast: { show: (input) => void toasts.push(input) },
    },
  }
  setup(host, () => state.now)
  const [base, composer] = layers
  /** Escape through the layer active in the current view: `false` falls through to the host. */
  const press = (layer = base) => {
    if (layer?.enabled?.() === false) return "inactive"
    return layer?.commands.find((command) => command.bind === "escape")?.run()
  }
  return { sessions, state, layers, base, composer, dispatched, interrupts, toasts, press }
}

describe("escape plugin", () => {
  test("one base-mode layer at the composer's priority and one composer-mode layer, both on Escape", () => {
    const { layers } = start()
    expect(layers.map((layer) => [layer.mode ?? "base", layer.priority, layer.commands.map((command) => command.bind)])).toEqual([
      ["base", 1, ["escape"]],
      ["composer", 2, ["escape"]],
    ])
  })

  test("Escape at 1 s runs the host's session.undo once; a second press while it settles does nothing", () => {
    const run = start()
    run.state.now = SENT + 1_000
    expect(run.press()).toBeUndefined()
    run.state.now = SENT + 1_200
    expect(run.press()).toBeUndefined()
    expect(run.dispatched).toEqual([UNDO])
    expect(run.interrupts).toEqual([])
  })

  test("Escape at 7 s interrupts through the client, resuming the session's queue", () => {
    const run = start()
    run.state.now = SENT + 7_000
    expect(run.press()).toBeUndefined()
    expect(run.interrupts).toEqual([{ sessionID: "ses_root", resume: true }])
    expect(run.dispatched).toEqual([])
  })

  test("the grace option sets the window; 0 always interrupts", () => {
    const run = start({ grace: 0 })
    run.state.now = SENT + 100
    run.press()
    expect(run.interrupts).toHaveLength(1)
    const long = start({ grace: 10_000 })
    long.state.now = SENT + 7_000
    long.press()
    expect(long.dispatched).toEqual([UNDO])
    expect(() => start({ grace: -1 })).toThrow()
  })

  test("a draft keeps the key and leaves the session alone", () => {
    const run = start()
    run.state.editor = { plainText: "half a thought" }
    run.state.now = SENT + 1_000
    expect(run.press()).toBeUndefined()
    expect([...run.dispatched, ...run.interrupts]).toEqual([])
  })

  test("an idle session leaves the key to the host", () => {
    const run = start()
    run.sessions.ses_root!.status = "idle"
    run.state.now = SENT + 1_000
    expect(run.press()).toBe(false)
    expect([...run.dispatched, ...run.interrupts]).toEqual([])
  })

  test("a pending prompt comes back through session.undo long after the grace", () => {
    const run = start()
    run.sessions.ses_root!.pending = [{ id: "msg_1", type: "user" }]
    run.state.now = SENT + 60_000
    run.press()
    expect(run.dispatched).toEqual([UNDO])
    expect(run.toasts).toEqual([])
  })

  test("taking back a run that called a shell warns that the shell's effects stay", () => {
    const run = start()
    run.sessions.ses_root!.messages.push({ id: "msg_2", type: "assistant", content: [{ type: "tool", name: "shell" }], time: { created: SENT + 10 } })
    run.state.now = SENT + 1_000
    run.press()
    expect(run.toasts).toEqual([{ message: "Cancelled; shell commands it ran are not undone", variant: "warning", duration: 5_000 }])
  })

  test("in a subagent's view the composer-mode layer interrupts the running subagent; elsewhere it is off", () => {
    const run = start()
    expect(run.press(run.composer)).toBe("inactive")
    run.state.sessionID = "ses_child"
    run.state.editor = null
    expect(run.press(run.composer)).toBeUndefined()
    expect(run.interrupts).toEqual([{ sessionID: "ses_child", resume: true }])
    run.sessions.ses_child!.status = "idle"
    expect(run.press(run.composer)).toBe(false)
  })
})
