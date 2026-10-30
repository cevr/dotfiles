#!/usr/bin/env bun
// One host's Codex load, from its session rollouts: the weighted tokens of
// each hour of the last 7 days by model family, the account's usage as Codex
// reported it, each thread's cost per active hour, the threads live now and
// the last hour's tokens. budget.ts --codex runs this file on every host
// (remote hosts read it from stdin, so it imports nothing but node and bun)
// and prints one JSON line.
//
// Weighted tokens (W): uncached input + 0.1 × cached input + 8 × output, the
// OpenAI price ratios. Codex counts cached input inside input, and reasoning
// inside output.
//
// A rollout logs each turn's token_count event with the thread's running
// total; the event repeats, so a file's tokens are the rises of that total.
//
// A thread's role is its orchestrate role, from the codex-bridge's state; a
// thread the bridge started without one is `none`, and any other thread
// (the CLI, `codex exec`) is `interactive`. A thread a thread spawned is
// counted in its parent's record.
//
// The scan is incremental: ~/.cache/orchestrate/codex-host.json keeps each
// rollout's read offset and tallies, so a run reads only appended bytes. A run
// stops reading after --deadline-ms and the next run goes on from there.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

const MINUTE = 60e3;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LOOKBACK = 7 * DAY;
// A thread resumed days after it began still writes to its first day's rollout.
const FILES = 8 * DAY;
const ACTIVE = 10 * MINUTE;
const RECENT = 30 * MINUTE;
// A rate needs this much history: one turn of a new thread is not its hour.
const MIN_SPAN = 5 * MINUTE;
const CHUNK = 32 << 20;
// Bump when FileTally changes, so cached tallies are read again from the start.
const VERSION = 1;

type Tokens = { input: number; cached: number; output: number };
type FileTally = {
  offset: number;
  id?: string;
  parent?: string;
  family: string;
  last?: Tokens;
  firstAt?: number;
  lastAt: number;
  activeMs: number;
  /** W by family over the whole file. */
  w: Record<string, number>;
  /** W by hour start, then family. */
  hours: Record<string, Record<string, number>>;
  /** The last hour's token events. */
  turns: [at: number, w: number, family: string][];
};
/** The account's use of one rate-limit window as a token event reported it: a percentage, whole steps. */
export type Snapshot = { at: number; used: number; resetsAt: number; windowMinutes: number };
type Cache = { version: number; files: Record<string, FileTally>; snapshots: Record<string, Snapshot> };

export type HourLoad = { at: number; w: Record<string, number> };
export type ThreadCost = { id: string; family: string; role: string; activeHours: number; w: number };
/** `activeHours`: how long the thread has been active so far. */
export type LiveThread = { id: string; family: string; role: string; recentWph: number; activeHours?: number };
export type CodexLoad = {
  host: string;
  complete: boolean;
  hours: HourLoad[];
  snapshots: Snapshot[];
  threads: ThreadCost[];
  live: LiveThread[];
  /** This host's W in the last hour. */
  w1h: number;
  /** The last hour's W of interactive threads, by family: they burn outside any thread admission. */
  interactive1h: Record<string, number>;
};

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const root = option('--sessions') ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
const scanMs = Number(option('--deadline-ms') ?? 6000);
const cachePath = join(homedir(), '.cache', 'orchestrate', 'codex-host.json');
const bridgeState = join(
  process.env.CODEX_BRIDGE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'codex-bridge'),
  'state.json',
);

const weightOf = (t: Tokens): number => t.input - t.cached + 0.1 * t.cached + 8 * t.output;

/** A model's family: `gpt-6.1-sol` → `sol`; another model goes by its name. */
export const familyOf = (model: string | undefined): string => /^gpt-[\d.]+-(\w+)$/.exec(model ?? '')?.[1] ?? (model || 'other');

function rollouts(dir: string, since: number, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) rollouts(p, since, out);
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl') && statSync(p).mtimeMs >= since) out.push(p);
  }
  return out;
}

// Read the bytes appended since the last run, a chunk at a time, up to the last whole line.
function* appended(file: string, offset: number): Generator<{ text: string; offset: number }> {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    let length = CHUNK;
    while (offset < size) {
      const buf = Buffer.alloc(Math.min(length, size - offset));
      readSync(fd, buf, 0, buf.length, offset);
      const end = buf.lastIndexOf(0x0a);
      if (end < 0) {
        // One line longer than the chunk: read it whole, unless it is still being written.
        if (offset + buf.length >= size) return;
        length *= 2;
        continue;
      }
      offset += end + 1;
      length = CHUNK;
      yield { text: buf.subarray(0, end + 1).toString('utf8'), offset };
    }
  } finally {
    closeSync(fd);
  }
}

