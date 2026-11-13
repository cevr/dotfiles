// The plugin seam: setup.ts on a stand-in TUI. It checks the layers it adds
// (base mode above the host's session.interrupt, none in a panel's mode, which
// owns Escape while open) and what one Escape does there: the host's session.undo
// within the grace, the client's interrupt after it or over a draft, both for
// a pending prompt behind a running turn, the host's own handling when the
// session is idle, and a toast whenever the press does not take: a refused
// interrupt, or a session still running STOP_MS later. Escape on a waiting
// prompt, and Up on the composer's first row with prompts waiting, take every
// waiting prompt back through the fork's ui.composer.takeBack, joined by a newline.
// tests/prime-escape.test.ts, tests/escape-states.test.ts and
// tests/queue-merge.test.ts run it in OpenCode.
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
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
  PARENT,
  QUEUE,
  SENDING,
  SETTLING,
  setup,
  SUBMIT,
  TAKE_COMMAND,
  UNDO,
} from "./setup.ts"
import { left } from "@dotfiles/opencode-escape/take"

interface Session {
  parentID?: string
  status: "idle" | "running"
  messages: Array<Message>
  pending: Array<InboxItem>
}

const SENT = 1_000_000

/** A focused composer holding `plainText`, the cursor at `cursorOffset` on visual row `row` (scrolled by none). */
const editor = (plainText: string, cursorOffset = plainText.length, row = 0) => ({ plainText, cursorOffset, scrollY: 0, visualCursor: { visualRow: row } })

/** The plugin set up on a stand-in TUI showing `sessionID`, with `options`. */
const start = (options: Record<string, unknown> = {}) => {
  const sessions: Record<string, Session> = {
    ses_root: { status: "running", messages: [{ id: "msg_1", type: "user", text: "Rename the helper.", time: { created: SENT } }], pending: [] },
    ses_child: { parentID: "ses_root", status: "running", messages: [], pending: [] },
  }
  const state = {
    now: SENT,
    sessionID: "ses_root",
    editor: editor("") as ReturnType<typeof editor> | null,
    /** Inbox ids the host's take-back leaves (sent meanwhile); the message the whole take-back fails with. */
    left: new Set<string>(),
    takeFailure: Option.none<string>(),
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
  /** Each take-back the plugin asked the host for. */
  const takes: Array<{ sessionID: string; inboxIDs: ReadonlyArray<string>; separator?: string }> = []
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
    const sessionID = state.sessionID
    state.editor = editor("")
    sessions[sessionID]!.pending.push({ id: inboxID, type: "user", delivery: "queue", time: { created: state.now } })
    if (state.admits) queueMicrotask(() => emit("session.inbox.enqueued", { data: { sessionID, inboxID, item: { type: "user" } } }))
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
      composer: {
        // The host's API is a promise; the stand-in builds its answer as an Effect and runs it to one.
        takeBack: (input) =>
          Effect.runPromise(
            Effect.gen(function* () {
              takes.push(input)
              calls.push(`take ${input.inboxIDs.join(",")}`)
              if (Option.isSome(state.takeFailure)) return yield* Effect.fail(state.takeFailure.value)
              const session = sessions[input.sessionID]!
              session.pending = session.pending.filter((item) => !input.inboxIDs.includes(item.id) || state.left.has(item.id))
              return { left: input.inboxIDs.filter((id) => state.left.has(id)) }
            }),
          ),
      },
    },
  }
  setup(host, { now: () => state.now, after: (ms, run) => void timers.push({ at: state.now + ms, run }) })
  const [base, upLayer, sendLayer] = layers
  /** Escape through the layer active in the current view: `false` falls through to the host. */
  const press = (layer = base) => {
    if (layer?.enabled?.() === false) return "inactive"
    return layer?.commands.find((command) => command.bind === "escape")?.run()
  }
  /** Up through its layer: `inactive` when the layer is off, `false` falls through to the host's history. */
  const up = () => {
    if (upLayer?.enabled?.() === false) return "inactive"
    return upLayer?.commands.find((command) => command.bind === "up")?.run()
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
  return { host, sessions, state, layers, base, dispatched, interrupts, moves, calls, toasts, takes, messages, press, up, send, flush, advance, end, begin }
}

