import { describe, expect, test } from "bun:test"
import { DEFAULT_TTL_MS, familyOf, lifetimeMs, parseTtl } from "./ttl.ts"

describe("parseTtl", () => {
  test("reads models.dev's duration format", () => {
    expect(parseTtl("5m")).toBe(300_000)
    expect(parseTtl("1h")).toBe(3_600_000)
    expect(parseTtl("30s")).toBe(30_000)
    expect(parseTtl("250ms")).toBe(250)
    expect(parseTtl("1d")).toBe(86_400_000)
    expect(parseTtl("5 minutes")).toBeUndefined()
  })
})

describe("familyOf", () => {
  test("by provider, else by the model's id", () => {
    expect(familyOf("anthropic", "claude-opus-4-5")).toBe("anthropic")
    expect(familyOf("openrouter", "anthropic/claude-sonnet-4.5")).toBe("anthropic")
    expect(familyOf("openai", "gpt-5.5")).toBe("openai")
    expect(familyOf("opencode", "gpt-5.5-codex")).toBe("openai")
    expect(familyOf("deepseek", "deepseek-chat")).toBeUndefined()
  })
})

describe("lifetimeMs", () => {
  test("the model's setting wins over the provider's, which wins over the family's default", () => {
    expect(lifetimeMs({ providerID: "anthropic", modelID: "claude-opus-4-5", modelTtl: "1h", providerTtl: "5m" })).toBe(3_600_000)
    expect(lifetimeMs({ providerID: "anthropic", modelID: "claude-opus-4-5", providerTtl: "1h" })).toBe(3_600_000)
    expect(lifetimeMs({ providerID: "anthropic", modelID: "claude-opus-4-5" })).toBe(DEFAULT_TTL_MS.anthropic)
    expect(lifetimeMs({ providerID: "openai", modelID: "gpt-5.5" })).toBe(DEFAULT_TTL_MS.openai)
  })

  test("Anthropic's default is 5 minutes; OpenAI's measured guess is 30", () => {
    expect(DEFAULT_TTL_MS).toEqual({ anthropic: 300_000, openai: 1_800_000 })
  })

  test("a model of no known family and no setting has no lifetime; a setting that does not parse is skipped", () => {
    expect(lifetimeMs({ providerID: "deepseek", modelID: "deepseek-chat" })).toBeUndefined()
    expect(lifetimeMs({ providerID: "deepseek", modelID: "deepseek-chat", modelTtl: "soon", providerTtl: "10m" })).toBe(600_000)
  })
})
