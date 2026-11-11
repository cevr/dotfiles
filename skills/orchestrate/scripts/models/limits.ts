// What an agent costs in % of ONE account's usage limit, from the pool's limit
// tally: the points of a window each model family spends per million
// input-equivalent tokens (the OpenCode pool's mods/pool/limits.ts, which
// writes $XDG_STATE_HOME/opencode-pool/limits.json on every sweep; its CLI,
// opencode/scripts/pool-limits.ts --json, prints the same shape). An agent's
// limit is its tokens, weighed at its model's list price over its input price
// (models/prices.ts), times its family's rate on the shared week (`7d`), and
// on its family's own week (`7d:Fable`) when it has one: two budgets, so
// never summed. Per role and family, the limit per finished task is every
// agent's limit over the tasks they finished, so a model that finishes in
// fewer tokens can win at a higher rate. Pure but for `readRates`.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Outcome, Phase } from './outcomes.ts';
import { PRICE, type Tokens } from './prices.ts';

export type Rate = { rate: number; low?: number; high?: number };
/** Per family: its rate on the shared week, and on its own week when it has one. */
export type Rates = Record<string, { week?: Rate; own?: Rate }>;
/** An agent's limit: points of the shared week, with its range, and of its family's own week. */
export type Limit = { pct: number; low?: number; high?: number; own?: number };

/** The pool's default tally file. */
export const defaultLimitsPath = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'opencode-pool', 'limits.json');

/** A model's family as the pool's tally names it (mods/pool/limits.ts `familyOf`): `Opus`, `Fable`, `sol`, `sol-ultrafast`. */
export const familyOf = (model: string): string => {
  const id = canonical(model);
  const claude = /^claude-([a-z]+)/.exec(id)?.[1];
  if (claude) return claude.charAt(0).toUpperCase() + claude.slice(1);
  return /^gpt-[\d.]+-(.+)$/.exec(id)?.[1] ?? id;
};

