// Start gate and cross-host Gemini CONCURRENCY cap tests:
// - defaults are coherent: perAgent 4, fleet 8 (configurable via pool option)
// - limited group (from own host or peer, pane limit or full window, with or without reset) -> held with finite retryAt
// - unknown/absent window or unmeasured -> admitted (never blocks by itself)
// - stale peer with no limit -> admitted (never blocks by itself, measured: false)
// - concurrent Gemini agents counted ACROSS hosts from the fleet's busy set (sessions/panes currently running,
//   however long ago they started), NOT starts in the last 10 minutes
// - a stale peer counts its last reported running agents until its report is older than BUSY_FRESH_MS (10 min),
//   after which they stop counting
// - Claude/GPT group is not capped by Gemini cap
// - gate always answers Admitted ("start") or Held ("hold until <finite time>")
import { describe, expect, test } from "bun:test"
import { BUSY_FRESH_MS } from "../fleet.ts"
import { fromReport, fromStalePeer, mergeAll, mergeRecords } from "./fleet.ts"
import { checkStartGate, DEFAULT_GEMINI_CAP, GateDecision, gateText, geminiStartProvider, isGeminiStart } from "./gate.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.parse("2026-11-25T02:00:00Z")

const roomyMerged = fromReport(
  {
    host: "mac",
    at: NOW - MINUTE,
    readableSignIn: true,
    limits: [],
    reading: {
      at: NOW - MINUTE,
      host: "mac",
      windows: [
        { group: "gemini", label: "Gemini", span: "5h", used: 0.2, resetAt: NOW + 3 * HOUR },
        { group: "gemini", label: "Gemini", span: "7d", used: 0.3, resetAt: NOW + 48 * HOUR },
        { group: "claude-gpt", label: "Claude & GPT (shared)", span: "5h", used: 0.1, resetAt: NOW + 3 * HOUR },
        { group: "claude-gpt", label: "Claude & GPT (shared)", span: "7d", used: 0.2, resetAt: NOW + 48 * HOUR },
      ],
    },
  },
  NOW,
)

