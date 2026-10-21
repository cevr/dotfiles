import { describe, expect, test } from 'bun:test';

import { admit, calibrate, DEFAULTS, estimate, fiveHourCeiling, target, weeklyPace, weightedHours, type Config } from './pace.ts';

const HOUR = 3600e3;
const UTC: Config = { ...DEFAULTS, timezone: 'UTC', dayStart: 8, dayEnd: 24, nightWeight: 0.25 };
// 2026-10-21 12:00 UTC, a day hour.
const NOON = Date.UTC(2026, 9, 21, 12);

describe('weightedHours', () => {
  test('a night hour counts its weight', () => {
    expect(weightedHours(NOON, NOON + 24 * HOUR, UTC)).toBeCloseTo(16 + 8 * 0.25);
  });
});

describe('weeklyPace', () => {
  test('spends the target of an account by its reset, more by day than by night', () => {
    const accounts = [{ used7d: 0.5, reset7d: NOON + 24 * HOUR, used5h: 0 }];
    const day = weeklyPace(accounts, NOON, UTC);
    expect(day.floor).toBeCloseTo((0.99 - 0.5) / 18);
    const night = weeklyPace(accounts, Date.UTC(2026, 9, 22, 2), UTC);
    expect(night.floor).toBeLessThan(day.floor);
  });

  test('the ceiling counts each earlier reset as a refill', () => {
    const accounts = [
      { used7d: 0.9, reset7d: NOON + 2 * HOUR, used5h: 0 },
      { used7d: 1, reset7d: NOON + 10 * HOUR, used5h: 0 },
    ];
    expect(weeklyPace(accounts, NOON, UTC).ceiling).toBeCloseTo(0.1 / 2);
  });

  test('the rolling pace counts the weeks that open in the next 7 days', () => {
    // Today's pool: one account just reset, six spent that reset over the week.
    const accounts = [
      { used7d: 0.03, reset7d: NOON + 166 * HOUR, used5h: 0 },
      ...[5, 17, 33, 55, 65, 108].map((h) => ({ used7d: 1, reset7d: NOON + h * HOUR, used5h: 0 })),
    ];
    const pace = weeklyPace(accounts, NOON, UTC);
    const inView = 0.96 + [5, 17, 33, 55, 65, 108].reduce((n, h) => n + (0.99 * (168 - h)) / 168, 0) + (0.99 * 2) / 168;
    expect(pace.rolling).toBeCloseTo(inView / (7 * (16 + 8 * 0.25)));
    // The floor sees only the one account in hand, spread over its week.
    expect(pace.floor).toBeLessThan(pace.rolling / 4);
  });

  test('a spent pool has no floor to keep', () => {
    const accounts = [{ used7d: 1, reset7d: NOON + 5 * HOUR, used5h: 0 }];
    expect(weeklyPace(accounts, NOON, UTC).floor).toBe(0);
  });
});

describe('fiveHourCeiling', () => {
  test('keeps the accounts with weekly quota under the 5-hour cap until they reset', () => {
    const accounts = [
      { used7d: 0.5, used5h: 0.6, reset5h: NOON + 2 * HOUR },
      { used7d: 1, used5h: 0, reset5h: NOON + HOUR },
    ];
    expect(fiveHourCeiling(accounts, NOON, UTC)).toBeCloseTo((0.9 - 0.6) / 2);
  });

  test('an account whose spent week resets within 5 hours refills the pool', () => {
    const live = { used7d: 0.5, used5h: 0.6, reset5h: NOON + 4 * HOUR };
    // 0.3 must last to the weekly reset at 1h; then 0.3 + 0.9 lasts to the 5h reset at 4h.
    const soon = [live, { used7d: 1, reset7d: NOON + HOUR, used5h: 0 }];
    expect(fiveHourCeiling(soon, NOON, UTC)).toBeCloseTo(0.3);
    const late = [live, { used7d: 1, reset7d: NOON + 6 * HOUR, used5h: 0 }];
    expect(fiveHourCeiling(late, NOON, UTC)).toBeCloseTo(0.3 / 4);
  });
});

