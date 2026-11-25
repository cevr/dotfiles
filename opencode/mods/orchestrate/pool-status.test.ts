// Pool quota rows appended to orchestrate status and land answers: Claude,
// OpenAI, and Antigravity per group (rows only, no prose).
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { decodeAntigravity, decodePools, poolStatusRows } from "./pool-status.ts"

const NOW = Date.parse("2026-11-25T02:00:00Z")

describe("orchestrate pool status rows", () => {
  test("shows Antigravity per group beside Claude and OpenAI, rows only", () => {
    const pools = decodePools({
      anthropic: {
        accounts: [
          {
            credentialID: "store:alpha",
            reading: {
              windows: [
                { name: "5h", utilization: 0.25, resetAt: NOW + 3_600_000 },
                { name: "7d", utilization: 0.42, resetAt: NOW + 48 * 3_600_000 },
              ],
            },
          },
        ],
      },
      openai: {
        accounts: [
          {
            credentialID: "chatgpt",
            hold: { kind: "usage-limit", until: NOW + 7_200_000 },
          },
        ],
      },
    })
    const antigravity = decodeAntigravity({
      lines: [
        "antigravity / Gemini · open",
        "  5h 12% used of 100% · reset Nov 25, 2026, 1:00:00 AM EST",
        "  7d 20% used of 100% · reset Nov 30, 2026, 8:00:00 PM EST",
        "antigravity / Claude & GPT (shared) · limited until Nov 24, 2026, 10:05:00 PM EST (a pane's limit)",
        "  5h 100% used of 100% · reset Nov 24, 2026, 10:05:00 PM EST",
        "  7d unknown: the weekly window is unknown",
        "  peer workbox · stale (5 min ago): ssh timed out",
      ],
    })
    const rows = poolStatusRows(pools, antigravity)
    expect(rows.some((row) => row.startsWith("anthropic / store:alpha"))).toBe(true)
    expect(rows.some((row) => row.startsWith("openai / chatgpt") && row.includes("held (usage-limit)"))).toBe(true)
    expect(rows.some((row) => row.startsWith("antigravity / Gemini"))).toBe(true)
    expect(rows.some((row) => row.startsWith("antigravity / Claude & GPT (shared)"))).toBe(true)
    expect(rows.some((row) => row.includes("peer workbox · stale"))).toBe(true)
  })

  test("returns no rows when neither pools nor antigravity answered", () => {
    expect(poolStatusRows(Option.none(), Option.none())).toEqual([])
    expect(poolStatusRows(decodePools({}), decodeAntigravity({ lines: [] }))).toEqual([])
  })
})