/** A prompt waiting in the inbox: `queue` for after the turn, `steer` for its next step. */
const waitingPrompt = (id: string, delivery: "steer" | "queue", created: number): InboxItem => ({ id, type: "user", delivery, time: { created } })

describe("escape plugin", () => {
  test("Escape: one base-mode layer at the composer's priority, none in a panel's mode, so an open panel owns Escape; Ctrl+Enter and its leader+F fallback: one base-mode layer, its command named", () => {
    const { layers } = start()
    expect(layers.map((layer) => [layer.mode ?? "base", layer.priority, layer.commands.map((command) => command.bind)])).toEqual([
      ["base", 1, ["escape"]],
      ["base", 2, ["up"]],
      ["base", 1, ["ctrl+return,<leader>f"]],
    ])
    expect(layers[1]?.commands[0]?.id).toBe(TAKE_COMMAND)
    expect(layers[2]?.commands[0]?.id).toBe(SEND_COMMAND)
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
    run.state.editor = editor("half a thought")
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

  test("a pending prompt behind a running turn comes back with every other waiting one, oldest first, joined by a newline, and the turn stops, the inbox not resumed", async () => {
    const run = start()
    run.sessions.ses_root!.messages.push({ id: "msg_3", type: "user", text: "Also update the docs.", time: { created: SENT + 6_000 } })
    run.sessions.ses_root!.pending = [waitingPrompt("msg_3", "queue", SENT + 6_000), waitingPrompt("msg_2", "steer", SENT + 5_000)]
    run.state.now = SENT + 60_000
    run.press()
    await run.flush()
    expect(run.takes).toEqual([{ sessionID: "ses_root", inboxIDs: ["msg_2", "msg_3"], separator: "\n" }])
    expect(run.calls).toEqual(["take msg_2,msg_3", "interrupt false"])
    expect(run.dispatched).toEqual([])
    expect(run.toasts).toEqual([])
  })

  test("an idle session's parked prompt comes back alone, and nothing is interrupted", async () => {
    const run = start()
    run.sessions.ses_root!.status = "idle"
    run.sessions.ses_root!.pending = [{ id: "msg_1", type: "user" }]
    run.state.now = SENT + 60_000
    run.press()
    await run.flush()
    expect(run.calls).toEqual(["take msg_1"])
    expect(run.interrupts).toEqual([])
  })

  test("a take-back that fails, or leaves a prompt sent meanwhile, says so", async () => {
    const run = start()
    run.sessions.ses_root!.status = "idle"
    run.sessions.ses_root!.pending = [waitingPrompt("msg_1", "queue", SENT)]
    run.state.left.add("msg_1")
    run.press()
    await run.flush()
    expect(run.messages()).toEqual([left(1)])
    const failed = start()
    failed.sessions.ses_root!.status = "idle"
    failed.sessions.ses_root!.pending = [waitingPrompt("msg_1", "queue", SENT)]
    failed.state.takeFailure = Option.some("Unable to connect")
    failed.press()
    await failed.flush()
    expect(failed.messages()).toEqual(["Could not take the waiting prompts back: Unable to connect"])
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
    // The server never answers the take-back: the prompt stays in the inbox.
    parked.host.ui.composer.takeBack = () => Effect.runPromise(Effect.never)
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

  test("in a subagent's view, its picker put away, Escape goes back to the parent through the host's session.parent and never interrupts the subagent", async () => {
    const run = start()
    run.state.sessionID = "ses_child"
    run.state.editor = editor("")
    expect(run.press()).toBeUndefined()
    run.state.editor = editor("Check the cents too.")
    expect(run.press()).toBeUndefined()
    run.sessions.ses_child!.status = "idle"
    expect(run.press()).toBeUndefined()
    await run.advance(STOP_MS)
    expect(run.dispatched).toEqual([PARENT, PARENT, PARENT])
    expect(run.interrupts).toEqual([])
    expect(run.toasts).toEqual([])
  })
})

describe("Ctrl+Enter", () => {
  test("on an idle session it submits the composer, as Enter does, and interrupts nothing", async () => {
    const run = start()
    run.sessions.ses_root!.status = "idle"
    run.state.editor = editor("Ship it.")
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
    run.state.editor = editor("Stop and fix the test instead.")
    run.send()
    // Until the server's echo, nothing is interrupted.
    expect(run.calls).toEqual([QUEUE])
    await run.flush()
    expect(run.calls).toEqual([QUEUE, "interrupt false", "steer msg_2", "steer msg_q1"])
    expect(run.state.editor?.plainText).toBe("")
  })

  test("a draft the host refuses to queue (a shell command, a slash command) interrupts nothing and says so", async () => {
    const run = start()
    run.state.admits = false
    run.state.editor = editor("!ls")
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
    queued.state.editor = editor("Stop and fix the test instead.")
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

  test("no editor focused leaves the key to the host", () => {
    const run = start()
    run.sessions.ses_root!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    run.state.editor = null
    expect(run.send()).toBe(false)
    expect(run.calls).toEqual([])
  })

  test("in a running subagent's view it queues the draft to that subagent, interrupts it, and sends what waits", async () => {
    const run = start()
    run.state.sessionID = "ses_child"
    run.state.editor = editor("Stop and check the cents.")
    run.sessions.ses_child!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    expect(run.send()).toBeUndefined()
    await run.flush()
    expect(run.calls).toEqual([QUEUE, "interrupt false", "steer msg_2", "steer msg_q1"])
    expect(run.interrupts).toEqual([{ sessionID: "ses_child", resume: false }])
    expect(run.sessions.ses_root!.pending).toEqual([])
  })
})

describe("Up", () => {
  test("with prompts waiting, Up on the composer's first row takes them all back, oldest first, joined by a newline; nothing is sent", async () => {
    const run = start()
    run.sessions.ses_root!.pending = [waitingPrompt("msg_4", "queue", SENT + 3), waitingPrompt("msg_2", "steer", SENT + 1), waitingPrompt("msg_3", "queue", SENT + 2)]
    run.state.editor = editor("")
    expect(run.up()).toBeUndefined()
    await run.flush()
    expect(run.takes).toEqual([{ sessionID: "ses_root", inboxIDs: ["msg_2", "msg_3", "msg_4"], separator: "\n" }])
    expect(run.calls).toEqual(["take msg_2,msg_3,msg_4"])
    expect(run.sessions.ses_root!.pending).toEqual([])
    // Nothing waits: Up is the host's history again.
    expect(run.up()).toBe("inactive")
  })

  test("over a draft, from anywhere on its first row, it takes them too; off the first row Up is the host's", async () => {
    const run = start()
    run.sessions.ses_root!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    run.state.editor = editor("line one\nline two", 14, 1)
    expect(run.up()).toBe(false)
    run.state.editor = editor("line one\nline two", 3, 0)
    expect(run.up()).toBeUndefined()
    await run.flush()
    expect(run.calls).toEqual(["take msg_2"])
  })

  test("with nothing waiting the layer is off, and another route leaves Up to the host", () => {
    const run = start()
    expect(run.up()).toBe("inactive")
    run.sessions.ses_root!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    run.host.ui.router.current = () => ({ type: "home" })
    expect(run.up()).toBe("inactive")
    expect(run.calls).toEqual([])
  })

  test("a prompt the session took between the layer turning on and the press leaves Up to the host", () => {
    const run = start()
    run.sessions.ses_root!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    expect(run.layers[1]?.enabled?.()).toBe(true)
    run.sessions.ses_root!.pending = []
    expect(run.layers[1]?.commands[0]?.run()).toBe(false)
    expect(run.calls).toEqual([])
  })

  test("a composer scrolled past its first line is not on the first row", () => {
    const run = start()
    run.sessions.ses_root!.pending = [waitingPrompt("msg_2", "queue", SENT + 1)]
    run.state.editor = { ...editor("one\ntwo\nthree", 9, 0), scrollY: 2 }
    expect(run.up()).toBe(false)
  })

  test("a program's synthetic note waiting in the inbox is not the reader's: Up leaves it", () => {
    const run = start()
    run.sessions.ses_root!.pending = [{ id: "msg_n", type: "synthetic", time: { created: SENT } }]
    expect(run.up()).toBe("inactive")
  })
})
