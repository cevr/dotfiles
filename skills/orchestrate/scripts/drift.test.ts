import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readingsOf, trendOf } from './drift.ts';

const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

const here = import.meta.dir;
const status = (...args: string[]) => {
  const p = Bun.spawnSync(['bun', join(here, 'status.ts'), ...args]);
  return { out: p.stdout.toString(), code: p.exitCode };
};

/** A run dir under `root` with one unit's transition, and this run log.md of its own. */
const runDir = (root: string, name: string, log: string) => {
  const dir = join(root, name);
  mkdirSync(join(dir, 'auth'), { recursive: true });
  writeFileSync(join(dir, 'auth', 'log.md'), '2026-11-12T01:00Z new → implement r1 spec.md\n');
  writeFileSync(join(dir, 'log.md'), log);
  return dir;
};

test('a run log.md reads as its drift lines alone, in order, the clean one with no parts', () => {
  const log = [
    '# notes',
    '2026-11-12T01:35Z drift 0 after batch-k accepted',
    '2026-11-12T02:45Z drift 13 after batch-m changes: 1 unfolded land ×6, 1 departed ×4, 3 refused ×1',
    '2026-11-12T02:46Z plan → implement r1 spec.md',
  ].join('\n');
  expect(readingsOf(log)).toEqual([
    { at: '2026-11-12T01:35Z', score: 0, batch: 'batch-k', verdict: 'accepted', parts: '' },
    { at: '2026-11-12T02:45Z', score: 13, batch: 'batch-m', verdict: 'changes', parts: '1 unfolded land ×6, 1 departed ×4, 3 refused ×1' },
  ]);
});

test('the trend compares the newer half of the runs with the older half', () => {
  expect(trendOf([9])).toBe('trend: too few runs');
  expect(trendOf([35, 12, 4, 0])).toBe('trend: falling (mean 2.0 over the newest 2 runs, 23.5 over the oldest 2)');
  expect(trendOf([0, 1, 6])).toBe('trend: rising (mean 6.0 over the newest 1 runs, 0.0 over the oldest 1)');
});

test("status prints the run's last drift under its table; a run with none prints no drift row", () => {
  const root = scratch('runs-drift-');
  const dir = runDir(root, 'web', '2026-11-12T01:35Z drift 4 after batch-1 changes: 2 off cadence ×2\n2026-11-12T02:00Z drift 5 after batch-2 accepted: 2 off cadence ×2, 1 refused ×1\n');
  const { out } = status(dir);
  expect(out).toContain('| auth | implement | 1 |');
  expect(out.trimEnd().split('\n').at(-1)).toBe('Drift: 5 after batch-2 accepted (2026-11-12T02:00Z): 2 off cadence ×2, 1 refused ×1');
  expect(status(runDir(root, 'quiet', '')).out).not.toContain('Drift');
});

test('--trend lists each run with drift lines by its last verdict, with its readings and the way it goes', () => {
  const root = scratch('runs-trend-');
  runDir(root, 'old', '2026-11-10T10:00Z drift 20 after batch-a changes: 5 departed ×4\n2026-11-10T12:00Z drift 35 after batch-b accepted: 1 unfolded land ×6\n');
  runDir(root, 'new', '2026-11-12T10:00Z drift 0 after batch-a accepted\n');
  runDir(root, 'none', '');
  const { out, code } = status('--trend', '--since', '2020-01-01', root);
  expect(code).toBe(0);
  expect(out).toBe(
    [
      '| Run | Last verdict | Drift | Verdicts | By verdict | Last parts |',
      '| --- | ------------ | ----- | -------- | ---------- | ---------- |',
      '| old | 2026-11-10T12:00Z | 35 | 2 | 20 → 35 | 1 unfolded land ×6 |',
      '| new | 2026-11-12T10:00Z | 0 | 1 | 0 |  |',
      '',
      'trend: falling (mean 0.0 over the newest 1 runs, 35.0 over the oldest 1)',
      '',
    ].join('\n'),
  );
  expect(status('--trend', '--since', 'never').code).toBe(2);
});
