// status.ts on scratch run dirs and repositories: the default table hides what is closed, `--all`
// shows it, and a unit whose files or repository say nothing keeps its log's state.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The script under test; STATUS_SCRIPT points it at another copy (the base's, for red-at-base). */
const SCRIPT = process.env.STATUS_SCRIPT ?? join(import.meta.dir, 'status.ts');

const status = (...args: string[]) => {
  const run = Bun.spawnSync(['bun', SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: run.exitCode, out: run.stdout.toString() };
};

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'status-test-')));

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

/** A repository with one commit on `main`, and a branch commit merged into it: its heads. */
const repository = (root: string) => {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'gc.auto', '0');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feat/x');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
  const merged = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge x', 'feat/x');
  git(repo, 'checkout', '-q', '-b', 'feat/y');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'y');
  const open = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  return { repo, merged, open };
};

/** A unit dir with this log, and these files beside it. */
const unit = (run: string, name: string, log: ReadonlyArray<string>, files: Readonly<Record<string, string>> = {}) => {
  const dir = join(run, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'log.md'), `${log.join('\n')}\n`);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
};

/** The states a table prints, by unit. */
const statesOf = (table: string) =>
  Object.fromEntries(
    table
      .split('\n')
      .map((line) => line.split('|').map((cell) => cell.trim()))
      .filter((cells) => cells.length > 3 && cells[1] !== 'Unit' && !cells[1]!.startsWith('-'))
      .map((cells) => [cells[1], cells[2]]),
  );

test('the default table hides merged and dropped units; --all shows them, with the verdict column', () => {
  const root = scratch();
  const { repo, merged, open } = repository(root);
  const run = join(root, 'run');
  unit(run, 'landed', ['2026-11-14T10:00Z implement → ready r1 round-1-request.md'], { 'round-1-request.md': `Head: ${merged}\n` });
  unit(run, 'logged', ['2026-11-14T10:00Z verify → merged abc1234 r1']);
  unit(run, 'gone', ['2026-11-14T10:00Z plan → dropped r1']);
  unit(run, 'working', ['2026-11-14T10:00Z ready → verify r1'], {
    'round-1-request.md': `Range: 0000000..${open}\n`,
    'round-1-findings.md': 'verifier batch-3 r1: changes /x/round-1-findings.md\n',
  });
  const shown = status(run, '--repo', repo);
  expect(shown.code).toBe(0);
  expect(shown.out.split('\n')[0]).toBe('| Unit | State | Round | Since | Cause | Verdict |');
  expect(statesOf(shown.out)).toEqual({ working: 'verify' });
  expect(shown.out).toContain('| working | verify | 1 | 2026-11-14T10:00Z |  | changes r1 |');
  const all = status(run, '--repo', repo, '--all');
  expect(all.code).toBe(0);
  expect(statesOf(all.out)).toEqual({ gone: 'dropped', landed: `merged ${merged.slice(0, 7)}`, logged: 'merged abc1234', working: 'verify' });
});

test('no request, a request with no head, a head git does not know, and no repository each print the log state and exit 0', () => {
  const root = scratch();
  const { repo } = repository(root);
  const run = join(root, 'run');
  unit(run, 'bare', ['2026-11-14T10:00Z implement → ready r1']);
  unit(run, 'headless', ['2026-11-14T10:00Z implement → ready r1'], { 'round-1-request.md': 'No head here.\n' });
  unit(run, 'stranger', ['2026-11-14T10:00Z implement → ready r2'], { 'round-2-request.md': `Head: ${'f'.repeat(40)}\n` });
  const expected = { bare: 'ready', headless: 'ready', stranger: 'ready' };
  const inRepo = status(run, '--repo', repo, '--all');
  expect([inRepo.code, statesOf(inRepo.out)]).toEqual([0, expected]);
  const noRepo = join(root, 'plain');
  mkdirSync(noRepo);
  const outside = status(run, '--repo', noRepo, '--all');
  expect([outside.code, statesOf(outside.out)]).toEqual([0, expected]);
  const missing = status(run, '--repo', join(root, 'nowhere'), '--all');
  expect([missing.code, statesOf(missing.out)]).toEqual([0, expected]);
});

test('a verify dir is no unit: its log.md of fleet lines gives no `?` row', () => {
  const root = scratch();
  const run = join(root, 'run');
  unit(run, 'verify-1115ce', ['2026-11-15T05:44Z fleet: batch-2026-11-15ce accepted; published the verified target dotfiles a1b1c6be70, fork d6be49fb0b'], {
    'batch-2026-11-15ce.md': 'Heads: dotfiles=a fork=b\n',
  });
  unit(run, 'verify-main-abc1234', ['2026-11-15T06:00Z fleet: batch-main-abc1234 accepted; the verified target is already dotfiles a1b1c6be70, fork d6be49fb0b']);
  unit(run, 'lexer', ['2026-11-14T10:00Z implement → ready r1']);
  const shown = status(run, '--all');
  expect([shown.code, statesOf(shown.out)]).toEqual([0, { lexer: 'ready' }]);
});

test('a repository with no remote and no main or master keeps the log state', () => {
  const root = scratch();
  const repo = join(root, 'trunk');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'trunk');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  const head = git(repo, 'rev-parse', 'HEAD');
  const run = join(root, 'run');
  unit(run, 'u', ['2026-11-14T10:00Z implement → ready r1'], { 'round-1-request.md': `Head: ${head}\n` });
  const shown = status(run, '--repo', repo);
  expect([shown.code, statesOf(shown.out)]).toEqual([0, { u: 'ready' }]);
});

test('a run dir inside a checkout reads that checkout with no --repo', () => {
  const root = scratch();
  const { repo, merged } = repository(root);
  const run = join(repo, 'tmp/orchestrate/r');
  unit(run, 'landed', ['2026-11-14T10:00Z implement → ready r1'], { 'round-1-request.md': `Head: ${merged}\n` });
  const shown = status(run, '--all');
  expect([shown.code, statesOf(shown.out)]).toEqual([0, { landed: `merged ${merged.slice(0, 7)}` }]);
});

test('150 units read within the status plugin\'s 20 s', () => {
  const root = scratch();
  const { repo, merged, open } = repository(root);
  const run = join(root, 'run');
  for (let i = 0; i < 150; i += 1)
    unit(run, `u${i}`, ['2026-11-14T10:00Z implement → ready r1'], { 'round-1-request.md': `Head: ${i % 2 ? merged : open}\n` });
  const started = performance.now();
  const shown = status(run, '--repo', repo, '--all');
  expect(shown.code).toBe(0);
  expect(performance.now() - started).toBeLessThan(20_000);
  expect(Object.values(statesOf(shown.out)).filter((state) => state.startsWith('merged')).length).toBe(75);
}, 30_000);
