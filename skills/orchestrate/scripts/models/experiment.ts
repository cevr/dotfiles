// The model experiment's view (`models.ts --experiment`): the orchestrate mod
// starts a share of one role's units on a trial model (its experiment.ts) and
// records each new start's arm in the call log. Per arm: the starts, what each
// cost in tokens and at each model's price, and what became of the units
// downstream. Pure, so the tests feed it fixture lines.
import { basename } from 'node:path';
import type { Round } from './opencode.ts';
import type { Outcome } from './outcomes.ts';
import { costOf, type Tokens } from './prices.ts';

/** Below this many starts in an arm, the view says the comparison is too small to call. */
export const MIN_PER_ARM = 10;

const ROLES = new Set(['planner', 'implementor', 'verifier', 'reviewer']);

/** The unit a step's description names: `planner auth r1` or `auth r2 planner`. */
export const unitOf = (description: string): string | undefined => {
  const [first, second] = description.trim().split(/\s+/);
  if (first && ROLES.has(first)) return second && !/^r\d+$/.test(second) ? second : undefined;
  return first && second && (ROLES.has(second) || /^r\d+$/.test(second)) ? first : undefined;
};

export type ArmStats = {
  arm: 'trial' | 'control';
  starts: number;
  units: number;
  ran: Record<string, number>; // starts per model id it ran on
  fellBack: number; // trial starts that took the normal chain
  joined: number; // starts whose session's tokens were found
  tokens: Tokens; // mean per joined start
  cost: Record<string, number | null>; // mean $ per joined start at each compared model's price
  passRounds: number | null; // median implementor rounds to an accepted verdict, over units that passed
  passed: number;
  firstPass: number | null; // share of judged units accepted at round 1
  judged: number;
  replans: number; // planner starts past the first, over the arm's units
  stuck: number; // units with a stuck verdict
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : null;
};
const top = (counts: Record<string, number>) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];

/**
 * Each arm's stats. `tokensOf` gives a child session's tokens (an OpenCode agent's); `outcomes`
 * are every unit round's verdicts, matched to a start by the unit's name.
 */
