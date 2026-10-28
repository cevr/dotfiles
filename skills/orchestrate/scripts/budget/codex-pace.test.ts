import { describe, expect, test } from 'bun:test';

import type { CodexLoad, HourLoad, Snapshot, ThreadCost } from './codex-host.ts';
import { admit, estimate, fit, fitWeek, MIN_CURRENT, MIN_WINDOWS, target, weekNow, windows, WINDOW } from './codex-pace.ts';
import { DEFAULTS } from './pace.ts';

const HOUR = 3600e3;
const WEEK = 7 * 24 * HOUR;
// 2026-10-21 00:00 UTC.
const START = Date.UTC(2026, 9, 21);
// The true cost of 1% of the week: 8 MW of sol, 48 MW of luna.
const K = { sol: 1 / 8e6, luna: 1 / 48e6 };

// A fixed pseudo-random sequence in [0, 1), so the families' tokens do not move together.
const random = (seed = 1) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/**
 * `days` of hourly tokens, sol every hour and luna in 40% of them, with the
 * week's use as Codex reports it: whole percent, a snapshot each hour, and the
 * week reset early at `resetAt` (it starts again from 0, where each token
 * costs `after` times as much of the week).
 */
function history(days: number, resetAt: number, luna?: (h: number) => number, after = 1) {
  const next = random();
  const hours: HourLoad[] = [];
  const snapshots: Snapshot[] = [];
  let used = 30;
  let resetsAt = START + 4 * 24 * HOUR;
  let cost = 1;
  for (let h = 0; h < days * 24; h++) {
    const at = START + h * HOUR;
    if (at === resetAt) {
      used = 0;
      resetsAt = at + WEEK;
      cost = after;
    }
    const w = { sol: 4e6 + Math.floor(next() * 13) * 1e6, luna: next() < 0.4 ? 40e6 : 0 };
    if (luna) w.luna = luna(h);
    hours.push({ at, w });
    used += cost * (w.sol * K.sol + w.luna * K.luna);
    snapshots.push({ at: at + HOUR - 60e3, used: Math.floor(used), resetsAt, windowMinutes: 7 * 1440 });
  }
  return { hours, snapshots };
}

describe('fit', () => {
  test("recovers each family's cost from whole-percent use, skipping the windows that span a reset", () => {
    const resetAt = START + 52 * HOUR;
    const { hours, snapshots } = history(5, resetAt);
    const rows = windows(hours, snapshots);
    expect(rows.some((r) => r.at < resetAt && r.at + WINDOW > resetAt - 60e3)).toBe(false);
    expect(rows.length).toBe(5 * 8 - 2);
    const f = fit(rows);
    // Whole-percent steps over 5 days pin each cost within 10%.
    expect(Math.abs(f.k.sol! / K.sol - 1)).toBeLessThan(0.1);
    expect(Math.abs(f.k.luna! / K.luna - 1)).toBeLessThan(0.1);
    expect(f.windows.sol).toBeGreaterThanOrEqual(MIN_WINDOWS);
  });

  test('a family that dominates too few windows takes the shared cost', () => {
    // Luna burns every hour, but never 60% of a window's tokens.
    const { hours, snapshots } = history(3, 0, (h) => (h % 2 ? 6e6 : 0));
    const f = fit(windows(hours, snapshots));
    expect(f.windows.luna).toBe(0);
    expect(f.k.luna).toBe(f.shared!);
    expect(f.windows.sol).toBeGreaterThanOrEqual(MIN_WINDOWS);
  });
});

describe('fitWeek', () => {
  test('fits the current reset period alone once it has enough windows, since a reset can change the cost', () => {
    const resetAt = START + 51 * HOUR;
    const { hours, snapshots } = history(5, resetAt, undefined, 2);
    const resetsAt = snapshots.at(-1)!.resetsAt;
    const now = fitWeek(windows(hours, snapshots), resetsAt);
    expect(now.span).toBe('current period');
    // The first window after the reset starts from the old period's use, so it is skipped.
    expect(now.sharedWindows).toBe((5 * 24 - 51) / 3 - 1);
    expect(Math.abs(now.k.sol! / (2 * K.sol) - 1)).toBeLessThan(0.1);

    // A day after the reset the period has too few windows: the 7 days stand in.
    const early = history(3, resetAt, undefined, 2);
    const rows = windows(early.hours, early.snapshots);
    expect(rows.filter((r) => r.at >= resetAt).length).toBeLessThan(MIN_CURRENT);
    expect(fitWeek(rows, resetsAt)).toMatchObject({ span: '7 days', sharedWindows: rows.length });
  });
});

describe('the week', () => {
  const now = Date.UTC(2026, 9, 27, 12);
  test('the pace is the even burn to the target, never below the rolling pace, under the ceiling', () => {
    const week = { used: 60, resetsAt: now + 127 * HOUR, windowMinutes: 7 * 1440, at: now };
    const pace = target(week, now, DEFAULTS);
    expect(pace.floor).toBeCloseTo(39 / 127);
    expect(pace.rolling).toBeCloseTo((39 + (99 * 41) / 168) / 168);
    expect(pace.ceiling).toBeCloseTo(40 / 127);
    expect(pace.pctph).toBeCloseTo(40 / 127);
    // Early in the week the target pace rules.
    expect(target({ ...week, used: 10, resetsAt: now + 150 * HOUR }, now, DEFAULTS).pctph).toBeCloseTo(89 / 150);
  });

  test('a reset since the last snapshot opens a new week at 0', () => {
    const s = { at: now - 30 * HOUR, used: 80, resetsAt: now - 2 * HOUR, windowMinutes: 7 * 1440 };
    expect(weekNow([s], now)).toMatchObject({ used: 0, resetsAt: now - 2 * HOUR + WEEK });
    expect(weekNow([{ ...s, resetsAt: now + HOUR }], now)).toMatchObject({ used: 80, resetsAt: now + HOUR });
    // A short window is no week.
    expect(weekNow([{ ...s, windowMinutes: 300 }], now)).toBeUndefined();
  });
});

