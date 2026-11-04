import { expect, test } from "bun:test"
import { poolPace } from "../src/pace.ts"
import type { AccountStatus } from "../src/pool.ts"
const now = Date.parse("2026-11-04T15:00:00Z")
const day = 86400000
const account = (used: number, reset = now + 3.5 * day): AccountStatus => ({ credentialID: "a", live: 1, load: 0, noRoom: false, reading: { at: now, windows: [{ name: "7d", utilization: used, resetAt: reset }, { name: "5h", utilization: 0.1, resetAt: now + 3600000 }] } })

test("weekly pace holds ahead-of-time use and opens once the pool catches up", () => {
  // Half the week: 49.5% target plus 5 percentage points of leeway.
  const held = poolPace([account(0.7)], now)
  expect(held.ok).toBe(false)
  expect(held.reason).toContain("weekly pace")
  expect(held.retryAt).toBeGreaterThan(now)
  expect(poolPace([account(0.7)], held.retryAt!).ok).toBe(true)
  expect(poolPace([account(0.5)], now).ok).toBe(true)
})
test("it pools accounts, honors short-window holds and never treats a reset reading as spent", () => {
  expect(poolPace([account(0.7), { ...account(0.2), credentialID: "b" }], now).ok).toBe(true)
  const held = { ...account(0.2), hold: { kind: "rate-limit" as const, at: now, until: now + 10000 } }
  expect(poolPace([held], now)).toMatchObject({ ok: false, retryAt: now + 10000 })
  expect(poolPace([account(1, now - 1)], now).ok).toBe(true)
  expect(poolPace([], now)).toMatchObject({ ok: true, measured: false })
})
