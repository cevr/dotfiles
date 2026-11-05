// What the /pool pane draws: account rows with their holds and both windows,
// running agents named by their call, unit lines, and which read failed.
import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { accountRows, agentRows, PanePools, stamp, unavailable, unitLine } from "./pane.ts"

const now = Date.parse("2026-11-04T15:00:00Z")

describe("stamp", () => {
  test("a time to the minute in UTC, or unknown", () => {
    expect(stamp(now + 3_600_000)).toBe("2026-11-04 16:00Z")
    expect(stamp(undefined)).toBe("unknown")
  })
})

describe("accountRows", () => {
  test("an available account and a held one, with both windows each", () => {
    const pools = {
      anthropic: {
        accounts: [
          {
            credentialID: "gent:alpha",
            reading: { windows: [{ name: "5h", utilization: 0.234, resetAt: now + 3_600_000 }, { name: "7d", utilization: 0.44 }] },
          },
          { credentialID: "gent:beta", hold: { kind: "usage-limit", until: now + 7_200_000 } },
        ],
      },
    }
    expect(accountRows(pools)).toEqual([
      {
        held: false,
        title: "anthropic / gent:alpha · available",
        windows: ["  5h 23% · reset 2026-11-04 16:00Z", "  7d 44% · reset unknown"],
      },
      {
        held: true,
        title: "anthropic / gent:beta · held (usage-limit) until 2026-11-04 17:00Z",
        windows: ["  5h unknown · reset unknown", "  7d unknown · reset unknown"],
      },
    ])
  })

  test("no pools, no rows", () => {
    expect(accountRows({})).toEqual([])
    expect(accountRows({ anthropic: { accounts: [] } })).toEqual([])
  })

  test("the pool's full answer decodes, keeping only what the pane draws", () => {
    const answer = {
      anthropic: {
        accounts: [
          {
            credentialID: "gent:beta",
            live: 0,
            load: 2,
            noRoom: true,
            hold: { kind: "usage-limit", until: now, at: now },
            reading: { at: now, windows: [{ name: "5h", utilization: 1, resetAt: now }] },
          },
        ],
        sources: [],
      },
    }
    const decoded = Schema.decodeUnknownOption(PanePools)(answer)
    expect(Option.map(decoded, accountRows)).toEqual(
      Option.some([
        {
          held: true,
          title: "anthropic / gent:beta · held (usage-limit) until 2026-11-04 15:00Z",
          windows: ["  5h 100% · reset 2026-11-04 15:00Z", "  7d unknown · reset unknown"],
        },
      ]),
    )
    expect(Option.isNone(Schema.decodeUnknownOption(PanePools)({ anthropic: { accounts: [{ credentialID: 7 }] } }))).toBe(true)
  })
})

describe("agentRows", () => {
  const calls = [{ sessionID: "ses_1", callID: "a", agent: "worker", description: "implementor pane r1", child: "ses_a" }]

  test("a running child is named by its agent and described by the call that started it", () => {
    expect(agentRows([{ id: "ses_a", agent: "implementor", title: "Child title" }], calls)).toEqual([
      { id: "ses_a", role: "implementor", description: "implementor pane r1" },
    ])
  })

  test("without its own agent, the call's; without a call, its title, else its id", () => {
    expect(agentRows([{ id: "ses_a" }, { id: "ses_b", title: "Other" }, { id: "ses_c" }], calls)).toEqual([
      { id: "ses_a", role: "worker", description: "implementor pane r1" },
      { id: "ses_b", role: "agent", description: "Other" },
      { id: "ses_c", role: "agent", description: "ses_c" },
    ])
  })
})

describe("unitLine", () => {
  test("a unit with its round, and one with none yet", () => {
    expect(unitLine({ unit: "wake", state: "implement", round: "1", since: "2026-11-04T15:00Z" })).toBe("  wake · implement · r1 · 2026-11-04T15:00Z")
    expect(unitLine({ unit: "fresh", state: "plan", round: "", since: "" })).toBe("  fresh · plan · r? · ")
  })
})

describe("unavailable", () => {
  test("names each read that failed", () => {
    expect(unavailable(false, false)).toEqual([])
    expect(unavailable(true, false)).toEqual(["Pool unavailable; keeping last reading"])
    expect(unavailable(true, true)).toEqual(["Pool unavailable; keeping last reading", "Agents and runs unavailable; keeping last reading"])
  })
})
