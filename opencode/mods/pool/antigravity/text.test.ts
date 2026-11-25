// The Antigravity rows' wording, as the /pool pane, pool_push status and the
// antigravity tool print them: a snapshot of each state the owner can meet.
import { describe, expect, test } from "bun:test"
import { EMPTY, Event, evolve, type State, Why } from "./state.ts"
import { statusLines } from "./text.ts"

const NOW = Date.parse("2026-11-25T01:00:00Z")
const MINUTE = 60_000

const read: State = evolve(
  evolve(EMPTY, Event.cases.Attempted.make({ id: "t", at: NOW - 2 * MINUTE, keychain: false })),
  Event.cases.Read.make({
    attempt: "t",
    at: NOW - 2 * MINUTE,
    windows: [
      { group: "gemini", label: "Gemini", span: "5h", used: 0.04, resetAt: NOW + 180 * MINUTE },
      { group: "gemini", label: "Gemini", span: "7d", used: 0.09, resetAt: NOW + 6 * 24 * 60 * MINUTE },
      { group: "claude-gpt", label: "Claude & GPT (shared)", span: "5h", used: 1, resetAt: NOW + 68 * MINUTE },
    ],
  }),
)

describe("Antigravity status rows", () => {
  test("a reading with one full window and one unknown", () => {
    expect(statusLines(read, NOW)).toMatchInlineSnapshot(`
      [
        "antigravity / Gemini · open",
        "  5h 4% used of 100% · reset Nov 24, 2026, 11:00:00 PM EST",
        "  7d 9% used of 100% · reset Nov 30, 2026, 8:00:00 PM EST",
        "antigravity / Claude & GPT (shared) · limited until Nov 24, 2026, 9:08:00 PM EST",
        "  5h 100% used of 100% · reset Nov 24, 2026, 9:08:00 PM EST",
        "  7d unknown: the weekly window is unknown",
        "  read Nov 24, 2026, 7:58:00 PM EST (2 min ago) · next read possible Nov 24, 2026, 8:03:00 PM EST",
        "  groups Antigravity reported: Gemini, Claude & GPT (shared)",
      ]
    `)
  })

  test("a pane's limit on top of the reading", () => {
    const limited = evolve(read, Event.cases.LimitSeen.make({ limit: { seenAt: NOW - MINUTE, resetAt: NOW + 69 * MINUTE } }))
    expect(statusLines(limited, NOW)).toMatchInlineSnapshot(`
      [
        "antigravity / Gemini · limited until Nov 24, 2026, 9:09:00 PM EST (a pane's limit)",
        "  5h 4% used of 100% · reset Nov 24, 2026, 11:00:00 PM EST",
        "  7d 9% used of 100% · reset Nov 30, 2026, 8:00:00 PM EST",
        "antigravity / Claude & GPT (shared) · limited until Nov 24, 2026, 9:09:00 PM EST (a pane's limit)",
        "  5h 100% used of 100% · reset Nov 24, 2026, 9:08:00 PM EST",
        "  7d unknown: the weekly window is unknown",
        "  read Nov 24, 2026, 7:58:00 PM EST (2 min ago) · next read possible Nov 24, 2026, 8:03:00 PM EST",
        "  groups Antigravity reported: Gemini, Claude & GPT (shared)",
        "  last limit seen Nov 24, 2026, 7:59:00 PM EST on Gemini, resets Nov 24, 2026, 9:09:00 PM EST",
        "  last limit seen Nov 24, 2026, 7:59:00 PM EST on Claude & GPT (shared), resets Nov 24, 2026, 9:09:00 PM EST",
      ]
    `)
  })

  test("no reading at all: a pane's limits alone, one with no reset and one that has reset", () => {
    const silent = evolve(EMPTY, Event.cases.LimitSeen.make({ limit: { seenAt: NOW - 10 * MINUTE, group: "gemini" } }))
    const passed = evolve(silent, Event.cases.LimitSeen.make({ limit: { seenAt: NOW - 90 * MINUTE, resetAt: NOW - MINUTE, group: "claude-gpt" } }))
    expect(statusLines(passed, NOW).filter((line) => line.startsWith("antigravity") || line.includes("last limit"))).toMatchInlineSnapshot(`
      [
        "antigravity / Gemini · limited, reset unknown (a pane's limit at Nov 24, 2026, 7:50:00 PM EST)",
        "antigravity / Claude & GPT (shared) · not measured (no limit seen since Nov 24, 2026, 7:59:00 PM EST): not read yet",
        "  last limit seen Nov 24, 2026, 7:50:00 PM EST on Gemini, no reset given",
        "  last limit seen Nov 24, 2026, 6:30:00 PM EST on Claude & GPT (shared), resets Nov 24, 2026, 7:59:00 PM EST",
      ]
    `)
  })

  test("nothing readable: each reason in words", () => {
    const failed = (why: Why) => statusLines(evolve(evolve(EMPTY, Event.cases.Attempted.make({ id: "f", at: NOW, keychain: false })), Event.cases.Failed.make({ attempt: "f", at: NOW, why })), NOW)
    expect(statusLines(EMPTY, NOW)).toMatchInlineSnapshot(`
      [
        "antigravity / Gemini · not measured (no limit seen ever): not read yet",
        "  5h unknown: the 5-hour window is unknown",
        "  7d unknown: the weekly window is unknown",
        "antigravity / Claude & GPT (shared) · not measured (no limit seen ever): not read yet",
        "  5h unknown: the 5-hour window is unknown",
        "  7d unknown: the weekly window is unknown",
        "  not read yet · a read is possible now (antigravity read)",
      ]
    `)
    expect(failed(Why.cases.SignInExpired.make({}))).toMatchInlineSnapshot(`
      [
        "antigravity / Gemini · not measured (no limit seen ever): sign-in expired: start an Antigravity turn",
        "  5h unknown: the 5-hour window is unknown",
        "  7d unknown: the weekly window is unknown",
        "antigravity / Claude & GPT (shared) · not measured (no limit seen ever): sign-in expired: start an Antigravity turn",
        "  5h unknown: the 5-hour window is unknown",
        "  7d unknown: the weekly window is unknown",
        "  last attempt Nov 24, 2026, 8:00:00 PM EST: sign-in expired: start an Antigravity turn · next read possible Nov 24, 2026, 8:10:00 PM EST",
      ]
    `)
    expect([
      Why.cases.NoSignIn.make({}),
      Why.cases.NotReadableHere.make({}),
      Why.cases.KeychainRefused.make({ outcome: "denied" }),
      Why.cases.KeychainRefused.make({ outcome: "timed-out" }),
      Why.cases.NotHeld.make({}),
      Why.cases.Contained.make({ reason: "UnknownError" }),
      Why.cases.StateUnreadable.make({}),
      Why.cases.RequestFailed.make({ why: "rate-limited", status: 429 }),
      Why.cases.RequestFailed.make({ why: "timed-out" }),
      Why.cases.NoQuota.make({}),
      Why.cases.HostRefused.make({ host: "example.com" }),
    ].map((why) => failed(why)[0])).toMatchInlineSnapshot(`
      [
        "antigravity / Gemini · not measured (no limit seen ever): no Antigravity sign-in on this host: sign in with agy",
        "antigravity / Gemini · not measured (no limit seen ever): sign-in not readable here",
        "antigravity / Gemini · not measured (no limit seen ever): the keychain read was denied: tried again only with a new consent (antigravity read, consent)",
        "antigravity / Gemini · not measured (no limit seen ever): the keychain read timed out: tried again only with a new consent (antigravity read, consent)",
        "antigravity / Gemini · not measured (no limit seen ever): sign-in not held: no token file, and the keychain is read only with consent (antigravity read, consent)",
        "antigravity / Gemini · not measured (no limit seen ever): the Antigravity reader failed here (UnknownError)",
        "antigravity / Gemini · not measured (no limit seen ever): the state file did not read (kept beside it as .undecodable): taken as an attempt then, so the floor holds",
        "antigravity / Gemini · not measured (no limit seen ever): Google's quota read was rate limited (429)",
        "antigravity / Gemini · not measured (no limit seen ever): Google's quota read timed out",
        "antigravity / Gemini · not measured (no limit seen ever): Google answered no quota this reads",
        "antigravity / Gemini · not measured (no limit seen ever): a request to example.com was refused: not a Google host",
      ]
    `)
  })
})
