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

const r1 = 'implementor sheet r1: ready round-1-request.md\nDigest: The sheet settles at every drag speed.\nHead: 1a2b3c4d5e\n';

test('a request naming its head lands', () => {
  expect(check({ 'round-1-request.md': r1 }, 1).code).toBe(0);
  expect(check({ 'round-1-request.md': 'Digest: The sheet settles.\nRange `1a2b3c4..9f8e7d6`\n' }, 1).code).toBe(0);
});

test('a missing request, or one with no head commit, goes back', () => {
  expect(check({}, 1).err).toContain('round-1-request.md is missing');
  expect(check({ 'round-1-request.md': 'Spec: spec.md\n' }, 1).err).toContain('names no head commit');
});

test('a request with no Digest: line in its first lines, or an empty one, is accepted with a hint; one in bold is read', () => {
  const head = 'implementor sheet r1: ready round-1-request.md\n';
  const hinted = (request: string) => {
    const r = check({ 'round-1-request.md': request }, 1);
    return [r.code, r.err.includes('request.ts hint:') && r.err.includes('has no `Digest:` line'), r.err.includes('refused')];
  };
  expect(hinted(`${head}Head: 1a2b3c4\n`)).toEqual([0, true, false]);
  expect(hinted(`${head}Digest:   \nHead: 1a2b3c4\n`)).toEqual([0, true, false]);
  expect(hinted(`${head}${'\n'.repeat(8)}Digest: Too late to read.\nHead: 1a2b3c4\n`)).toEqual([0, true, false]);
  expect(hinted(`${head}**Digest:** The sheet settles.\nHead: 1a2b3c4\n`)).toEqual([0, false, false]);
  // The hint never hides a refusal.
  expect(hinted(`${head}Spec: spec.md\n`)).toEqual([1, true, true]);
});
