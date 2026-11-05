#!/usr/bin/env bun
// Clear what Bun's WebView leaves behind. Bun starts a headless Chrome with a
// profile in the temp folder (`.<id>.bun-chrome`) and does not remove the
// profile when it is done; a Chrome whose Bun process died keeps running under
// launchd (parent pid 1). This stops those orphans and deletes every profile no
// live process uses, skipping profiles changed in the last hour.
// A dry run by default; prints one JSON summary line.
//
// Usage: bun bun-webview-leftovers.ts [--apply] [--tmp <dir>] [--min-age-minutes 60]

import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const apply = args.includes('--apply');
const tmp = flag('--tmp', tmpdir()).replace(/\/$/, '');
const minAge = Number(flag('--min-age-minutes', '60')) * 60e3;

const PROFILE = /^\.[0-9a-f]+-[0-9a-f]+\.bun-chrome$/;
const ls = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
const size = (dir: string): number =>
  ls(dir).reduce((sum, e) => {
    const p = join(dir, e.name);
    try {
      return sum + (e.isDirectory() ? size(p) : lstatSync(p).blocks * 512);
    } catch {
      return sum;
    }
  }, 0);
// The newest change in a profile's top level: Chrome writes there while it runs.
const changed = (dir: string): number =>
  Math.max(lstatSync(dir).mtimeMs, ...ls(dir).map((e) => {
    try {
      return lstatSync(join(dir, e.name)).mtimeMs;
    } catch {
      return 0;
    }
  }));

// Processes that hold a profile in this temp folder, by profile name.
type Holder = { pid: number; orphan: boolean };
const holders = new Map<string, Holder[]>();
const ps = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,args='], { stderr: 'ignore' }).stdout.toString();
for (const line of ps.split('\n')) {
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
  const dir = m?.[3]?.match(/--user-data-dir=(\S+\.bun-chrome)/)?.[1];
  if (!m || !dir) continue;
  const at = dir.lastIndexOf('/');
  if (dir.slice(0, at).replace(/^\/private/, '') !== tmp.replace(/^\/private/, '')) continue;
  const name = dir.slice(at + 1);
  const list = holders.get(name) ?? [];
  list.push({ pid: Number(m[1]), orphan: m[2] === '1' && (m[3] ?? '').includes('--headless') });
  holders.set(name, list);
}

let stopped = 0;
const kept: string[] = [];
const failed: string[] = [];
const paths: string[] = [];
let bytes = 0;
for (const e of ls(tmp).filter((e) => e.isDirectory() && PROFILE.test(e.name))) {
  const dir = join(tmp, e.name);
  const held = holders.get(e.name) ?? [];
  // Only a headless Chrome nobody owns is stopped; anything else holding it keeps the profile.
  if (held.some((h) => !h.orphan)) {
    kept.push(dir);
    continue;
  }
  if (held.length === 0 && Date.now() - changed(dir) < minAge) {
    kept.push(dir);
    continue;
  }
  const freed = size(dir);
  if (apply) {
    for (const h of held) {
      try {
        process.kill(h.pid, 'SIGTERM');
        stopped++;
      } catch {}
    }
    if (held.length) Bun.sleepSync(1000);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      failed.push(dir);
      continue;
    }
  } else stopped += held.length;
  paths.push(dir);
  bytes += freed;
}

console.log(
  JSON.stringify({
    apply,
    tmp,
    profiles: paths.length,
    orphans: stopped,
    kept: kept.length,
    freedGB: +(bytes / 1e9).toFixed(2),
    bytes,
    paths,
    failed: failed.length,
    ...(failed.length > 0 ? { firstFailed: failed.slice(0, 5) } : {}),
  }),
);
