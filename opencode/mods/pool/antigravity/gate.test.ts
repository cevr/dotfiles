// Start gate and cross-host Gemini concurrency cap tests:
// - limited group (from own host or peer, pane limit or full window, with or without reset) -> held with finite retryAt
// - unknown/absent window or unmeasured -> admitted (never blocks by itself)
// - stale peer with no limit -> admitted (never blocks by itself, measured: false)
// - concurrent Gemini agents counted ACROSS hosts from fleet starts: default 4 per agent, 4 fleet total (configurable)
// - Claude/GPT group is not capped by Gemini cap
// - settled starts no longer count; resuming while limited is still held
import { describe, expect, test } from "bun:test"
import { fromReport, fromStalePeer, mergeAll, mergeRecords } from "./fleet.ts"
import { checkStartGate, DEFAULT_GEMINI_CAP, GateDecision, gateText, geminiStartProvider, isGeminiStart } from "./gate.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.parse("2026-11-25T02:00:00Z")
const SETTLE = 10 * MINUTE

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
  test("defaults are 4 per agent and 4 across the fleet (from Wed 4.5h/5h measurement)", () => {
    expect(DEFAULT_GEMINI_CAP).toEqual({ perAgent: 4, fleet: 4 })
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
        fleetStarts: [],
        settleMs: SETTLE,
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
      fleetStarts: [],
      settleMs: SETTLE,
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
      fleetStarts: [],
      settleMs: SETTLE,
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
      fleetStarts: [],
      settleMs: SETTLE,
      now: NOW,
      query: { model: "gemini-3-pro" },
    })
    expect(decision._tag).toBe("Admitted")
    if (decision._tag === "Admitted") expect(decision.measured).toBe(false)
  })

  test("caps concurrent Gemini agents across hosts from fleet starts, with finite retryAt and configurable owner cap", () => {
    // 2 starts on Mac + 2 starts on workbox = 4 across the fleet -> 5th Gemini start is held!
    const starts = [
      { providerID: geminiStartProvider("implementor"), at: NOW - 8 * MINUTE },
      { providerID: geminiStartProvider("implementor"), at: NOW - 6 * MINUTE },
      { providerID: geminiStartProvider("worker"), at: NOW - 4 * MINUTE },
      { providerID: geminiStartProvider("worker"), at: NOW - 2 * MINUTE },
      // Unrelated providers do not count toward Gemini cap
      { providerID: "anthropic", at: NOW - MINUTE },
      // Settled Gemini start (older than settleMs) does not count
      { providerID: geminiStartProvider("implementor"), at: NOW - SETTLE - MINUTE },
    ]
    const heldFleet = checkStartGate({
      merged: roomyMerged,
      fleetStarts: starts,
      settleMs: SETTLE,
      now: NOW,
      query: { model: "gemini-3-pro", agent: "worker" },
    })
    expect(heldFleet._tag).toBe("Held")
    if (heldFleet._tag === "Held") {
      expect(heldFleet.why).toBe("gemini-cap-fleet")
      expect(heldFleet.geminiFleetCount).toBe(4)
      // Earliest unsettled Gemini start settles at (NOW - 8m) + 10m = NOW + 2m
      expect(heldFleet.retryAt).toBe(NOW + 2 * MINUTE)
      expect(gateText(heldFleet)).toContain("held")
    }

    // Claude/GPT is NOT held by Gemini's concurrency cap
    const claudeAllowed = checkStartGate({
      merged: roomyMerged,
      fleetStarts: starts,
      settleMs: SETTLE,
      now: NOW,
      query: { model: "claude-opus-4-6" },
    })
    expect(claudeAllowed._tag).toBe("Admitted")

    // Owner raises fleet total to 6 while keeping perAgent at 4:
    // 4 starts on "implementor" -> 5th "implementor" is held by perAgent cap, but "worker" is admitted!
    const sameAgentStarts = [
      { providerID: geminiStartProvider("implementor"), at: NOW - 7 * MINUTE },
      { providerID: geminiStartProvider("implementor"), at: NOW - 5 * MINUTE },
      { providerID: geminiStartProvider("implementor"), at: NOW - 3 * MINUTE },
      { providerID: geminiStartProvider("implementor"), at: NOW - MINUTE },
    ]
    const heldAgent = checkStartGate({
      merged: roomyMerged,
      fleetStarts: sameAgentStarts,
      settleMs: SETTLE,
      cap: { perAgent: 4, fleet: 6 },
      now: NOW,
      query: { model: "gemini-3-pro", agent: "implementor" },
    })
    expect(heldAgent._tag).toBe("Held")
    if (heldAgent._tag === "Held") {
      expect(heldAgent.why).toBe("gemini-cap-agent")
      expect(heldAgent.geminiAgentCount).toBe(4)
      expect(heldAgent.retryAt).toBe(NOW + 3 * MINUTE)
    }

    const otherAgent = checkStartGate({
      merged: roomyMerged,
      fleetStarts: sameAgentStarts,
      settleMs: SETTLE,
      cap: { perAgent: 4, fleet: 6 },
      now: NOW,
      query: { model: "gemini-3-pro", agent: "worker" },
    })
    expect(otherAgent._tag).toBe("Admitted")
    expect(GateDecision.cases.Admitted).toBeDefined()
  })
})
