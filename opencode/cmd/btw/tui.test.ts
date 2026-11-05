// The plugin seam: the composition root's setup (setup.ts) on a stand-in TUI over the
// memory World. It checks what the TUI sees: /btw (and /side) registered as a
// palette command with arguments; /btw outside a session told, not run; /btw
// in a session opening the btw panel, forking, naming and asking; the side
// question kept in the plugin's durable store; a host failure shown as a
// warning; the session.panel slot drawing for the btw panel only; and the
// pane's reading taken from the server's message list as the host's events
// about the fork arrive, with no help from the TUI's message cache.
// tests/btw.test.ts runs it in OpenCode.
import { describe, expect, test } from "bun:test"
import { answer, world, type World } from "@dotfiles/opencode-btw/memory/forks"
import { SETTLE_MS } from "@dotfiles/opencode-btw/tui/controller"
import { forkNote } from "@dotfiles/opencode-btw/question"
import type { Stored } from "@dotfiles/opencode-btw/opencode/store"
import { type Draw, setup } from "./setup.ts"

type Host = Parameters<typeof setup>[0]

interface Command {
  readonly id: string
  readonly group?: string
  readonly palette?: boolean
  readonly slash?: { readonly name: string; readonly aliases?: ReadonlyArray<string>; readonly arguments?: boolean }
  readonly run: (input?: string) => unknown
}

interface Slot {
  readonly append: string
  readonly render: (input: { readonly name: string; readonly sessionID: string }) => unknown
}

const notFound = (sessionID: string) => Object.assign(new Error(`Session not found: ${sessionID}`), { _tag: "SessionNotFoundError" })

/** The plugin set up on a stand-in TUI showing `route`, over `host`. */
const start = (host: World, route: { readonly type: string; readonly sessionID?: string }) => {
  const toasts: Array<{ message: string; variant?: string }> = []
  const opened: Array<string> = []
  const commands: Array<Command> = []
  const slots: Array<Slot> = []
  const keys: Array<string> = []
  const listeners = new Set<(event: { details: unknown }) => void>()
  const pages: Array<string> = []
  let stored: Stored = { sessions: {} }
  const sessionIn = (sessionID: string) => {
    const session = host.sessions.get(sessionID)
    return session === undefined ? Promise.reject(notFound(sessionID)) : Promise.resolve(session)
  }
  const ctx = {
    storage: {
      store: (key: string, options: { readonly initial: Stored }) => {
        keys.push(key)
        stored = structuredClone(options.initial)
        return [
          new Proxy({} as Stored, { get: (_, field) => Reflect.get(stored, field) }),
          async (mutation: (draft: Stored) => void) => {
            const draft = structuredClone(stored)
            mutation(draft)
            stored = draft
          },
        ] as const
      },
    },
    client: {
      session: {
        fork: async (input: { sessionID: string }) => {
          const session = await sessionIn(input.sessionID)
          const id = `ses_fork${++host.forks}`
          const created = host.now++
          host.sessions.set(id, { title: session.title, createdAt: created, messages: [...session.messages], running: false })
          return { id, time: { created } }
        },
        update: async (input: { sessionID: string; title: string }) => {
          const session = await sessionIn(input.sessionID)
          session.title = input.title
        },
        prompt: async (input: { sessionID: string; text: string }) => {
          const session = await sessionIn(input.sessionID)
          session.messages.push({ type: "user", id: `msg_${session.messages.length}`, text: input.text, time: { created: host.now++ } })
          session.running = true
        },
        synthetic: async (input: { sessionID: string; id?: string; text: string; description?: string; resume?: boolean }) => {
          const session = await sessionIn(input.sessionID)
          session.messages.push({ type: "synthetic", id: input.id ?? `msg_${session.messages.length}`, text: input.text, description: input.description, time: { created: host.now++ } })
          if (input.resume) session.running = true
        },
      },
      message: {
        list: async (input: { sessionID: string; limit: number; order: "desc"; cursor?: string }) => {
          pages.push(input.sessionID)
          const session = await sessionIn(input.sessionID)
          return { data: session.messages.toReversed().slice(0, input.limit), cursor: { next: null } }
        },
      },
    },
    data: {
      listen: (handler: (event: { details: unknown }) => void) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
      session: {
        status: (sessionID: string) => (host.sessions.get(sessionID)?.running === true ? "running" : "idle"),
      },
    },
    keymap: {
      layer: (make: () => { readonly commands: ReadonlyArray<Command> }) => {
        commands.push(...make().commands)
      },
    },
    ui: {
      toast: { show: (toast: { message: string; variant?: string }) => void toasts.push(toast) },
      router: { current: () => route },
      panel: { open: (name: string) => void opened.push(name) },
      slot: (slot: Slot) => void slots.push(slot),
    },
  }
  const drawn: Array<Parameters<Draw>[0]> = []
  const cleanup = setup(ctx as unknown as Host, (input) => {
    drawn.push(input)
    return "pane"
  })
  const emit = (details: unknown) => listeners.forEach((listener) => listener({ details }))
  const command = (name: string) => commands.find((each) => each.slash?.name === name || each.slash?.aliases?.includes(name))
  return { toasts, opened, commands, slots, keys, drawn, stored: () => stored, pages, listeners, emit, cleanup, command }
}