describe("Antigravity start gate and cross-host Gemini concurrency cap", () => {
  test("defaults are coherent: 4 per agent and 8 across the fleet (so perAgent can bind on a multi-host fleet)", () => {
    expect(DEFAULT_GEMINI_CAP).toEqual({ perAgent: 4, fleet: 8 })
    expect(isGeminiStart(geminiStartProvider())).toBe(true)
    expect(isGeminiStart(geminiStartProvider("implementor"))).toBe(true)
    expect(isGeminiStart("anthropic")).toBe(false)
  })

  test("limited group holds both start and resume with the finite reset time (from peer or local)", () => {
    const resetAt = NOW + 68 * MINUTE
    const peerLimit = fromReport(
      {
        host: "workbox",
        at: NOW,
        readableSignIn: false,
        limits: [{ group: "gemini", seenAt: NOW, resetAt, host: "workbox", key: "id:err-1" }],
      },
      NOW,
    )
    const merged = mergeRecords(roomyMerged, peerLimit)
    for (const resume of [false, true]) {
      const decision = checkStartGate({
        merged,
        ownBusy: [],
        peerBusy: [],
        now: NOW,
        query: { model: "google/gemini-3-pro", resume },
      })
      expect(decision._tag).toBe("Held")
      if (decision._tag === "Held") {
        expect(decision.why).toBe("limited")
        expect(decision.retryAt).toBe(resetAt)
        expect(Number.isFinite(decision.retryAt)).toBe(true)
      }
    }
    // Claude/GPT is unaffected by Gemini's limit
    const claude = checkStartGate({
      merged,
      ownBusy: [],
      peerBusy: [],
      now: NOW,
      query: { model: "anthropic/claude-opus-4-6" },
    })
    expect(claude._tag).toBe("Admitted")
  })

  test("a limit with no reset time still holds with a finite retryAt > now", () => {
    const silentLimit = fromReport(
      {
        host: "workbox",
        at: NOW,
        readableSignIn: false,
        limits: [{ group: "claude-gpt", seenAt: NOW, host: "workbox" }],
      },
      NOW,
    )
    const decision = checkStartGate({
      merged: mergeRecords(roomyMerged, silentLimit),
      ownBusy: [],
      peerBusy: [],
      now: NOW,
      query: { model: "claude-opus-4-6" },
    })
    expect(decision._tag).toBe("Held")
    if (decision._tag === "Held") {
      expect(decision.why).toBe("limited")
      expect(Number.isFinite(decision.retryAt)).toBe(true)
      expect(decision.retryAt).toBeGreaterThan(NOW)
    }
  })

  test("unknown/absent windows and stale peers never block a start by themselves", () => {
    const partial = fromReport(
      {
        host: "mac",
        at: NOW - MINUTE,
        readableSignIn: true,
        limits: [],
        reading: {
          at: NOW - MINUTE,
          host: "mac",
          windows: [{ group: "gemini", label: "Gemini", span: "5h", used: 0.2, resetAt: NOW + 3 * HOUR }],
        },
      },
      NOW,
    )
    const withStale = mergeAll([partial, fromStalePeer({ host: "workbox", since: NOW - 5 * MINUTE, message: "ssh timed out" })])
    const decision = checkStartGate({
      merged: withStale,
      ownBusy: [],
      peerBusy: [],
      now: NOW,
      query: { model: "gemini-3-pro" },
    })
    expect(decision._tag).toBe("Admitted")
    if (decision._tag === "Admitted") expect(decision.measured).toBe(false)
  })

  test("caps TRUE concurrency across hosts from the fleet busy set: perAgent 4 binds before fleet 8, and stale peers count until BUSY_FRESH_MS", () => {
    // 4 running on implementor (2 on mac + 2 on workbox) -> 5th implementor is held by perAgent (4/4),
    // while worker is ADMITTED because fleet is only 4/8!
    const ownBusy = [geminiStartProvider("implementor"), geminiStartProvider("implementor"), "anthropic"]
    const peerBusy = [
      {
        host: "workbox",
        busy: [geminiStartProvider("implementor"), geminiStartProvider("implementor"), "openai"],
        seenAt: NOW - 2 * MINUTE,
      },
    ]
    const heldAgent = checkStartGate({
      merged: roomyMerged,
      ownBusy,
      peerBusy,
      now: NOW,
      query: { model: "gemini-3-pro", agent: "implementor" },
    })
    expect(heldAgent._tag).toBe("Held")
    if (heldAgent._tag === "Held") {
      expect(heldAgent.why).toBe("gemini-cap-agent")
      expect(heldAgent.geminiAgentCount).toBe(4)
      expect(heldAgent.geminiFleetCount).toBe(4)
      expect(Number.isFinite(heldAgent.retryAt)).toBe(true)
      expect(heldAgent.retryAt).toBeGreaterThan(NOW)
      expect(gateText(heldAgent)).toContain("held")
    }

    const otherAgentAdmitted = checkStartGate({
      merged: roomyMerged,
      ownBusy,
      peerBusy,
      now: NOW,
      query: { model: "gemini-3-pro", agent: "worker" },
    })
    expect(otherAgentAdmitted._tag).toBe("Admitted")
    if (otherAgentAdmitted._tag === "Admitted") {
      expect(otherAgentAdmitted.geminiFleetCount).toBe(4)
      expect(otherAgentAdmitted.geminiAgentCount).toBe(0)
    }

    // 8 running across hosts (4 implementor + 4 worker) -> 9th Gemini agent (even a 3rd role) is held by fleet cap (8/8)!
    const fullPeerBusy = [
      {
        host: "workbox",
        busy: [
          geminiStartProvider("implementor"),
          geminiStartProvider("implementor"),
          geminiStartProvider("worker"),
          geminiStartProvider("worker"),
          geminiStartProvider("worker"),
          geminiStartProvider("worker"),
        ],
        seenAt: NOW - 5 * MINUTE,
      },
    ]
    const heldFleet = checkStartGate({
      merged: roomyMerged,
      ownBusy: [geminiStartProvider("implementor"), geminiStartProvider("implementor")],
      peerBusy: fullPeerBusy,
      now: NOW,
      query: { model: "gemini-3-pro", agent: "planner" },
    })
    expect(heldFleet._tag).toBe("Held")
    if (heldFleet._tag === "Held") {
      expect(heldFleet.why).toBe("gemini-cap-fleet")
      expect(heldFleet.geminiFleetCount).toBe(8)
      expect(Number.isFinite(heldFleet.retryAt)).toBe(true)
      expect(heldFleet.retryAt).toBeGreaterThan(NOW)
    }

    // Claude/GPT is NOT held by Gemini's concurrency cap
    const claudeAllowed = checkStartGate({
      merged: roomyMerged,
      ownBusy: [geminiStartProvider("implementor"), geminiStartProvider("implementor")],
      peerBusy: fullPeerBusy,
      now: NOW,
      query: { model: "claude-opus-4-6" },
    })
    expect(claudeAllowed._tag).toBe("Admitted")

    // A stale peer's last reported busy agents STILL count while seenAt > now - BUSY_FRESH_MS (e.g. 9 min ago),
    // and STOP counting once older than BUSY_FRESH_MS (10 min + 1ms ago)!
    const staleWithinFresh = checkStartGate({
      merged: mergeRecords(roomyMerged, fromStalePeer({ host: "workbox", since: NOW - 3 * MINUTE, seenAt: NOW - (BUSY_FRESH_MS - MINUTE), message: "ssh timeout" })),
      ownBusy: [geminiStartProvider("implementor"), geminiStartProvider("implementor")],
      peerBusy: [{ host: "workbox", busy: fullPeerBusy[0]!.busy, seenAt: NOW - (BUSY_FRESH_MS - MINUTE) }],
      now: NOW,
      query: { model: "gemini-3-pro", agent: "planner" },
    })
    expect(staleWithinFresh._tag).toBe("Held")
    if (staleWithinFresh._tag === "Held") {
      expect(staleWithinFresh.why).toBe("gemini-cap-fleet")
      // Finite retryAt bounded by at most the stale peer's BUSY_FRESH_MS expiry (NOW + 1m)
      expect(staleWithinFresh.retryAt).toBeLessThanOrEqual(NOW + MINUTE)
      expect(staleWithinFresh.retryAt).toBeGreaterThan(NOW)
    }

    const staleExpired = checkStartGate({
      merged: mergeRecords(roomyMerged, fromStalePeer({ host: "workbox", since: NOW - BUSY_FRESH_MS, seenAt: NOW - BUSY_FRESH_MS - 1, message: "ssh timeout" })),
      ownBusy: [geminiStartProvider("implementor"), geminiStartProvider("implementor")],
      peerBusy: [{ host: "workbox", busy: fullPeerBusy[0]!.busy, seenAt: NOW - BUSY_FRESH_MS - 1 }],
      now: NOW,
      query: { model: "gemini-3-pro", agent: "planner" },
    })
    expect(staleExpired._tag).toBe("Admitted")
    if (staleExpired._tag === "Admitted") expect(staleExpired.geminiFleetCount).toBe(2)

    // Owner can customize cap (e.g. lower fleet total to 3)
    const customHeld = checkStartGate({
      merged: roomyMerged,
      ownBusy: [geminiStartProvider("a"), geminiStartProvider("b"), geminiStartProvider("c")],
      peerBusy: [],
      cap: { perAgent: 4, fleet: 3 },
      now: NOW,
      query: { model: "gemini-3-pro", agent: "d" },
    })
    expect(customHeld._tag).toBe("Held")
    expect(GateDecision.cases.Admitted).toBeDefined()
  })
})
