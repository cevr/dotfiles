import { describe, expect, test } from 'bun:test';

import { admit, calibrate, DEFAULTS, estimate, fiveHourCeiling, resumeAt, target, weeklyPace, type Config } from './pace.ts';

const HOUR = 3600e3;
// Clock hours: these cases check the arithmetic, not the Sabbath.
const UTC: Config = { ...DEFAULTS, sabbath: false };
// 2026-10-21 12:00 UTC.
const NOON = Date.UTC(2026, 9, 21, 12);

describe('resumeAt', () => {
  test('an account with both windows left serves now', () => {
    expect(resumeAt([{ used7d: 1, reset7d: NOON + HOUR, used5h: 0 }, { used7d: 0.5, used5h: 0.9 }], NOON)).toBe(NOON);
  });
  test('a spent pool resumes at the earliest reset that frees an account', () => {
    const pool = [
      { used7d: 1, reset7d: NOON + 30 * HOUR, used5h: 0 },
      { used7d: 0.4, reset7d: NOON + 90 * HOUR, used5h: 1, reset5h: NOON + 2 * HOUR },
      // Its 5-hour window resets first, but its week is still spent.
      { used7d: 1, reset7d: NOON + 50 * HOUR, used5h: 1, reset5h: NOON + HOUR },
    ];
    expect(resumeAt(pool, NOON)).toBe(NOON + 2 * HOUR);
  });
  test('no known reset gives no time', () => {
    expect(resumeAt([{ used7d: 1, used5h: 0 }], NOON)).toBeUndefined();
  });
});

describe('weeklyPace', () => {
  test('spends the target of an account evenly by its reset, at any hour', () => {
    const accounts = [{ used7d: 0.5, reset7d: NOON + 24 * HOUR, used5h: 0 }];
    const day = weeklyPace(accounts, NOON, UTC);
    expect(day.floor).toBeCloseTo((0.99 - 0.5) / 24);
    // 02:00, ten hours before the reset: the same even burn over the hours left.
    const late = weeklyPace(accounts, Date.UTC(2026, 9, 22, 2), UTC);
    expect(late.floor).toBeCloseTo((0.99 - 0.5) / 10);
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
    expect(pace.rolling).toBeCloseTo(inView / (7 * 24));
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
  const base = { targetWph: 100, estimateWph: 20, reserved: [] };
  const root = (recentWph: number) => ({ session: 'r', project: 'gent', kind: 'root', sub: false, recentWph });
  const sub = (recentWph: number) => ({ session: 'r', project: 'gent', kind: 'w:task', sub: true, recentWph });
  test('starts an agent that fits the pace', () => {
    expect(admit({ ...base, sessions: [root(30)] }).ok).toBe(true);
  });
  test('holds an agent that would pass the pace', () => {
    expect(admit({ ...base, sessions: [root(90)] }).ok).toBe(false);
  });
  test('counts a granted agent at its estimate before its burn shows', () => {
    expect(admit({ ...base, sessions: [root(50)], reserved: [{ estimateWph: 40 }] }).ok).toBe(false);
  });
  test('the cap holds every agent once the pool runs that many, granted ones included', () => {
    const sessions = [sub(5), sub(5)];
    expect(admit({ ...base, sessions, cap: 3 }).ok).toBe(true);
    expect(admit({ ...base, sessions, cap: 2 }).ok).toBe(false);
    expect(admit({ ...base, sessions, reserved: [{ estimateWph: 0 }], cap: 3 }).ok).toBe(false);
  });
  test('without a pace only the cap decides', () => {
    expect(admit({ ...base, targetWph: Infinity, estimateWph: 0, sessions: [], cap: 1 })).toEqual({ ok: true, reason: 'fits: pool 0.0 MW/h of no pace yet' });
  });
});

describe('the Sabbath', () => {
  test('spreads the week over the hours outside it, so each working hour carries more', () => {
    // Wednesday noon; the account resets the next Wednesday noon, half spent.
    const accounts = [{ used7d: 0.5, reset7d: NOON + 7 * 24 * HOUR, used5h: 0 }];
    const clock = weeklyPace(accounts, NOON, UTC);
    const rest = weeklyPace(accounts, NOON, DEFAULTS);
    // Friday sunset to Saturday sunset in Knowlton is about 24 hours of the 168.
    expect(rest.floor / clock.floor).toBeGreaterThan(168 / 145);
    expect(rest.floor / clock.floor).toBeLessThan(168 / 143);
  });
  test('a reset that falls in the rest leaves no pace undefined: its quota left is lost, and it refills', () => {
    // Saturday noon in Knowlton, in the rest; one account resets at 15:00, the other next Wednesday.
    const now = Date.UTC(2026, 9, 31, 16);
    const accounts = [
      { used7d: 1, reset7d: Date.UTC(2026, 9, 31, 19), used5h: 0 },
      { used7d: 0.2, reset7d: Date.UTC(2026, 10, 4, 12), used5h: 0 },
    ];
    const pace = weeklyPace(accounts, now, DEFAULTS);
    expect(Number.isFinite(pace.floor)).toBe(true);
    expect(pace.floor).toBeGreaterThan(0);
    expect(Number.isFinite(pace.ceiling)).toBe(true);
  });
});
