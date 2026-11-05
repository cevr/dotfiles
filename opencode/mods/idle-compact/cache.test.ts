import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { ANTHROPIC_DEFAULT, defaultTTL, marginOf, OPENAI_DEFAULT, OPENAI_IN_MEMORY, parseTTL, ttlOf } from "./cache.ts"

const MINUTE = 60_000

describe("cache lifetimes", () => {
  test("read OpenCode's cache.ttl format", () => {
    expect(parseTTL("5m")).toEqual(Option.some(5 * MINUTE))
    expect(parseTTL("1h")).toEqual(Option.some(60 * MINUTE))
    expect(parseTTL("20s")).toEqual(Option.some(20_000))
    expect(parseTTL("24h")).toEqual(Option.some(24 * 60 * MINUTE))
    expect(parseTTL("1d")).toEqual(Option.some(24 * 60 * MINUTE))
    expect(parseTTL("0m")).toEqual(Option.none())
    expect(parseTTL("five minutes")).toEqual(Option.none())
    expect(parseTTL("5")).toEqual(Option.none())
  })

  test("Anthropic keeps five minutes; OpenAI thirty from GPT-5.6, five before; another provider is unknown", () => {
    expect(defaultTTL({ providerID: "anthropic", modelID: "claude-opus-5-5" })).toEqual(Option.some(ANTHROPIC_DEFAULT))
    expect(ANTHROPIC_DEFAULT).toBe(5 * MINUTE)
    expect(defaultTTL({ providerID: "openai", modelID: "gpt-5.6" })).toEqual(Option.some(OPENAI_DEFAULT))
    expect(defaultTTL({ providerID: "openai", modelID: "gpt-6.1-sol" })).toEqual(Option.some(OPENAI_DEFAULT))
    expect(OPENAI_DEFAULT).toBe(30 * MINUTE)
    expect(defaultTTL({ providerID: "openai", modelID: "gpt-5.5" })).toEqual(Option.some(OPENAI_IN_MEMORY))
    expect(defaultTTL({ providerID: "openai", modelID: "gpt-4.1" })).toEqual(Option.some(OPENAI_IN_MEMORY))
    // A provider under another id whose catalog entry is Anthropic's.
    expect(defaultTTL({ providerID: "pool-anthropic", canonical: "anthropic", modelID: "claude" })).toEqual(Option.some(ANTHROPIC_DEFAULT))
    expect(defaultTTL({ providerID: "acme", modelID: "acme-1" })).toEqual(Option.none())
  })

  test("a configured ttl wins; one that does not parse leaves the default", () => {
    expect(ttlOf({ providerID: "anthropic", modelID: "claude", configured: "1h" })).toEqual(Option.some(60 * MINUTE))
    expect(ttlOf({ providerID: "acme", modelID: "acme-1", configured: "10m" })).toEqual(Option.some(10 * MINUTE))
    expect(ttlOf({ providerID: "anthropic", modelID: "claude", configured: "soon" })).toEqual(Option.some(ANTHROPIC_DEFAULT))
  })

  test("the short margin for a cache of five minutes or less, the long one for a longer cache", () => {
    const margins = { short: 60_000, long: 5 * MINUTE }
    expect(marginOf(5 * MINUTE, margins)).toBe(60_000)
    expect(marginOf(20_000, margins)).toBe(60_000)
    expect(marginOf(60 * MINUTE, margins)).toBe(5 * MINUTE)
    expect(marginOf(30 * MINUTE, margins)).toBe(5 * MINUTE)
  })
})
