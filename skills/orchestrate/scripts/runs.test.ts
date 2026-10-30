import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  unit(root, 'run/sheet', [
    '2026-10-20T10:00Z plan → implement r1 spec.md',
    '2026-10-20T11:00Z review → implement r2 round-1-findings.md',
    '2026-10-20T12:00Z decide → plan R4 re-plan',
    '2026-10-20T13:00Z plan → implement R5 spec.md',
  ].join('\n'));
  const [u] = JSON.parse(run('timing.ts', join(root, 'run'), '--json'));
  expect(u).toMatchObject({ unit: 'sheet', rounds: 5, final: 'implement' });
});

test('runs lists each run dir whose unit logs hold transitions and changed since the date, under any root', () => {
  const dev = mkdtempSync(join(tmpdir(), 'runs-dev-'));
  const cache = mkdtempSync(join(tmpdir(), 'runs-cache-'));
  const line = '2026-10-20T10:00Z plan → implement r1 spec.md\n';
  unit(dev, 'repo/tmp/orchestrate/hymn/sheet', line);
  unit(dev, 'repo/tmp/orchestrate/hymn/tabs', line);
  unit(cache, 'verify/gate', line);
  unit(dev, 'notes/journal', 'a log with no transition\n');
  const old = unit(dev, 'repo/tmp/orchestrate/old/unit', line);
  utimesSync(join(old, 'log.md'), new Date('2026-09-01'), new Date('2026-09-01'));
  // A run's own log beside its plan.md is not a unit.
  writeFileSync(join(dev, 'repo/tmp/orchestrate/hymn/plan.md'), '');
  writeFileSync(join(dev, 'repo/tmp/orchestrate/hymn/log.md'), line);
  unit(dev, 'repo/node_modules/pkg/run/unit', line);

  const out = run('runs.ts', '--since', '2026-10-01', dev, cache).trim().split('\n');
  expect(out).toEqual([join(dev, 'repo/tmp/orchestrate/hymn'), join(cache, 'verify')].sort());
});
