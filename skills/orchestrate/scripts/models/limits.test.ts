import { describe, expect, test } from 'bun:test';
import { familyOf, limitOf, limitRows, limitTable, ratesOf, weightedMtok } from './limits.ts';
import type { Outcome } from './outcomes.ts';

const M = 1e6;
/** A tally as the pool writes it: Opus 0.6 and Fable 1.0 points of the shared week per weighted Mtok, Fable 2.0 of its own. */
const file = {
  line: '…',
  tally: {
    recent: [
      { pool: 'anthropic', window: '5h', rows: 4, families: [{ family: 'Opus', weighted: { rate: 5 }, n: 4 }] },
      { pool: 'anthropic', window: '7d', rows: 6, families: [
        { family: 'Fable', weighted: { rate: 1, low: 0.8, high: 1.2 }, n: 6 },
        { family: 'Opus', weighted: { rate: 0.6, low: 0.5, high: 0.7 }, n: 6 },
      ] },
      { pool: 'anthropic', window: '7d:Fable', rows: 6, families: [{ family: 'Fable', weighted: { rate: 2, low: 1.5, high: 2.5 }, n: 6 }] },
      // One period: a fit with no range prices nothing.
      { pool: 'openai', window: '7d', rows: 1, families: [{ family: 'sol', weighted: { rate: 0 }, n: 1 }] },
    ],
    cumulative: [],
  },
};

describe('limit rates', () => {
  test('the shared week and a model’s own week, per family, from the tally', () => {
    expect(ratesOf(file)).toEqual({
      Opus: { week: { rate: 0.6, low: 0.5, high: 0.7 } },
      Fable: { week: { rate: 1, low: 0.8, high: 1.2 }, own: { rate: 2, low: 1.5, high: 2.5 } },
    });
    expect(ratesOf(undefined)).toEqual({});
  });

  test('a family as the pool names it, however models.ts spells the model', () => {
    expect(['opus-5-5@high', 'anthropic/claude-opus-5-5#high', 'claude-fable-5-2', 'gpt-6.1-sol'].map(familyOf)).toEqual(['Opus', 'Opus', 'Fable', 'sol']);
    // Weighted as input-equivalent: Opus output 20/4 = 5.
    expect(weightedMtok('opus-5-5', { input: M, cacheWrite: 0, cacheRead: 0, output: M })).toBe(6);
  });

  test('an agent’s limit is its weighted Mtok at its family’s rate, with its range and its own week', () => {
    const t = { input: M, cacheWrite: 0, cacheRead: 0, output: 0 };
    expect(limitOf(ratesOf(file), 'claude-fable-5-2', t)).toEqual({ pct: 1, low: 0.8, high: 1.2, own: 2 });
    expect(limitOf(ratesOf(file), 'gpt-6.1-sol', t)).toBeUndefined();
  });
});

describe('limit per finished task', () => {
  const outcome = (unit: string, round: number, result: string): Outcome => ({ phase: 'implement', unit, round, result, fate: 'open' });
  const agent = (model: string, input: number, min: number) => ({ model, tokens: { input: input * M, cacheWrite: 0, cacheRead: 0, output: 0 }, min, role: 'implement' });

  test('a family at a higher rate that finishes in fewer tokens spends less per finished task', () => {
    // Fable: 1.0 %/Mtok, 2 Mtok an agent, both accepted. Opus: 0.6 %/Mtok, 5 Mtok an agent, one of two accepted.
    const rows = [
      { agent: agent('claude-fable-5-2', 2, 20), outcome: outcome('a', 1, 'accepted') },
      { agent: agent('claude-fable-5-2', 2, 30), outcome: outcome('b', 1, 'accepted') },
      { agent: agent('claude-opus-5-5', 5, 40), outcome: outcome('c', 1, 'accepted') },
      { agent: agent('claude-opus-5-5', 5, 50), outcome: outcome('d', 1, 'changes') },
    ];
    const [fable, opus] = limitRows(rows, ratesOf(file));
    expect(fable).toMatchObject({ phase: 'implement', family: 'Fable', agents: 2, tasks: 2, outcomes: 2, rate: 1, minutes: 30 });
    expect(fable!.perTask!.pct).toBeCloseTo(2);
    expect(opus).toMatchObject({ family: 'Opus', tasks: 1, outcomes: 2, rate: 0.5 });
    expect(opus!.perTask!.pct).toBeCloseTo(6);
    expect(limitTable([fable!])[0]!.trim()).toBe(
      'implement  Fable          2.0% (1.6–2.4) +4.0% own week limit / finished task · 2.0% (1.6–2.4) +4.0% own week / agent · 30 min / agent · finished 100% (2 of 2; n 2 agents)',
    );
  });
});
