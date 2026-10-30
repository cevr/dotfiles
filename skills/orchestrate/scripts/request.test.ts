import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const check = (files: Record<string, string>, round: number) => {
  const dir = mkdtempSync(join(tmpdir(), 'request-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const p = Bun.spawnSync(['bun', join(import.meta.dir, 'request.ts'), dir, String(round)]);
  return { code: p.exitCode, err: p.stderr.toString() };
};

const findings = `Verdict: CHANGES REQUIRED

## Blockers

None.

## Major

### M1 repeat of r1 M2 — src/sheet.ts:40
The sheet snaps shut on a slow drag.

- **M2** src/tabs.ts:12: a tab press is lost while the sheet moves.

### M3
repeat of r1 M1: the header jumps on rotate.

## Minor

- m1 repeat of r1 m1: a stale comment.
`;
const r2 = 'Protocol: protocol.md\nSpec: spec.md\nHead: 1a2b3c4d5e\n';

test('a request that names no red test for a repeated Major goes back, naming each one', () => {
  const r = check({ 'round-2-request.md': r2, 'round-2-findings.md': findings, 'round-3-request.md': 'Head: 9f8e7d6c5b\n' }, 3);
  expect(r.code).toBe(1);
  expect(r.err).toContain('M1 is a repeat');
  expect(r.err).toContain('M3 is a repeat');
  expect(r.err).not.toContain('M2');
  expect(r.err).not.toContain('m1');
});

test("a red test must be red at the head the repeat's round reviewed", () => {
  const request = 'Head: 9f8e7d6c5b\n\n## Repeat tests\n- repeat M1: test/sheet.prop.ts "every drag speed settles" red at 1a2b3c4\n- repeat M3: test/header.test.ts red at 0000000\n';
  const r = check({ 'round-2-request.md': r2, 'round-2-findings.md': findings, 'round-3-request.md': request }, 3);
  expect(r.code).toBe(1);
  expect(r.err).toContain('repeat M3: 0000000 is not the head round 2 reviewed');
  expect(r.err).not.toContain('M1');
});

test('red at the base of the reviewed range is not red at its head', () => {
  const range = 'Base: aaaaaaa\nHead: bbbbbbb\n';
  const at = (sha: string) => check({ 'round-2-request.md': range, 'round-2-findings.md': findings, 'round-3-request.md': `Head: ccccccc\n- repeat M1: a.test.ts red at ${sha}\n- repeat M3: b.test.ts red at ${sha}\n` }, 3).code;
  expect(at('aaaaaaa')).toBe(1);
  expect(at('bbbbbbb')).toBe(0);
  // A range names its head on the right.
  const r = check({ 'round-2-request.md': 'Commits: aaaaaaa..bbbbbbb\n', 'round-2-findings.md': findings, 'round-3-request.md': 'Head: ccccccc\n- repeat M1: a red at bbbbbbb\n- repeat M3: b red at bbbbbbb\n' }, 3);
  expect(r.code).toBe(0);
});

test('a request with a red test for every repeat, or with no repeat behind it, goes to review', () => {
  const request = 'Head: 9f8e7d6c5b\n- repeat M1: test/sheet.prop.ts red at 1a2b3c4\n- repeat M3: test/header.test.ts red at 1a2b3c4d5e\n';
  expect(check({ 'round-2-request.md': r2, 'round-2-findings.md': findings, 'round-3-request.md': request }, 3).code).toBe(0);
  expect(check({ 'round-1-request.md': r2 }, 1).code).toBe(0);
});

test('a missing request, or one with no head commit, goes back', () => {
  expect(check({}, 1).err).toContain('round-1-request.md is missing');
  expect(check({ 'round-1-request.md': 'Spec: spec.md\n' }, 1).err).toContain('names no head commit');
  expect(check({ 'round-1-request.md': 'Range `1a2b3c4..9f8e7d6`\n' }, 1).code).toBe(0);
});