export function armStats(rounds: Round[], tokensOf: (child: string) => Tokens | undefined, outcomes: Outcome[]): { role: string; trial: string; models: string[]; arms: ArmStats[] } | undefined {
  const starts = rounds.filter((r) => r.experiment && r.fate !== 'denied');
  if (!starts.length) return undefined;
  const role = top(Object.fromEntries([...new Set(starts.map((r) => r.role))].map((x) => [x, starts.filter((r) => r.role === x).length])))!;
  const trial = starts.find((r) => r.experiment!.arm === 'trial')?.experiment!.model ?? starts[0]!.experiment!.model;
  const trialId = trial.replace(/^[\w-]+\//, '');
  const control = top(starts.filter((r) => r.experiment!.arm === 'control' && r.ran).reduce<Record<string, number>>((m, r) => ({ ...m, [r.ran!]: (m[r.ran!] ?? 0) + 1 }), {}));
  const models = [trialId, ...(control && control !== trialId ? [control] : [])];
  const planners = rounds.filter((r) => r.role === 'planner' && !r.followUp && r.fate !== 'denied');
  const arms = (['trial', 'control'] as const).map((arm): ArmStats => {
    const mine = starts.filter((r) => r.experiment!.arm === arm);
    const ran: Record<string, number> = {};
    for (const r of mine) ran[r.ran ?? '?'] = (ran[r.ran ?? '?'] ?? 0) + 1;
    const used = mine.flatMap((r) => (r.child ? [tokensOf(r.child)].filter((t): t is Tokens => t !== undefined) : []));
    const tokens: Tokens = {
      input: mean(used.map((t) => t.input)),
      cacheWrite: mean(used.map((t) => t.cacheWrite)),
      cacheRead: mean(used.map((t) => t.cacheRead)),
      output: mean(used.map((t) => t.output)),
    };
    const cost = Object.fromEntries(models.map((m) => [m, used.length ? (used.some((t) => costOf(m, t) === null) ? null : mean(used.map((t) => costOf(m, t)!))) : null]));
    const units = [...new Set(mine.map((r) => unitOf(r.description)).filter((u): u is string => u !== undefined))];
    const passes: number[] = [];
    let judged = 0, first = 0, stuck = 0, replans = 0;
    for (const unit of units) {
      const os = outcomes.filter((o) => basename(o.unit) === unit && o.phase !== 'decide');
      const accepted = os.filter((o) => (o.phase === 'implement' || o.phase === 'verify') && o.result === 'accepted').map((o) => o.round);
      if (accepted.length) passes.push(Math.min(...accepted));
      const r1 = os.filter((o) => (o.phase === 'implement' || o.phase === 'verify') && o.round === 1 && o.result !== 'no findings' && o.result !== 'no file');
      if (r1.length) {
        judged += 1;
        if (r1.some((o) => o.result === 'accepted')) first += 1;
      }
      if (os.some((o) => o.result === 'stuck')) stuck += 1;
      replans += Math.max(0, planners.filter((r) => unitOf(r.description) === unit).length - 1);
    }
    return {
      arm,
      starts: mine.length,
      units: units.length,
      ran,
      fellBack: mine.filter((r) => r.experiment!.fellBack).length,
      joined: used.length,
      tokens,
      cost,
      passRounds: median(passes),
      passed: passes.length,
      firstPass: judged ? first / judged : null,
      judged,
      replans,
      stuck,
    };
  });
  return { role, trial, models, arms };
}

/** The view's lines: a header, one row per arm, and whether n is enough to call. */
export function experimentTable(stats: ReturnType<typeof armStats>): string[] {
  if (!stats) return ['Experiment: no start in the call log carries an arm (is the mod\'s `experiment` option set?)'];
  const { role, trial, models, arms } = stats;
  const k = (x: number) => (x / 1e3).toFixed(1);
  const lines = [
    `Experiment: ${role}, trial ${trial} (n = starts; tokens and $ are means per start joined to its session)`,
    `  arm       n  units  fellBack  joined   in-k  out-k  read-k  write-k  ${models.map((m) => `$@${m}`.padStart(18)).join(' ')}  pass-rounds  r1-accepted  replans  stuck  ran`,
  ];
  for (const a of arms) {
    const ran = Object.entries(a.ran).sort((x, y) => y[1] - x[1]).map(([m, n]) => `${m} ${n}`).join(', ');
    const cost = models.map((m) => (a.cost[m] === null || a.cost[m] === undefined ? '?' : (a.cost[m] as number).toFixed(2)).padStart(18)).join(' ');
    const pass = a.passRounds === null ? '-' : `${a.passRounds} (${a.passed})`;
    const r1 = a.firstPass === null ? '-' : `${Math.round(a.firstPass * 100)}% (${a.judged})`;
    lines.push(`  ${a.arm.padEnd(7)} ${String(a.starts).padStart(3)} ${String(a.units).padStart(6)} ${String(a.fellBack).padStart(9)} ${String(a.joined).padStart(7)} ${k(a.tokens.input).padStart(6)} ${k(a.tokens.output).padStart(6)} ${k(a.tokens.cacheRead).padStart(7)} ${k(a.tokens.cacheWrite).padStart(8)}  ${cost}  ${pass.padStart(11)}  ${r1.padStart(11)}  ${String(a.replans).padStart(7)}  ${String(a.stuck).padStart(5)}  ${ran}`);
  }
  const small = arms.filter((a) => a.starts < MIN_PER_ARM);
  lines.push(
    small.length
      ? `  too small to call: ${small.map((a) => `${a.arm} n=${a.starts}`).join(', ')} (need ${MIN_PER_ARM} starts per arm)`
      : `  n is enough to compare (${MIN_PER_ARM}+ starts per arm); the downstream columns count units, so read them with their n`,
  );
  return lines;
}
