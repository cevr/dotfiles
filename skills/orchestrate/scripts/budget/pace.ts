// The pool's pace, in weighted tokens per hour (W/h), and whether a new agent
// fits it. Pure: budget.ts gathers the inputs.
//
// - Weekly: each account's quota expires at its own reset, so the pace is the
//   slowest even burn that spends `weeklyTarget` of every account before it
//   resets. Every hour carries the same pace, so the flow stays steady until
//   the quota is spent.
// - Rolling: quota keeps coming, as each account opens a new week at its reset.
//   The pace never falls below an even burn of the quota in hand plus the share
//   of each new week that opens in the next 7 days, so a pool whose accounts
//   are spent but reset soon keeps working on the accounts left.
// - Ceilings: never so fast that the pool hits a weekly limit before the next
//   refill, nor that the accounts with weekly quota pass `fiveHourMax` of their
//   5-hour windows before those reset.
// - Quota fractions turn into W/h through k7 and k5: the rise of the accounts'
//   weekly and 5-hour use per weighted token over the last hour.
// - No agent works on the Sabbath (the sabbath mod), so with `sabbath` set the
//   weekly paces spread the quota over the hours outside it (owner, 2026-10-30).

import { awake } from '../../../../claude/mods/sabbath/hooks/sabbath.ts';

export type Account = { used7d: number; reset7d?: number; used5h: number; reset5h?: number };

// When the first account can serve again: now when one has both windows left,
// else the earliest reset that frees an account. Undefined when no reset is known.
export function resumeAt(accounts: Account[], now: number): number | undefined {
  const free = (a: Account) => {
    const waits = [a.used7d >= 1 ? a.reset7d : now, a.used5h >= 1 ? a.reset5h : now];
    return waits.some((t) => t === undefined) ? undefined : Math.max(now, ...(waits as number[]));
  };
  const times = accounts.map(free).filter((t): t is number => t !== undefined);
  return times.length ? Math.min(...times) : undefined;
}

export type Config = {
  weeklyTarget: number;
  fiveHourMax: number;
  /** The weekly paces count only the hours outside the Sabbath. */
  sabbath: boolean;
};

export const DEFAULTS: Config = {
  weeklyTarget: 0.99,
  fiveHourMax: 0.9,
  sabbath: true,
};

const HOUR = 3600e3;
const WEEK = 7 * 24 * HOUR;
/** The working hours from `now` to `until`. */
const hours = (now: number, until: number, c: Config) => (c.sabbath ? awake(now, until) : until - now) / HOUR;
/** Fractions of one account's week per hour, now. */
export function weeklyPace(accounts: readonly Account[], now: number, c: Config): { floor: number; rolling: number; ceiling: number } {
  const due = accounts
    .filter((a): a is Account & { reset7d: number } => (a.reset7d ?? 0) > now)
    .sort((a, b) => a.reset7d - b.reset7d);
  let expiring = 0;
  let floor = 0;
  let fuel = due.reduce((n, a) => n + Math.max(0, 1 - a.used7d), 0);
  let ceiling = Infinity;
  for (const a of due) {
    const h = hours(now, a.reset7d, c);
    // No working hour comes before this reset (it falls in the rest): its quota left is lost, and it refills whole.
    if (h <= 0) {
      fuel += Math.min(1, a.used7d) - Math.max(0, 1 - a.used7d);
      continue;
    }
    expiring += Math.max(0, c.weeklyTarget - a.used7d);
    floor = Math.max(floor, expiring / h);
    ceiling = Math.min(ceiling, fuel / h);
    fuel += Math.min(1, a.used7d);
  }
  const inView = due.reduce(
    (n, a) => n + Math.max(0, c.weeklyTarget - a.used7d) + (c.weeklyTarget * Math.max(0, now + WEEK - a.reset7d)) / WEEK,
    0,
  );
  const rolling = due.length === 0 ? 0 : inView / hours(now, now + WEEK, c);
  return { floor, rolling, ceiling };
}

/**
 * Fractions of one account's 5-hour window per hour that keep every account with weekly quota under `fiveHourMax`.
 * An account out of weekly quota serves again from its weekly reset, when that comes within 5 hours.
 */
