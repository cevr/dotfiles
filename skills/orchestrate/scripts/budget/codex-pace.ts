// The Codex account's pace, in percent of its week per hour (%/h), and whether
// a new thread fits it. Pure: budget.ts --codex gathers every host's load
// (budget/codex-host.ts).
//
// - Cost: Codex reports only the week's use, in whole percent. One weighted
//   token (W) of each model family costs k percent of the week, fitted from
//   every host's tokens against the rise of that use over 3-hour windows. An
//   early reset can change what a percent costs (on 2026-10-27 sol's went
//   from about 5 MW to 9.5 MW), so the fit takes the current reset period once
//   it has enough windows, and the last 7 days until then.
// - Pace: the weekly pace of pace.ts for one account: spend the target by the
//   reset at an even rate, never below the rolling pace, under the ceiling.
// - Admission: the threads live now and the last hour of interactive use burn
//   at some %/h; a new thread adds its family and role's median cost per
//   active hour. It starts when the sum stays within the pace.

import type { CodexLoad, HourLoad, LiveThread, Snapshot, ThreadCost } from './codex-host.ts';
import { weeklyPace, type Config } from './pace.ts';

const HOUR = 3600e3;
/** The fit's window: long enough that the use rises several whole percent in it. */
export const WINDOW = 3 * HOUR;
/** A family's own k needs this many windows it dominates: where it burns at least SHARE of the tokens. */
export const MIN_WINDOWS = 6;
const SHARE = 0.6;
/** The current reset period alone is fitted from this many windows. */
export const MIN_CURRENT = 8;
// A reset may come a little off the reported time: windows of one epoch report resets this close.
const EPOCH_SLACK = HOUR;

/**
 * Percent of the week per W of each family, and the windows it dominates;
 * a family with too few has the shared k (`windows` 0). `span` names the
 * windows fitted, `sharedWindows` how many.
 */
export type Fit = { k: Record<string, number>; windows: Record<string, number>; shared?: number; sharedWindows: number; span?: 'current period' | '7 days' };

/** The week's snapshots: the longest window Codex reports, past a day. */
export function weekly(snapshots: readonly Snapshot[]): Snapshot[] {
  const minutes = Math.max(0, ...snapshots.map((s) => s.windowMinutes));
  return minutes > 1440 ? snapshots.filter((s) => s.windowMinutes === minutes).sort((a, b) => a.at - b.at) : [];
}

/** The last snapshot at or before `at`. */
function before(snapshots: readonly Snapshot[], at: number): Snapshot | undefined {
  let lo = 0;
  let hi = snapshots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid]!.at <= at) lo = mid + 1;
    else hi = mid;
  }
  return snapshots[lo - 1];
}

export type Row = { at: number; resetsAt: number; rise: number; w: Record<string, number> };

/** Every host's tokens in WINDOW steps against the rise of the week's use; a window that spans a reset is skipped. */
export function windows(hours: readonly HourLoad[], snapshots: readonly Snapshot[]): Row[] {
  const week = weekly(snapshots);
  const by = new Map<number, Record<string, number>>();
  for (const h of hours) {
    const at = Math.floor(h.at / WINDOW) * WINDOW;
    const w = by.get(at) ?? {};
    for (const [f, x] of Object.entries(h.w)) w[f] = (w[f] ?? 0) + x;
    by.set(at, w);
  }
  const rows: Row[] = [];
  for (const [at, w] of by) {
    const a = before(week, at);
    const b = before(week, at + WINDOW);
    if (!a || !b || Math.abs(a.resetsAt - b.resetsAt) > EPOCH_SLACK || b.used < a.used) continue;
    if (Object.values(w).every((x) => x <= 0)) continue;
    rows.push({ at, resetsAt: b.resetsAt, rise: b.used - a.used, w });
  }
  return rows.sort((x, y) => x.at - y.at);
}

