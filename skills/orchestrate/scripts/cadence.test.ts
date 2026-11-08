import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cadenceLine, cadenceOf, DEFAULT_CADENCE, formatCadence, parseCadence } from './cadence.ts';

test('the Batch cadence line is found as a plain, listed or bold label, and nowhere mid-line', () => {
  expect(cadenceLine('Lands: push\nBatch cadence: 2 ready or 10 min\n')).toBe('2 ready or 10 min');
  expect(cadenceLine('- Batch cadence: **override.** held at ready')).toBe('override.** held at ready');
  expect(cadenceLine('**Batch cadence: override.** It lands with hslexicon.')).toBe('override.** It lands with hslexicon.');
  expect(cadenceLine('Machine: … lands with `hskokoro` (Batch cadence, below).')).toBeUndefined();
  expect(cadenceLine('')).toBeUndefined();
});

test("a line's numbers set the cadence; what it leaves out comes from the level above", () => {
  const template = 'default: land when 3 units are ready or the oldest ready unit has waited 30 min, whichever comes first.';
  expect(parseCadence(template, { ready: 9, minutes: 99 })).toEqual(DEFAULT_CADENCE);
  expect(parseCadence('1 ready or 5 minutes: a hotfix', DEFAULT_CADENCE)).toEqual({ ready: 1, minutes: 5 });
  expect(parseCadence('override: land at 2 hours, whatever is ready', DEFAULT_CADENCE)).toEqual({ ready: 3, minutes: 120 });
  expect(parseCadence('5 ready', { ready: 3, minutes: 45 })).toEqual({ ready: 5, minutes: 45 });
  expect(parseCadence('override: lands in one batch with hslexicon', { ready: 2, minutes: 10 })).toEqual({ ready: 2, minutes: 10 });
});

test("a unit's cadence is its spec's over the plan's over the default", () => {
  expect(cadenceOf(undefined, undefined)).toEqual(DEFAULT_CADENCE);
  expect(cadenceOf('# p5\nBatch cadence: 2 ready or 60 min\n', undefined)).toEqual({ ready: 2, minutes: 60 });
  expect(cadenceOf('Batch cadence: 2 ready or 60 min', 'Batch cadence: 15 min, a hotfix')).toEqual({ ready: 2, minutes: 15 });
  expect(cadenceOf(undefined, 'Batch cadence: default')).toEqual(DEFAULT_CADENCE);
  expect(formatCadence({ ready: 2, minutes: 15 })).toBe('2 ready or 15 min');
});

test("status prints each unit's cadence: its spec's, else the plan's", () => {
  const run = join(mkdtempSync(join(tmpdir(), 'cadence-')), 'p5');
  const unit = (name: string, spec?: string) => {
    mkdirSync(join(run, name), { recursive: true });
    writeFileSync(join(run, name, 'log.md'), '2026-11-06T10:00Z verify → ready r1 round-1-findings.md\n');
    if (spec !== undefined) writeFileSync(join(run, name, 'spec.md'), `# ${name}\n\nBatch cadence: ${spec}\n`);
  };
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'plan.md'), '# p5\n\nBatch cadence: 4 ready or 45 min\n');
  unit('lexer');
  unit('hotfix', '1 ready, a hotfix');
  const out = Bun.spawnSync(['bun', join(import.meta.dir, 'status.ts'), run]).stdout.toString();
  expect(out.split('\n').slice(0, 4)).toEqual([
    '| Unit | State | Round | Since | Cause | Cadence |',
    '| ---- | ----- | ----- | ----- | ----- | ------- |',
    '| hotfix | ready | 1 | 2026-11-06T10:00Z | round-1-findings.md | 1 ready or 45 min |',
    '| lexer | ready | 1 | 2026-11-06T10:00Z | round-1-findings.md | 4 ready or 45 min |',
  ]);
});
