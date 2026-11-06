import { describe, expect, test } from "bun:test"
import { firstChange, hash, lifetime, segments } from "./fingerprint.ts"

/** A paragraph of about `tokens` tokens. */
const prose = (word: string, tokens: number) => Array.from({ length: tokens }, () => word).join(" ").slice(0, tokens * 4)

const TOOLS = [
  { name: "shell", description: "Run a command.", input_schema: { type: "object" } },
  { name: "read", description: "Read a file.", input_schema: { type: "object" } },
]

/**
 * An Anthropic Messages body as the workbox sends it: a first system block that
 * stays, then a second whose fourth paragraph, about 3k tokens in, carries the
 * date. The marker sits on the last message, as the provider moves it.
 */
const body = (date: string, options: { tools?: ReadonlyArray<unknown>; messages?: number; marker?: number } = {}) => {
  const messages = Array.from({ length: options.messages ?? 3 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [
      {
        type: "text",
        text: `message ${index}`,
        ...(index === (options.marker ?? (options.messages ?? 3) - 1) ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}),
      },
    ],
  }))
  return {
    model: "claude-x",
    tools: options.tools ?? TOOLS,
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      {
        type: "text",
        text: [prose("rules", 1_000), prose("skills", 1_000), prose("agents", 950), `Today is ${date}. The working directory is /work.`, prose("tail", 500)].join("\n\n"),
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages,
  }
}

describe("segments", () => {
  test("tools, then each system paragraph, then each message part, in cache order", () => {
    expect(segments(body("Friday")).map((segment) => segment.label)).toEqual([
      "tool shell",
      "tool read",
      "system[0] ¶1",
      "system[1] ¶1",
      "system[1] ¶2",
      "system[1] ¶3",
      "system[1] ¶4",
      "system[1] ¶5",
      "messages[0] user part 0 (text)",
      "messages[1] assistant part 0 (text)",
      "messages[2] user part 0 (text)",
    ])
  })

  test("a chat-completions body: tools by function name, a system message by paragraph", () => {
    const chat = {
      tools: [{ type: "function", function: { name: "shell" } }],
      messages: [
        { role: "system", content: "One.\n\nTwo." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
      ],
    }
    expect(segments(chat).map((segment) => segment.label)).toEqual([
      "tool shell",
      "messages[0] system ¶1",
      "messages[0] system ¶2",
      "messages[1] user",
      "messages[2] assistant",
    ])
  })

  test("nothing for a body of another shape", () => {
    expect(segments(undefined)).toEqual([])
    expect(segments("text")).toEqual([])
  })

  test("only hashes, lengths and a system paragraph's first words are kept", () => {
    const found = segments(body("Friday"))
    expect(found.find((segment) => segment.label === "system[1] ¶4")?.head).toBe("Today is Friday. The working directory is /work.")
    expect(found.find((segment) => segment.label === "messages[0] user part 0 (text)")).toEqual({
      label: "messages[0] user part 0 (text)",
      hash: expect.any(String),
      chars: expect.any(Number),
    })
  })
})

describe("firstChange", () => {
  test("a dynamic line about 3k tokens into the system prompt is named, with what the cache could still read", () => {
    const change = firstChange(segments(body("Friday")), segments(body("Saturday")))
    expect(change?.segment).toBe("system[1] ¶4")
    expect(change?.head).toBe("Today is Saturday. The working directory is /work.")
    // The tools and the system prompt before the date: about 3k tokens.
    expect(change?.offsetTokens).toBeGreaterThan(2_900)
    expect(change?.offsetTokens).toBeLessThan(3_100)
  })

  test("a moved cache marker is no change; a longer conversation holds the shorter one", () => {
    expect(firstChange(segments(body("Friday", { marker: 0 })), segments(body("Friday", { marker: 2 })))).toBeUndefined()
    expect(firstChange(segments(body("Friday")), segments(body("Friday", { messages: 5 })))).toBeUndefined()
  })

  test("a reordered tool list is named at its first tool", () => {
    expect(firstChange(segments(body("Friday")), segments(body("Friday", { tools: [...TOOLS].reverse() })))).toEqual({
      segment: "tool read",
      previous: "tool shell",
      offsetTokens: 0,
    })
  })

  test("an edited earlier message is named by its index", () => {
    const before = body("Friday", { messages: 5 })
    const after = body("Friday", { messages: 5 })
    after.messages[3] = { role: "assistant", content: [{ type: "text", text: "rewritten" }] }
    expect(firstChange(segments(before), segments(after))?.segment).toBe("messages[3] assistant part 0 (text)")
  })

  test("a prompt that stops short of the one before it changed at its end", () => {
    expect(firstChange(segments(body("Friday", { messages: 5 })), segments(body("Friday", { messages: 3 }))))
      .toMatchObject({ segment: "end of prompt", previous: "messages[3] assistant part 0 (text)" })
  })
})

describe("lifetime", () => {
  test("the longest marker's ttl, Anthropic's 5 minutes for a marker naming none, the pool's header over both", () => {
    expect(lifetime(body("Friday"))).toEqual({ ttlMs: 3_600_000, explicit: true })
    expect(lifetime({ messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }] })).toEqual({
      ttlMs: 300_000,
      explicit: true,
    })
    expect(lifetime(body("Friday"), "5m")).toEqual({ ttlMs: 300_000, explicit: true })
  })

  test("a body with no marker is cached by its provider: OpenAI's 30 minutes", () => {
    expect(lifetime({ input: [] })).toEqual({ ttlMs: 1_800_000, explicit: false })
  })

  test("an OpenAI body's request-level lifetime names its cache's, the pool's header over it", () => {
    expect(lifetime({ messages: [], prompt_cache_options: { ttl: "2s" } })).toEqual({ ttlMs: 2_000, explicit: false })
    expect(lifetime({ input: [], prompt_cache_retention: "24h" })).toEqual({ ttlMs: 86_400_000, explicit: false })
    expect(lifetime({ input: [], prompt_cache_retention: "in_memory" })).toEqual({ ttlMs: 1_800_000, explicit: false })
    expect(lifetime({ messages: [], prompt_cache_options: { ttl: "2s" } }, "1h")).toEqual({ ttlMs: 3_600_000, explicit: false })
  })
})

test("hash tells apart texts that differ in one character", () => {
  expect(hash("Today is Friday")).not.toBe(hash("Today is Fridax"))
  expect(hash("same")).toBe(hash("same"))
})
