import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fateOf, joinUnit, outcomeOf, verdictOf } from './outcomes.ts';
import { costOf } from './prices.ts';
import { bridgeUnits, claudeAgent, codexAgent, codexAgents } from './sources.ts';

const jsonl = (xs: object[]) => xs.map((x) => JSON.stringify(x)).join('\n');

describe('claudeAgent', () => {
  test('counts a message once across its lines, and keeps the last text as the hand-back', () => {
    const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 100 };
    const text = jsonl([
      { type: 'user', timestamp: '2026-10-20T10:00:00Z', message: { content: 'Implement round 2 of /r/u/spec.md' } },
      { type: 'assistant', timestamp: '2026-10-20T10:01:00Z', message: { id: 'm1', model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'working' }] } },
      { type: 'assistant', timestamp: '2026-10-20T10:02:00Z', message: { id: 'm1', model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'implementor u r2: done /r/u/round-2-request.md' }] } },
    ]);
    const a = claudeAgent(text, 'a1', 's1')!;
    expect(a).toMatchObject({ model: 'opus-5-5', role: 'implement', min: 2, final: 'implementor u r2: done /r/u/round-2-request.md' });
    expect(a.tokens).toEqual({ input: 10, cacheWrite: 1000, cacheRead: 2000, output: 100 });
    expect(a.cost).toBeCloseTo((10 * 4 + 1000 * 5 + 2000 * 0.2 + 100 * 20) / 1e6);
  });
});

test('a Claude reviewer that runs counsel-review is labelled as such', () => {
  const text = jsonl([
    { type: 'user', message: { content: 'You are the reviewer. Run the counsel-review skill on /r/u/round-1-request.md' } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: {}, content: [] } },
  ]);
  expect(claudeAgent(text, 'a', 's')).toMatchObject({ role: 'review', model: 'opus-5-5+counsel' });
});

test('a worker takes the role it was given, not the roles its prompt mentions', () => {
  const agent = (prompt: string, description = '') =>
    claudeAgent(jsonl([
      { type: 'user', message: { content: prompt } },
      { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: {}, content: [] } },
    ]), 'a', 's', description);
  expect(agent('Read protocol.md. You are the implementor for round 1; the reviewer reads your request.', 'ftb-copy rewrite r1: built-output guard')).toMatchObject({ role: 'implement' });
  expect(agent('Read protocol.md and verify round 3.', 'verifier coldload r3')).toMatchObject({ role: 'verify' });
  expect(agent('Review the findings of the last run', 'look over notes')).toMatchObject({ role: 'review' });
  const typed = claudeAgent(jsonl([{ type: 'user', message: { content: 'Round 2: the findings are in round-1-findings.md' } }, { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: {}, content: [] } }]), 'a', 's', 'sheet r2', false, 'status:orchestrate-implementor');
  expect(typed).toMatchObject({ role: 'implement' });
});

describe('codexAgent', () => {
  test('takes the last cumulative token count, the turn model and effort, and skips injected messages', () => {
    const count = (input: number, cached: number, output: number) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
    const text = jsonl([
      { type: 'session_meta', timestamp: '2026-10-20T10:00:00Z', payload: { id: 'x', cwd: '/r/u' } },
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'max' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review /r/u/round-1-request.md' }] } },
      count(100, 60, 5),
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reviewer u r1: changes /r/u/round-1-findings.md' }] } },
      { ...count(300, 200, 20), timestamp: '2026-10-20T10:05:00Z' },
    ]);
    const a = codexAgent(text, 'rollout-x')!;
    expect(a).toMatchObject({ harness: 'codex', model: 'gpt-6.1-sol', effort: 'max', role: 'review', cwd: '/r/u', min: 5 });
    expect(a.tokens).toEqual({ input: 100, cacheWrite: 0, cacheRead: 200, output: 20 });
    // OpenAI's Standard row for gpt-6.1-sol: $2 input, $0.10 cached input, $10 output per million.
    expect(a.cost).toBeCloseTo(0.00042);
    expect(a.prompt.trim()).toBe('Review /r/u/round-1-request.md');
  });

  test("a role agent's developer instructions name its role over the prompt's words", () => {
    const text = jsonl([
      { type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'max' } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are the implementor of one orchestrate unit. Your first message names the spec.' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Unit sheet, review findings in round-1-findings.md' }] } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 1 } } } },
    ]);
    expect(codexAgent(text, 'rollout-y')).toMatchObject({ model: 'gpt-6-luna', role: 'implement' });
  });
});

