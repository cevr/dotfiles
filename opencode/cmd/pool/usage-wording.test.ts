// Every kind of message that reads a usage figure to the owner or an agent,
// with its text: a window's use is the share USED, "X% used of 100%" (or
// "X%/100% used" where space is tight), a threshold is the line it holds at,
// and a rate is the use per hour. Never a bare "X%", never room, left or
// remaining as a percent. The pool's plugin root reaches the pool and the status mod both, so this table sees every kind.
import { describe, expect, test } from "bun:test"
import { NO_INFLIGHT, poolPace } from "@dotfiles/opencode-pool/pace"
import { forecastText, planText } from "@dotfiles/opencode-pool/push"
import { buysOf, claudeQuestion, toldText, unagreedQuestion } from "@dotfiles/opencode-pool/resets"
import type { AccountStatus } from "@dotfiles/opencode-pool/status"
import { accountRows } from "@dotfiles/opencode-status/pane"
import { sidebarLines } from "@dotfiles/opencode-status/sidebar"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = Date.parse("2026-11-15T12:00:00Z")

const account = (windows: ReadonlyArray<{ readonly name: string; readonly utilization: number; readonly resetAt: number }>): AccountStatus => ({
  credentialID: "a",
  live: 0,
  load: 0,
  noRoom: false,
  reading: { at: now, windows },
})

const fiveHourReset = buysOf([{ window: "5h", from: 1, to: 0, resetAt: now + HOUR }])
const fableReset = buysOf([
  { window: "7d:Fable", from: 1, to: 0, resetAt: now + 2 * DAY },
  { window: "7d", from: 0.6, to: 0.1, resetAt: now + 3.5 * DAY, share: { points: 0.5, low: 0.4, high: 0.6, source: "tally" } },
])

