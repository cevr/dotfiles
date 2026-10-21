import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { burnOf, hostBurn, report } from './burn.ts';

const hour = (create: number, read: number, output: number) => ({
  input_tokens: 0,
  cache_creation_input_tokens: create,
  cache_read_input_tokens: read,
  output_tokens: output,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: create },
});
const at = (s: number) => new Date(Date.UTC(2026, 9, 21, 12, 0, s)).toISOString();

// A session: a 1000-token start, a Bash call whose 4000-char result enters the context,
// a compaction, and one call on the summary.
const session = [
  { type: 'user', cwd: '/Users/x/Developer/personal/foo', timestamp: at(0), message: { role: 'user', content: 'list the files' } },
  {
    type: 'assistant',
    timestamp: at(1),
    message: { id: 'm1', usage: hour(1000, 0, 100), content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', description: 'List files' } }] },
  },
  { type: 'user', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(4000) }] } },
  { type: 'assistant', timestamp: at(3), message: { id: 'm2', usage: hour(2100, 1000, 50), content: [{ type: 'text', text: 'done' }] } },
  { type: 'system', subtype: 'compact_boundary', timestamp: at(4), compactMetadata: { preTokens: 3100 } },
  { type: 'assistant', timestamp: at(5), message: { id: 'm3', usage: hour(1500, 0, 20), content: [{ type: 'text', text: 'ok' }] } },
];
const jsonl = session.map((l) => JSON.stringify(l)).join('\n') + '\n';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'burn-'));
  const file = join(dir, 's1.jsonl');
  writeFileSync(file, jsonl);
  return file;
}

describe('burnOf', () => {
  test('charges each item its write once and its share of every later read', () => {
    const b = burnOf(fixture(), jsonl.length);
    expect(b.calls).toBe(3);
    expect(b.project).toBe('foo');
    expect(b.w.output).toBe(5 * (100 + 50 + 20));
    // The reply (100 tokens) and the 4000-char result (≤ 2000 tokens) fill the 2100-token growth.
    expect(b.cats['tool:Bash']).toBe(2 * 2000);
    expect(b.cats.assistant).toBe(2 * 100);
    // The base: written at m1, read at m2, and rebuilt after the compaction.
    expect(b.cats.base).toBe(2 * 1000 + 0.1 * 1000 + 2 * 1000);
    // The summary: the compaction call's read, and the part of m3's context beyond the base.
    expect(b.cats.compaction).toBe(0.1 * 3100 + 2 * 500);
    expect(b.base).toEqual([1000, 1500]);
    expect(b.compactions).toBe(1);
    expect(b.top[0]).toMatchObject({ cat: 'tool:Bash', label: 'List files', tokens: 2000 });
  });
});

describe('hostBurn', () => {
  test('counts a session copied under two project folders once', () => {
    const root = mkdtempSync(join(tmpdir(), 'burn-projects-'));
    for (const project of ['-a', '-b']) {
      mkdirSync(join(root, project));
      writeFileSync(join(root, project, 's1.jsonl'), jsonl);
    }
    const h = hostBurn(Date.now(), root, join(root, 'burn.json'));
    expect(h.burns).toHaveLength(1);
    expect(report([h])).toContain('| tool:Bash |');
  });
});