const thread = (family: string, role: string, wph: number): ThreadCost => ({ id: `${family}-${role}-${wph}`, family, role, activeHours: 2, w: 2 * wph });

describe('estimate', () => {
  const threads = [
    thread('sol', 'implementor', 3e6),
    thread('sol', 'implementor', 4e6),
    thread('sol', 'implementor', 5e6),
    thread('sol', 'reviewer', 1e6),
    thread('luna', 'verifier', 9e6),
    // Too short to tell.
    { ...thread('sol', 'reviewer', 50e6), activeHours: 0.05, w: 2.5e6 },
  ];
  test("a family and role's median, then the family's, then every thread's", () => {
    expect(estimate(threads, 'sol', 'implementor')).toBe(4e6);
    expect(estimate(threads, 'sol', 'reviewer')).toBe(4e6);
    expect(estimate(threads, 'luna', 'verifier')).toBe(4e6);
    expect(estimate([], 'sol', 'none')).toBeUndefined();
  });
});

describe('admit', () => {
  const k = { k: { sol: 1 / 8e6, luna: 1 / 48e6 }, windows: { sol: 40, luna: 10 }, shared: 1 / 10e6, sharedWindows: 50 };
  const load = (more: Partial<CodexLoad>): CodexLoad => ({
    host: 'mac',
    complete: true,
    hours: [],
    snapshots: [],
    threads: [thread('sol', 'implementor', 3.2e6), thread('sol', 'implementor', 3.2e6), thread('sol', 'implementor', 3.2e6)],
    live: [],
    w1h: 0,
    interactive1h: {},
    ...more,
  });
  // 8 MW/h of live sol threads, and 4.8 MW of interactive luna in the last hour: 1.1 %/h.
  const loads = [
    load({ live: [{ id: 'a', family: 'sol', role: 'reviewer', recentWph: 8e6 }, { id: 'i', family: 'sol', role: 'interactive', recentWph: 99e6 }] }),
    load({ host: 'box', threads: [], interactive1h: { luna: 4.8e6 } }),
  ];

  test('holds a thread whose cost takes the burn past the pace', () => {
    expect(admit({ loads, fit: k, pctph: 1.2, family: 'sol', role: 'implementor' })).toEqual({
      ok: false,
      reason: 'codex burns 1.1 %/h; this sol implementor adds about 0.4 %/h; the pace is 1.2 %/h',
    });
  });

  test('starts one that fits', () => {
    expect(admit({ loads, fit: k, pctph: 2, family: 'sol', role: 'implementor' })).toEqual({ ok: true, reason: 'fits: codex 1.5 %/h of 2.0 %/h with this sol implementor (+0.4 %/h)' });
  });

  test("a next turn does not count its own thread's live burn again", () => {
    // Without thread a's 1.0 %/h: 0.1 %/h interactive, plus 0.4 %/h for the turn.
    expect(admit({ loads, fit: k, pctph: 1.2, family: 'sol', role: 'reviewer', thread: 'a' })).toEqual({ ok: true, reason: 'fits: codex 0.5 %/h of 1.2 %/h with this sol reviewer (+0.4 %/h)' });
  });

  test('counts the turns just started that the live burn does not show yet', () => {
    expect(admit({ loads, fit: k, pctph: 2, family: 'sol', role: 'implementor', reserve: 0.6 })).toEqual({
      ok: false,
      reason: 'codex burns 1.7 %/h (0.6 %/h of it just started); this sol implementor adds about 0.4 %/h; the pace is 2.0 %/h',
    });
  });

  test('starts a lone turn that alone passes the pace', () => {
    expect(admit({ loads: [load({}), load({ host: 'box', threads: [] })], fit: k, pctph: 0.3, family: 'sol', role: 'implementor' })).toEqual({
      ok: true,
      reason: 'fits: this sol implementor runs alone, as no other worker burns; the pace is 0.3 %/h (+0.4 %/h)',
    });
    // Interactive use is no worker (2026-10-28: 0.2 %/h of it held the Workbox queue).
    expect(admit({ loads: [load({ interactive1h: { sol: 1.6e6 } })], fit: k, pctph: 0.5, family: 'sol', role: 'implementor' })).toMatchObject({ ok: true });
    // A worker live or just started is not alone.
    expect(admit({ loads: [load({})], fit: k, pctph: 0.3, family: 'sol', role: 'implementor', reserve: 0.1 })).toMatchObject({ ok: false });
  });

  test('cannot tell without a cost', () => {
    expect(admit({ loads, fit: { k: {}, windows: {}, sharedWindows: 0 }, pctph: 2, family: 'sol', role: 'none' })).toBeUndefined();
  });
});
