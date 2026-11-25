// Admission must follow usable accounts' own cycles, without another login's pacing debt.
import { expect, test } from "bun:test"
import { dispatchPace, NO_INFLIGHT, poolPace } from "./pace.ts"
import type { AccountStatus } from "./status.ts"

const now = Date.parse("2026-11-25T19:00:00Z")
const hour = 3_600_000
const day = 24 * hour
const model = "claude-fable-5-2"
const account = (credentialID: string, used: number, resetIn: number) => ({
  credentialID, live: 0, load: 0, noRoom: false,
  reading: { at: now, windows: [
    { name: "7d", utilization: used, resetAt: now + resetIn },
    { name: "5h", utilization: 0, resetAt: now + hour },
    { name: "7d:Fable", utilization: 0, resetAt: now + resetIn },
  ] },
} satisfies AccountStatus)

test("a fresh week starts beside six nearly exhausted weeks, exactly as the fresh account alone", () => {
  const fresh = account("fresh", 0, 7 * day)
  const others = [
    account("spent-a", 1, day), account("spent-b", 0.99, 4 * day),
    account("spent-c", 0.99, 18 * hour), account("spent-d", 1, 7 * hour),
    account("spent-e", 1, 2 * day), account("ahead", 0.94, 3 * day),
  ]
  const alone = dispatchPace([fresh], now, {}, 0.005, model)
  expect(alone).toMatchObject({ ok: true, admission: "ordinary", eligible: ["fresh"] })
  expect(dispatchPace([...others, fresh], now, {}, 0.005, model)).toMatchObject({
    ok: true, admission: "ordinary", eligible: ["fresh"],
  })
  expect(poolPace([...others, fresh], now, NO_INFLIGHT, model)).toMatchObject({
    ok: true, admission: "ordinary", eligible: ["fresh"],
  })
})

test("only accounts within their own cycle's pace receive ordinary requests; a push can explicitly lift it", () => {
  const ahead = account("ahead", 0.7, 3.5 * day)
  const behind = account("behind", 0.2, 3.5 * day)
  expect(dispatchPace([ahead, behind], now, {}, 0.005, model)).toMatchObject({ ok: true, eligible: ["behind"] })
  expect(dispatchPace([ahead, behind], now, {}, 0.005, model, { liftEvenLine: true })).toMatchObject({
    ok: true, admission: "ordinary", eligible: ["ahead", "behind"],
  })
  // Spending the only fresh week ahead of its own line still holds it.
  expect(dispatchPace([account("fresh", 0.06, 7 * day)], now, {}, 0.005, model)).toMatchObject({
    ok: false, reasonCode: "even-line", eligible: [],
  })
})

test("a usable login has exactly its solo pacing with any unavailable peer, including fleet charges", () => {
  const blocked = account("blocked", 0.98, 7 * day)
  const variants = [
    account("blocked", 0.99, day),
    { ...blocked, hold: { kind: "rate-limit" as const, at: now, until: now + hour } },
    { ...blocked, reading: { at: now, windows: [
      { name: "7d", utilization: 0.98, resetAt: now + 7 * day },
      { name: "5h", utilization: 0.95, resetAt: now + hour },
      { name: "7d:Fable", utilization: 0.1, resetAt: now + day },
    ] } },
    { ...blocked, reading: { at: now, windows: [
      { name: "7d", utilization: 0.98, resetAt: now + 7 * day },
      { name: "5h", utilization: 0, resetAt: now + hour },
      { name: "7d:Fable", utilization: 1, resetAt: now + day },
    ] } },
    { ...blocked, reading: { ...blocked.reading, at: now - hour } },
  ]
  for (const peer of variants) {
    for (const used of [0, 0.05, 0.051, 0.54, 0.545, 0.55, 0.98]) {
      for (const resetIn of [7 * day, 3.5 * day, hour]) {
        for (const count of [0, 1, 10, 11]) {
          const fresh = account("usable", used, resetIn)
          const inflight = { starts: Array.from({ length: count }, () => now - 1), cost: 0.005, settleMs: 10 * 60_000 }
          const solo = poolPace([fresh], now, inflight, model)
          for (const accounts of [[fresh, peer], [peer, fresh]]) {
            const pooled = poolPace(accounts, now, inflight, model)
            expect({ ok: pooled.ok, eligible: pooled.eligible }).toEqual({ ok: solo.ok, eligible: solo.eligible })
          }
        }
      }
    }
  }
})

test("fleet starts spend positive room once and a retry catches the first account up without foreign debt", () => {
  const first = account("first", 0.54, 3.5 * day)
  const second = account("second", 0.54, 3.5 * day)
  const ahead = account("ahead", 0.98, 3.5 * day)
  const inflight = (count: number) => ({ starts: Array.from({ length: count }, () => now - 1), cost: 0.005, settleMs: 10 * 60_000 })
  expect(poolPace([first, second, ahead], now, inflight(2), model)).toMatchObject({ ok: true, eligible: ["first", "second"] })
  expect(poolPace([first, second, ahead], now, inflight(3), model)).toMatchObject({ ok: false, reasonCode: "even-line" })
  const slight = account("slight", 0.546, 3.5 * day)
  const held = poolPace([ahead, slight], now, NO_INFLIGHT, model)
  expect(held.ok).toBe(false)
  if (held.ok) return
  // One tenth of a percentage point catches up in about ten minutes, not days.
  expect(held.retryAt - now).toBeLessThan(11 * 60_000)
  const refreshed = { ...slight, reading: { ...slight.reading, at: held.retryAt } }
  expect(poolPace([ahead, refreshed], held.retryAt, NO_INFLIGHT, model)).toMatchObject({ ok: true, eligible: ["slight"] })
})
