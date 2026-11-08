// The plugin seam: setup.ts on a stand-in TUI. It checks the layers it adds
// (base mode above the host's session.interrupt, and the composer mode only in
// a subagent's view) and what one Escape does there: the host's session.undo
// within the grace, the client's interrupt after it or over a draft, both for
// a pending prompt behind a running turn, the host's own handling when the
// session is idle, and a toast whenever the press does not take: a refused
// interrupt, or a session still running STOP_MS later.
// tests/prime-escape.test.ts and tests/escape-states.test.ts run it in OpenCode.
import { describe, expect, test } from "bun:test"
import { STOP_MS } from "@dotfiles/opencode-escape/escape"
import type { Message } from "@dotfiles/opencode-escape/opencode/view"
import { type Host, type Layer, NOT_STOPPED, NOT_TAKEN, SETTLING, setup, UNDO } from "./setup.ts"

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
  const state = { now: SENT, sessionID: "ses_root", editor: { plainText: "" } as { plainText: string } | null, refuse: undefined as Error | undefined }
  const layers: Array<Layer> = []
  const dispatched: Array<string> = []
  const interrupts: Array<{ sessionID: string; resume?: boolean }> = []
  const toasts: Array<{ message: string; variant: string; duration?: number }> = []
  const timers: Array<{ at: number; run: () => void }> = []
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
          if (state.refuse) throw state.refuse
        },
      },
    },
    keymap: { layer: (factory) => void layers.push(factory()), dispatch: (id) => void dispatched.push(id) },
    ui: {
      router: { current: () => ({ type: "session", sessionID: state.sessionID }) },
      toast: { show: (input) => void toasts.push(input) },
    },
  }
  setup(host, { now: () => state.now, after: (ms, run) => void timers.push({ at: state.now + ms, run }) })
  const [base, composer] = layers
  /** Escape through the layer active in the current view: `false` falls through to the host. */
  const press = (layer = base) => {
    if (layer?.enabled?.() === false) return "inactive"
    return layer?.commands.find((command) => command.bind === "escape")?.run()
  }
  /** Moves the clock on by `ms`, running the timers due; lets refused interrupts settle first. */
  const advance = async (ms: number) => {
    await Promise.resolve()
    state.now += ms
    const all = timers.splice(0)
    timers.push(...all.filter((timer) => timer.at > state.now))
    for (const timer of all) if (timer.at <= state.now) timer.run()
  }
  const messages = () => toasts.map((toast) => toast.message)
  return { sessions, state, layers, base, composer, dispatched, interrupts, toasts, messages, press, advance }
}

describe("escape plugin", () => {
  test("one base-mode layer at the composer's priority and one composer-mode layer, both on Escape", () => {
    const { layers } = start()
    expect(layers.map((layer) => [layer.mode ?? "base", layer.priority, layer.commands.map((command) => command.bind)])).toEqual([
      ["base", 1, ["escape"]],
      ["composer", 2, ["escape"]],
    ])
  })

  test("Escape at 1 s runs the host's session.undo once; a second press while it settles says so and does nothing else", () => {
    const run = start()
    run.state.now = SENT + 1_000
    expect(run.press()).toBeUndefined()
    run.state.now = SENT + 1_200
    expect(run.press()).toBeUndefined()
    expect(run.dispatched).toEqual([UNDO])
    expect(run.interrupts).toEqual([])
    expect(run.messages()).toEqual([SETTLING])
  })

  test("Escape at 7 s interrupts through the client, resuming the session's steers", () => {
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

  test("a draft interrupts the busy session and stays in the composer: nothing is taken back into it", () => {
    const run = start()
    run.state.editor = { plainText: "half a thought" }
    run.state.now = SENT + 1_000
    expect(run.press()).toBeUndefined()
    expect(run.interrupts).toEqual([{ sessionID: "ses_root", resume: true }])
    expect(run.dispatched).toEqual([])
  })

  test("an idle session leaves the key to the host", () => {
    const run = start()
    run.sessions.ses_root!.status = "idle"
    run.state.now = SENT + 1_000
    expect(run.press()).toBe(false)
    expect([...run.dispatched, ...run.interrupts]).toEqual([])
  })

  test("a pending prompt behind a running turn comes back through session.undo and the turn stops, the inbox not resumed", () => {
    const run = start()
    run.sessions.ses_root!.messages.push({ id: "msg_2", type: "user", text: "Also update the docs.", time: { created: SENT + 6_000 } })
    run.sessions.ses_root!.pending = [{ id: "msg_2", type: "user" }]
    run.state.now = SENT + 60_000
    run.press()
    expect(run.dispatched).toEqual([UNDO])
    expect(run.interrupts).toEqual([{ sessionID: "ses_root", resume: false }])
    expect(run.toasts).toEqual([])
  })

  test("an idle session's parked prompt comes back through session.undo alone", () => {
    const run = start()
    run.sessions.ses_root!.status = "idle"
    run.sessions.ses_root!.pending = [{ id: "msg_1", type: "user" }]
    run.state.now = SENT + 60_000
    run.press()
    expect(run.dispatched).toEqual([UNDO])
    expect(run.interrupts).toEqual([])
  })

  test("a session that stops says nothing more", async () => {
    const run = start()
    run.state.now = SENT + 7_000
    run.press()
    run.sessions.ses_root!.status = "idle"
    await run.advance(STOP_MS)
    expect(run.toasts).toEqual([])
  })

  test("a session still running STOP_MS after Escape says the server has not stopped it", async () => {
    const run = start()
    run.state.now = SENT + 7_000
    run.press()
    await run.advance(STOP_MS - 1)
    expect(run.toasts).toEqual([])
    await run.advance(1)
    expect(run.toasts).toEqual([{ message: NOT_STOPPED, variant: "error", duration: 5_000 }])
  })

  test("a take-back the server never answers says so: the run still going, or the prompt still queued", async () => {
    const sent = start()
    sent.state.now = SENT + 1_000
    sent.press()
    await sent.advance(STOP_MS)
    expect(sent.messages()).toEqual([NOT_STOPPED])
    const parked = start()
    parked.sessions.ses_root!.status = "idle"
    parked.sessions.ses_root!.pending = [{ id: "msg_1", type: "user" }]
    parked.press()
    await parked.advance(STOP_MS)
    expect(parked.messages()).toEqual([NOT_TAKEN])
  })

  test("a refused interrupt says why, once", async () => {
    const run = start()
    run.state.refuse = new Error("Unable to connect")
    run.state.now = SENT + 7_000
    run.press()
    await run.advance(STOP_MS)
    expect(run.toasts).toEqual([{ message: "Could not interrupt: Unable to connect", variant: "error", duration: 5_000 }])
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