const fresh = (): FileTally => ({ offset: 0, family: 'other', lastAt: 0, activeMs: 0, w: {}, hours: {}, turns: [] });

function tally(file: string, t: FileTally, now: number, deadline: number, snapshots: Cache['snapshots']): boolean {
  // Rewritten: a shorter file starts over.
  if (statSync(file).size < t.offset) Object.assign(t, fresh());
  for (const chunk of appended(file, t.offset)) {
    for (const line of chunk.text.split('\n')) read(line, t, snapshots);
    t.offset = chunk.offset;
    if (Date.now() >= deadline) break;
  }
  t.turns = t.turns.filter(([at]) => at >= now - HOUR);
  for (const h of Object.keys(t.hours)) if (Number(h) < now - LOOKBACK - HOUR) delete t.hours[h];
  return t.offset >= statSync(file).size;
}

function read(line: string, t: FileTally, snapshots: Cache['snapshots']): void {
  const meta = line.includes('"type":"session_meta"');
  const context = !meta && line.includes('"type":"turn_context"');
  const count = !meta && !context && line.includes('"token_count"');
  if (!meta && !context && !count) return;
  let d: { timestamp?: string; type?: string; payload?: any };
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  const p = d.payload ?? {};
  if (d.type === 'session_meta') {
    t.id ??= p.id;
    t.parent ??= p.source?.subagent?.thread_spawn?.parent_thread_id;
    return;
  }
  if (d.type === 'turn_context') {
    t.family = familyOf(p.model ?? p.collaboration_mode?.settings?.model);
    return;
  }
  if (d.type !== 'event_msg' || p.type !== 'token_count') return;
  const at = Date.parse(d.timestamp ?? '');
  if (!(at > 0)) return;
  // The account's own limit; a model's separate limit is not the week this budget paces.
  const limits = (p.rate_limits?.limit_id ?? 'codex') === 'codex' ? p.rate_limits : undefined;
  for (const w of [limits?.primary, limits?.secondary]) {
    if (typeof w?.used_percent !== 'number' || typeof w.resets_at !== 'number') continue;
    const s: Snapshot = { at, used: w.used_percent, resetsAt: w.resets_at * 1e3, windowMinutes: Number(w.window_minutes ?? 0) };
    // One a minute: the highest use, so a minute that spans a reset keeps the old window's.
    const key = `${s.windowMinutes}:${Math.floor(at / MINUTE)}`;
    const seen = snapshots[key];
    if (!seen || s.used > seen.used) snapshots[key] = s;
  }
  const total = p.info?.total_token_usage;
  if (!total) return;
  const now: Tokens = { input: Number(total.input_tokens ?? 0), cached: Number(total.cached_input_tokens ?? 0), output: Number(total.output_tokens ?? 0) };
  const before = t.last;
  t.last = now;
  // A total below the last one counts from 0: the thread's count started over.
  const fell = before !== undefined && (now.input < before.input || now.output < before.output);
  const w = weightOf(now) - (before && !fell ? weightOf(before) : 0);
  if (w <= 0) return;
  if (t.lastAt > 0 && at - t.lastAt <= ACTIVE) t.activeMs += at - t.lastAt;
  t.firstAt ??= at;
  t.lastAt = Math.max(t.lastAt, at);
  t.w[t.family] = (t.w[t.family] ?? 0) + w;
  const hour = String(Math.floor(at / HOUR) * HOUR);
  const bucket = (t.hours[hour] ??= {});
  bucket[t.family] = (bucket[t.family] ?? 0) + w;
  t.turns.push([at, w, t.family]);
}

/** Each bridge thread's role: its orchestrate role, else `none`. */
function roles(): Map<string, string> {
  try {
    // A thread the bridge opened again writes its rollout under its app-server id (`codexId`).
    const state = JSON.parse(readFileSync(bridgeState, 'utf8')) as { threads?: Record<string, { role?: string; codexId?: string }> };
    return new Map(Object.entries(state.threads ?? {}).flatMap(([id, thread]) => [id, thread.codexId ?? id].map((key) => [key, thread.role ?? 'none'] as const)));
  } catch {
    return new Map();
  }
}

