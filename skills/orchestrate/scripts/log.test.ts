import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = import.meta.dir;
const bun = (script: string, ...args: string[]) => {
  const p = Bun.spawnSync(['bun', join(here, script), ...args]);
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const unitDir = () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'log-')), 'run', 'auth');
  mkdirSync(dir, { recursive: true });
  return dir;
};

test('the lines log.ts writes are the transitions timing.ts and status.ts read', () => {
  const dir = unitDir();
  for (const step of [
    ['new', 'plan', 'r0', 'owner ask'],
    ['plan', 'implement', 'r1', 'spec.md'],
    ['implement', 'verify', 'r1', 'round-1-request.md'],
    ['verify', 'implement', 'r2', 'round-1-findings.md changes'],
    ['implement', 'verify', 'r2', 'round-2-request.md'],
    ['verify', 'decide', 'r2', 'round-2-findings.md accepted'],
    ['decide', 'merged', 'r2', 'abc1234 fast-forward'],
  ]) expect(bun('log.ts', dir, ...step).code).toBe(0);

  const [u] = JSON.parse(bun('timing.ts', join(dir, '..'), '--json').out);
  expect(u).toMatchObject({ unit: 'auth', final: 'merged', rounds: 2, verifyBounces: 1 });
  expect(bun('status.ts', join(dir, '..')).out).toContain('| auth | merged abc1234 | 2 |');
});

test('refuses an unknown state, a from that is not the current state, and a round below the last', () => {
  const dir = unitDir();
  bun('log.ts', dir, 'new', 'implement', 'r1');
  bun('log.ts', dir, 'implement', 'verify', 'r2');
  const before = readFileSync(join(dir, 'log.md'), 'utf8');
  for (const step of [
    ['verify', 'reviewing', 'r2'],
    ['implement', 'verify', 'r2'],
    ['verify', 'implement', 'r1'],
    ['verify', 'decide', '2'],
    ['verify', 'merged', 'r2', 'not-a-sha'],
  ]) {
    const r = bun('log.ts', dir, ...step);
    expect([r.code, r.err]).toEqual([1, expect.stringContaining('log.ts refused')]);
  }
  expect(readFileSync(join(dir, 'log.md'), 'utf8')).toBe(before);
});

test('a session that still writes review is recorded as verify', () => {
  const dir = unitDir();
  bun('log.ts', dir, 'new', 'implement', 'r1');
  expect(bun('log.ts', dir, 'implement', 'review', 'r1', 'round-1-request.md').out).toContain('implement → verify r1');
  expect(bun('log.ts', dir, 'review', 'implement', 'r2', 'round-1-findings.md changes').out).toContain('verify → implement r2');
  expect(bun('log.ts', dir, 'implement', 'review', 'r2').out).toContain('implement → verify r2');
  expect(bun('log.ts', dir, 'verify', 'decide', 'r2', 'round-2-findings.md accepted').code).toBe(0);
  expect(readFileSync(join(dir, 'log.md'), 'utf8')).not.toContain('review');
});

test("an older run's review and its separate verify both read as verify", () => {
  const dir = unitDir();
  appendFileSync(join(dir, 'log.md'), [
    '2026-10-20T10:00Z new → implement r1',
    '2026-10-20T11:00Z implement → review r1 round-1-request.md',
    '2026-10-20T11:30Z review → implement r2 round-1-findings.md changes',
    '2026-10-20T12:00Z implement → review r2 round-2-request.md',
    '2026-10-20T12:30Z review → verify r2 round-2-findings.md accepted',
    '2026-10-20T13:00Z verify → implement r3 round-2-verify.md fail',
    '2026-10-20T14:00Z implement → review r3 round-3-request.md',
    '',
  ].join('\n'));
  expect(bun('status.ts', join(dir, '..')).out).toContain('| auth | verify | 3 |');
  const [u] = JSON.parse(bun('timing.ts', join(dir, '..'), '--json').out);
  expect(u).toMatchObject({ verifyBounces: 2, time: { implement: 150, verify: 90 } });
  expect(bun('log.ts', dir, 'review', 'decide', 'r3', 'round-3-findings.md accepted').out).toContain('verify → decide r3');
});

test('a rewrite at decide starts its rounds from 1 again', () => {
  const dir = unitDir();
  bun('log.ts', dir, 'new', 'verify', 'r3');
  bun('log.ts', dir, 'verify', 'decide', 'r3', '3 failed rounds');
  expect(bun('log.ts', dir, 'decide', 'implement', 'r1', 'rewrite on a new premise').code).toBe(0);
});

test('a stale branch goes through integration-check, which the timing names', () => {
  const dir = unitDir();
  bun('log.ts', dir, 'new', 'decide', 'r1');
  expect(bun('log.ts', dir, 'decide', 'integration-check', 'r1', 'main moved; merge with no conflict').code).toBe(0);
  expect(bun('log.ts', dir, 'integration-check', 'decide', 'r1', 'merge-auth.log exit 0').code).toBe(0);
  const [u] = JSON.parse(bun('timing.ts', join(dir, '..'), '--json').out);
  expect(Object.keys(u.time)).toEqual(['decide', 'integration-check']);
});

test('a unit too big for a round is stuck(size): logged, timed as stuck, and shown as such', () => {
  const dir = unitDir();
  bun('log.ts', dir, 'new', 'implement', 'r2');
  expect(bun('log.ts', dir, 'implement', 'stuck(size)', 'r2', 'third continuation').code).toBe(0);
  expect(bun('log.ts', dir, 'stuck(size)', 'decide', 'r2', 're-plan into smaller units').code).toBe(0);
  const [u] = JSON.parse(bun('timing.ts', join(dir, '..'), '--json').out);
  expect(Object.keys(u.time)).toEqual(['implement', 'stuck']);
  bun('log.ts', dir, 'decide', 'stuck(size)', 'r2');
  expect(bun('status.ts', join(dir, '..')).out).toContain('| auth | stuck(size) | 2 |');
});