/** A model id as prices.ts keys it: no provider, no effort, and a Claude model's `claude-` (models.ts spells `opus-5-5@high`). */
const canonical = (model: string) => {
  const id = model.replace(/^[\w-]+\//, '').split(/[#@]/)[0]!.toLowerCase();
  return /^(opus|fable|sonnet|haiku)-/.test(id) ? `claude-${id}` : id;
};

/** The model's price row: its own, else its family's, else the family it extends (`sol-ultrafast` → `sol`). */
const priceOf = (model: string) => {
  const own = PRICE[canonical(model)];
  if (own) return own;
  let family = familyOf(model);
  for (;;) {
    const row = Object.entries(PRICE).find(([id]) => familyOf(id) === family)?.[1];
    if (row) return row;
    const cut = family.lastIndexOf('-');
    if (cut <= 0) return undefined;
    family = family.slice(0, cut);
  }
};

/** Input-equivalent Mtok: the tokens' list price over the model's input price; raw with no price row. */
export const weightedMtok = (model: string, t: Tokens): number => {
  const p = priceOf(model);
  if (!p || p[0] <= 0) return (t.input + t.cacheWrite + t.cacheRead + t.output) / 1e6;
  return (t.input + (t.cacheWrite * p[1] + t.cacheRead * p[2] + t.output * p[3]) / p[0]) / 1e6;
};

/** A measured rate: one with a range, so a fit with no degree of freedom left (one period) prices nothing. */
const isRate = (x: any): x is Rate => typeof x?.rate === 'number' && typeof x?.low === 'number' && typeof x?.high === 'number';

/** The rates a tally file holds: its last 7 days, else every period kept. Nothing when it holds none. */
export function ratesOf(file: unknown): Rates {
  const tally = (file as any)?.tally;
  const windows: any[] = tally?.recent?.length ? tally.recent : tally?.cumulative ?? [];
  const rates: Rates = {};
  for (const w of windows) {
    if (typeof w?.window !== 'string') continue;
    for (const f of w.families ?? []) {
      if (typeof f?.family !== 'string' || !isRate(f.weighted) || !(f.n > 0)) continue;
      const held = (rates[f.family] ??= {});
      // A model's own week counts only the tokens of the models it limits: every family in it is one of those.
      if (w.window === '7d') held.week = f.weighted;
      else if (w.window.startsWith('7d:')) held.own = f.weighted;
    }
  }
  return rates;
}

/** The rates in the tally file at `path`; none when it cannot be read. */
export function readRates(path = defaultLimitsPath()): Rates {
  try {
    return ratesOf(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return {};
  }
}

/** An agent's limit on `model` for `t`; none when its family has no rate on the shared week. */
export function limitOf(rates: Rates, model: string, t: Tokens): Limit | undefined {
  const r = rates[familyOf(model)];
  if (!r?.week) return undefined;
  const m = weightedMtok(model, t);
  return {
    pct: m * r.week.rate,
    ...(r.week.low !== undefined && r.week.high !== undefined ? { low: m * r.week.low, high: m * r.week.high } : {}),
    ...(r.own ? { own: m * r.own.rate } : {}),
  };
}

/** Several limits summed; a bound only when every limit has one. */
export function sumLimits(limits: Limit[]): Limit {
  const all = (key: 'low' | 'high' | 'own') => (limits.every((l) => l[key] !== undefined) ? { [key]: limits.reduce((s, l) => s + l[key]!, 0) } : {});
  return { pct: limits.reduce((s, l) => s + l.pct, 0), ...(limits.length ? { ...all('low'), ...all('high'), ...all('own') } : {}) };
}

/** Whether a phase's outcome is a finished task: a plan whose unit merged, an accepted implementation, a verdict given. */
export const finished = (o: Outcome): boolean =>
  o.phase === 'plan' ? o.fate === 'merged' : o.phase === 'implement' ? o.result === 'accepted' : o.phase === 'verify' ? ['accepted', 'changes', 'stuck'].includes(o.result) : false;

const num = (x: number) => (x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2));
/** `2.1%` with its range `(1.6–2.6)` and the own week `+0.40% own week`. */
export const limitText = (l: Limit) =>
  `${num(l.pct)}%${l.low !== undefined && l.high !== undefined ? ` (${num(l.low)}–${num(l.high)})` : ''}${l.own !== undefined ? ` +${num(l.own)}% own week` : ''}`;

export type LimitRow = { phase: Phase; family: string; agents: number; tasks: number; outcomes: number; perTask?: Limit; perAgent?: Limit; minutes: number; rate: number | null };

/**
 * Per phase and family: the agents, the tasks they finished out of the
 * outcomes joined to them, the limit per finished task (all their limit over
 * those tasks) and per agent, the median wall minutes per agent, and the
 * outcome rate. `rows` pairs each agent with its outcome, when it has one.
 */
export function limitRows(rows: { agent: { model: string; tokens: Tokens; min: number; role: string }; outcome?: Outcome }[], rates: Rates): LimitRow[] {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const phase = r.outcome?.phase ?? (['plan', 'implement', 'verify'].includes(r.agent.role) ? r.agent.role : undefined);
    if (!phase || phase === 'decide') continue;
    const key = `${phase}\t${familyOf(r.agent.model)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rs]) => {
      const [phase, family] = key.split('\t') as [Phase, string];
      const agents = [...new Set(rs.map((r) => r.agent))];
      const limits = agents.map((a) => limitOf(rates, a.model, a.tokens));
      const priced = limits.every((l) => l !== undefined) ? sumLimits(limits as Limit[]) : undefined;
      // One task per unit and round: a round that took several agents counts once.
      const outcomes = [...new Map(rs.flatMap((r) => (r.outcome ? [[`${r.outcome.unit} ${r.outcome.round}`, r.outcome] as const] : []))).values()];
      const tasks = outcomes.filter(finished).length;
      const mins = agents.map((a) => a.min).sort((x, y) => x - y);
      const per = (l: Limit, n: number): Limit => ({ pct: l.pct / n, ...(l.low !== undefined ? { low: l.low / n } : {}), ...(l.high !== undefined ? { high: l.high / n } : {}), ...(l.own !== undefined ? { own: l.own / n } : {}) });
      return {
        phase,
        family,
        agents: agents.length,
        tasks,
        outcomes: outcomes.length,
        ...(priced && tasks ? { perTask: per(priced, tasks) } : {}),
        ...(priced && agents.length ? { perAgent: per(priced, agents.length) } : {}),
        minutes: mins[Math.floor(mins.length / 2)] ?? 0,
        rate: outcomes.length ? tasks / outcomes.length : null,
      };
    });
}

/** The rows as a table, one compact line each: `plan Fable: 2.1% (1.6–2.6) limit / finished task, 24 min, finished 89% (n 9 agents, 8 of 9)`. */
export const limitTable = (rows: LimitRow[]): string[] =>
  rows.map(
    (r) =>
      `      ${r.phase.padEnd(10)} ${r.family.padEnd(14)} ${r.perTask ? limitText(r.perTask) : '?'} limit / finished task · ${r.perAgent ? limitText(r.perAgent) : '?'} / agent · ${num(r.minutes)} min / agent · finished ${r.rate === null ? '-' : `${Math.round(r.rate * 100)}%`} (${r.tasks} of ${r.outcomes}; n ${r.agents} agents)`,
  );