export function codexLoad(now = Date.now(), deadline = Date.now() + scanMs): CodexLoad {
  let cache: Cache = { version: VERSION, files: {}, snapshots: {} };
  try {
    const read = JSON.parse(readFileSync(cachePath, 'utf8')) as Cache;
    if (read.version === VERSION) cache = read;
  } catch {}
  const live = rollouts(root, now - FILES);
  // Newest first, so a run cut short by the deadline has the live threads.
  const mtime = new Map(live.map((f) => [f, statSync(f).mtimeMs]));
  live.sort((a, b) => mtime.get(b)! - mtime.get(a)!);
  const files: Record<string, FileTally> = {};
  let complete = true;
  for (const file of live) {
    const t = cache.files[file] ?? fresh();
    if (Date.now() < deadline) complete = tally(file, t, now, deadline, cache.snapshots) && complete;
    else complete = false;
    files[file] = t;
  }
  const snapshots = Object.fromEntries(Object.entries(cache.snapshots).filter(([, s]) => s.at >= now - LOOKBACK));
  mkdirSync(dirname(cachePath), { recursive: true });
  // Several admissions scan at once: a reader never sees half a file.
  const tmp = `${cachePath}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version: VERSION, files, snapshots }));
  renameSync(tmp, cachePath);

  const role = roles();
  const byId = new Map(Object.values(files).flatMap((t) => (t.id ? [[t.id, t] as const] : [])));
  // A spawned thread counts as its root's.
  const rootOf = (t: FileTally): string => {
    let id = t.id ?? '';
    for (let n = 0, p = t.parent; p && n < 8; n++, p = byId.get(p)?.parent) id = p;
    return id;
  };
  const hours = new Map<number, Record<string, number>>();
  const threads = new Map<string, ThreadCost>();
  const liveThreads: LiveThread[] = [];
  const interactive1h: Record<string, number> = {};
  let w1h = 0;
  for (const t of Object.values(files)) {
    for (const [h, fams] of Object.entries(t.hours)) {
      if (Number(h) < now - LOOKBACK) continue;
      const bucket = hours.get(Number(h)) ?? {};
      for (const [f, w] of Object.entries(fams)) bucket[f] = (bucket[f] ?? 0) + w;
      hours.set(Number(h), bucket);
    }
    if (t.lastAt < now - LOOKBACK) continue;
    const id = rootOf(t);
    const r = role.get(id) ?? 'interactive';
    const family = Object.entries(t.w).sort((a, b) => b[1] - a[1])[0]?.[0] ?? t.family;
    const w = Object.values(t.w).reduce((n, x) => n + x, 0);
    // A spawned thread runs alongside its root: its tokens join the root's, its hours do not.
    const rec = threads.get(id) ?? { id, family, role: r, activeHours: 0, w: 0 };
    if (id === t.id) rec.family = family;
    rec.w += w;
    rec.activeHours = Math.max(rec.activeHours, t.activeMs / HOUR);
    threads.set(id, rec);
    const hour = t.turns.filter(([at]) => at >= now - HOUR);
    w1h += hour.reduce((n, [, x]) => n + x, 0);
    if (r === 'interactive') for (const [, x, f] of hour) interactive1h[f] = Math.round((interactive1h[f] ?? 0) + x);
    if (t.lastAt >= now - ACTIVE) {
      const recent = hour.filter(([at]) => at >= now - RECENT);
      // A thread younger than the window burns over its own age, not the whole window.
      const span = Math.min(RECENT, Math.max(MIN_SPAN, now - (t.firstAt ?? now)));
      const x = recent.reduce((n, [, v]) => n + v, 0);
      liveThreads.push({ id: t.id ?? id, family: t.family, role: r, recentWph: Math.round(x * (HOUR / span)), activeHours: Number((t.activeMs / HOUR).toFixed(3)) });
    }
  }
  return {
    host: hostname(),
    complete,
    hours: [...hours].sort((a, b) => a[0] - b[0]).map(([at, w]) => ({ at, w: Object.fromEntries(Object.entries(w).map(([f, x]) => [f, Math.round(x)])) })),
    snapshots: Object.values(snapshots).sort((a, b) => a.at - b.at),
    threads: [...threads.values()].map((t) => ({ ...t, w: Math.round(t.w), activeHours: Number(t.activeHours.toFixed(3)) })),
    live: liveThreads,
    w1h: Math.round(w1h),
    interactive1h,
  };
}

const empty = (): CodexLoad => ({ host: hostname(), complete: true, hours: [], snapshots: [], threads: [], live: [], w1h: 0, interactive1h: {} });

if (import.meta.main) console.log(JSON.stringify(existsSync(root) ? codexLoad() : empty()));
