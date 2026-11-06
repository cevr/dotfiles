// SearchProviders over OpenCode's websearch, on a stand-in host
// (memory/providers.ts), under the SearchProviders laws; and the message it
// reads out of the host's wrapped errors.
import { describe, expect, test } from "bun:test"
import { searchProvidersLaws } from "../laws.ts"
import * as MemoryProviders from "../memory/providers.ts"
import { describe as describeError } from "./providers.ts"

searchProvidersLaws(
  "SearchProviders over OpenCode",
  MemoryProviders.layer({
    steady: [{ url: "https://bun.com/docs/test", title: "Test runner", time: {} }],
    down: { fail: "StatusCode: non 2xx status code (429 POST https://mcp.exa.ai/mcp)", status: 429 },
  }),
)

describe("the message of a provider's failure", () => {
  test("is the innermost message the host's wrappers carry", () => {
    expect(describeError({ _tag: "WebSearch.Request", message: "", cause: { message: "web_search_exa request timed out" } })).toBe(
      "web_search_exa request timed out",
    )
  })

  test("names the HTTP status when the message does not", () => {
    expect(describeError({ message: "", cause: { message: "Unauthorized", response: { status: 401 } } })).toBe("HTTP 401: Unauthorized")
  })

  test("is the error itself when nothing carries a message", () => {
    expect(describeError("refused")).toBe("refused")
  })
})
