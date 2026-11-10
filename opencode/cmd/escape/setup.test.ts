// The plugin seam: setup.ts on a stand-in TUI. It checks the layers it adds
// (base mode above the host's session.interrupt, none in a panel's mode, which
// owns Escape while open) and what one Escape does there: the host's session.undo
// within the grace, the client's interrupt after it or over a draft, both for
// a pending prompt behind a running turn, the host's own handling when the
// session is idle, and a toast whenever the press does not take: a refused
// interrupt, or a session still running STOP_MS later.
// tests/prime-escape.test.ts and tests/escape-states.test.ts run it in OpenCode.
import { describe, expect, test } from "bun:test"
import { STOP_MS } from "@dotfiles/opencode-escape/escape"
import type { InboxItem, Message } from "@dotfiles/opencode-escape/opencode/view"
import { SEND_COMMAND } from "@dotfiles/opencode-escape/send"
import {
  type Ended,
  type Enqueued,
  type Host,
  type Layer,
  NOT_QUEUED,
  NOT_STOPPED,
  NOT_TAKEN,
  notStopped,
  QUEUE,
  SENDING,
  SETTLING,
  setup,
  SUBMIT,
  UNDO,
} from "./setup.ts"

interface Session {
  parentID?: string
  status: "idle" | "running"
  messages: Array<Message>
  pending: Array<InboxItem>
}

const SENT = 1_000_000

/** The plugin set up on a stand-in TUI showing `sessionID`, with `options`. */
const start = (options: Record<string, unknown> = {}) => {
  const sessions: Record<string, Session> = {
    ses_root: { status: "running", messages: [{ id: "msg_1", type: "user", text: "Rename the helper.", time: { created: SENT } }], pending: [] },
    ses_child: { parentID: "ses_root", status: "running", messages: [], pending: [] },
  }
  const state = {
    now: SENT,
    sessionID: "ses_root",
    editor: { plainText: "" } as { plainText: string } | null,
    refuse: undefined as Error | undefined,
    /** Whether the server admits a prompt the host's prompt.queue sends (its enqueued event follows). */
    admits: true,
    /** Inbox ids whose move the server refuses, as for a prompt the session already took. */
    taken: new Set<string>(),
    /** A failure of every move, the prompt left waiting (an unreachable server). */
    moveError: undefined as Error | undefined,
  }
  const layers: Array<Layer> = []
  const dispatched: Array<string> = []
  const interrupts: Array<{ sessionID: string; resume?: boolean }> = []
  const moves: Array<{ inboxID: string; delivery: string }> = []
  /** Every call the plugin made of the host, in order: what the race guards are about. */
  const calls: Array<string> = []
  const toasts: Array<{ message: string; variant: string; duration?: number }> = []
  const timers: Array<{ at: number; run: () => void }> = []
  /** The plugin's event subscriptions, by event type. */
  const listeners: Record<string, Array<(event: Enqueued & Ended) => void>> = {}
  const emit = (type: string, event: Enqueued & Ended) => {
    for (const listener of (listeners[type] ?? []).slice()) listener(event)
  }
  let minted = 0
  const dispatch = (id: string) => {
    dispatched.push(id)
    calls.push(id)
    // The host's prompt.queue: the composer clears at once, the prompt reaches the inbox, then the server's echo.
    if (id !== QUEUE || !state.editor?.plainText) return
    const inboxID = `msg_q${++minted}`
    state.editor = { plainText: "" }
    sessions.ses_root!.pending.push({ id: inboxID, type: "user", delivery: "queue", time: { created: state.now } })
    if (state.admits)
      queueMicrotask(() => emit("session.inbox.enqueued", { data: { sessionID: "ses_root", inboxID, item: { type: "user" } } }))
  }
  /** The session's turn ends (`interrupted`, `succeeded` or `failed`), as the server says: the session goes idle. */
  const end = (sessionID = "ses_root", outcome: "interrupted" | "succeeded" | "failed" = "interrupted") => {
    sessions[sessionID]!.status = "idle"
    emit(`session.execution.${outcome}`, { data: { sessionID, inboxID: "", item: { type: "" } } })
  }
  /** A new turn starts on the session (the interrupt's resume, or a promoted prompt's): it runs again. */
  const begin = (sessionID = "ses_root") => {
    sessions[sessionID]!.status = "running"
  }
  const host: Host = {
    options,
    data: {
      on: (type: string, handler: (event: Enqueued & Ended) => void) => {
        const list = (listeners[type] ??= [])
        list.push(handler)
        return () => void list.splice(list.indexOf(handler), 1)
      },
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
          calls.push(`interrupt ${input.resume}`)
          if (state.refuse) throw state.refuse
        },
        inbox: {
          update: async (input) => {
            calls.push(`${input.delivery} ${input.inboxID}`)
            if (state.moveError) throw state.moveError
            if (state.taken.has(input.inboxID)) {
              sessions.ses_root!.pending = sessions.ses_root!.pending.filter((item) => item.id !== input.inboxID)
              throw new Error("Inbox item is no longer pending")
            }
            moves.push({ inboxID: input.inboxID, delivery: input.delivery })
          },
        },
      },
    },
    keymap: { layer: (factory) => void layers.push(factory()), dispatch },
    ui: {
      router: { current: () => ({ type: "session", sessionID: state.sessionID }) },
      toast: { show: (input) => void toasts.push(input) },
    },
  }
  setup(host, { now: () => state.now, after: (ms, run) => void timers.push({ at: state.now + ms, run }) })
  const [base, sendLayer] = layers
  /** Escape through the layer active in the current view: `false` falls through to the host. */
  const press = (layer = base) => {
    if (layer?.enabled?.() === false) return "inactive"
    return layer?.commands.find((command) => command.bind === "escape")?.run()
  }
  /** Ctrl+Enter: `false` falls through to the host (its newline). */
  const send = () => sendLayer?.commands.find((command) => command.id === SEND_COMMAND)?.run()
  /** Lets the plugin's pending promises run. */
  const flush = async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve()
  }
  /** Moves the clock on by `ms`, running the timers due; lets refused interrupts settle first. */
  const advance = async (ms: number) => {
    await flush()
    state.now += ms
    const all = timers.splice(0)
    timers.push(...all.filter((timer) => timer.at > state.now))
    for (const timer of all) if (timer.at <= state.now) timer.run()
    await flush()
  }
  const messages = () => toasts.map((toast) => toast.message)
  return { host, sessions, state, layers, base, dispatched, interrupts, moves, calls, toasts, messages, press, send, flush, advance, end, begin }
}

