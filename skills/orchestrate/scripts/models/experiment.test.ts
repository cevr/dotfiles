import { describe, expect, test } from 'bun:test';
import { armStats, experimentTable, MIN_PER_ARM, unitOf } from './experiment.ts';
import { roundsOf } from './opencode.ts';
import type { Outcome } from './outcomes.ts';

const jsonl = (xs: object[]) => xs.map((x) => JSON.stringify(x)).join('\n');
const FABLE = 'anthropic/claude-fable-5-2';
let minute = 0;
const at = () => new Date(Date.parse('2026-11-09T10:00:00Z') + 60e3 * minute++).toISOString();

/** A planner start's call line and its done line, as the orchestrate mod writes them. */
const start = (callID: string, unit: string, round: number, model: string, arm: 'trial' | 'control', fellBack?: string) => [
  { kind: 'call', at: at(), sessionID: 'root', callID, from: 'build', asked: 'planner', agent: 'planner', reason: 'kept', model, description: `planner ${unit} r${round}`, pace: { ok: true, measured: true, reason: 'room' }, experiment: { arm, model: FABLE, ...(fellBack ? { fellBack } : {}) } },
  { kind: 'done', at: at(), sessionID: 'root', callID, child: `ses_${callID}`, status: 'completed' },
];

const log = jsonl([
  ...start('t1', 'billing', 1, `${FABLE}#high`, 'trial'),
  ...start('t2', 'billing', 2, `${FABLE}#high`, 'trial'), // a replan, in the same arm
  ...start('t3', 'search', 1, 'openai/gpt-6.1-sol#high', 'trial', `${FABLE}#high held: all pool accounts are held`),
  ...start('c1', 'auth', 1, 'anthropic/claude-opus-5-5#high', 'control'),
  ...start('c2', 'inbox', 1, 'anthropic/claude-opus-5-5#high', 'control'),
  // A follow-up and another role carry no arm.
  { kind: 'call', at: at(), sessionID: 'root', callID: 'f1', agent: 'planner', reason: 'continued', child: 'ses_t1', description: 'planner billing r1' },
  { kind: 'call', at: at(), sessionID: 'root', callID: 'i1', agent: 'implementor', reason: 'kept', model: 'anthropic/claude-opus-5-5#high', description: 'implementor billing r1' },
]);

const M = 1e6;
const tokens: Record<string, { input: number; cacheWrite: number; cacheRead: number; output: number }> = {
  ses_t1: { input: 1000, cacheWrite: 100_000, cacheRead: 2 * M, output: 20_000 },
  ses_t2: { input: 3000, cacheWrite: 300_000, cacheRead: 4 * M, output: 40_000 },
  ses_c1: { input: 1000, cacheWrite: 100_000, cacheRead: 1 * M, output: 10_000 },
};

const outcome = (unit: string, phase: Outcome['phase'], round: number, result: string): Outcome => ({ phase, unit: `run/${unit}`, round, result, fate: 'open' });
const outcomes = [
  outcome('billing', 'implement', 1, 'changes'),
  outcome('billing', 'implement', 2, 'accepted'),
  outcome('search', 'verify', 1, 'stuck'),
  outcome('auth', 'implement', 1, 'accepted'),
  outcome('inbox', 'implement', 1, 'no findings'),
];

