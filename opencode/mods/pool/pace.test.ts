// The pool's pace: whether a new agent may start now, from its accounts' readings.
import { expect, test } from "bun:test"
import { poolPace } from "./pace.ts"
import type { AccountStatus } from "./status.ts"
const now = Date.parse("2026-11-04T15:00:00Z")
const day = 86400000
const account = (used: number, reset = now + 3.5 * day): AccountStatus => ({ credentialID: "a", live: 1, load: 0, noRoom: false, reading: { at: now, windows: [{ name: "7d", utilization: used, resetAt: reset }, { name: "5h", utilization: 0.1, resetAt: now + 3600000 }] } })

test("weekly pace holds ahead-of-time use and opens once the pool catches up", () => {
  // Half the week: 49.5% target plus 5 percentage points of leeway.
  const held = poolPace([account(0.7)], now)
  expect(held.ok).toBe(false)
  expect(held.reason).toContain("weekly pace")
  expect(held.retryAt).toBeGreaterThan(now)
  expect(poolPace([account(0.7)], held.retryAt ?? Number.NaN).ok).toBe(true)
  expect(poolPace([account(0.5)], now).ok).toBe(true)
})
test("it pools accounts, honors short-window holds and never treats a reset reading as spent", () => {
  expect(poolPace([account(0.7), { ...account(0.2), credentialID: "b" }], now).ok).toBe(true)
  const held = { ...account(0.2), hold: { kind: "rate-limit" as const, at: now, until: now + 10000 } }
  expect(poolPace([held], now)).toMatchObject({ ok: false, retryAt: now + 10000 })
  expect(poolPace([account(1, now - 1)], now).ok).toBe(true)
  expect(poolPace([], now)).toMatchObject({ ok: true, measured: false })
})
test("a model's own weekly window holds only that model's starts; the main windows hold every start", () => {
  const fable = (used: number, scoped: number, five = 0.1): AccountStatus => ({
    ...account(used),
    reading: {
      at: now,
      windows: [
        { name: "7d", utilization: used, resetAt: now + 3.5 * day },
        { name: "5h", utilization: five, resetAt: now + 3600000 },
        { name: "7d:Fable", utilization: scoped, resetAt: now + 2 * day },
      ],
    },
  })
  // Fable's week spent: an Opus start (or one naming no model) goes ahead...
  expect(poolPace([fable(0.3, 1)], now).ok).toBe(true)
  expect(poolPace([fable(0.3, 1)], now, undefined, "claude-opus-5-5").ok).toBe(true)
  // ...a Fable start waits for Fable's reset.
  expect(poolPace([fable(0.3, 1)], now, undefined, "claude-fable-5-2")).toMatchObject({ ok: false, measured: true, retryAt: now + 2 * day })
  // Another account with Fable room takes the start.
  expect(poolPace([fable(0.3, 1), { ...fable(0.3, 0.4), credentialID: "b" }], now, undefined, "claude-fable-5-2").ok).toBe(true)
  // Fable spends the main windows too: a full 5-hour window or a held account holds a Fable start with room of its own.
  expect(poolPace([fable(0.3, 0.2, 0.95)], now, undefined, "claude-fable-5-2")).toMatchObject({ ok: false, retryAt: now + 3600000 })
  const held = { ...fable(0.3, 0.2), hold: { kind: "rate-limit" as const, at: now, until: now + 10000 } }
  expect(poolPace([held], now, undefined, "claude-fable-5-2")).toMatchObject({ ok: false, retryAt: now + 10000 })
  // A Fable window that has reset holds nothing.
  expect(poolPace([fable(0.3, 1)], now + 2 * day, undefined, "claude-fable-5-2").ok).toBe(true)
})
test("agents started in the fleet count until they settle, so a wave holds the next start before the readings show it", () => {
  const minute = 60000
  const inflight = (starts: ReadonlyArray<number>) => ({ starts, cost: 0.005, settleMs: 10 * minute })
  // 54% read against 54.5% allowed: room for one start, not for two.
  expect(poolPace([account(0.54)], now, inflight([now - minute])).ok).toBe(true)
  const held = poolPace([account(0.54)], now, inflight([now - 3 * minute, now - minute]))
  expect(held).toMatchObject({ ok: false, measured: true })
  expect(held.reason).toBe("the pool's weekly pace is over (54.0% spent across 1 accounts, +1.0% for 2 agents started in the last 10 min)")
  // It opens when the older start settles, not later: by then its spend is in the readings.
  expect(held.retryAt).toBe(now + 7 * minute + 1)
  // Without readings the starts cannot be weighed: the pace stays unmeasured and open.
  expect(poolPace([{ ...account(0.54), reading: { at: now, windows: [] } }], now, inflight([now, now, now]))).toMatchObject({ ok: true, measured: false })
})
