// What the /pool pane draws: account rows with their holds and both windows,
// running agents named by their call, unit lines, and which read failed.
import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { accountRows, agentRows, fleetRows, PaneFleet, PaneLimits, PanePools, PaneResets, resetRows, resetsLine, stamp, unavailable, unitLine } from "./pane.ts"

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

  test("each model's own window and the resets an account can claim follow its windows, and sum on one line", () => {
    const pools = {
      anthropic: {
        accounts: [
          {
            credentialID: "gent:alpha",
            reading: {
              windows: [
                { name: "7d", utilization: 0.5 },
                { name: "7d:Fable", utilization: 0.12, resetAt: now + 3_600_000 },
              ],
              resets: { available: 2, nextExpiresAt: Date.parse("2026-11-30T20:04:00Z") },
            },
          },
          { credentialID: "gent:beta", reading: { windows: [], resets: { available: 0 } } },
        ],
      },
      openai: { accounts: [{ credentialID: "chatgpt", reading: { windows: [], resets: { available: 1 } } }] },
    }
    expect(accountRows(pools)[0]?.windows).toEqual([
      "  5h unknown · reset unknown",
      "  7d 50% · reset unknown",
      "  Fable 7d 12% · reset 2026-11-04 16:00Z",
      "  resets 2 · until 2026-11-30",
    ])
    expect(accountRows(pools)[1]?.windows).toEqual(["  5h unknown · reset unknown", "  7d unknown · reset unknown"])
    expect(resetsLine(pools)).toBe("resets: 2 (Claude, until 2026-11-30) · 1 (Codex)")
    expect(resetsLine({ anthropic: { accounts: [{ credentialID: "a", reading: { windows: [], resets: { available: 0 } } }] } })).toBeUndefined()
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

describe("fleetRows", () => {
  test("this host's new agents, a peer read with its own, and a peer that cannot be read, flagged", () => {
    const fleet = {
      host: "Cristians-MacBook-Pro.local",
      starts: 1,
      settleMinutes: 10,
      peers: [
        { name: "workbox", host: "bite-cristian", seenAt: now, starts: 3 },
        { name: "studio", starts: 0, missed: { since: now - 60_000, message: "ssh: connect to host studio port 22: Operation timed out" } },
      ],
    }
    expect(fleetRows(fleet)).toEqual([
      { down: false, text: "Cristians-MacBook-Pro.local (this host) · 1 new agent counting for 10 min" },
      { down: false, text: "workbox (bite-cristian) · 3 new agents counting · read 2026-11-04 15:00Z" },
      {
        down: true,
        text: "studio · unreachable since 2026-11-04 14:59Z: ssh: connect to host studio port 22: Operation timed out; the pace goes on without it",
      },
    ])
  })

  test("with no peers it says the pace counts this host only; the pool's answer decodes", () => {
    const answer = { host: "bite-cristian", starts: 0, settleMinutes: 10, peers: [] }
    expect(Option.map(Schema.decodeUnknownOption(PaneFleet)(answer), fleetRows)).toEqual(
      Option.some([
        { down: false, text: "bite-cristian (this host) · 0 new agents counting for 10 min" },
        { down: false, text: "No other hosts: the pace counts this one's new agents only." },
      ]),
    )
    expect(Option.isNone(Schema.decodeUnknownOption(PaneFleet)({ host: "x" }))).toBe(true)
  })
})

describe("resetRows", () => {
  test("a question waiting on the owner first, flagged, then the claims newest first with what they did to the week, then the closed ones", () => {
    // As the pool's resets method answers, with the fields the pane does not draw.
    const answer = {
      resets: [
        { key: "k3", pool: "anthropic", provider: "claude", credentialID: "cred-a", label: "Max 1", creditID: "g", requestID: "pool-x", why: "held", stage: "asked", at: now, attempts: 0, sessionID: "ses_root", question: "Claim it?" },
        { key: "k2", pool: "openai", provider: "codex", credentialID: "c", label: "work", creditID: "c1", requestID: "pool-y", why: "held", stage: "settled", at: now - 60_000, attempts: 1, outcome: "reset" },
        { key: "k1", pool: "anthropic", provider: "claude", credentialID: "cred-b", label: "Max 2", creditID: "g", requestID: "pool-z", why: "held", stage: "withdrawn", at: now - 120_000, attempts: 0, message: "the hold lifted" },
      ],
      claims: [
        { key: "k2", pool: "openai", provider: "codex", credentialID: "c", label: "work", creditID: "c1", requestID: "pool-y", at: now - 60_000, outcome: "reset", before: [], after: [], weekly: "moved" },
      ],
    }
    expect(Option.map(Schema.decodeUnknownOption(PaneResets)(answer), resetRows)).toEqual(
      Option.some([
        { asking: true, text: "Claude · Max 1 · asked the owner, waiting for an answer · 2026-11-04 15:00Z" },
        { asking: false, text: "claimed Codex · work · reset · weekly reset moved · 2026-11-04 14:59Z" },
        { asking: false, text: "Claude · Max 2 · question withdrawn (the hold lifted) · 2026-11-04 14:58Z" },
      ]),
    )
  })

  test("a pool that has worked no reset draws none", () => {
    expect(resetRows({ resets: [], claims: [] })).toEqual([])
  })
})

describe("unitLine", () => {
  test("a unit with its round, and one with none yet", () => {
    expect(unitLine({ unit: "wake", state: "implement", round: "1", since: "2026-11-04T15:00Z" })).toBe("  wake · implement · r1 · 2026-11-04T15:00Z")
    expect(unitLine({ unit: "fresh", state: "plan", round: "", since: "" })).toBe("  fresh · plan · r? · ")
  })
})

describe("PaneLimits", () => {
  test("reads the line of the pool's limits answer, whatever tally rides with it; a pool with no tally yet has none", () => {
    const decode = Schema.decodeUnknownOption(PaneLimits)
    const line = "limit/Mtok 7d: Opus 0.90% 0.70–1.1 n 12 · Fable 1.6% n 5 (own week 0.30%) (last 7 days)"
    expect(Option.getOrUndefined(decode({ tally: { recent: [], cumulative: [] }, line }))?.line).toBe(line)
    expect(Option.getOrUndefined(decode({}))).toEqual({})
  })
})

describe("unavailable", () => {
  test("names each read that failed", () => {
    expect(unavailable(false, false)).toEqual([])
    expect(unavailable(true, false)).toEqual(["Pool unavailable; keeping last reading"])
    expect(unavailable(true, true)).toEqual(["Pool unavailable; keeping last reading", "Agents and runs unavailable; keeping last reading"])
  })
})