describe('a transcript that spans the window start counts only its usage inside the window', () => {
  const since = Date.parse('2026-10-20T00:00:00Z');
  test('Claude', () => {
    const msg = (id: string, at: string, output: number) => ({ type: 'assistant', timestamp: at, message: { id, model: 'claude-opus-5-5', usage: { output_tokens: output }, content: [] } });
    const text = jsonl([
      { type: 'user', timestamp: '2026-10-10T10:00:00Z', message: { content: 'orchestrate the run' } },
      msg('m1', '2026-10-10T10:01:00Z', 1000),
      { type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-11T10:00:00Z' },
      msg('m2', '2026-10-20T10:00:00Z', 30),
      msg('m3', '2026-10-20T10:10:00Z', 7),
    ]);
    expect(claudeAgent(text, 'a', 'a', '', true, '', since)).toMatchObject({ tokens: { output: 37 }, min: 10, compacted: false });
  });
  test('Codex', () => {
    const count = (at: string, input: number, cached: number, output: number) => ({ type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
    const text = jsonl([
      { type: 'turn_context', timestamp: '2026-10-10T10:00:00Z', payload: { model: 'gpt-6-luna' } },
      count('2026-10-10T10:05:00Z', 1000, 800, 50),
      count('2026-10-20T10:05:00Z', 1500, 1100, 70),
    ]);
    expect(codexAgent(text, 'r', since)!.tokens).toEqual({ input: 200, cacheWrite: 0, cacheRead: 300, output: 20 });
  });
  test('Codex: the window prices its own model, not the one most used before it', () => {
    const context = (at: string, model: string) => ({ type: 'turn_context', timestamp: at, payload: { model } });
    const count = (at: string, input: number, output: number) => ({ type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } } });
    const text = jsonl([
      context('2026-10-10T10:00:00Z', 'gpt-6.1-sol'),
      context('2026-10-11T10:00:00Z', 'gpt-6.1-sol'),
      count('2026-10-11T10:05:00Z', 500, 50),
      context('2026-10-20T10:00:00Z', 'gpt-6-luna'),
      count('2026-10-20T10:05:00Z', 1500, 1050),
    ]);
    expect(codexAgent(text, 'r', since)).toMatchObject({ model: 'gpt-6-luna' });
  });
});

test("a Codex thread carries the unit and round its bridge start named, from the state or the log", () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  const a = '01a184fe-d423-7352-943c-524b71bd8327', b = '01a18504-ae1b-75f0-8eea-511e064dc88c', c = '01a18524-a8df-7001-af96-1850e9c452e8';
  // d named no unit, so its description joins it; e is a's thread the bridge opened again on the app-server.
  const d = '01a18530-0000-7000-8000-000000000001', e = '01a18531-0000-7000-8000-000000000002';
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ threads: { [a]: { id: a, unit: 'sheet', round: 2, codexId: e }, [c]: { id: c, description: 'a look prototype' }, [d]: { id: d, description: 'reviewer tabs r3: delta' } } }),
  );
  writeFileSync(join(dir, 'bridge.log'), jsonl([{ event: 'drain' }, { event: 'start', thread: b, unit: 'tabs', round: 1 }]));
  const sessions = join(dir, 'sessions', '2026', '10', '29');
  mkdirSync(sessions, { recursive: true });
  const rollout = jsonl([
    { type: 'turn_context', timestamp: '2026-10-29T10:00:00Z', payload: { model: 'gpt-6-luna' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } } },
  ]);
  for (const id of [a, b, c, d, e]) writeFileSync(join(sessions, `rollout-2026-10-29T00-10-55-${id}.jsonl`), rollout);
  const tags = Object.fromEntries(codexAgents(join(dir, 'sessions'), 0, bridgeUnits(dir)).map((x) => [x.id.slice(-36), [x.unit, x.round]]));
  expect(tags).toEqual({ [a]: ['sheet', 2], [b]: ['tabs', 1], [c]: [undefined, undefined], [d]: ['tabs', 3], [e]: ['sheet', 2] });
});

test('a model with no price row has no cost', () => {
  expect(costOf('glm-9', { input: 1, cacheWrite: 0, cacheRead: 0, output: 1 })).toBeNull();
});

