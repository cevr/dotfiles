import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = import.meta.dir;
const bun = (script: string, ...args: string[]) => {
  const p = Bun.spawnSync(['bun', join(here, script), ...args]);
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const unitDir = () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'log-')), 'run', 'sheet');
  mkdirSync(dir, { recursive: true });
  return dir;
};

test('the lines log.ts writes are the transitions timing.ts and status.ts read', () => {
  const dir = unitDir();
  for (const step of [
    ['new', 'plan', 'r0', 'owner ask'],
    ['plan', 'implement', 'r1', 'spec.md'],
    ['implement', 'review', 'r1', 'round-1-request.md'],
    ['review', 'implement', 'r2', 'round-1-findings.md changes'],
    ['implement', 'review', 'r2', 'round-2-request.md'],
    ['review', 'decide', 'r2', 'round-2-findings.md accepted'],
    ['decide', 'merged', 'r2', 'abc1234 fast-forward'],
  ]) expect(bun('log.ts', dir, ...step).code).toBe(0);

  const [u] = JSON.parse(bun('timing.ts', join(dir, '..'), '--json').out);
  expect(u).toMatchObject({ unit: 'sheet', final: 'merged', rounds: 2, reviewBounces: 1 });
  expect(bun('status.ts', join(dir, '..')).out).toContain('| sheet | merged abc1234 | 2 |');
});

test('refuses an unknown state, a from that is not the current state, and a round below the last', () => {
  const dir = unitDir();
  bun('log.ts', dir, 'new', 'implement', 'r1');
  bun('log.ts', dir, 'implement', 'review', 'r2');
  const before = readFileSync(join(dir, 'log.md'), 'utf8');
  for (const step of [
    ['review', 'reviewing', 'r2'],
    ['implement', 'review', 'r2'],
    ['review', 'implement', 'r1'],
    ['review', 'decide', '2'],
    ['review', 'merged', 'r2', 'not-a-sha'],
  ]) {
    const r = bun('log.ts', dir, ...step);
    expect([r.code, r.err]).toEqual([1, expect.stringContaining('log.ts refused')]);
  }
  expect(readFileSync(join(dir, 'log.md'), 'utf8')).toBe(before);
});

test('a rewrite at decide starts its rounds from 1 again', () => {
  const dir = unitDir();
  bun('log.ts', dir, 'new', 'review', 'r3');
  bun('log.ts', dir, 'review', 'decide', 'r3', '3 failed rounds');
  expect(bun('log.ts', dir, 'decide', 'implement', 'r1', 'rewrite on a new premise').code).toBe(0);
});

test('a unit too big for a round is stuck(size): logged, timed as stuck, and shown as such', () => {
  const dir = unitDir();
  bun('log.ts', dir, 'new', 'implement', 'r2');
  expect(bun('log.ts', dir, 'implement', 'stuck(size)', 'r2', 'third continuation').code).toBe(0);
  expect(bun('log.ts', dir, 'stuck(size)', 'decide', 'r2', 're-plan into smaller units').code).toBe(0);
  const [u] = JSON.parse(bun('timing.ts', join(dir, '..'), '--json').out);
  expect(Object.keys(u.time)).toEqual(['implement', 'stuck']);
  bun('log.ts', dir, 'decide', 'stuck(size)', 'r2');
  expect(bun('status.ts', join(dir, '..')).out).toContain('| sheet | stuck(size) | 2 |');
});
