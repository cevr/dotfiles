#!/usr/bin/env bun
// One host's Claude load, from its transcripts: the sessions active now, the
// weighted tokens of the last hour, and each agent kind's cost per active hour
// over the last 7 days. budget.ts runs this file on every host (remote hosts
// read it from stdin, so it imports nothing but node and bun) and prints one
// JSON line.
//
// Weighted tokens (W): input + 1.25 × cache-create(5m) + 2 × cache-create(1h)
// + 0.1 × cache-read + 5 × output, the Anthropic price ratios.
//
// The scan is incremental: ~/.cache/orchestrate/host-costs.json keeps each
// transcript's read offset and tallies, so a run reads only appended bytes. A
// run stops reading after --deadline-ms and the next run goes on from there.
//
// A session's project is its label (label.ts, from its herdr workspace), else
// its orchestrate run, else its repository. A subagent takes its session's.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

const MINUTE = 60e3;
const HOUR = 60 * MINUTE;
const LOOKBACK = 7 * 24 * HOUR;
const ACTIVE = 10 * MINUTE;
const RECENT = 30 * MINUTE;

type Turn = [at: number, w: number];
type FileTally = {
  offset: number;
  cwd?: string;
  kind: string;
  sub: boolean;
  totalW: number;
  activeMs: number;
  lastAt: number;
  lastId?: string;
  lastW: number;
  turns: Turn[];
};
type Cache = { files: Record<string, FileTally> };

export type Session = { project: string; kind: string; sub: boolean; recentWph: number };
export type KindCost = { project: string; kind: string; agents: number; wph: number[] };
export type HostLoad = { host: string; sessions: Session[]; w1h: number; kinds: KindCost[]; complete: boolean };

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const root = option('--projects') ?? join(homedir(), '.claude', 'projects');
const deadline = Date.now() + Number(option('--deadline-ms') ?? 6000);
const cachePath = join(homedir(), '.cache', 'orchestrate', 'host-costs.json');

type Usage = Record<string, number | Record<string, number> | undefined>;

function weightOf(u: Usage): number {
  const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  const split = typeof u.cache_creation === 'object' ? u.cache_creation : undefined;
  const create =
    split !== undefined
      ? 1.25 * (split.ephemeral_5m_input_tokens ?? 0) + 2 * (split.ephemeral_1h_input_tokens ?? 0)
      : 1.25 * n('cache_creation_input_tokens');
  return n('input_tokens') + create + 0.1 * n('cache_read_input_tokens') + 5 * n('output_tokens');
}

const labelDir = join(homedir(), '.cache', 'orchestrate', 'labels');

/** The project of a session, by its id, working in `cwd`. */
export function projectFor(sessionId: string | undefined, cwd: string | undefined): string {
  if (sessionId) {
    try {
      return (JSON.parse(readFileSync(join(labelDir, `${sessionId}.json`), 'utf8')) as { project: string }).project;
    } catch {}
  }
  if (!cwd) return 'unknown';
  const m =
    cwd.match(/\/tmp\/orchestrate\/([^/]+)/) ??
    cwd.match(/\/\.rifts\/([^/]+)/) ??
    cwd.match(/\/Developer\/(?:personal|work)\/([^/.][^/]*)/) ??
    cwd.match(/\/workspaces\/([^/]+)/);
  return m?.[1] ?? basename(cwd);
}

// A root transcript is <session id>.jsonl; a subagent's sits in <session id>/subagents/.
const sessionOf = (file: string): string =>
  file.includes('/subagents/') ? basename(dirname(dirname(file))) : basename(file, '.jsonl');

const ROLES: [RegExp, string][] = [
  [/review|counsel|audit/i, 'review'],
  [/verif|prove|probe|e2e|smoke/i, 'verify'],
  [/plan|design|spec/i, 'plan'],
  [/explore|search|find|survey|read|research/i, 'explore'],
  [/implement|build|fix|write|add|split|port|refactor|migrat/i, 'implement'],
];

/** An agent's kind: its type and the role its description names. */
// The status mod runs orchestrate-worker as its own copy, `status:orchestrate-worker`.
export const kindFor = (agentType: string | undefined, description: string | undefined): string =>
  `${agentType?.replace(/^status:/, '') || 'agent'}:${ROLES.find(([re]) => re.test(description ?? ''))?.[1] ?? 'task'}`;

function kindOf(file: string): { kind: string; sub: boolean } {
  if (!file.includes('/subagents/')) return { kind: 'root', sub: false };
  let meta: { agentType?: string; description?: string } = {};
  try {
    meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {}
  return { kind: kindFor(meta.agentType, meta.description), sub: true };
}

function transcripts(dir: string, since: number, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) transcripts(p, since, out);
    else if (e.name.endsWith('.jsonl') && statSync(p).mtimeMs >= since) out.push(p);
  }
  return out;
}

