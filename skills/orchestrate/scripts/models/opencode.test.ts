import { describe, expect, test } from 'bun:test';
import { opencodeAgent, roundsOf, roundsTable } from './opencode.ts';

const T0 = Date.parse('2026-11-05T10:00:00Z');
const at = (min: number) => ({ created: T0 + min * 60e3 });
const jsonl = (xs: object[]) => xs.map((x) => JSON.stringify(x)).join('\n');
const opus = { id: 'claude-opus-5-5', providerID: 'anthropic', variant: 'medium' };
const tokens = { input: 10, output: 100, reasoning: 50, cache: { read: 2000, write: 1000 } };

describe('opencodeAgent', () => {
  const info = { id: 'ses_kid', parentID: 'ses_root', agent: 'implementor', title: 'implementor auth r2', model: opus, time: { created: T0, updated: T0 }, location: { directory: '/r' } };
  const msgs = [
    { type: 'user', time: at(-5), text: 'You are a subagent spawned by another session.\nImplementor, unit auth, round 2.' },
    { type: 'assistant', time: at(-4), model: opus, tokens, content: [] },
    { type: 'assistant', time: at(1), model: opus, tokens, content: [{ type: 'text', text: 'working' }] },
    { type: 'compaction', time: at(2), status: 'completed' },
    { type: 'assistant', time: at(3), model: opus, tokens, content: [{ type: 'text', text: 'implementor auth r2: done /r/auth/round-2-request.md' }] },
  ];

  test('takes its role from its agent, its unit and round from its description, and only the window’s usage', () => {
    const a = opencodeAgent(info, msgs, T0)!;
    expect(a).toMatchObject({ harness: 'opencode', session: 'ses_root', model: 'opus-5-5', effort: 'medium', role: 'implement', unit: 'auth', round: 2, compacted: true, min: 2, final: 'implementor auth r2: done /r/auth/round-2-request.md' });
    expect(a.prompt).toStartWith('You are a subagent');
    expect(a.tokens).toEqual({ input: 20, cacheWrite: 2000, cacheRead: 4000, output: 300 });
    expect(a.cost).toBeCloseTo((20 * 4 + 2000 * 5 + 4000 * 0.2 + 300 * 20) / 1e6);
  });

  test('a worker takes the role its description names; a root is the orchestrator; no model, no agent', () => {
    expect(opencodeAgent({ ...info, agent: 'worker', title: 'verifier auth r2' }, msgs, T0)).toMatchObject({ role: 'verify' });
    expect(opencodeAgent({ ...info, parentID: undefined }, msgs, T0)).toMatchObject({ role: 'root', session: 'ses_kid' });
    expect(opencodeAgent(info, msgs.slice(0, 1), T0)).toBeUndefined();
  });
});

describe('roundsOf', () => {
  const log = jsonl([
    { kind: 'call', at: '2026-11-04T09:00:00Z', sessionID: 's', callID: 'old', agent: 'worker', description: 'before the window' },
    { kind: 'call', at: '2026-11-05T10:00:00Z', sessionID: 's', callID: 'c1', from: 'build', asked: 'implementor', agent: 'implementor', reason: 'kept', model: 'anthropic/claude-opus-5-5#medium', background: true, description: 'implementor auth r1' },
    { kind: 'done', at: '2026-11-05T10:00:01Z', sessionID: 's', callID: 'c1', child: 'ses_a', status: 'running' },
    { kind: 'call', at: '2026-11-05T10:01:00Z', sessionID: 's', callID: 'c2', agent: 'verifier', reason: 'fallback', model: 'openai/gpt-6.1-sol#high', background: true, description: 'verifier auth r1', pace: { ok: false } },
    { kind: 'latched', at: '2026-11-05T10:01:01Z', sessionID: 's', callID: 'c2', child: 'ses_b', opens: '2026-11-05T11:00:00Z' },
    { kind: 'denied', at: '2026-11-05T10:02:00Z', sessionID: 's', callID: 'c3', tool: 'subagent', why: 'all pool accounts are held' },
    { kind: 'call', at: '2026-11-05T10:03:00Z', sessionID: 's', callID: 'c4', agent: 'implementor', reason: 'kept', child: 'ses_a', background: true, description: 'implementor auth r1 cont1' },
    { kind: 'done', at: '2026-11-05T10:03:01Z', sessionID: 's', callID: 'c4', child: 'ses_a', status: 'error' },
  ]) + '\nnot json';

  test('joins each call to its outcome line, inside the window', () => {
    const rs = roundsOf(log, T0);
    expect(rs.map((r) => [r.callID, r.role, r.model, r.fate])).toEqual([
      ['c1', 'implementor', 'opus-5-5@medium', 'started'],
      ['c2', 'verifier', 'gpt-6.1-sol@high', 'latched'],
      ['c3', '?', '(not started)', 'denied'],
      ['c4', 'implementor', '(agent default)', 'error'],
    ]);
    expect(rs[1]).toMatchObject({ reason: 'fallback', paceHeld: true, child: 'ses_b' });
    expect(rs[3]).toMatchObject({ followUp: true });
  });

  test('the table counts each role and model’s starts and fates', () => {
    const rows = roundsTable(roundsOf(log, T0)).map((l) => l.trim().split(/\s+/));
    expect(rows).toContainEqual(['verifier', 'gpt-6.1-sol@high', '1', '0', '1', '1', '1', '0', '0']);
    expect(rows).toContainEqual(['implementor', '(agent', 'default)', '1', '1', '1', '0', '0', '0', '1']);
  });
});
