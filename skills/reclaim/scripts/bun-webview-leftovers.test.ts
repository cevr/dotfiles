import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'bun-webview-leftovers.ts');
const HOUR_AGO = new Date(Date.now() - 2 * 3600e3);

let root = '';
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
});

const profile = (name: string, at?: Date) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Local State'), 'x'.repeat(5000));
  if (at) {
    utimesSync(join(dir, 'Local State'), at, at);
    utimesSync(dir, at, at);
  }
  return dir;
};
const run = (...flags: string[]) => JSON.parse(Bun.spawnSync(['bun', SCRIPT, '--tmp', root, ...flags]).stdout.toString());
// A stand-in Chrome: a sleep whose command line names the profile, as Bun's Chrome does.
const chrome = (dir: string, orphan: boolean) => {
  const argv0 = `chrome --headless --user-data-dir=${dir}`;
  const cmd = orphan ? `(exec -a "${argv0}" sleep 60 &) ; sleep 0.2` : `exec -a "${argv0}" sleep 60`;
  const child = Bun.spawn(['bash', '-c', cmd], { stdout: 'ignore', stderr: 'ignore' });
  return child;
};
const pidOf = (dir: string) => {
  const ps = Bun.spawnSync(['ps', '-axo', 'pid=,args=']).stdout.toString();
  const line = ps.split('\n').find((l) => l.includes(`--user-data-dir=${dir}`));
  return line ? Number(line.trim().split(/\s+/)[0]) : 0;
};

test('a dry run lists idle profiles and deletes nothing', () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bun-webview-')));
  const idle = profile('.abc123-00000000.bun-chrome', HOUR_AGO);
  const summary = run();
  expect(summary).toMatchObject({ apply: false, profiles: 1, paths: [idle] });
  expect(existsSync(idle)).toBe(true);
});

test('deletes idle profiles and keeps fresh ones and other folders', () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bun-webview-')));
  const idle = profile('.abc123-00000000.bun-chrome', HOUR_AGO);
  const fresh = profile('.def456-00000000.bun-chrome');
  const other = profile('com.google.Chrome.x1y2z3', HOUR_AGO);
  const summary = run('--apply');
  expect(summary).toMatchObject({ apply: true, profiles: 1, kept: 1, failed: 0 });
  expect(existsSync(idle)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(other)).toBe(true);
});

test('keeps a profile a live process holds', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bun-webview-')));
  const held = profile('.abc123-00000000.bun-chrome', HOUR_AGO);
  const child = chrome(held, false);
  pids.push(child.pid);
  await Bun.sleep(200);
  const summary = run('--apply');
  expect(summary).toMatchObject({ profiles: 0, kept: 1, orphans: 0 });
  expect(existsSync(held)).toBe(true);
});

test('stops an orphaned headless Chrome and deletes its profile, however fresh', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bun-webview-')));
  const dir = profile('.abc123-00000000.bun-chrome');
  await chrome(dir, true).exited;
  const pid = pidOf(dir);
  expect(pid).toBeGreaterThan(0);
  pids.push(pid);
  const summary = run('--apply');
  expect(summary).toMatchObject({ profiles: 1, orphans: 1, failed: 0 });
  expect(existsSync(dir)).toBe(false);
  await Bun.sleep(300);
  expect(pidOf(dir)).toBe(0);
});
