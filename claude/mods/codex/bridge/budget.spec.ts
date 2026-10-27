import { describe, expect, test } from 'bun:test'

import { budget, DEFAULTS, refusal } from './budget.ts'

const HOUR = 3600e3
const DAY = 24 * HOUR
const now = Date.UTC(2026, 9, 27, 12)
const s = (ms: number) => Math.round(ms / 1e3)
// A 7-day window `elapsed` days in.
const week = (usedPercent: number, elapsed: number) => ({ usedPercent, windowDurationMins: 7 * 1440, resetsAt: s(now + (7 - elapsed) * DAY) })
const fiveHours = (usedPercent: number) => ({ usedPercent, windowDurationMins: 300, resetsAt: s(now + 2 * HOUR) })

describe('budget', () => {
  test('lets new threads and next turns go on under the even line, a day ahead', () => {
    // The line 2 days in: 99% × 3/7 ≈ 42%.
    const b = budget({ primary: week(40, 2) }, now)
    expect(b.start.ok).toBe(true)
    expect(b.send.ok).toBe(true)
    expect(b.summary).toBe('Codex budget: 7-day window: 40% used; even line 42% now; 99% by 2026-11-01 12:00Z. New threads and next turns go on.')
  })

  test('holds new threads ahead of the line until the line reaches the use, and lets next turns go on', () => {
    const b = budget({ primary: week(58, 2) }, now)
    expect(b.start.ok).toBe(false)
    expect(b.send.ok).toBe(true)
    // 58% of 7 days at 99% is 4.10 days of the week, less the day's lead.
    expect(b.start.until).toBeCloseTo(now - 2 * DAY + (0.58 * 7 * DAY) / 0.99 - DAY, -3)
    expect(refusal('start', b.start)).toStartWith('The Codex budget holds a new Codex thread: the 7-day window is 58% used; an even burn to 99% by 2026-11-01 12:00Z allows 42% now')
  })

  test('holds both at the weekly target, and at a spent window, until the reset', () => {
    for (const used of [99, 100]) {
      const b = budget({ primary: week(used, 6) }, now)
      expect([b.start.ok, b.send.ok]).toEqual([false, false])
      expect(b.send.until).toBe(now + DAY)
    }
  })

  test('holds both when the 5-hour window passes its ceiling, whatever the week', () => {
    const b = budget({ primary: fiveHours(DEFAULTS.shortMax * 100), secondary: week(10, 3) }, now)
    expect([b.start.ok, b.send.ok]).toEqual([false, false])
    expect(b.send.until).toBe(now + 2 * HOUR)
    expect(budget({ primary: fiveHours(50), secondary: week(10, 3) }, now).start.ok).toBe(true)
  })

  test('holds both when Codex reports a reached limit', () => {
    const b = budget({ primary: week(10, 3), rateLimitReachedType: 'rate_limit_reached' }, now)
    expect([b.start.ok, b.send.ok]).toEqual([false, false])
  })

  test('takes the settings over the defaults', () => {
    expect(budget({ primary: week(58, 2) }, now, { ...DEFAULTS, leadHours: 72 }).start.ok).toBe(true)
  })

  test('applies no budget when the usage is unknown', () => {
    const b = budget(null, now)
    expect([b.start.ok, b.send.ok]).toEqual([true, true])
    expect(b.summary).toBe('Codex usage unknown; no budget applied.')
  })
})