/** Lets the handler the command started run to its end. */
const settle = () => Bun.sleep(5)

describe("the btw plugin", () => {
  test("registers /btw, alias /side, as a Session palette command taking the question as its argument", () => {
    const { commands, keys } = start(world(), { type: "home" })
    expect(commands.map((each) => [each.id, each.group, each.palette, each.slash])).toEqual([
      ["dotfiles-opencode.btw.ask", "Session", true, { name: "btw", aliases: ["side"], arguments: true }],
    ])
    expect(keys).toEqual(["side-questions"])
  })

  test("outside a session, /btw says so and forks nothing", async () => {
    const host = world()
    const { command, toasts, opened } = start(host, { type: "home" })
    command("btw")?.run("why?")
    await settle()
    expect(toasts).toEqual([{ message: "btw: open a session first", variant: "warning" }])
    expect(opened).toEqual([])
    expect(host.forks).toBe(0)
  })

  test("in a session, /btw opens the btw panel, forks, names the fork after the question, asks it and keeps the side question", async () => {
    const host = world({ main: 1 })
    const before = structuredClone(host.sessions.get("main")?.messages)
    const { command, toasts, opened, stored, pages } = start(host, { type: "session", sessionID: "main" })
    command("side")?.run("why is it slow?")
    expect(opened).toEqual(["btw"])
    await settle()
    const fork = host.sessions.get("ses_fork1")
    expect(fork?.title).toBe("btw: why is it slow?")
    expect(fork?.messages.slice(-2).map((message) => [message.type, message.text, message.description])).toEqual([
      ["synthetic", forkNote("main"), undefined],
      ["user", "why is it slow?", undefined],
    ])
    expect(fork?.running).toBe(true)
    expect(host.sessions.get("main")?.messages).toEqual(before)
    expect(pages).toEqual(["ses_fork1"])
    expect(stored().sessions.main).toEqual({ fork: { sessionID: "ses_fork1", name: "btw: why is it slow?", createdAt: expect.any(Number), broughtBack: [] } })
    expect(toasts).toEqual([])
  })

  test("a fork the host refuses reaches the reader as a warning and keeps nothing", async () => {
    const host = world({ main: 1 })
    const { command, toasts, stored } = start(host, { type: "session", sessionID: "gone" })
    command("btw")?.run("why?")
    await settle()
    expect(toasts).toEqual([{ message: "btw: could not fork: Session not found: gone", variant: "warning" }])
    expect(stored().sessions).toEqual({})
  })

  test("draws the pane in the host's session panel, for the btw panel only", () => {
    const { slots, drawn } = start(world(), { type: "home" })
    expect(slots.map((slot) => slot.append)).toEqual(["session.panel"])
    expect(slots[0]?.render({ name: "other", sessionID: "main" })).toBeNull()
    expect(drawn).toEqual([])
    expect(slots[0]?.render({ name: "btw", sessionID: "main" })).toBe("pane")
    expect(drawn.map((input): ReadonlyArray<unknown> => [input.sessionID, input.panel])).toEqual([["main", { name: "btw", sessionID: "main" }]])
  })

  test("the pane's reading comes from the message list, taken again as the host's events about the fork arrive", async () => {
    const host = world({ main: 1 })
    const { command, slots, drawn, emit, pages } = start(host, { type: "session", sessionID: "main" })
    command("btw")?.run("why is it slow?")
    await settle()
    slots[0]?.render({ name: "btw", sessionID: "main" })
    const control = drawn[0]?.controller
    expect(control?.reading("main")).toEqual({ turns: [{ question: "why is it slow?", answer: "" }], replying: true })
    const stop = control?.watch("main")
    answer(host, "ses_fork1", "It sleeps.")
    emit({ type: "session.text.delta", data: { sessionID: "main" } })
    emit({ type: "server.connected", data: {} })
    emit({ type: "session.execution.succeeded", data: { sessionID: "ses_fork1" } })
    await Bun.sleep(SETTLE_MS + 20)
    expect(pages).toEqual(["ses_fork1", "ses_fork1"])
    expect(control?.reading("main").turns.map((turn) => [turn.question, turn.answer])).toEqual([["why is it slow?", "It sleeps."]])
    expect(control?.reading("main").replying).toBe(false)
    stop?.()
  })

  test("its cleanup stops listening to the host's events", () => {
    const { listeners, cleanup } = start(world(), { type: "home" })
    expect(listeners.size).toBe(1)
    cleanup()
    expect(listeners.size).toBe(0)
  })
})
