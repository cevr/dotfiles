#!/usr/bin/env bun
// Delete what Claude Code leaves behind once its sessions are done: subagent
// transcripts and tool-result spills under ~/.claude/projects older than a
// date, and session scratchpads under /private/tmp/claude-<uid> (/tmp on Linux) nothing wrote
// to since then. Main session transcripts stay, so every session can still be
// resumed. A dry run by default; prints one JSON summary line.
//
// Usage: bun prune-agent-files.ts --before YYYY-MM-DD [--apply] [--projects <dir>] [--scratch <dir>]

import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const before = Date.parse(flag('--before') ?? '');
if (Number.isNaN(before)) {
  console.error('usage: bun prune-agent-files.ts --before YYYY-MM-DD [--apply] [--projects <dir>] [--scratch <dir>]');
  process.exit(2);
}
const apply = args.includes('--apply');
const projects = flag('--projects', join(homedir(), '.claude', 'projects'))!;
const scratch = flag('--scratch', existsSync('/private/tmp') ? '/private/tmp' : '/tmp')!;

const ls = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

// Every file under a folder, with the newest change and the space they hold.
function tally(dir: string, out = { newest: 0, bytes: 0, files: [] as string[] }) {
  for (const e of ls(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tally(p, out);
    else {
      const s = lstatSync(p);
      out.newest = Math.max(out.newest, s.mtimeMs);
      out.bytes += s.blocks * 512;
      out.files.push(p);
    }
  }
  return out;
}

const SPILLS = [`${sep}subagents${sep}`, `${sep}tool-results${sep}`];
let files = 0;
let bytes = 0;
for (const p of tally(projects).files) {
  if (!SPILLS.some((s) => p.includes(s))) continue;
  const s = lstatSync(p);
  if (s.mtimeMs >= before) continue;
  files++;
  bytes += s.blocks * 512;
  if (apply) rmSync(p);
}

let scratchpads = 0;
for (const user of ls(scratch).filter((e) => e.isDirectory() && /^claude-\d+$/.test(e.name)))
  for (const project of ls(join(scratch, user.name)).filter((e) => e.isDirectory()))
    for (const session of ls(join(scratch, user.name, project.name)).filter((e) => e.isDirectory())) {
      const dir = join(scratch, user.name, project.name, session.name);
      const t = tally(dir);
      if (t.newest >= before) continue;
      scratchpads++;
      bytes += t.bytes;
      if (apply) rmSync(dir, { recursive: true, force: true });
    }

console.log(JSON.stringify({ apply, before: new Date(before).toISOString().slice(0, 10), files, scratchpads, freedGB: +(bytes / 1e9).toFixed(2) }));
