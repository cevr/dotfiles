import { describe, expect, test } from "bun:test"
import { catalog, descendants, hits, sessionCatalog, timeline, type Reads } from "./view.ts"

/** An assistant message as the fork's TUI holds it (packages/schema/src/session-message.ts, `Assistant`, encoded). */
const assistant = (id: string, at: number, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  id,
  agent: "build",
  model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
  content: [],
  tokens: { input: 1_000, output: 200, reasoning: 0, cache: { read: 30_000, write: 9_000 } },
  time: { created: at, streamed: at + 1_500, completed: at + 1_600 },
  ...extra,
})

describe("timeline", () => {
  test("an assistant message is a step: its prompt sums uncached input, reads and writes; its tool calls are spans", () => {
    const shell = { type: "tool", id: "call_1", name: "shell", state: { status: "completed" }, time: { created: 1_200, ran: 1_400, completed: 9_400 } }
    const streaming = { type: "tool", id: "call_2", name: "read", state: { status: "streaming" }, time: { created: 1_300 } }
    const [step] = timeline([assistant("msg_a", 1_000, { content: [{ type: "text", text: "hi" }, shell, streaming], finish: "tool-calls" })])
    expect(step).toEqual({
      type: "step",
      id: "msg_a",
      model: "anthropic/claude-sonnet-4-5",
      startedAt: 1_000,
      endedAt: 2_500,
      usage: { promptTokens: 40_000, cacheReadTokens: 30_000, cacheWriteTokens: 9_000 },
      tools: [{ name: "shell", at: 1_400, ms: 8_000 }],
      opener: { id: "start", kind: "other" },
      closes: false,
    })
  })

  test("a step without usage has none; an unfinished one ends when it was created", () => {
    const [step] = timeline([{ ...assistant("msg_a", 1_000), tokens: undefined, time: { created: 1_000 } }])
    expect(step).toMatchObject({ type: "step", endedAt: 1_000 })
    expect(step !== undefined && "usage" in step).toBe(false)
  })

  test("the first input after an idle marker opens a turn; a subagent's report is its own kind; input inside a turn does not", () => {
    const entries = timeline([
      { type: "user", id: "msg_u1", time: { created: 0 } },
      assistant("msg_a", 10, { finish: "tool-calls" }),
      { type: "user", id: "msg_steer", time: { created: 20 } },
      assistant("msg_b", 30, { finish: "stop" }),
      { type: "idle", id: "msg_idle", outcome: "succeeded", time: { created: 40 } },
      { type: "synthetic", id: "msg_report", metadata: { source: "subagent", childID: "ses_child", state: "completed" }, text: "done", time: { created: 50 } },
      assistant("msg_c", 60, { error: { type: "unknown", message: "boom" } }),
      { type: "compaction", id: "msg_compact", status: "completed", reason: "auto", summary: "…", time: { created: 70 } },
      { type: "compaction", id: "msg_running", status: "running", reason: "auto", summary: "", time: { created: 80 } },
    ])
    expect(entries.map((entry) => (entry.type === "step" ? [entry.id, entry.opener, entry.closes] : entry.type))).toEqual([
      ["msg_a", { id: "msg_u1", kind: "prompt" }, false],
      ["msg_b", { id: "msg_u1", kind: "prompt" }, true],
      ["msg_c", { id: "msg_report", kind: "subagent" }, true],
      "compaction",
    ])
  })
})

describe("catalog", () => {
  const models = [
    {
      id: "claude-sonnet-4-5",
      providerID: "anthropic",
      cost: [
        { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        { tier: { type: "context", size: 200_000 }, input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
      ],
    },
    { id: "gpt-sim-model", providerID: "simulation", settings: { cache: { ttl: "2s" } }, cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }] },
    { id: "local", providerID: "ollama", cost: [] },
    { id: "broken" },
  ]
  test("each model's family, lifetime and rates, by providerID/modelID; the provider's ttl applies to its models", () => {
    const terms = catalog(models, [{ id: "ollama", settings: { cache: { ttl: "10m" } } }])
    expect(terms.get("anthropic/claude-sonnet-4-5")).toEqual({
      family: "anthropic",
      lifetimeMs: 300_000,
      rates: [
        { input: 3, cacheRead: 0.3, cacheWrite: 3.75 },
        { tier: 200_000, input: 6, cacheRead: 0.6, cacheWrite: 7.5 },
      ],
    })
    expect(terms.get("simulation/gpt-sim-model")?.lifetimeMs).toBe(2_000)
    expect(terms.get("ollama/local")).toEqual({ lifetimeMs: 600_000, rates: [] })
    expect(terms.has("undefined/broken")).toBe(false)
  })
})

describe("the family reads", () => {
  type Location = { readonly directory: string }
  const sessions: Record<string, { parentID?: string; location: Location; tokens: { input: number; cache: { read: number; write: number } } }> = {
    ses_root: { location: { directory: "/repo" }, tokens: { input: 1_000, cache: { read: 90_000, write: 9_000 } } },
    ses_child: { parentID: "ses_root", location: { directory: "/repo" }, tokens: { input: 0, cache: { read: 0, write: 0 } } },
    ses_grandchild: { parentID: "ses_child", location: { directory: "/repo" }, tokens: { input: 500, cache: { read: 4_500, write: 5_000 } } },
    ses_sibling: { parentID: "ses_root", location: { directory: "/repo" }, tokens: { input: 7, cache: { read: 7, write: 7 } } },
  }
  const asked: Array<Location | undefined> = []
  const reads: Reads<Location> = {
    session: {
      get: (id) => sessions[id],
      family: () => Object.keys(sessions),
      message: { list: () => [] },
    },
    location: {
      model: {
        list: (location) => {
          asked.push(location)
          return [{ id: "claude-sonnet-4-5", providerID: "anthropic", cost: [] }]
        },
      },
      provider: { list: () => undefined },
    },
  }

  test("a session and every session under it, not its siblings", () => {
    expect(descendants(reads, "ses_root")).toEqual(["ses_root", "ses_child", "ses_grandchild", "ses_sibling"])
    expect(descendants(reads, "ses_child")).toEqual(["ses_child", "ses_grandchild"])
  })

  test("their token totals, from each session's summed usage", () => {
    expect(hits(reads, ["ses_root", "ses_grandchild"])).toEqual({ promptTokens: 110_000, cacheReadTokens: 94_500, cacheWriteTokens: 14_000 })
  })

  test("the catalog of the session's own location", () => {
    expect([...sessionCatalog(reads, "ses_child").keys()]).toEqual(["anthropic/claude-sonnet-4-5"])
    expect(asked).toEqual([{ directory: "/repo" }])
  })
})
