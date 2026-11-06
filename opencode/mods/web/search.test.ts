import { describe, expect, test } from "bun:test"
import { chain, DEFAULT_ORDER, defaultSelection, exhausted, SELF } from "./search.ts"

describe("chain", () => {
  test("keeps the order's providers the host has, once each, never the mod's own", () => {
    expect(chain(["exa", "brave", "web", "tavily", "exa"], ["tavily", "exa", "web", "parallel"])).toEqual(["exa", "tavily"])
  })

  test("the default order is the host's keyless built-ins, Exa first", () => {
    expect(chain(DEFAULT_ORDER, ["exa", "firecrawl", "parallel", "tavily", "tinyfish", SELF])).toEqual(["exa", "parallel", "tavily", "firecrawl", "tinyfish"])
  })
})

describe("defaultSelection", () => {
  test("is the mod's provider when nothing chose one, and leaves a choice or a disable alone", () => {
    expect(defaultSelection(undefined)).toBe(SELF)
    expect(defaultSelection("exa")).toBeUndefined()
    expect(defaultSelection("random")).toBeUndefined()
    expect(defaultSelection(false)).toBeUndefined()
  })
})

describe("exhausted", () => {
  test("names each provider's failure", () => {
    expect(exhausted([{ provider: "exa", message: "HTTP 429" }, { provider: "tavily", message: "timed out" }], ["exa", "tavily"]).message).toBe(
      "every web search provider failed: exa: HTTP 429; tavily: timed out",
    )
  })

  test("says when the host has none of them", () => {
    expect(exhausted([], ["brave"]).message).toBe("no web search provider of brave is registered")
  })
})
