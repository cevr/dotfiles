import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kindFor } from './host.ts';

const HOST = join(import.meta.dir, 'host.ts');
const usage = { input_tokens: 100, output_tokens: 10 };
const reply = (id: string, stop: string) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, stop_reason: stop, usage } });

// host.ts over a projects folder with one session and the given subagents, in a fresh HOME.
function load(subs: Record<string, string[]>): { sessions: { sub: boolean }[] } {
  const home = mkdtempSync(join(tmpdir(), 'host-'));
  const dir = join(home, 'projects', '-repo', 's1', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, 'projects', '-repo', 's1.jsonl'), reply('r1', 'end_turn') + '\n');
  for (const [name, lines] of Object.entries(subs)) writeFileSync(join(dir, `${name}.jsonl`), lines.join('\n') + '\n');
  const run = Bun.spawnSync(['bun', HOST, '--projects', join(home, 'projects')], { env: { ...process.env, HOME: home } });
  return JSON.parse(run.stdout.toString());
}

describe('hostLoad', () => {
  test('a subagent that has reported back holds no slot; a root waiting on its owner still counts', () => {
    const { sessions } = load({
      'agent-a': [reply('m1', 'tool_use'), reply('m2', 'end_turn')],
      'agent-b': [reply('m1', 'end_turn'), reply('m2', 'tool_use')],
    });
    expect(sessions.filter((s) => s.sub)).toHaveLength(1);
    expect(sessions.filter((s) => !s.sub)).toHaveLength(1);
  });

  test('a subagent its owner stopped holds no slot', () => {
    const stopped = JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    });
    const { sessions } = load({ 'agent-a': [reply('m1', 'tool_use'), stopped] });
    expect(sessions.filter((s) => s.sub)).toHaveLength(0);
  });
});

test("a role agent keeps the worker's cost history in its role", () => {
  expect(kindFor('status:orchestrate-implementor', 'implementor sheet r2')).toBe('orchestrate-worker:implement');
  expect(kindFor('orchestrate-reviewer', 'anything')).toBe('orchestrate-worker:review');
  expect(kindFor('status:orchestrate-worker', 'verify coldload r3')).toBe('orchestrate-worker:verify');
  expect(kindFor(undefined, 'explore the docs')).toBe('agent:explore');
});