describe('outcomes', () => {
  test('reads the verdict from the first line in every protocol spelling', () => {
    expect(verdictOf('Verdict: CHANGES REQUIRED\n\n## Major')).toBe('changes');
    expect(verdictOf('**Verdict: ACCEPTED**')).toBe('accepted');
    expect(verdictOf('Verdict: PASS')).toBe('pass');
    expect(verdictOf('# Findings\nVerdict: FAIL')).toBeUndefined();
    expect(verdictOf('**CHANGES. Do not merge yet.**')).toBe('changes');
    expect(verdictOf('APPROVE with minor corrections.')).toBe('accepted');
    expect(verdictOf('REVISE. Reviewed a..b.')).toBe('changes');
    expect(verdictOf('# p6 review 1\n- Range')).toBeUndefined();
    expect(verdictOf(undefined)).toBeUndefined();
  });

  test('a unit is merged, dropped or open by its log', () => {
    expect(fateOf('t plan → implement r1\nt decide → merged r2 abc1234')).toBe('merged');
    expect(fateOf('t plan → dropped r0')).toBe('dropped');
    expect(fateOf('t plan → implement r1')).toBe('open');
  });

  const unit = () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'models-')), 'run', 'unit');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'log.md'), 't plan → implement r1 spec.md\n');
    return dir;
  };
  const agent = (role: string, prompt = '', final = '') =>
    ({ role, prompt, final, harness: 'claude', session: 's', model: 'opus-5-5' }) as any;

  test('joins by the hand-back line, and judges an implementor by its round review', () => {
    const dir = unit();
    writeFileSync(join(dir, 'round-2-findings.md'), 'Verdict: ACCEPTED\n');
    const j = joinUnit(agent('implement'), `implementor unit r2: done ${dir}/round-2-request.md`)!;
    expect(j).toEqual({ phase: 'implement', dir, unit: dir, round: 2, own: 'done' });
    expect(outcomeOf(j)).toEqual({ phase: 'implement', unit: 'run/unit', round: 2, result: 'accepted', fate: 'open' });
  });

  test("a rewrite's round files sit in a folder under the unit, whose log decides its fate", () => {
    const unitDir = unit();
    const dir = join(unitDir, 'rewrite');
    mkdirSync(dir);
    writeFileSync(join(dir, 'round-1-findings.md'), 'Verdict: CHANGES REQUIRED\n');
    const j = joinUnit(agent('review', `Review ${dir}/round-1-request.md`), '')!;
    expect(j).toEqual({ phase: 'review', dir, unit: unitDir, round: 1 });
    expect(outcomeOf(j)).toEqual({ phase: 'review', unit: 'run/unit', round: 1, result: 'changes', fate: 'open' });
  });

  test('a review that accepted what verify failed escaped', () => {
    const dir = unit();
    writeFileSync(join(dir, 'round-1-findings.md'), 'Verdict: ACCEPTED\n');
    writeFileSync(join(dir, 'round-1-verify.md'), 'Verdict: FAIL\n');
    expect(outcomeOf({ phase: 'review', dir, unit: dir, round: 1 }).result).toBe('escaped');
    expect(outcomeOf({ phase: 'implement', dir, unit: dir, round: 1 }).result).toBe('failed verify');
    expect(outcomeOf({ phase: 'verify', dir, unit: dir, round: 1 }).result).toBe('fail');
  });

  test("with no hand-back line, joins a bridge thread by its unit's name and round", () => {
    const dir = unit();
    const other = unit();
    const thread = { ...agent('implement', 'Fix the findings.'), unit: 'unit', round: 2, last: Date.now() };
    expect(joinUnit(thread, 'context ran out', () => [dir])).toEqual({ phase: 'implement', dir, unit: dir, round: 2 });
    expect(joinUnit({ ...thread, prompt: `Read ${other}/spec.md` }, '', () => [dir])).toEqual({ phase: 'implement', dir: other, unit: other, round: 2 });
  });

  test('with no hand-back line, joins by the unit files the prompt names', () => {
    const dir = unit();
    expect(joinUnit(agent('review', `Review ${dir}/round-3-request.md against ${dir}/spec.md`), 'done')).toEqual({ phase: 'review', dir, unit: dir, round: 3 });
    expect(joinUnit(agent('implement', `Implementor, round 2. The unit dir is ${dir}/.`), '')).toEqual({ phase: 'implement', dir, unit: dir, round: 2 });
    expect(joinUnit(agent('explore', `Read ${dir}/spec.md`), '')).toBeUndefined();
    writeFileSync(join(dir, '..', 'plan.md'), '');
    writeFileSync(join(dir, '..', 'log.md'), '');
    expect(joinUnit(agent('implement', `Read ${dir}/../state.md`), '')).toBeUndefined();
  });
});
