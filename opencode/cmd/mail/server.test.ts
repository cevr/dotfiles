// The plugin seam: the composition root on a stand-in host whose tool editor
// the test reads, its sessions read through the OpenCode adapter over a world
// in memory. It checks what OpenCode sees: two direct tools, the listing, a
// message reaching the host's `session.synthetic` with the sender's header, a
// steer or a wake by the receiver's state, and each refusal as a Tool.Error.
// tests/mail.test.ts runs it in OpenCode, on a scripted model.
import { describe, expect, test } from "bun:test"
import type { Tool } from "@opencode/plugin/effect"
import { Effect, Logger, type Scope } from "effect"
import { type Host as SessionsHost, layer as sessionsLayer, type SessionView, type Synthetic } from "@dotfiles/opencode-mail/opencode/sessions"
import MailPlugin, { make } from "./server.ts"

type Host = Parameters<(typeof MailPlugin)["effect"]>[0]

/** A tool as the host's editor receives it: only what the tests read. */
interface Added {
  readonly name: string
  readonly description: string
  readonly options?: { readonly codemode?: boolean }
  readonly execute: (
    input: unknown,
    context: unknown,
  ) => Effect.Effect<{ readonly content: ReadonlyArray<Tool.Content>; readonly metadata?: Record<string, unknown> }, Tool.Error>
}

const NOW = Date.now()

/** The host's sessions, kept in memory, and the synthetic messages it took in. */
const world = () => {
  const sessions = new Map<string, SessionView>()
  const synthetic: Array<Synthetic> = []
  const missing = (sessionID: string) => Effect.fail({ _tag: "Session.NotFoundError", sessionID })
  const host: SessionsHost = {
    get: (id) => {
      const found = sessions.get(id)
      return found === undefined ? missing(id) : Effect.succeed(found)
    },
    list: ({ children }) =>
      Effect.sync(() => [...sessions.values()].filter((session) => children || session.parentID === undefined).toSorted((left, right) => right.updated - left.updated)),
    synthetic: (input) => (sessions.has(input.sessionID) ? Effect.sync(() => void synthetic.push(input)) : missing(input.sessionID)),
  }
  const session = (id: string, fields: Partial<SessionView> & { readonly running?: boolean } = {}) => {
    const { running, ...rest } = fields
    sessions.set(id, { id, directory: "/work", updated: NOW, ...(running ? { busy: 2, idle: 1 } : { busy: 1, idle: 2 }), ...rest })
  }
  return { synthetic, host, session }
}
type World = ReturnType<typeof world>

// Quiet: the deliveries' log lines are checked in the model's test.
const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body).pipe(Effect.provide(Logger.layer([]))))

