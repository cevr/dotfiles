// The OpenCode Sessions over a stand-in host built from the laws' world: the
// views `fromContext` hands it, with the host's `Session.NotFoundError` for a
// session it does not have.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { type Delivered, sessionsLaws, type World } from "../laws.ts"
import { Sessions } from "../service.ts"
import { cardOf, type Host, layer, messageOf, notFound, running, type SessionView } from "./sessions.ts"

const missing = (sessionID: string) => ({ _tag: "Session.NotFoundError", sessionID })

const host = (world: World, delivered: Array<Delivered>): Host => {
  const view = (id: string): SessionView | undefined => {
    const session = world.sessions[id]
    if (session === undefined) return undefined
    return {
      id,
      parentID: session.parentID,
      title: session.title,
      agent: session.agent,
      directory: "/work",
      busy: 2,
      idle: session.running ? 1 : 3,
      updated: session.updated,
    }
  }
  return {
    get: (id) => {
      const found = view(id)
      return found === undefined ? Effect.fail(missing(id)) : Effect.succeed(found)
    },
    list: ({ children }) =>
      Effect.succeed(
        Object.entries(world.sessions)
          .filter(([, session]) => session.archived !== true && (children || session.parentID === undefined))
          .flatMap(([id]) => view(id) ?? [])
          .toSorted((left, right) => right.updated - left.updated),
      ),
    synthetic: (input) =>
      world.sessions[input.sessionID] === undefined
        ? Effect.fail(missing(input.sessionID))
        : Effect.sync(() =>
            delivered.push({ sessionID: input.sessionID, text: input.text, description: input.description, metadata: input.metadata, wake: input.resume }),
          ),
  }
}

sessionsLaws("the OpenCode sessions", (world) =>
  Effect.sync(() => {
    const delivered: Array<Delivered> = []
    return { layer: layer(host(world, delivered)), delivered: () => delivered }
  }),
)

describe("reading the host", () => {
  test("a session runs while its latest execution started after the last one ended", () => {
    expect(running({ id: "a", directory: "/", updated: 0 })).toBe(false)
    expect(running({ id: "a", directory: "/", updated: 0, busy: 5 })).toBe(true)
    expect(running({ id: "a", directory: "/", updated: 0, busy: 5, idle: 4 })).toBe(true)
    expect(running({ id: "a", directory: "/", updated: 0, busy: 5, idle: 6 })).toBe(false)
  })

  test("only the host's Session.NotFoundError means no such session", () => {
    expect(notFound(missing("ses_a"))).toBe(true)
    expect(notFound(new Error("Session.NotFoundError"))).toBe(false)
    expect(notFound({ _tag: "Database.Error" })).toBe(false)
  })

  test("another failure of the host is unreadable, with its message", async () => {
    const failing: Host = {
      get: () => Effect.fail(new Error("database is locked")),
      list: () => Effect.fail({ _tag: "Database.Error" }),
      synthetic: () => Effect.fail(new Error("inbox closed")),
    }
    const sessions = layer(failing)
    const [get, list] = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Sessions
        return [yield* Effect.flip(service.get("ses_a")), yield* Effect.flip(service.list({ children: false }))] as const
      }).pipe(Effect.provide(sessions)),
    )
    expect(get).toMatchObject({ _tag: "SessionsUnreadable", message: "database is locked" })
    expect(list).toMatchObject({ _tag: "SessionsUnreadable", message: "Database.Error" })
    expect(messageOf("plain")).toBe("plain")
    expect(cardOf({ id: "a", directory: "/w", updated: 7, busy: 2 })).toEqual({
      id: "a",
      title: undefined,
      directory: "/w",
      agent: undefined,
      running: true,
      parentID: undefined,
      updated: 7,
    })
  })
})