const table: ReadonlyArray<readonly [string, string]> = [
  [
    poolPace(
      [account([{ name: "5h", utilization: 0.1, resetAt: now + HOUR }, { name: "7d", utilization: 0.3, resetAt: now + 3.5 * DAY }, { name: "7d:Fable", utilization: 1, resetAt: now + 2 * DAY }])],
      now,
      NO_INFLIGHT,
      "claude-fable-5-2",
    ).reason,
    "every pool account is held or has claude-fable-5-2's own weekly window (7d:Fable) at 100% used of 100%: " +
      "a claude-fable-5-2 start holds at 100% used of 100% there; the first resets 2026-11-17 12:00Z",
  ],
  [
    poolPace([account([{ name: "5h", utilization: 0.95, resetAt: now + HOUR }, { name: "7d", utilization: 0.3, resetAt: now + 3.5 * DAY }])], now).reason,
    "every pool account is at a hold line: its 5-hour window at 90% used of 100% or more, or its week at 99% used of 100% or more; the first resets 2026-11-15 13:00Z",
  ],
  [
    poolPace([account([{ name: "5h", utilization: 0.1, resetAt: now + HOUR }, { name: "7d", utilization: 0.7, resetAt: now + 3.5 * DAY }])], now).reason,
    "the pool's weekly pace is over: its 1 account's week is at 70.0% used of 100%; the spend-evenly line is 54.5% used of 100% now, and the start holds past it",
  ],
  [fiveHourReset, "5h 100% used of 100% → 0% used"],
  [
    fableReset,
    "Fable week 100% used of 100% → 0% used, next reset 2026-11-17 12:00Z, " +
      "weekly 60% used of 100% → ~10% used, next reset 2026-11-19 00:00Z (Fable's part 50% of the week (40%–60%) by the limit tally)",
  ],
  [
    toldText({ kind: "session", label: "a", buys: fiveHourReset }),
    "The pool claimed the 5-hour reset on account a before it expired unused: 5h 100% used of 100% → 0% used.",
  ],
  [
    claudeQuestion(
      "a",
      account([{ name: "5h", utilization: 1, resetAt: now + HOUR }, { name: "7d", utilization: 0.3, resetAt: now + 3.5 * DAY }]),
      { id: "g", count: 1, usable: true, expiresAt: now + 30 * DAY, clears: ["five_hour"] },
      now,
    ),
    "Claude reset on account a now: takes the 5h window from 100% used of 100% to 0% used and 3.5 days remain before the weekly reset (2026-11-19). The grant ends 2026-12-15. Claim it?",
  ],
  [
    unagreedQuestion({ label: "a", kind: "session", why: "expiring", buys: fiveHourReset }, ["mac"]),
    "5-hour reset on account a now? It would expire unused otherwise. Claiming it takes 5h 100% used of 100% → 0% used. mac is unreachable, so I can't rule out it claiming too. Claim it?",
  ],
  [
    forecastText({ pool: "anthropic", burn: 0.0085, inHand: 2, wasted: [{ pool: "anthropic", label: "a", kind: "weekly", spare: 0.99, expiresAt: now + 6 * DAY }] }) ?? "",
    "Pool anthropic: at this rate (it uses 0.85% of a week per hour), 1 of its 2 resets (weekly reset; each gives back ≈99% of a week) expire unused by 2026-11-21 12:00Z.",
  ],
  [
    planText({
      at: now,
      pools: [
        {
          id: "anthropic",
          accounts: 2,
          weeklyRoom: 0.6,
          weeklyUsed: 1.4,
          weeklyRead: 2,
          weekResetAt: now + 3.5 * DAY,
          weeklyBurn: 0.0167,
          shortRoom: 1,
          shortUsed: 1,
          shortRead: 2,
          shortResetAt: now + 2 * HOUR,
          shortBurn: 0.2,
        },
      ],
      resets: [{ pool: "anthropic", label: "a", kind: "weekly", weekly: 0.7, short: 0, expiresAt: now + 30 * DAY, expiresFirst: false, at: now + 36 * HOUR, notNeeded: false }],
      need: { units: 3, cost: 0.4 },
      forecasts: [],
    }),
    [
      "Pool anthropic: 2 accounts, their weeks at 70% used of 100% on average, the first resetting by itself 2026-11-19 00:00Z; " +
        "together they use 1.67% of a week per hour, reaching 100% used of 100% in ~1.5 days at this rate. " +
        "5-hour windows at 50% used of 100% on average, the first resetting 2026-11-15 14:00Z; they use 20.0% of a 5-hour window per hour.",
      "1. weekly reset on a (anthropic): gives back 70% of a week, expires 2026-12-15 12:00Z; likely claimed ~2026-11-17 00:00Z at the current burn.",
      "Queued work: 3 units ≈ 40% of one account's week: it would take the pool's weeks from 70% used of 100% on average to 90% used of 100%, or to 55% used of 100% with the approved resets.",
    ].join("\n"),
  ],
  [
    accountRows({ anthropic: { accounts: [{ credentialID: "a", reading: { windows: [{ name: "5h", utilization: 0.23, resetAt: now + HOUR }, { name: "7d:Fable", utilization: 0.12, resetAt: now + 2 * DAY }] } }] } }, now)
      .flatMap((row) => row.windows)
      .join("\n"),
    ["  5h 23%/100% used · reset 2026-11-15 13:00Z", "  7d unknown · reset unknown", "  Fable 7d 12%/100% used · reset 2026-11-17 12:00Z"].join("\n"),
  ],
  [
    sidebarLines({ account: { label: "claude-max-2", on: "placed", reading: { windows: [{ name: "5h", utilization: 0.23, resetAt: now + HOUR }] } } }, now)
      .map((line) => line.text)
      .join("\n"),
    ["claude-max-2", "5h 23%/100% used · in 1h 0m · 13:00Z"].join("\n"),
  ],
]

describe("every usage message says the share used, out of 100%", () => {
  test.each(table.map(([text, expected], index) => [index, text, expected] as const))("message %i", (_index, text, expected) => {
    expect(text).toBe(expected)
    // The rule, beside the exact text: no room, left or remaining as a percent, and every whole-window figure out of 100%.
    expect(text).not.toMatch(/\d% (room|left|remaining)|(room|left|remaining) \d+%/)
  })
})
