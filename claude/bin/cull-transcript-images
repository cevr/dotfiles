#!/usr/bin/env bun
// Replace the base64 images and documents in Claude and Codex transcripts with
// a short text note, and empty the copy of each image the Read tool keeps for
// the terminal. The text stays: every other line is kept byte for byte, and
// each file keeps its modified time, so cleanupPeriodDays still counts from the
// real age.
// A transcript written in the last --idle-min minutes belongs to a live session
// and is skipped.
//
// Usage: cull-transcript-images [--dry-run] [--idle-min <n>] [<dir>...]
//   Default dirs: ~/.claude/projects and ~/.codex/sessions.
//   Prints one JSON summary line.

import { readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NOTE = '[image removed to save disk]';

let dryRun = false;
let idleMs = 60 * 60e3;
const dirs: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--idle-min') idleMs = Number(args[++i]) * 60e3;
  else dirs.push(args[i]!);
}
const roots = dirs.length > 0 ? dirs : [join(homedir(), '.claude', 'projects'), join(homedir(), '.codex', 'sessions')];

function transcripts(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) transcripts(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Claude: { type: 'image' | 'document', source: { type: 'base64', data } }, and
// the Read tool's copy for the terminal, toolUseResult { type: 'image', file: { base64 } },
// which keeps its shape with an empty base64.
// Codex: { type: 'input_image', image_url: 'data:image/…;base64,…' }.
function strip(value: unknown): [unknown, number] {
  if (Array.isArray(value)) {
    let bytes = 0;
    const out = value.map((item) => {
      const [next, n] = strip(item);
      bytes += n;
      return next;
    });
    return [out, bytes];
  }
  if (typeof value !== 'object' || value === null) return [value, 0];
  const v = value as Record<string, unknown>;
  const source = v.source as Record<string, unknown> | undefined;
  if ((v.type === 'image' || v.type === 'document') && source?.type === 'base64' && typeof source.data === 'string') {
    return [{ type: 'text', text: NOTE }, source.data.length];
  }
  const file = v.file as Record<string, unknown> | undefined;
  if (v.type === 'image' && typeof file?.base64 === 'string' && file.base64.length > 0) {
    return [{ ...v, file: { ...file, base64: '' } }, file.base64.length];
  }
  if (v.type === 'input_image' && typeof v.image_url === 'string' && v.image_url.startsWith('data:')) {
    return [{ type: 'input_text', text: NOTE }, v.image_url.length];
  }
  let bytes = 0;
  const out: Record<string, unknown> = {};
  for (const key in v) {
    const [next, n] = strip(v[key]);
    out[key] = next;
    bytes += n;
  }
  return [out, bytes];
}

const hasImage = (text: string): boolean => text.includes('"base64"') || text.includes(';base64,');

const now = Date.now();
let files = 0;
let culled = 0;
let bytes = 0;
let live = 0;
for (const file of roots.flatMap((root) => transcripts(root))) {
  files++;
  const stat = statSync(file);
  const text = readFileSync(file, 'utf8');
  if (!hasImage(text)) continue;
  let fileBytes = 0;
  const lines = text.split('\n').map((line) => {
    if (!hasImage(line)) return line;
    try {
      const [next, n] = strip(JSON.parse(line));
      if (n === 0) return line;
      fileBytes += n;
      return JSON.stringify(next);
    } catch {
      return line;
    }
  });
  if (fileBytes === 0) continue;
  if (now - stat.mtimeMs < idleMs) {
    live++;
    continue;
  }
  culled++;
  bytes += fileBytes;
  if (dryRun) continue;
  const tmp = `${file}.cull-tmp`;
  writeFileSync(tmp, lines.join('\n'));
  renameSync(tmp, file);
  utimesSync(file, stat.atime, stat.mtime);
}

console.log(
  JSON.stringify({ at: new Date(now).toISOString(), dryRun, files, culled, liveSkipped: live, freedGB: +(bytes / 1e9).toFixed(2) }),
);