// Read the bytes appended since the last run, up to the last whole line.
function appended(file: string, offset: number): { text: string; offset: number } {
  const size = statSync(file).size;
  if (size < offset) offset = 0; // rewritten: the cull keeps lines, so a shorter file starts over
  if (size === offset) return { text: '', offset };
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { text: '', offset };
    return { text: buf.subarray(0, end + 1).toString('utf8'), offset: offset + end + 1 };
  } finally {
    closeSync(fd);
  }
}

function tally(file: string, t: FileTally, now: number): void {
  const { text, offset } = appended(file, t.offset);
  if (offset < t.offset) Object.assign(t, { totalW: 0, activeMs: 0, lastAt: 0, lastId: undefined, lastW: 0, turns: [] });
  t.offset = offset;
  for (const line of text.split('\n')) {
    if (t.cwd === undefined && line.includes('"cwd"')) t.cwd = line.match(/"cwd":"([^"]+)"/)?.[1];
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let d: { type?: string; timestamp?: string; message?: { id?: string; usage?: Usage } };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== 'assistant' || !d.message?.usage) continue;
    const at = Date.parse(d.timestamp ?? '');
    if (!(at > 0)) continue;
    const w = weightOf(d.message.usage);
    // One message spans several lines; the last line of a message id carries its final usage.
    if (d.message.id !== undefined && d.message.id === t.lastId) {
      t.totalW += w - t.lastW;
      const last = t.turns.at(-1);
      if (last) last[1] = w;
      t.lastW = w;
      continue;
    }
    if (t.lastAt > 0 && at - t.lastAt <= ACTIVE) t.activeMs += at - t.lastAt;
    t.totalW += w;
    t.lastAt = Math.max(t.lastAt, at);
    t.lastId = d.message.id;
    t.lastW = w;
    t.turns.push([at, w]);
  }
  t.turns = t.turns.filter(([at]) => at >= now - HOUR);
}

export function hostLoad(now = Date.now()): HostLoad {
  let cache: Cache = { files: {} };
  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {}
  // A session copied under two project folders (a moved repo) counts once: the larger copy.
  const copies = new Map<string, { file: string; size: number }>();
  for (const file of transcripts(root, now - LOOKBACK)) {
    const key = file.slice(root.length).split('/').slice(2).join('/');
    const size = statSync(file).size;
    if ((copies.get(key)?.size ?? -1) < size) copies.set(key, { file, size });
  }
  const live = [...copies.values()].map((c) => c.file);
  const files: Record<string, FileTally> = {};
  let complete = true;
  // Newest first, so a run cut short by the deadline has the active sessions.
  const mtime = new Map(live.map((f) => [f, statSync(f).mtimeMs]));
  live.sort((a, b) => mtime.get(b)! - mtime.get(a)!);
  for (const file of live) {
    const t = cache.files[file] ?? { offset: 0, ...kindOf(file), totalW: 0, activeMs: 0, lastAt: 0, lastW: 0, turns: [] };
    if (Date.now() < deadline) tally(file, t, now);
    else complete = false;
    files[file] = t;
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ files }));

  const sessions: Session[] = [];
  const kinds = new Map<string, KindCost>();
  let w1h = 0;
  for (const [file, t] of Object.entries(files)) {
    const project = projectFor(sessionOf(file), t.cwd);
    w1h += t.turns.reduce((n, [, w]) => n + w, 0);
    if (t.lastAt >= now - ACTIVE) {
      const recent = t.turns.filter(([at]) => at >= now - RECENT).reduce((n, [, w]) => n + w, 0);
      sessions.push({ project, kind: t.kind, sub: t.sub, recentWph: Math.round(recent * (HOUR / RECENT)) });
    }
    // An agent's cost per active hour, once it has run 5 minutes.
    if (t.sub && t.activeMs >= 5 * MINUTE) {
      const key = `${project}\0${t.kind}`;
      const k = kinds.get(key) ?? { project, kind: t.kind, agents: 0, wph: [] };
      k.agents++;
      k.wph.push(Math.round(t.totalW / (t.activeMs / HOUR)));
      kinds.set(key, k);
    }
  }
  return { host: hostname(), sessions, w1h: Math.round(w1h), kinds: [...kinds.values()], complete };
}

if (import.meta.main && existsSync(root)) console.log(JSON.stringify(hostLoad()));
else if (import.meta.main) console.log(JSON.stringify({ host: hostname(), sessions: [], w1h: 0, kinds: [], complete: true }));