/** A prompt waiting in the inbox: `queue` for after the turn, `steer` for its next step. */
const waitingPrompt = (id: string, delivery: "steer" | "queue", created: number): InboxItem => ({ id, type: "user", delivery, time: { created } })

describe("escape plugin", () => {
  test("Escape: one base-mode layer at the composer's priority, none in a panel's mode, so an open panel owns Escape; Ctrl+Enter and its leader+F fallback: one base-mode layer, its command named", () => {
    const { layers } = start()
    expect(layers.map((layer) => [layer.mode ?? "base", layer.priority, layer.commands.map((command) => command.bind)])).toEqual([
      ["base", 1, ["escape"]],
      ["base", 1, ["ctrl+return,<leader>f"]],
    ])
    expect(layers[1]?.commands[0]?.id).toBe(SEND_COMMAND)
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

  test("a turn that stops, its waiting steers resumed as the next turn, says nothing though the session runs again", async () => {
    const run = start()
    run.state.now = SENT + 7_000
    run.press()
    await run.advance(50)
    run.end()
    run.begin()
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

  test("in a subagent's view, its picker put away, Escape on the prompt interrupts the running subagent; an idle one is the host's", () => {
    const run = start()
    run.state.sessionID = "ses_child"
    run.state.editor = { plainText: "" }
    expect(run.press()).toBeUndefined()
    expect(run.interrupts).toEqual([{ sessionID: "ses_child", resume: true }])
    expect(run.dispatched).toEqual([])
    run.sessions.ses_child!.status = "idle"
    expect(run.press()).toBe(false)
  })
})

describe("Ctrl+Enter", () => {
  test("on an idle session it submits the composer, as Enter does, and interrupts nothing", async () => {
    const run = start()
    run.sessions.ses_root!.status = "idle"
    run.state.editor = { plainText: "Ship it." }
    expect(run.send()).toBeUndefined()
    await run.flush()
    expect(run.dispatched).toEqual([SUBMIT])
    expect(run.interrupts).toEqual([])
  })

  test("on a busy session with nothing to send it does nothing: no interrupt, no newline", async () => {
    const run = start()
    expect(run.send()).toBeUndefined()
    await run.advance(STOP_MS)
    expect(run.calls).toEqual([])
    expect(run.toasts).toEqual([])
  })

  test("with only steers waiting, it interrupts with resume, and the server sends them as the next turn", async () => {
    const run = start()
    run.sessions.ses_root!.pending = [waitingPrompt("msg_2", "steer", SENT + 1)]
    run.send()
    await run.flush()
    expect(run.calls).toEqual(["interrupt true"])
    run.sessions.ses_root!.status = "idle"
    await run.advance(STOP_MS)
    expect(run.moves).toEqual([])
    expect(run.toasts).toEqual([])
  })

  test("with queued prompts, it interrupts without resume, and only once the server took the interrupt moves each to the steers, oldest first, once", async () => {
    const run = start()
    let release = () => {}
    const taken = new Promise<void>((resolve) => (release = resolve))
    const interrupt = run.host.client.session.interrupt
    run.host.client.session.interrupt = async (input) => {
      await interrupt(input)
      await taken
    }
    run.sessions.ses_root!.pending = [waitingPrompt("msg_4", "queue", SENT + 3), waitingPrompt("msg_2", "steer", SENT + 1), waitingPrompt("msg_3", "queue", SENT + 2)]
    run.send()
    await run.flush()
    // The server has not answered the interrupt: nothing moves, so the dying turn cannot take a moved prompt.
    expect(run.calls).toEqual(["interrupt false"])
    release()
    await run.flush()
    expect(run.calls).toEqual(["interrupt false", "steer msg_3", "steer msg_4"])
    run.sessions.ses_root!.status = "idle"
    await run.advance(STOP_MS)
    expect(run.calls).toHaveLength(3)
    expect(run.toasts).toEqual([])
  })

  test("a draft goes to the queue through the host first; the interrupt waits for the server to admit it, then it goes out after the older prompts", async () => {
    const run = start()
    run.sessions.ses_root!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    run.state.editor = { plainText: "Stop and fix the test instead." }
    run.send()
    // Until the server's echo, nothing is interrupted.
    expect(run.calls).toEqual([QUEUE])
    await run.flush()
    expect(run.calls).toEqual([QUEUE, "interrupt false", "steer msg_2", "steer msg_q1"])
    expect(run.state.editor).toEqual({ plainText: "" })
  })

  test("a draft the host refuses to queue (a shell command, a slash command) interrupts nothing and says so", async () => {
    const run = start()
    run.state.admits = false
    run.state.editor = { plainText: "!ls" }
    run.send()
    await run.advance(STOP_MS - 1)
    expect(run.interrupts).toEqual([])
    await run.advance(1)
    expect(run.interrupts).toEqual([])
    expect(run.messages()).toEqual([NOT_QUEUED])
  })

  test("a second press while the first still sends interrupts nothing more and says so", async () => {
    const run = start()
    let release = () => {}
    const answered = new Promise<void>((resolve) => (release = resolve))
    const interrupt = run.host.client.session.interrupt
    run.host.client.session.interrupt = async (input) => {
      await interrupt(input)
      await answered
    }
    run.sessions.ses_root!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    run.send()
    await run.flush()
    run.sessions.ses_root!.pending.push(waitingPrompt("msg_3", "queue", SENT + 2))
    run.send()
    expect(run.interrupts).toHaveLength(1)
    expect(run.messages()).toEqual([SENDING])
    release()
    await run.flush()
    expect(run.moves.map((move) => move.inboxID)).toEqual(["msg_2"])
  })

  test("a prompt the session took on its own before the move is no news; one still waiting whose move fails says why", async () => {
    const took = start()
    took.sessions.ses_root!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    took.state.taken.add("msg_2")
    took.send()
    took.sessions.ses_root!.status = "idle"
    await took.advance(50)
    expect(took.toasts).toEqual([])
    const failed = start()
    failed.sessions.ses_root!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    failed.state.moveError = new Error("Unable to connect")
    failed.send()
    failed.sessions.ses_root!.status = "idle"
    await failed.advance(50)
    expect(failed.messages()).toEqual(["Could not send a queued prompt: Unable to connect"])
  })

  test("a turn still running STOP_MS after the press says so, and the queued prompts still go out", async () => {
    const run = start()
    run.sessions.ses_root!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    run.send()
    for (let at = 0; at < STOP_MS; at += 50) await run.advance(50)
    expect(run.messages()).toEqual([notStopped("Ctrl+Enter")])
    expect(run.moves.map((move) => move.inboxID)).toEqual(["msg_2"])
  })

  test("a turn that stops, the next one already running STOP_MS after the press, says nothing: the steers resumed, or the queued prompts sent", async () => {
    const steers = start()
    steers.sessions.ses_root!.pending = [waitingPrompt("msg_2", "steer", SENT + 1)]
    steers.send()
    await steers.advance(50)
    steers.end()
    steers.begin()
    await steers.advance(STOP_MS)
    expect(steers.sessions.ses_root!.status).toBe("running")
    expect(steers.toasts).toEqual([])
    const queued = start()
    queued.state.editor = { plainText: "Stop and fix the test instead." }
    queued.sessions.ses_root!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    queued.send()
    await queued.advance(50)
    expect(queued.moves.map((move) => move.inboxID)).toEqual(["msg_2", "msg_q1"])
    queued.end()
    queued.begin()
    await queued.advance(STOP_MS)
    expect(queued.toasts).toEqual([])
  })

  test("another session's turn ending does not count as this one stopping", async () => {
    const run = start()
    run.sessions.ses_root!.pending = [waitingPrompt("msg_2", "steer", SENT + 1)]
    run.send()
    await run.advance(50)
    run.end("ses_child")
    await run.advance(STOP_MS)
    expect(run.messages()).toEqual([notStopped("Ctrl+Enter")])
  })

  test("a refused interrupt says why and moves nothing", async () => {
    const run = start()
    run.state.refuse = new Error("Unable to connect")
    run.sessions.ses_root!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    run.send()
    run.sessions.ses_root!.status = "idle"
    await run.advance(STOP_MS)
    expect(run.messages()).toEqual(["Could not interrupt: Unable to connect"])
    expect(run.moves).toEqual([])
  })

  test("a subagent's view or no editor focused leaves the key to the host", () => {
    const run = start()
    run.sessions.ses_root!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    run.state.editor = null
    expect(run.send()).toBe(false)
    run.state.editor = { plainText: "" }
    run.state.sessionID = "ses_child"
    expect(run.send()).toBe(false)
    expect(run.calls).toEqual([])
  })
})