/** Least squares of `rise` over the columns, by the normal equations; undefined when they are singular. */
function leastSquares(rows: readonly { rise: number; x: number[] }[], n: number): number[] | undefined {
  // Scale each column to its largest value, so tokens and percents share one range.
  const scale = Array.from({ length: n }, (_, j) => Math.max(...rows.map((r) => Math.abs(r.x[j]!)), 0) || 1);
  const a = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  for (const r of rows) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) a[i]![j]! += (r.x[i]! / scale[i]!) * (r.x[j]! / scale[j]!);
      a[i]![n]! += (r.x[i]! / scale[i]!) * r.rise;
    }
  }
  for (let c = 0; c < n; c++) {
    const p = a.slice(c).reduce((best, row, i) => (Math.abs(row[c]!) > Math.abs(a[best]![c]!) ? c + i : best), c);
    if (Math.abs(a[p]![c]!) < 1e-12) return undefined;
    [a[c], a[p]] = [a[p]!, a[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r]![c]! / a[c]![c]!;
      for (let j = c; j <= n; j++) a[r]![j]! -= f * a[c]![j]!;
    }
  }
  return a.map((row, i) => row[n]! / row[i]! / scale[i]!);
}

/** Non-negative least squares over few columns: the best fit among every subset of them solved freely. */
export function nnls(rows: readonly { rise: number; x: number[] }[], n: number): number[] {
  let best: { k: number[]; residual: number } = { k: new Array(n).fill(0), residual: rows.reduce((s, r) => s + r.rise ** 2, 0) };
  for (let mask = 1; mask < 1 << n; mask++) {
    const cols = [...Array(n).keys()].filter((j) => mask & (1 << j));
    const k = leastSquares(rows.map((r) => ({ rise: r.rise, x: cols.map((j) => r.x[j]!) })), cols.length);
    if (!k || k.some((x) => !(x >= 0))) continue;
    const full = new Array(n).fill(0);
    cols.forEach((j, i) => (full[j] = k[i]));
    const residual = rows.reduce((s, r) => s + (r.rise - r.x.reduce((t, x, j) => t + x * full[j], 0)) ** 2, 0);
    if (residual < best.residual) best = { k: full, residual };
  }
  return best.k;
}

/**
 * Each family's k: its own where it dominates MIN_WINDOWS windows, fitted with
 * the others' tokens at the shared k; else the shared k, one fit over every token.
 */
export function fit(rows: readonly Row[]): Fit {
  const families = [...new Set(rows.flatMap((r) => Object.keys(r.w)))].sort();
  const total = (r: Row) => Object.values(r.w).reduce((n, x) => n + x, 0);
  const [shared] = rows.length >= MIN_WINDOWS ? nnls(rows.map((r) => ({ rise: r.rise, x: [total(r)] })), 1) : [];
  const backing = Object.fromEntries(families.map((f) => [f, rows.filter((r) => (r.w[f] ?? 0) >= SHARE * total(r)).length]));
  const own = families.filter((f) => backing[f]! >= MIN_WINDOWS);
  const k: Record<string, number> = {};
  const used: Record<string, number> = {};
  if (own.length) {
    // The other families' tokens at the shared k come off the rise.
    const rest = (r: Row) => (shared ?? 0) * Object.entries(r.w).reduce((n, [f, x]) => n + (own.includes(f) ? 0 : x), 0);
    const ks = nnls(rows.map((r) => ({ rise: r.rise - rest(r), x: own.map((f) => r.w[f] ?? 0) })), own.length);
    own.forEach((f, i) => {
      if (ks[i]! > 0) {
        k[f] = ks[i]!;
        used[f] = backing[f]!;
      }
    });
  }
  for (const f of families) {
    if (k[f] === undefined && shared) {
      k[f] = shared;
      used[f] = 0;
    }
  }
  return { k, windows: used, shared: shared || undefined, sharedWindows: rows.length };
}

/** The fit of the current reset period, ending at `resetsAt`, once it has MIN_CURRENT windows; else of every window. */
export function fitWeek(rows: readonly Row[], resetsAt: number | undefined): Fit {
  const current = rows.filter((r) => resetsAt !== undefined && Math.abs(r.resetsAt - resetsAt) <= EPOCH_SLACK);
  return current.length >= MIN_CURRENT ? { ...fit(current), span: 'current period' } : { ...fit(rows), span: '7 days' };
}

/** The k of a family: its own, else the shared one. */
export const kOf = (f: Fit, family: string): number | undefined => f.k[family] ?? f.shared;

export type Week = { used: number; resetsAt: number; windowMinutes: number; at: number };

