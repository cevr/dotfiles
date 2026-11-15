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

test.if(APFS)("the survey lists a work workspace as a Rift and work's trash for work gc, and never the store's own files", () => {
  root = mkdtempSync(join(tmpdir(), 'survey-'));
  const code = join(root, 'code');
  const source = file('code/app/big.bin', 120 * MIB);
  mkdirSync(join(code, 'app/.git'), { recursive: true });
  file('code/app/.rift', 26, LAST_WEEK); // a warm source's marker, cloned into its workspaces
  // A Rift of the same base, to compare with.
  rift('code/.rifts/app/feature');
  mkdirSync(join(code, '.rifts/app/feature/.git'));
  clone(source, 'code/.rifts/app/feature/big.bin');
  file('code/.rifts/app/feature/new.bin', 60 * MIB);
  // work's store for code/app: its own files, a workspace, and the trash of a removed one.
  const store = ['.registry', '.trusted', '.lock', '.lock-1'].map((f) => file(`code/.work/app/${f}`, 64));
  for (const dir of ['code/.work/app/feat-x', 'code/.work/app/.work-trash/old.1794762895', 'code/.rifts/app/.work-trash/adopted.1794762895']) {
    mkdirSync(join(root, dir, '.git'), { recursive: true });
    file(`${dir}/.rift`, 26, LAST_WEEK);
    clone(source, `${dir}/big.bin`);
    file(`${dir}/new.bin`, 60 * MIB);
  }
  // A store left with only trash, over a GiB by du (clones), holds no checkout: neither it nor its
  // folder for a base is a loose folder.
  const bare = join(root, 'bare');
  store.push(file('bare/.work/gone/.registry', 64));
  for (let i = 0; i < 9; i++) clone(source, `bare/.work/gone/.work-trash/gone.1/big${i}.bin`);
  // A repository with a .work folder of its own: its data, not a store.
  mkdirSync(join(code, 'lib/.git'), { recursive: true });
  file('code/lib/.work/x/.registry', 64);
  mkdirSync(join(code, 'lib/.work/x/y/.git'), { recursive: true });
  file('code/lib/.work/x/.work-trash/z.1/new.bin', 60 * MIB);
  // A base named .work, whose store is .work/.work: a base, never a copy.
  const other = join(root, 'other');
  mkdirSync(join(other, '.work/.git'), { recursive: true });
  file('other/.work/big.bin', 60 * MIB);
  file('other/.work/.work/.registry', 64);
  mkdirSync(join(other, '.work/.work/main/.git'), { recursive: true });

  const run = Bun.spawnSync(['bun', SCRIPT, '--json', '--roots', `${code},${other},${bare}`], { env: { ...process.env, HOME: join(root, 'home') } });
  expect(run.exitCode).toBe(0);
  const items: { tier: string; category: string; what: string; paths: string[]; bytes: number; command: string; clone?: { sharedWith: string } }[] = JSON.parse(run.stdout.toString()).items;
  const at = (path: string) => items.filter((i) => i.paths.includes(path));

  const [riftItem] = at(join(code, '.rifts/app/feature'));
  const [workspace] = at(join(code, '.work/app/feat-x'));
  expect([workspace!.tier, workspace!.category]).toEqual([riftItem!.tier, riftItem!.category]);
  expect(workspace!.clone!.sharedWith).toBe(join(code, 'app'));
  expect(workspace!.command).toStartWith(`work rm feat-x (from ${join(code, 'app')})`);
  expect(workspace!.bytes).toBeGreaterThanOrEqual(60 * MIB);
  expect(workspace!.bytes).toBeLessThan(62 * MIB);

  const trash = items.filter((i) => i.command.includes('work gc'));
  expect(trash.flatMap((i) => i.paths).sort()).toEqual([join(code, '.rifts/app/.work-trash'), join(code, '.work/app/.work-trash')]);
  for (const t of trash) {
    expect(t.what).toContain('1 removed workspaces');
    expect(t.command).toContain(`work gc (from ${join(code, 'app')}`);
    // The trash is what a rollback to Rift restores from until the window closes.
    if (Date.now() < Date.parse('2026-12-06T00:00:00')) expect(t.command).toStartWith('keep until 2026-12-06');
  }

  const paths = items.flatMap((i) => i.paths);
  for (const f of store) expect(paths.filter((p) => f === p || f.startsWith(p + '/'))).toEqual([]);
  expect(paths.filter((p) => p.startsWith(join(code, 'lib/.work')) || p.startsWith(other))).toEqual([]);
}, 60_000);