export function fiveHourCeiling(accounts: readonly Account[], now: number, c: Config): number {
  const open = accounts.filter((a) => a.used7d < 1);
  const refills = [
    ...open.filter((a) => (a.reset5h ?? 0) > now).map((a) => ({ at: a.reset5h!, gain: Math.min(c.fiveHourMax, a.used5h) })),
    ...accounts
      .filter((a) => a.used7d >= 1 && (a.reset7d ?? 0) > now && a.reset7d! <= now + 5 * HOUR)
      .flatMap((a) => {
        const held = (a.reset5h ?? 0) > a.reset7d! ? Math.min(c.fiveHourMax, a.used5h) : 0;
        return [{ at: a.reset7d!, gain: Math.max(0, c.fiveHourMax - held) }, ...(held > 0 ? [{ at: a.reset5h!, gain: held }] : [])];
      }),
  ].sort((a, b) => a.at - b.at);
  let fuel = open.reduce((n, a) => n + Math.max(0, c.fiveHourMax - a.used5h), 0);
  let ceiling = Infinity;
  for (const r of refills) {
    ceiling = Math.min(ceiling, fuel / ((r.at - now) / HOUR));
    fuel += r.gain;
  }
  // After the resets in view, the refilled windows must last a whole window.
  return Math.min(ceiling, fuel / 5);
}

export type Sample = { at: number; used7d: number[]; used5h: number[]; w1h: number };

/** The summed rise of each account's use from `before` to `after`; a fall is a reset and counts from 0. */
function rise(before: number[], after: number[]): number {
  return after.reduce((n, used, i) => n + (used >= (before[i] ?? 0) ? used - (before[i] ?? 0) : used), 0);
}

/** Quota per weighted token, from samples at least 45 minutes apart. */
export function calibrate(samples: readonly Sample[]): { k7?: number; k5?: number } {
  const now = samples.at(-1);
  const base = samples.findLast((s) => now !== undefined && s.at <= now.at - 45 * 60e3);
  if (!now || !base || now.used7d.length !== base.used7d.length || now.w1h <= 0) return {};
  const tokens = (now.w1h * (now.at - base.at)) / HOUR;
  const k7 = rise(base.used7d, now.used7d) / tokens;
  const k5 = rise(base.used5h, now.used5h) / tokens;
  return { k7: k7 > 0 ? k7 : undefined, k5: k5 > 0 ? k5 : undefined };
}

/** The pool's target burn in W/h: the weekly pace, the higher of the floor and the rolling pace, under both ceilings. */
export function target(accounts: readonly Account[], now: number, c: Config, k: { k7?: number; k5?: number }) {
  const week = weeklyPace(accounts, now, c);
  const five = fiveHourCeiling(accounts, now, c);
  if (!k.k7) return { week, five, targetWph: undefined };
  const limits = [Math.max(week.floor, week.rolling) / k.k7, week.ceiling / k.k7];
  if (k.k5) limits.push(five / k.k5);
  return { week, five, targetWph: Math.max(0, Math.min(...limits)) };
}

export type Session = { session: string; project: string; kind: string; sub: boolean; recentWph: number };
export type KindCost = { project: string; kind: string; agents: number; wph: number[] };

const median = (xs: number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** An agent's expected W/h: its project and kind's history, then its kind's, then every agent's. */
export function estimate(kinds: readonly KindCost[], project: string, kind: string): number | undefined {
  const of = (match: (k: KindCost) => boolean) => kinds.filter(match).flatMap((k) => k.wph);
  for (const xs of [of((k) => k.project === project && k.kind === kind), of((k) => k.kind === kind), of(() => true)]) {
    if (xs.length >= 3) return median(xs);
  }
  return median(of(() => true));
}

export type Decision = { ok: boolean; reason: string };

/**
 * Whether one more agent fits the pace. `reserved` are agents whose turn came
 * but whose burn the transcripts do not show yet. Which agent asks is the
 * queue's choice (budget/queue.ts), so this sees only the pool.
 */
export function admit(input: {
  targetWph: number;
  sessions: readonly Session[];
  reserved: readonly { estimateWph: number }[];
  estimateWph: number;
  /** The most agents the pool runs at once, whatever the pace. */
  cap?: number;
}): Decision {
  const { targetWph, sessions, reserved, estimateWph, cap } = input;
  const burn = sessions.reduce((n, s) => n + s.recentWph, 0) + reserved.reduce((n, r) => n + r.estimateWph, 0);
  const mw = (n: number) => (Number.isFinite(n) ? `${(n / 1e6).toFixed(1)} MW/h` : 'no pace yet');
  const agents = sessions.filter((s) => s.sub).length + reserved.length;
  if (cap !== undefined && agents >= cap) {
    return { ok: false, reason: `the pool runs ${agents} of its ${cap} agent(s)` };
  }
  if (burn + estimateWph > targetWph) {
    return { ok: false, reason: `pool burns ${mw(burn)}; this agent adds about ${mw(estimateWph)}; the pace is ${mw(targetWph)}` };
  }
  return { ok: true, reason: `fits: pool ${mw(burn + estimateWph)} of ${mw(targetWph)}` };
}