/** The week now, from its latest snapshot: a reset since then opens a new week at 0. */
export function weekNow(snapshots: readonly Snapshot[], now: number): Week | undefined {
  const last = weekly(snapshots).at(-1);
  if (!last) return undefined;
  const span = last.windowMinutes * 60e3;
  if (last.resetsAt > now) return { used: last.used, resetsAt: last.resetsAt, windowMinutes: last.windowMinutes, at: last.at };
  const resetsAt = last.resetsAt + Math.ceil((now - last.resetsAt + 1) / span) * span;
  return { used: 0, resetsAt, windowMinutes: last.windowMinutes, at: now };
}

/** The pace in %/h: the higher of the even burn to the target and the rolling pace, under the ceiling. */
export function target(week: Week, now: number, c: Config) {
  const pace = weeklyPace([{ used7d: week.used / 100, reset7d: week.resetsAt, used5h: 0 }], now, c);
  const pct = { floor: 100 * pace.floor, rolling: 100 * pace.rolling, ceiling: 100 * pace.ceiling };
  return { ...pct, pctph: Math.max(0, Math.min(Math.max(pct.floor, pct.rolling), pct.ceiling)) };
}

const median = (xs: number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** A thread runs this long before its cost per active hour counts. */
const MIN_ACTIVE = 5 / 60;

/** Past threads' W per active hour, with the threads that ran long enough to tell. */
export const wph = (threads: readonly ThreadCost[]): number[] =>
  threads.filter((t) => t.activeHours >= MIN_ACTIVE).map((t) => t.w / t.activeHours);

/** A new thread's W per active hour: its family and role's median, then its family's, then every thread's. */
export function estimate(threads: readonly ThreadCost[], family: string, role: string): number | undefined {
  for (const xs of [wph(threads.filter((t) => t.family === family && t.role === role)), wph(threads.filter((t) => t.family === family))]) {
    if (xs.length >= 3) return median(xs);
  }
  return median(wph(threads));
}

/** The %/h burnt now: each live thread's recent rate, and the last hour of interactive use, which no admission sees. */
export function burn(live: readonly LiveThread[], interactive1h: Record<string, number>, f: Fit): number {
  const threads = live.filter((t) => t.role !== 'interactive').reduce((n, t) => n + t.recentWph * (kOf(f, t.family) ?? 0), 0);
  return threads + Object.entries(interactive1h).reduce((n, [family, w]) => n + w * (kOf(f, family) ?? 0), 0);
}

export type Decision = { ok: boolean; reason: string };

/**
 * Whether one more turn of `family` in `role` fits the pace; undefined when its cost cannot be measured.
 * `thread` is the thread a next turn continues: its own live burn is the turn's estimate, not extra.
 * `reserve` (%/h) is the turns the bridge started that the live burn does not show yet.
 */
export function admit(input: {
  loads: readonly CodexLoad[];
  fit: Fit;
  pctph: number;
  family: string;
  role: string;
  thread?: string;
  reserve?: number;
}): Decision | undefined {
  const { loads, fit: f, pctph, family, role, thread, reserve = 0 } = input;
  const k = kOf(f, family);
  const wph = estimate(
    loads.flatMap((l) => l.threads),
    family,
    role,
  );
  if (k === undefined || wph === undefined) return undefined;
  const interactive: Record<string, number> = {};
  for (const l of loads) for (const [fam, w] of Object.entries(l.interactive1h)) interactive[fam] = (interactive[fam] ?? 0) + w;
  const now =
    burn(
      loads.flatMap((l) => l.live).filter((t) => t.id !== thread),
      interactive,
      f,
    ) + reserve;
  const adds = wph * k;
  const p = (n: number) => `${n.toFixed(1)} %/h`;
  const who = `${family} ${role === 'none' ? 'thread' : role}`;
  const burns = `codex burns ${p(now)}${reserve > 0 ? ` (${p(reserve)} of it just started)` : ''}`;
  if (now + adds > pctph) return { ok: false, reason: `${burns}; this ${who} adds about ${p(adds)}; the pace is ${p(pctph)}` };
  return { ok: true, reason: `fits: codex ${p(now + adds)} of ${p(pctph)} with this ${who} (+${p(adds)})` };
}
