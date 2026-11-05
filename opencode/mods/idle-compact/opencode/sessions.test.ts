// The OpenCode Sessions over a stand-in host built from the laws' world: the
// views `fromContext` hands it, with the host's failures for an unknown
// session and a refused compaction.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sessionsLaws, type World } from "../laws.ts"
import { type Host, layer, lastRequest, type MessageView, running, type SessionView } from "./sessions.ts"

const host = (world: World, compacted: Array<string>): Host => {
  const view = (id: string): SessionView | undefined => {
    const session = world.sessions[id]
    if (session === undefined) return undefined
    return {
      id,
      parentID: session.parentID,
      title: session.title,
      directory: session.directory ?? "/work",
      workspaceID: session.workspaceID,
      busy: 2,
      idle: session.running ? 1 : 3,
    }
  }
  const missing = (id: string) => Effect.fail(new Error(`no session ${id}`))
  return {
    location: world.location,
    session: (id) => {
      const found = view(id)
      return found === undefined ? missing(id) : Effect.succeed(found)
    },
    messages: (id) => {
      const session = world.sessions[id]
      if (session === undefined) return missing(id)
      return Effect.succeed(
        (session.messages ?? []).map((message): MessageView => {
          if (message.kind === "user") return { type: "other" }
          if (message.kind === "compaction") return { type: "compaction" }
          return {
            type: "assistant",
            created: message.startedAt,
            tokens: { input: message.input, cache: { read: message.read, write: message.write } },
            model: { providerID: message.providerID, id: message.modelID },
            agent: message.agent ?? "build",
          }
        }),
      )
    },
    children: (id) =>
      Effect.succeed(
        Object.entries(world.sessions)
          .filter(([, session]) => session.parentID === id)
          .flatMap(([child]) => view(child) ?? []),
      ),
    model: (ref) => {
      const found = world.models.find((model) => model.providerID === ref.providerID && model.modelID === ref.id)
      if (found?.unreadable === true) return Effect.fail(new Error(`provider ${ref.providerID} cannot be read`))
      if (found === undefined) return Effect.succeed(undefined)
      const { cost } = found
      return Effect.succeed({
        providerID: found.providerID,
        modelID: found.modelID,
        window: found.window,
        ttl: found.ttl,
        rates: cost === undefined ? [] : [{ input: cost.input, output: cost.output, cacheRead: cost.read, cacheWrite: cost.write }],
      })
    },
    agentTTL: (id) => {
      const agent = world.agents[id]
      return agent === undefined ? Effect.fail(new Error(`Agent not found: ${id}`)) : Effect.succeed(agent.cacheTTL)
    },
    roots: Effect.succeed(
      Object.entries(world.sessions)
        .filter(([, session]) => session.parentID === undefined)
        .flatMap(([id]) => view(id) ?? []),
    ),
    compact: (id) =>
      (world.refuse ?? []).includes(id) ? Effect.fail(new Error("busy")) : Effect.sync(() => void compacted.push(id)),
  }
}

sessionsLaws("OpenCode Sessions", (world) =>
  Effect.sync(() => {
    const compacted: Array<string> = []
    return { layer: layer(host(world, compacted)), compacted: () => compacted }
  }),
)

describe("reading OpenCode's records", () => {
  test("an execution runs while its start is later than the last end", () => {
    expect(running({ id: "s", directory: "/", busy: 5, idle: 4 })).toBe(true)
    expect(running({ id: "s", directory: "/", busy: 5 })).toBe(true)
    expect(running({ id: "s", directory: "/", busy: 5, idle: 5 })).toBe(false)
    expect(running({ id: "s", directory: "/" })).toBe(false)
  })

  test("a failed step without usage is passed over for the last request that has it", () => {
    const usage = { input: 1, cache: { read: 2, write: 3 } }
    const model = { providerID: "anthropic", id: "claude-x" }
    const found = lastRequest([
      { type: "assistant", created: 1, tokens: usage, model, agent: "build" },
      { type: "assistant", created: 2, model, agent: "build" },
    ])
    expect(found.compacted).toBe(false)
    expect(found.message._tag === "Some" ? found.message.value.created : undefined).toBe(1)
  })
})