describe('calibrate', () => {
  test('turns the last hour of quota rise into quota per weighted token', () => {
    const samples = [
      { at: NOON, used7d: [0.5], used5h: [0.2], w1h: 10e6 },
      { at: NOON + HOUR, used7d: [0.52], used5h: [0.3], w1h: 10e6 },
    ];
    const k = calibrate(samples);
    expect(k.k7).toBeCloseTo(0.02 / 10e6);
    expect(k.k5).toBeCloseTo(0.1 / 10e6);
  });

  test('needs 45 minutes of samples', () => {
    expect(calibrate([{ at: NOON, used7d: [0.5], used5h: [0.2], w1h: 1 }])).toEqual({});
  });
});

describe('target', () => {
  test('takes the lowest of the pace and the ceilings, in weighted tokens per hour', () => {
    const accounts = [{ used7d: 0.5, reset7d: NOON + 24 * HOUR, used5h: 0.85, reset5h: NOON + 4 * HOUR }];
    const t = target(accounts, NOON, UTC, { k7: 1e-8, k5: 1e-7 });
    expect(t.targetWph).toBeCloseTo((0.05 / 4) / 1e-7);
  });

  test('a pool of spent accounts that reset soon keeps the rolling pace, under the ceilings', () => {
    const accounts = [
      { used7d: 0.5, reset7d: NOON + 160 * HOUR, used5h: 0 },
      { used7d: 1, reset7d: NOON + 2 * HOUR, used5h: 0 },
    ];
    const t = target(accounts, NOON, UTC, { k7: 1e-8 });
    expect(t.week.rolling).toBeGreaterThan(t.week.floor);
    expect(t.targetWph).toBeCloseTo(Math.min(t.week.rolling, t.week.ceiling) / 1e-8);
  });
});

describe('estimate', () => {
  const kinds = [
    { project: 'gent', kind: 'w:review', agents: 3, wph: [10, 12, 14] },
    { project: 'hymn', kind: 'w:review', agents: 1, wph: [40] },
    { project: 'hymn', kind: 'w:verify', agents: 3, wph: [20, 22, 24] },
  ];
  test("prefers the project's own history for the kind", () => {
    expect(estimate(kinds, 'gent', 'w:review')).toBe(12);
  });
  test("falls back to the kind's history across projects", () => {
    expect(estimate(kinds, 'hymn', 'w:review')).toBe(14);
  });
});

describe('admit', () => {
  const base = { targetWph: 100, project: 'gent', estimateWph: 20, night: false, c: UTC };
  test('starts an agent that fits the pace', () => {
    expect(admit({ ...base, sessions: [{ project: 'gent', kind: 'root', sub: false, recentWph: 30 }] }).ok).toBe(true);
  });
  test('holds an agent that would pass the pace', () => {
    expect(admit({ ...base, sessions: [{ project: 'hymn', kind: 'root', sub: false, recentWph: 90 }] }).ok).toBe(false);
  });
  test("holds a project over its share once the pool nears the pace", () => {
    const sessions = [
      { project: 'gent', kind: 'w:task', sub: true, recentWph: 50 },
      { project: 'hymn', kind: 'root', sub: false, recentWph: 15 },
    ];
    expect(admit({ ...base, sessions }).ok).toBe(false);
  });
  test('lets a project borrow while the pool has room', () => {
    const sessions = [{ project: 'gent', kind: 'w:task', sub: true, recentWph: 55 }, { project: 'hymn', kind: 'root', sub: false, recentWph: 0 }];
    expect(admit({ ...base, sessions }).ok).toBe(true);
  });
  test('runs one agent per project at night', () => {
    const sessions = [{ project: 'gent', kind: 'w:task', sub: true, recentWph: 5 }];
    expect(admit({ ...base, night: true, sessions }).ok).toBe(false);
    expect(admit({ ...base, night: true, project: 'hymn', sessions }).ok).toBe(true);
  });
});
