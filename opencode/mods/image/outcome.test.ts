import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { DETAIL_LIMIT, detail, fail, failureWords, redact, words } from "./outcome.ts"

describe("redact", () => {
  test("cuts out each named secret and anything shaped like a credential", () => {
    const text = 'echo: {"authorization":"Bearer abc.def-123","chatgpt-account-id":"acct-42","x":"sk-proj-ABCDEFGH12345678","t":"eyJhbGciOi.eyJzdWIi.c2ln"}'
    const clean = redact(text, ["acct-42", "abc.def-123"])
    expect(clean).not.toContain("abc.def-123")
    expect(clean).not.toContain("acct-42")
    expect(clean).not.toContain("sk-proj-ABCDEFGH12345678")
    expect(clean).not.toContain("eyJhbGciOi")
    expect(clean).toContain("[redacted]")
  })

  test("leaves text without secrets alone, and ignores secrets too short to name", () => {
    expect(redact("Rate limit exceeded", ["ab"])).toBe("Rate limit exceeded")
  })
})

describe("detail", () => {
  test("is at most DETAIL_LIMIT characters, redacted, and says so when the server sent nothing", () => {
    expect(detail("x".repeat(500), [])).toHaveLength(DETAIL_LIMIT + 1)
    expect(detail(`${"y".repeat(290)}TOKEN-SECRET-1`, ["TOKEN-SECRET-1"])).not.toContain("TOKEN-SECRET-1")
    expect(detail("  ", [])).toBe("no error detail in response")
  })
})

describe("words", () => {
  test("an outcome names its route, each file with its dimensions, and its note", () => {
    expect(
      words({
        route: "subscription",
        saved: [{ path: "/o/a.png", width: Option.some(1254), height: Option.some(1254) }],
        note: Option.some("Note: changed."),
      }),
    ).toBe("Saved via subscription:\n- /o/a.png (1254x1254)\nNote: changed.\nRead the path to view it.")
    expect(words({ route: "paid: x", saved: [{ path: "/o/b", width: Option.none(), height: Option.none() }], note: Option.none() })).toBe(
      "Saved via paid: x:\n- /o/b\nRead the path to view it.",
    )
  })

  test("a failure names its code, message, route and fix", () => {
    expect(failureWords("subscription", fail("AUTH_MISSING", "No codex credentials."))).toBe(
      "[AUTH_MISSING] No codex credentials.\nRoute: subscription.\nSign in with `codex login` (subscription), or set OPENAI_API_KEY / store a key with `bun cmd/image/key.ts set --stdin` (paid).",
    )
  })
})