describe('the experiment view', () => {
  const stats = armStats(roundsOf(log), (child) => tokens[child], outcomes)!;
  const [trial, control] = stats.arms;

  test('counts each arm’s new starts and units, never a follow-up or another role', () => {
    expect(stats).toMatchObject({ role: 'planner', trial: FABLE, models: ['claude-fable-5-2', 'claude-opus-5-5'] });
    expect(trial).toMatchObject({ arm: 'trial', starts: 3, units: 2, fellBack: 1, ran: { 'claude-fable-5-2': 2, 'gpt-6.1-sol': 1 } });
    expect(control).toMatchObject({ arm: 'control', starts: 2, units: 2, fellBack: 0, ran: { 'claude-opus-5-5': 2 } });
  });

  test('tokens are means per joined start, and cost is priced at each model', () => {
    expect(trial!.joined).toBe(2);
    expect(trial!.tokens).toEqual({ input: 2000, cacheWrite: 200_000, cacheRead: 3 * M, output: 30_000 });
    // Fable 5.2: 8 in, 10 write, 0.2 read, 40 out; Opus 5.5: 4, 5, 0.2, 20 ($ per million).
    expect(trial!.cost['claude-fable-5-2']).toBeCloseTo((2000 * 8 + 200_000 * 10 + 3 * M * 0.2 + 30_000 * 40) / M);
    expect(trial!.cost['claude-opus-5-5']).toBeCloseTo((2000 * 4 + 200_000 * 5 + 3 * M * 0.2 + 30_000 * 20) / M);
    expect(control!.joined).toBe(1);
    expect(control!.cost['claude-opus-5-5']).toBeCloseTo((1000 * 4 + 100_000 * 5 + 1 * M * 0.2 + 10_000 * 20) / M);
  });

  test('downstream: rounds to pass, round-1 acceptance, replans and stuck units per arm', () => {
    expect(trial).toMatchObject({ passRounds: 2, passed: 1, firstPass: 0, judged: 2, replans: 1, stuck: 1 });
    expect(control).toMatchObject({ passRounds: 1, passed: 1, firstPass: 1, judged: 1, replans: 0, stuck: 0 });
  });

  test('the table names n per arm and says when it is too small to call', () => {
    const lines = experimentTable(stats);
    expect(lines[0]).toStartWith(`Experiment: planner, trial ${FABLE}`);
    expect(lines[2]!.trim().split(/\s+/).slice(0, 3)).toEqual(['trial', '3', '2']);
    expect(lines.at(-1)).toBe(`  too small to call: trial n=3, control n=2 (need ${MIN_PER_ARM} starts per arm)`);
    expect(experimentTable(undefined)[0]).toContain('no start in the call log carries an arm');
  });

  test('with the pool’s rates: the limit per plan, per merged unit, minutes and merged share per arm', () => {
    const rates = { Fable: { week: { rate: 1 } }, Opus: { week: { rate: 0.5, low: 0.4, high: 0.6 } } };
    const merged = [...outcomes, { ...outcome('auth', 'plan', 1, 'merged'), fate: 'merged' }];
    const minutes: Record<string, number> = { ses_t1: 20, ses_t2: 40, ses_c1: 30 };
    const limited = armStats(roundsOf(log), (child) => tokens[child], merged, { minutesOf: (child) => minutes[child], rates })!;
    const [t, c] = limited.arms;
    // Weighted at Fable's prices: input + write × 10/8 + read × 0.2/8 + output × 40/8.
    const fable = (x: (typeof tokens)[string]) => (x.input + (x.cacheWrite * 10 + x.cacheRead * 0.2 + x.output * 40) / 8) / M;
    expect(t!.limitPerStart!.pct).toBeCloseTo((fable(tokens.ses_t1!) + fable(tokens.ses_t2!)) / 2);
    expect(t).toMatchObject({ done: 0, minutes: 40 });
    expect(t!.limitPerDone).toBeUndefined();
    const opus = (1000 + (100_000 * 5 + M * 0.2 + 10_000 * 20) / 4) / M;
    expect(c!.limitPerStart).toEqual({ pct: expect.closeTo(opus * 0.5, 9), low: expect.closeTo(opus * 0.4, 9), high: expect.closeTo(opus * 0.6, 9) });
    expect(c).toMatchObject({ done: 1, minutes: 30 });
    const lines = experimentTable(limited);
    expect(lines.find((l) => l.trim().startsWith('control') && l.includes('/ plan'))).toContain(`Opus planner: ${(opus * 0.5).toFixed(2)}% (${(opus * 0.4).toFixed(2)}–${(opus * 0.6).toFixed(2)}) / plan`);
    expect(lines.find((l) => l.trim().startsWith('control') && l.includes('/ plan'))).toContain('30 min, merged 50% (1 of 2 units)');
  });

  test('ten starts per arm is enough to compare', () => {
    const many = jsonl(Array.from({ length: 10 }, (_, i) => [...start(`t${i}`, `u${i}`, 1, `${FABLE}#high`, 'trial'), ...start(`c${i}`, `v${i}`, 1, 'anthropic/claude-opus-5-5#high', 'control')]).flat());
    expect(experimentTable(armStats(roundsOf(many), () => undefined, [])).at(-1)).toStartWith('  n is enough to compare');
  });

  test('a unit is the word after the role, or before it', () => {
    expect(unitOf('planner billing r1')).toBe('billing');
    expect(unitOf('billing r2 planner')).toBe('billing');
    expect(unitOf('planner r1')).toBeUndefined();
    expect(unitOf('plan the work')).toBeUndefined();
  });
});
