// What the TUI tells the owner from the pool's alerts: the sidebar's warning
// lines, the toast text, and the rule that toasts each occurrence once.
import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { AlertsAnswer, alertLines, alertToasts, causeText, fresh, lasted, NO_ALERTS } from "./alert.ts"

const MINUTE = 60_000
const now = Date.parse("2026-11-04T15:00:00Z")
const slot = "~/.local/share/opencode-prime/pool-auth/.slots/anthropic/work"
const lost = { pool: "anthropic", credentialID: "store:work", label: "work", since: now - 5 * MINUTE, slot }
const outage = {
  pool: "anthropic",
  dir: "/home/me/.local/share/opencode-prime/pool-auth",
  since: now - 40 * MINUTE,
  lastAt: now - MINUTE,
  failures: 9,
  cause: { status: 429, server: "cloudflare", retryAfter: "300" },
}

describe("the answer", () => {
  test("decodes the pool's alerts, and refuses a malformed one", () => {
    const decode = Schema.decodeUnknownOption(AlertsAnswer)
    expect(Option.isSome(decode({ lost: [lost], outages: [outage] }))).toBe(true)
    expect(Option.isNone(decode({ lost: [{ label: "work" }], outages: [] }))).toBe(true)
  })
})

describe("the text", () => {
  test("how long a run lasted, and what the endpoint last said", () => {
    expect(lasted(12 * MINUTE + 30_000)).toBe("12m")
    expect(lasted(65 * MINUTE)).toBe("1h 5m")
    expect(causeText(outage.cause)).toBe("429 from cloudflare, retry-after 300")
    expect(causeText({ status: 503 })).toBe("503")
    expect(causeText({})).toBe("the token endpoint did not answer")
    expect(causeText(undefined)).toBe("the token endpoint did not answer")
  })
})

describe("alertLines", () => {
  test("a lost login's label and the slot file to sign it in to again; an outage's length and cause", () => {
    expect(alertLines({ lost: [lost], outages: [outage] }, now)).toEqual([
      { text: "work · signed out", tone: "error" },
      { text: `sign in again into ${slot}`, tone: "warning" },
      { text: "refresh failing 40m · 429 from cloudflare, retry-after 300", tone: "error" },
    ])
  })

  test("nothing when the pool has no alert", () => {
    expect(alertLines(NO_ALERTS, now)).toEqual([])
  })
})

describe("the toasts", () => {
  test("name the login and its slot file, or the store, how long and the cause", () => {
    expect(alertToasts({ lost: [lost], outages: [outage] }, now)).toEqual([
      {
        key: `lost:store:work:${lost.since}`,
        title: "Pool login work is signed out",
        message: `The token endpoint refused its refresh token. Sign it in again into ${slot}`,
      },
      {
        key: `outage:anthropic:${outage.dir}:${outage.since}`,
        title: "Pool refreshes are failing",
        message: `Every refresh from ${outage.dir} has failed for 40m (9 tries); last: 429 from cloudflare, retry-after 300.`,
      },
    ])
  })

  test("each occurrence toasts once: a repeat is quiet, a cleared one is forgotten, and its return toasts again", () => {
    const first = fresh(new Set(), { lost: [lost], outages: [] }, now)
    expect(first.toasts.map((toast) => toast.key)).toEqual([`lost:store:work:${lost.since}`])
    const again = fresh(first.seen, { lost: [lost], outages: [] }, now + MINUTE)
    expect(again.toasts).toEqual([])
    const cleared = fresh(again.seen, NO_ALERTS, now + 2 * MINUTE)
    expect(cleared.toasts).toEqual([])
    expect([...cleared.seen]).toEqual([])
    const back = fresh(cleared.seen, { lost: [{ ...lost, since: now + 3 * MINUTE }], outages: [] }, now + 3 * MINUTE)
    expect(back.toasts).toHaveLength(1)
  })
})
