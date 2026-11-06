import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOTS, runDirs } from './runs.ts';

const here = import.meta.dir;
const run = (script: string, ...args: string[]) => {
  const p = Bun.spawnSync(['bun', join(here, script), ...args]);
  return p.stdout.toString();
};

/** A unit dir with this log.md, under `<root>/<run>/<unit>`. */
const unit = (root: string, path: string, log: string) => {
  const dir = join(root, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'log.md'), log);
  return dir;
};

test('timing reads a round in either case: a re-plan written R4 is round 4', () => {
  const root = mkdtempSync(join(tmpdir(), 'timing-'));
  unit(root, 'run/auth', [
    '2026-10-20T10:00Z plan → implement r1 spec.md',
    '2026-10-20T11:00Z review → implement r2 round-1-findings.md',
    '2026-10-20T12:00Z decide → plan R4 re-plan',
    '2026-10-20T13:00Z plan → implement R5 spec.md',
  ].join('\n'));
  const [u] = JSON.parse(run('timing.ts', join(root, 'run'), '--json'));
  expect(u).toMatchObject({ unit: 'auth', rounds: 5, final: 'implement' });
});

test('runs lists each run dir whose unit logs hold transitions and changed since the date, under any root', () => {
  const dev = mkdtempSync(join(tmpdir(), 'runs-dev-'));
  const cache = mkdtempSync(join(tmpdir(), 'runs-cache-'));
  const line = '2026-10-20T10:00Z plan → implement r1 spec.md\n';
  unit(dev, 'repo/tmp/orchestrate/web/auth', line);
  unit(dev, 'repo/tmp/orchestrate/web/tabs', line);
  unit(cache, 'verify/gate', line);
  unit(dev, 'notes/journal', 'a log with no transition\n');
  const old = unit(dev, 'repo/tmp/orchestrate/old/unit', line);
  utimesSync(join(old, 'log.md'), new Date('2026-09-01'), new Date('2026-09-01'));
  // A run's own log beside its plan.md is not a unit.
  writeFileSync(join(dev, 'repo/tmp/orchestrate/web/plan.md'), '');
  writeFileSync(join(dev, 'repo/tmp/orchestrate/web/log.md'), line);
  unit(dev, 'repo/node_modules/pkg/run/unit', line);

  const out = run('runs.ts', '--since', '2026-10-01', dev, cache).trim().split('\n');
  expect(out).toEqual([join(dev, 'repo/tmp/orchestrate/web'), join(cache, 'verify')].sort());
});

test('runs skips a test fixture right under a temp root and a removed Rift, and lists a run reached twice once', () => {
  const temp = mkdtempSync(join(tmpdir(), 'runs-temp-'));
  const dev = mkdtempSync(join(tmpdir(), 'runs-dev-'));
  const line = '2026-10-20T10:00Z plan → implement r1 spec.md\n';
  for (const fixture of ['log-a1/run/auth', 'timing-b2/run/auth', 'runs-dev-c3/repo/tmp/orchestrate/web/auth', 'request-d4/run/unit', 'agents-e5/run/unit'])
    unit(temp, fixture, line);
  // A run kept in /tmp by hand is a run; so is one whose name only looks like a fixture deeper down.
  unit(temp, 'work/tmp/orchestrate/p5/auth', line);
  unit(temp, 'work/tmp/orchestrate/log-x/auth', line);
  unit(dev, 'repo/tmp/orchestrate/web/auth', line);
  unit(dev, '.rifts/repo/.trash/01ABC-old/tmp/orchestrate/web/auth', line);
  // The same run under a second root, through a symlink to it.
  symlinkSync(join(dev, 'repo'), join(temp, 'repo-link'));

  const listed = runDirs([dev, temp, join(temp, 'repo-link')], Date.parse('2026-10-01'), [temp]);
  expect(listed).toEqual([join(dev, 'repo/tmp/orchestrate/web'), join(temp, 'work/tmp/orchestrate/log-x'), join(temp, 'work/tmp/orchestrate/p5')].sort());
});

test('runs searches the baton cache, /tmp and the orchestrate cache by default', () => {
  expect(ROOTS).toEqual([join(homedir(), 'Developer'), '/tmp', join(homedir(), '.cache/orchestrate'), join(homedir(), '.cache/baton')]);
});