/** The plugin started on a stand-in host over `state`: its tools, and a call of each as a session. */
const start = (state: World) =>
  Effect.gen(function* () {
    const added: Array<Added> = []
    const host = {
      options: {},
      tool: {
        transform: (callback: (editor: { add: (tool: Added) => void }) => void) =>
          Effect.sync(() => {
            callback({ add: (tool) => void added.push(tool) })
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Host
    yield* make(() => sessionsLayer(state.host)).effect(host)
    const execute = (name: string, input: unknown, sessionID: string) => {
      const tool = added.find((item) => item.name === name)
      return tool === undefined
        ? Effect.die(new Error(`no tool ${name}`))
        : tool.execute(input, { sessionID, agent: "build", messageID: "msg_1", id: "call_1", progress: () => Effect.void })
    }
    const textOf = (result: { readonly content: ReadonlyArray<Tool.Content> }) =>
      result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    const call = (name: string, input: unknown, sessionID = "ses_a") => execute(name, input, sessionID).pipe(Effect.map(textOf))
    const fail = (name: string, input: unknown, sessionID = "ses_a") => Effect.flip(execute(name, input, sessionID)).pipe(Effect.map((error) => error.message))
    return { added, call, fail, execute }
  })

const team = () => {
  const state = world()
  state.session("ses_a", { title: "Bite PR", agent: "build", running: true })
  state.session("ses_b", { title: "Dotfiles", agent: "build", updated: NOW - 60_000 })
  state.session("ses_c", { title: "Dotfiles review", updated: NOW - 120_000 })
  state.session("ses_w", { title: "Fix money", parentID: "ses_a", agent: "worker", running: true, updated: NOW - 10_000 })
  return state
}

describe("the mail plugin", () => {
  test("adds two direct tools, sessions and message, that say how to use them", () =>
    scenario(
      Effect.gen(function* () {
        const { added } = yield* start(world())
        expect(added.map((tool) => [tool.name, tool.options?.codemode])).toEqual([
          ["sessions", false],
          ["message", false],
        ])
        expect(added[0]?.description).toContain("message tool")
        expect(added[1]?.description).toContain("sessions tool")
        expect(added[1]?.description).toContain("wake: false")
      }),
    ))

  test("sessions lists the main sessions and marks the caller; children adds the subagents'", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start(team())
        const main = yield* plugin.call("sessions", {}, "ses_b")
        expect(main.split("\n")).toEqual([
          "Sessions (3):",
          'ses_a "Bite PR" · running · build · /work · just now',
          'ses_b "Dotfiles" · idle · build · /work · 1m ago (you)',
          'ses_c "Dotfiles review" · idle · /work · 2m ago',
        ])
        expect(yield* plugin.call("sessions", { children: true, search: "money" })).toBe(
          'Sessions (1):\nses_w "Fix money" · running · worker · /work · 10s ago · child of ses_a',
        )
      }),
    ))

  test("message wakes an idle session with a steer naming the sender and how to answer", () =>
    scenario(
      Effect.gen(function* () {
        const state = team()
        const plugin = yield* start(state)
        const result = yield* plugin.execute("message", { to: "ses_b", text: "Rebase on main, please." }, "ses_a")
        expect(result.content).toEqual([{ type: "text", text: 'Delivered to session "Dotfiles" (ses_b). It was idle and is now reading it.' }])
        expect(result.metadata).toEqual({ to: "ses_b", delivery: "woke" })
        expect(state.synthetic).toEqual([
          {
            sessionID: "ses_b",
            text: [
              '✉ Message from session "Bite PR" (ses_a), sent with the message tool. It is not the user speaking.',
              'To answer, call the message tool with { "to": "ses_a", "text": "…" }; answer only if it asks for something.',
              "",
              "Rebase on main, please.",
            ].join("\n"),
            description: "from Bite PR · Rebase on main, please.",
            metadata: { source: "mail", from: { sessionID: "ses_a", title: "Bite PR" }, replyTo: { sessionID: "ses_a", title: "Bite PR" } },
            delivery: "steer",
            resume: true,
          },
        ])
      }),
    ))

  test("message to a running session by title is a steer it reads at its next step; wake: false does not wake", () =>
    scenario(
      Effect.gen(function* () {
        const state = team()
        const plugin = yield* start(state)
        expect(yield* plugin.call("message", { to: "Bite PR", text: "ready" }, "ses_b")).toBe(
          'Delivered to session "Bite PR" (ses_a). It is running and reads it at its next step.',
        )
        expect(yield* plugin.call("message", { to: "review", text: "later", wake: false }, "ses_b")).toBe(
          'Delivered to session "Dotfiles review" (ses_c). It is idle and reads it at its next turn (not woken).',
        )
        expect(state.synthetic.map((item) => [item.sessionID, item.delivery, item.resume])).toEqual([
          ["ses_a", "steer", true],
          ["ses_c", "steer", false],
        ])
      }),
    ))

  test("a subagent writes to its parent, naming another session to answer", () =>
    scenario(
      Effect.gen(function* () {
        const state = team()
        const plugin = yield* start(state)
        yield* plugin.call("message", { to: "ses_a", text: "blocked on a login", replyTo: "ses_b" }, "ses_w")
        expect(state.synthetic[0]?.text.split("\n")[1]).toBe(
          'Answers go to session "Dotfiles" (ses_b): call the message tool with { "to": "ses_b", "text": "…" }; answer only if it asks for something.',
        )
        expect(state.synthetic[0]?.description).toBe("from Fix money · blocked on a login")
      }),
    ))

  test("refuses its own session, a session that does not exist and an ambiguous title, delivering nothing", () =>
    scenario(
      Effect.gen(function* () {
        const state = team()
        const plugin = yield* start(state)
        expect(yield* plugin.fail("message", { to: "ses_a", text: "hi" })).toBe("That is your own session (ses_a). Write to another one.")
        expect(yield* plugin.fail("message", { to: "ses_gone", text: "hi" })).toBe(
          'No session on this server is "ses_gone". List them with the sessions tool, and give an id (ses_…) or a title.',
        )
        expect(yield* plugin.fail("message", { to: "otfiles", text: "hi" })).toBe(
          'More than one session matches "otfiles": ses_b "Dotfiles", ses_c "Dotfiles review". Give the id.',
        )
        expect(yield* plugin.fail("message", { to: "ses_b", text: "  " })).toBe("The message has no text.")
        expect(state.synthetic).toEqual([])
      }),
    ))

  test("a session gone between the lookup and the delivery is a refusal the agent reads", () =>
    scenario(
      Effect.gen(function* () {
        const state = team()
        const host: SessionsHost = { ...state.host, synthetic: (input) => Effect.fail({ _tag: "Session.NotFoundError", sessionID: input.sessionID }) }
        const plugin = yield* start({ ...state, host })
        expect(yield* plugin.fail("message", { to: "ses_b", text: "hi" })).toBe("OpenCode did not take the message into session ses_b: no such session")
      }),
    ))
})
