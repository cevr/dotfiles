import { afterEach, expect, test } from 'bun:test';
import { constants, copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cloneSize, cloneSizes, merge, partOf, riftSince, split } from './clone-size.ts';

const SCRIPT = join(import.meta.dir, 'survey.ts');
const MIB = 1024 ** 2;
const APFS = process.platform === 'darwin';
const LAST_WEEK = new Date(Date.now() - 7 * 86400e3);

let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = (path: string, bytes: number, at?: Date) => {
  const p = join(root, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes, 7));
  if (at) utimesSync(p, at, at);
  return p;
};
// An APFS clone: shares every block with the original until one is written.
const clone = (from: string, to: string) => {
  mkdirSync(dirname(join(root, to)), { recursive: true });
  copyFileSync(from, join(root, to), constants.COPYFILE_FICLONE_FORCE);
};
// A Rift made last week: its marker, and a file copied from the source then.
const rift = (dir: string) => {
  file(`${dir}/.rift`, 26, LAST_WEEK);
  return join(root, dir);
};

test('counts shared blocks once, and only when every holder of them is in the set', () => {
  const files = [
    { alloc: 100, priv: 0, family: 1n, refs: 2 },
    { alloc: 100, priv: 0, family: 1n, refs: 2 },
    { alloc: 50, priv: 0, family: 2n, refs: 3 },
    { alloc: 30, priv: 30, family: 3n, refs: 1 },
  ];
  expect(merge([partOf(files)])).toEqual({ own: 130, du: 280, method: 'apfs' });
  // Walked in two parts, the family split between them still counts once, and the open one not at all.
  expect(merge([partOf(files.slice(0, 1)), partOf(files.slice(1))])).toEqual({ own: 130, du: 280, method: 'apfs' });
  expect(merge([partOf(files.slice(0, 1))]).own).toBe(0);
});

test('without APFS a Rift owns the files written since its marker', () => {
  root = mkdtempSync(join(tmpdir(), 'survey-'));
  const dir = rift('rift');
  file('rift/old.bin', MIB, new Date(LAST_WEEK.getTime() - 86400e3));
  file('rift/new.bin', 2 * MIB);

  const size = cloneSize([dir], { since: riftSince(dir), method: 'mtime' });
  expect(size.method).toBe('mtime');
  expect(size.own).toBeGreaterThanOrEqual(2 * MIB);
  expect(size.own).toBeLessThan(2.5 * MIB);
  expect(size.du).toBeGreaterThanOrEqual(3 * MIB);
  expect(riftSince(join(root, 'nothing'))).toBeUndefined();
});

test.if(APFS)('on APFS a clone of a file outside the folder is free, and a written file is its own', () => {
  root = mkdtempSync(join(tmpdir(), 'survey-'));
  const source = file('source/big.bin', 8 * MIB);
  const dir = rift('rift');
  clone(source, 'rift/big.bin');
  file('rift/new.bin', 2 * MIB);

  const size = cloneSize([dir], { since: riftSince(dir) });
  expect(size.method).toBe('apfs');
  expect(size.own).toBeGreaterThanOrEqual(2 * MIB);
  expect(size.own).toBeLessThan(2.5 * MIB);
  expect(size.du).toBeGreaterThanOrEqual(10 * MIB);
  // With the source in the set too, the shared blocks go with it.
  expect(cloneSize([dir, join(root, 'source')]).own).toBeGreaterThanOrEqual(10 * MIB);
});

test.if(APFS)('sized in a pool of walks, a clone family split across units still counts once', async () => {
  root = mkdtempSync(join(tmpdir(), 'survey-'));
  const original = file('trash/a/big.bin', 8 * MIB);
  clone(original, 'trash/b/big.bin');
  file('trash/c/new.bin', MIB);

  const [whole, half] = await cloneSizes([{ units: split(join(root, 'trash'), 3) }, { units: [[join(root, 'trash/b')]] }], 2);
  expect(whole!.own).toBeGreaterThanOrEqual(9 * MIB);
  expect(whole!.own).toBeLessThan(9.5 * MIB);
  expect(half!.own).toBeLessThan(MIB / 10);
});

test.if(APFS)('the survey sizes Rifts and their trash by their own blocks, and worktrees by du', () => {
  root = mkdtempSync(join(tmpdir(), 'survey-'));
  const code = join(root, 'code');
  const source = file('code/app/big.bin', 120 * MIB);
  mkdirSync(join(code, 'app/.git'), { recursive: true });
  file('code/app/.rift', 26, LAST_WEEK); // a warm source carries a marker too
  rift('code/.rifts/app/feature');
  mkdirSync(join(code, '.rifts/app/feature/.git'));
  clone(source, 'code/.rifts/app/feature/big.bin');
  file('code/.rifts/app/feature/new.bin', 60 * MIB);
  rift('code/.rifts/app/.trash/01ABC-old');
  clone(source, 'code/.rifts/app/.trash/01ABC-old/big.bin');
  file('code/.rifts/app/.trash/01ABC-old/new.bin', 70 * MIB);
  file('code/.hidden/copy/big.bin', 55 * MIB);
  writeFileSync(join(code, '.hidden/copy/.git'), 'gitdir: /nonexistent/loop-probe-x\n');

  const run = Bun.spawnSync(['bun', SCRIPT, '--json', '--roots', code], { env: { ...process.env, HOME: join(root, 'home') } });
  expect(run.exitCode).toBe(0);
  const items: { category: string; what: string; bytes: number; duBytes?: number; clone?: { method: string; sharedWith: string } }[] = JSON.parse(run.stdout.toString()).items;
  const by = (category: string) => items.filter((i) => i.category === category);

  expect(by('rifts').map((i) => i.what.split(' ')[0])).toEqual([join(code, '.rifts/app/feature')]);
  const [feature] = by('rifts');
  expect(feature!.clone).toEqual({ method: 'apfs', sharedWith: join(root, 'code/app') });
  expect(feature!.bytes).toBeGreaterThanOrEqual(60 * MIB);
  expect(feature!.bytes).toBeLessThan(62 * MIB);
  expect(feature!.duBytes).toBeGreaterThanOrEqual(180 * MIB);

  const [trash] = by('rift trash');
  expect(trash!.what).toContain('1 removed Rifts');
  expect(trash!.bytes).toBeGreaterThanOrEqual(70 * MIB);
  expect(trash!.bytes).toBeLessThan(72 * MIB);

  const [worktree] = by('worktrees');
  expect(worktree!.clone).toBeUndefined();
  expect(worktree!.bytes).toBeGreaterThanOrEqual(55 * MIB);
}, 60_000);
