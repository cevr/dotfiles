import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'prune-agent-files.ts');
const OLD = new Date('2026-01-01');
const NEW = new Date('2026-03-01');

let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = (path: string, at: Date) => {
  const p = join(root, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'x'.repeat(5000));
  utimesSync(p, at, at);
  return p;
};

const prune = (...args: string[]) => {
  const run = Bun.spawnSync(['bun', SCRIPT, '--before', '2026-02-01', '--projects', join(root, 'projects'), '--scratch', join(root, 'tmp'), ...args]);
  return JSON.parse(run.stdout.toString());
};

test('deletes subagent transcripts, tool-result spills and idle scratchpads before the date, and keeps the rest', () => {
  root = mkdtempSync(join(tmpdir(), 'prune-'));
  const session = file('projects/-repo/s1.jsonl', OLD);
  const oldAgent = file('projects/-repo/s1/subagents/agent-a.jsonl', OLD);
  const newAgent = file('projects/-repo/s1/subagents/agent-b.jsonl', NEW);
  const oldSpill = file('projects/-repo/s1/tool-results/r1.txt', OLD);
  const idlePad = file('tmp/claude-501/-repo/s1/scratchpad/notes.md', OLD);
  const livePad = file('tmp/claude-501/-repo/s2/scratchpad/notes.md', NEW);

  expect(prune()).toMatchObject({ apply: false, files: 2, scratchpads: 1 });
  expect([oldAgent, oldSpill, idlePad].every(existsSync)).toBe(true);

  expect(prune('--apply')).toMatchObject({ apply: true, files: 2, scratchpads: 1 });
  expect([oldAgent, oldSpill, idlePad].map(existsSync)).toEqual([false, false, false]);
  expect(existsSync(join(root, 'tmp/claude-501/-repo/s1'))).toBe(false);
  expect([session, newAgent, livePad].every(existsSync)).toBe(true);
});

test('refuses to run without a date', () => {
  const run = Bun.spawnSync(['bun', SCRIPT]);
  expect(run.exitCode).toBe(2);
});
