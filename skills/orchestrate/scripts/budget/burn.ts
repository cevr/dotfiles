#!/usr/bin/env bun
// Where one host's Claude tokens go. Each API call's weighted cost (W, the
// price ratios in host.ts) splits into output, writing new context, rewriting
// context after a cache miss, and reading the cached context. The read share
// splits across what the context holds: the base prompt the session started
// with, each tool result, skill, attachment and message since, and the
// summary a compaction left. So a 20k-token Bash output that sits through 300
// calls is charged its write once and its read 300 times: its rent.
//
// It also replays each transcript's context growth as if it compacted at each
// of WINDOWS, so `budget.ts --tune` can pick the window each kind of agent
// costs least at.
//
// `budget.ts --burn` runs this on every host (remote hosts read it from stdin,
// so it imports nothing but node and bun); each prints one JSON line. Per-file
// results are cached by size in ~/.cache/orchestrate/burn.json.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const DAY = 864e5;
const root = option('--projects') ?? join(homedir(), '.claude', 'projects');
const days = Number(option('--days') ?? 7);
const deadline = Date.now() + Number(option('--deadline-ms') ?? 120e3);
const cachePath = join(homedir(), '.cache', 'orchestrate', 'burn.json');
// Bump when FileBurn or the attribution changes, so cached results are recomputed.
const VERSION = 4;
// Attachment records the model sees; the rest (prompt_snapshot, environment, hook_success, ...) are local.
const SENT = new Set(['skill_listing', 'nested_memory', 'instructions', 'invoked_skills', 'hook_additional_context', 'file', 'edited_text_file', 'mcp_instructions_delta', 'deferred_tools_delta', 'agent_listing_delta', 'date', 'queued_command', 'silent_turn_reminder', 'todo_reminder', 'task_reminder', 'plan_mode', 'critical_system_reminder', 'diagnostics', 'selected_lines_in_ide', 'opened_file_in_ide', 'compact_file_reference']);

type Usage = Record<string, number | Record<string, number> | undefined>;
type Item = { cat: string; label: string; tokens: number; w: number; big?: boolean };
// A tool result past this many chars is big: the cap (bashOutputMaxChars) would move it to a file.
const BIG = 8000;
// The compaction windows the replay tries, in tokens.
export const WINDOWS = [100e3, 120e3, 140e3, 160e3, 180e3, 200e3, 250e3, 300e3, 350e3, 400e3, 500e3];
// What a compaction leaves past the base prompt, and what its summary costs in output (measured: ~15k postTokens).
const SUMMARY = 15e3;
const SUMMARY_OUT = 4e3;
export type FileBurn = {
  size: number;
  project: string;
  kind: string;
  calls: number;
  w: { output: number; write: number; rewrite: number; read: number; input: number };
  cats: Record<string, number>; // W by context category (write + read)
  base: number[]; // the first call's context of each segment (session start, after each compaction)
  peak: number;
  ctxSum: number; // Σ context per call, for the mean
  misses: number;
  compactions: number;
  compactMs: number; // wall time spent compacting
  reread: number; // tokens of files read again after a compaction that were read before it
  // At each of WINDOWS: the replay's [W, compactions, calls after a compaction].
  windows: Record<string, [number, number, number]>;
  tokens: { output: number; thinking: number; rewrite: number; rewrite5m: number };
  big: number; // W of tool results over BIG chars
  top: Item[];
};
export type HostBurn = { host: string; days: number; files: number; complete: boolean; burns: FileBurn[] };

const n = (u: Usage, k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
const writeRate = (u: Usage): number => {
  const s = typeof u.cache_creation === 'object' ? u.cache_creation : undefined;
  const five = s?.ephemeral_5m_input_tokens ?? 0;
  const hour = s?.ephemeral_1h_input_tokens ?? 0;
  return five + hour > 0 ? (1.25 * five + 2 * hour) / (five + hour) : 1.25;
};

const labelDir = join(homedir(), '.cache', 'orchestrate', 'labels');
function projectFor(sessionId: string, cwd: string | undefined): string {
  try {
    return (JSON.parse(readFileSync(join(labelDir, `${sessionId}.json`), 'utf8')) as { project: string }).project;
  } catch {}
  if (!cwd) return 'unknown';
  const m =
    cwd.match(/\/tmp\/orchestrate\/([^/]+)/) ??
    cwd.match(/\/\.rifts\/([^/]+)/) ??
    cwd.match(/\/Developer\/(?:personal|work)\/([^/.][^/]*)/) ??
    cwd.match(/\/workspaces\/([^/]+)/);
  return m?.[1] ?? basename(cwd);
}
const sessionOf = (file: string): string =>
  file.includes('/subagents/') ? basename(dirname(dirname(file))) : basename(file, '.jsonl');
/**
 * An agent's kind: its type, without the status mod's `status:` prefix. An
 * orchestrate-worker that ran a protocol role before the role agents existed
 * counts as that role's agent (`orchestrate-<role>`), so each role tunes on its
 * history from the first day.
 */
export function workerKind(type: string | undefined, prompt: string): string {
  const kind = type?.replace(/^status:/, '') || 'agent';
  if (kind !== 'orchestrate-worker' || !prompt.includes('protocol.md')) return kind;
  const role = /\b(planner|implementor|reviewer|verifier)\b/i.exec(prompt)?.[1];
  return role ? `orchestrate-${role.toLowerCase()}` : kind;
}

// The first user message of a transcript: an agent's task.
const firstPrompt = (file: string): string => {
  const fd = openSync(file, 'r');
  const head = Buffer.alloc(Math.min(statSync(file).size, 200e3));
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  for (const line of head.toString('utf8').split('\n')) {
    try {
      const d = JSON.parse(line);
      if (d.type !== 'user') continue;
      const c = d.message?.content;
      return typeof c === 'string' ? c : (c ?? []).map((x: { text?: string }) => x?.text ?? '').join(' ');
    } catch {}
  }
  return '';
};

function kindOf(file: string): string {
  if (!file.includes('/subagents/')) return 'root';
  try {
    const type = (JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as { agentType?: string }).agentType;
    return workerKind(type, type?.endsWith('orchestrate-worker') ? firstPrompt(file) : '');
  } catch {
    return 'agent';
  }
}

const clip = (s: unknown, max = 70): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return clip(input.description || input.command);
    case 'Read':
    case 'Edit':
    case 'Write':
      return clip(input.file_path);
    case 'Grep':
    case 'Glob':
      return clip(input.pattern);
    case 'Agent':
    case 'Task':
      return clip(`${input.subagent_type ?? ''} ${input.description ?? ''}`);
    case 'Skill':
      return clip(input.skill);
    case 'WebFetch':
      return clip(input.url);
    default:
      return clip(JSON.stringify(input), 50);
  }
}
// The file a Read, or a Bash cat/sed/head/tail, reads.
function fileRead(name: string, input: Record<string, unknown>): string | undefined {
  if (name === 'Read') return typeof input.file_path === 'string' ? input.file_path : undefined;
  if (name !== 'Bash') return undefined;
  return String(input.command ?? '').match(/\b(?:cat|sed -n '[^']*'|head(?: -\S+)*|tail(?: -\S+)*)\s+(\S+)/)?.[1];
}
const toolCat = (name: string, input: Record<string, unknown>): string =>
  name === 'Skill' ? `skill:${input.skill}` : name.startsWith('mcp__') ? `mcp:${name.split('__')[1]}` : `tool:${name}`;

function textLength(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let len = 0;
  for (const c of content as Record<string, unknown>[]) {
    if (c.type === 'text') len += String(c.text ?? '').length;
    else if (c.type === 'image') len += 6000; // ~1.5k tokens
    else if (c.type === 'tool_result') len += textLength(c.content);
    else len += JSON.stringify(c).length;
  }
  return len;
}

/**
 * Replays a transcript's context growth as if it compacted at `window`: each
 * call reads the context and writes what it added; a compaction reads the
 * context once, writes a summary and rebuilds from the base. `calls` holds each
 * call's growth and write rate, with the transcript's own compactions undone.
 * Returns [W, compactions, calls after a compaction].
 */
export function simulate(start: number, calls: [number, number][], window: number): [number, number, number] {
  const restart = start + SUMMARY;
  let ctx = start;
  let w = 0;
  let compactions = 0;
  let after = 0;
  for (const [growth, rate] of calls) {
    if (ctx + growth > window && ctx > restart) {
      w += 0.1 * ctx + 5 * SUMMARY_OUT + rate * restart;
      ctx = restart;
      compactions++;
    }
    ctx += growth;
    w += 0.1 * ctx + rate * growth;
    if (compactions > 0) after++;
  }
  return [Math.round(w), compactions, after];
}

/** One transcript's burn. */
export function burnOf(file: string, size: number): FileBurn {
  const text = readText(file);
  const b: FileBurn = {
    size,
    project: 'unknown',
    kind: kindOf(file),
    calls: 0,
    w: { output: 0, write: 0, rewrite: 0, read: 0, input: 0 },
    cats: {},
    base: [],
    peak: 0,
    ctxSum: 0,
    misses: 0,
    compactions: 0,
    compactMs: 0,
    reread: 0,
    windows: {},
    tokens: { output: 0, thinking: 0, rewrite: 0, rewrite5m: 0 },
    big: 0,
    top: [],
  };
  let cwd: string | undefined;
  const tools = new Map<string, { cat: string; label: string; file?: string }>();
  // Files read before the last compaction, to count what is read again after it.
  const readBefore = new Set<string>();
  const readSince = new Set<string>();
  // Each call's context growth and write rate, the transcript's compactions undone.
  const growths: [number, number][] = [];
  // The context as it stands: its items, with tokens; scaled to the measured size at each call.
  let live: Item[] = [];
  // Since the last call: replies with exact token counts, and items with only a char length.
  let pending: { cat: string; label: string; chars: number; tokens?: number }[] = [];
  let ctx = 0; // the previous call's context
  let lastId: string | undefined;
  let lastOut = 0;
  let lastThink = 0;
  // A message's output counts once, when the next message (or a compaction, or the end) closes it.
  const flush = () => {
    b.w.output += 5 * lastOut;
    b.tokens.output += lastOut;
    b.tokens.thinking += lastThink;
    lastOut = 0;
    lastThink = 0;
  };
  let compactions = 0;
  let compacted = false;
  const all: Item[] = [];
  const add = (cat: string, label: string, chars: number) => chars > 0 && pending.push({ cat, label, chars });

  const settle = (u: Usage) => {
    const now = n(u, 'input_tokens') + n(u, 'cache_creation_input_tokens') + n(u, 'cache_read_input_tokens');
    if (now === 0) return; // a synthetic message (an API error, an interrupt): no call was made
    const create = n(u, 'cache_creation_input_tokens');
    const read = n(u, 'cache_read_input_tokens');
    const rate = writeRate(u);
    b.calls++;
    b.ctxSum += now;
    b.peak = Math.max(b.peak, now);
    b.w.input += n(u, 'input_tokens');
    b.w.read += 0.1 * read;
    if (live.length === 0 || compacted) {
      // Undone, a compaction adds nothing: the call after it grows the context by 0.
      if (live.length > 0) growths.push([0, rate]);
      // A segment starts. The session's first call is its base (system prompt, tools, first
      // prompt); after a compaction, the part beyond that base is the summary and kept turns.
      b.base.push(now);
      const fixed = compacted ? Math.min(b.base[0], now) : now;
      live = [{ cat: 'base', label: 'system+tools+prompt', tokens: fixed, w: 0 }];
      if (now > fixed) live.push({ cat: 'compaction', label: 'summary', tokens: now - fixed, w: 0 });
      for (const i of live) {
        i.w = (rate * create + 0.1 * read) * (i.tokens / now);
        all.push(i);
      }
      pending = [];
      compacted = false;
      b.w.write += rate * create;
      ctx = now;
      return;
    }
    const growth = Math.max(0, now - ctx);
    growths.push([growth, rate]);
    // A cache miss: the call wrote more than it added, so it rewrote what was cached.
    const rewrite = Math.max(0, create - growth);
    if (rewrite > 2000) {
      b.misses++;
      b.tokens.rewrite += rewrite;
      const s = typeof u.cache_creation === 'object' ? u.cache_creation : undefined;
      if ((s?.ephemeral_5m_input_tokens ?? 0) > (s?.ephemeral_1h_input_tokens ?? 0)) b.tokens.rewrite5m += rewrite;
    }
    b.w.write += rate * (create - rewrite);
    b.w.rewrite += rate * rewrite;
    // The call read (or, after a miss, re-wrote) the context the previous call left.
    const held = live.reduce((s, i) => s + i.tokens, 0);
    if (held > 0) {
      const spread = 0.1 * read + rate * rewrite;
      for (const i of live) i.w += spread * (i.tokens / held);
    }
    if (growth > 0) {
      // A reply takes its exact output tokens. The rest of the growth splits across items by
      // length, at most ~1 token per 2 chars; what they cannot hold (reminders, tool schemas
      // surfaced mid-session) stays unattributed.
      let left = growth;
      const fresh: Item[] = [];
      for (const p of pending)
        if (p.tokens !== undefined) {
          const t = Math.min(p.tokens, left);
          left -= t;
          fresh.push({ cat: p.cat, label: p.label, tokens: t, w: 0 });
        }
      const chars = pending.reduce((s, p) => s + (p.tokens === undefined ? p.chars : 0), 0);
      const room = left;
      for (const p of pending)
        if (p.tokens === undefined) {
          const t = Math.min(p.chars / 2, (room * p.chars) / Math.max(chars, 1));
          left -= t;
          fresh.push({ cat: p.cat, label: p.label, tokens: t, w: 0, big: p.cat.startsWith('tool:') && p.chars > BIG });
        }
      if (left > 1) fresh.push({ cat: 'other', label: 'unattributed', tokens: left, w: 0 });
      for (const f of fresh) {
        f.w += rate * (create - rewrite) * (f.tokens / growth);
        live.push(f);
        all.push(f);
      }
    }
    // Keep the items' sizes summing to what the call measured (thinking cleared, a reminder dropped).
    const size = live.reduce((s, i) => s + i.tokens, 0);
    if (size > 0) for (const i of live) i.tokens *= now / size;
    pending = [];
    ctx = now;
  };

  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    if (!/"type":"(assistant|user|attachment)"|"compact_boundary"/.test(line)) continue;
    let d: Record<string, any>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (cwd === undefined && typeof d.cwd === 'string') cwd = d.cwd;
    if (d.type === 'system' && d.subtype === 'compact_boundary') {
      // The summary call reads the whole context once; it leaves no assistant line.
      const pre = Number(d.compactMetadata?.preTokens ?? 0);
      b.compactMs += Number(d.compactMetadata?.durationMs ?? 0);
      for (const f of readSince) readBefore.add(f);
      readSince.clear();
      b.w.read += 0.1 * pre;
      b.cats.compaction = (b.cats.compaction ?? 0) + 0.1 * pre;
      compactions++;
      flush();
      lastId = undefined;
      pending = [];
      compacted = true;
      continue;
    }
    if (d.type === 'attachment') {
      if (!SENT.has(d.attachment?.type)) continue;
      add(`attach:${d.attachment?.type}`, String(d.attachment?.type), JSON.stringify(d.attachment ?? '').length);
      continue;
    }
    if (d.type === 'user') {
      const c = d.message?.content;
      if (typeof c === 'string') add(d.isMeta ? 'meta' : d.isCompactSummary ? 'compaction' : 'user', 'prompt', c.length);
      else if (Array.isArray(c))
        for (const part of c) {
          if (part.type === 'tool_result') {
            const t = tools.get(part.tool_use_id) ?? { cat: 'tool:?', label: '' };
            const chars = textLength(part.content);
            add(t.cat, t.label, chars);
            if (t.file) {
              if (readBefore.has(t.file)) b.reread += chars / 3;
              readSince.add(t.file);
            }
          } else add(d.isMeta ? 'meta' : 'user', 'prompt', textLength([part]));
        }
      continue;
    }
    if (d.type !== 'assistant') continue;
    const m = d.message ?? {};
    // A message spans several lines: each carries the context the call read, and the last
    // its final output. The previous reply joins the context the next call reads.
    if (m.id !== lastId && m.usage) {
      if (lastOut > 0) pending.push({ cat: 'assistant', label: 'reply', chars: 0, tokens: lastOut });
      flush();
      settle(m.usage);
      lastId = m.id;
    }
    if (m.usage) {
      lastOut = n(m.usage, 'output_tokens');
      lastThink = Number(m.usage.output_tokens_details?.thinking_tokens ?? 0);
    }
    for (const part of m.content ?? [])
      if (part.type === 'tool_use') {
        const input = (part.input ?? {}) as Record<string, unknown>;
        tools.set(part.id, { cat: toolCat(part.name, input), label: toolLabel(part.name, input), file: fileRead(part.name, input) });
      }
  }
  flush();
  b.compactions = compactions;
  b.reread = Math.round(b.reread);
  if (b.base.length > 0) for (const window of WINDOWS) b.windows[window] = simulate(b.base[0], growths, window);
  b.big = Math.round(all.reduce((s, i) => s + (i.big ? i.w : 0), 0));
  b.project = projectFor(sessionOf(file), cwd);
  for (const i of all) b.cats[i.cat] = (b.cats[i.cat] ?? 0) + i.w;
  b.top = all
    .filter((i) => i.cat !== 'base' && i.cat !== 'compaction' && i.cat !== 'assistant')
    .sort((a, c) => c.w - a.w)
    .slice(0, 10)
    .map((i) => ({ ...i, tokens: Math.round(i.tokens), w: Math.round(i.w) }));
  for (const k of Object.keys(b.cats)) b.cats[k] = Math.round(b.cats[k]);
  for (const k of Object.keys(b.w) as (keyof FileBurn['w'])[]) b.w[k] = Math.round(b.w[k]);
  return b;
}

function readText(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
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

export function hostBurn(now = Date.now(), dir = root, cacheFile = cachePath): HostBurn {
  let cache: Record<string, FileBurn> = {};
  try {
    const kept = JSON.parse(readFileSync(cacheFile, 'utf8')) as { version?: number; files: Record<string, FileBurn> };
    if (kept.version === VERSION) cache = kept.files;
  } catch {}
  // A session copied under two project folders (a moved repo) counts once: the larger copy.
  const byKey = new Map<string, { file: string; size: number }>();
  for (const file of transcripts(dir, now - days * DAY)) {
    const key = file.slice(dir.length).split('/').slice(2).join('/');
    const size = statSync(file).size;
    if ((byKey.get(key)?.size ?? -1) < size) byKey.set(key, { file, size });
  }
  const files = [...byKey.values()].map((f) => f.file);
  const next: Record<string, FileBurn> = {};
  let complete = true;
  for (const file of files) {
    const size = statSync(file).size;
    const hit = cache[file];
    if (hit && hit.size === size) next[file] = hit;
    else if (Date.now() < deadline) next[file] = burnOf(file, size);
    else complete = false;
  }
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ version: VERSION, files: next }));
  return { host: hostname(), days, files: files.length, complete, burns: Object.values(next).filter((b) => b.calls > 0) };
}

// ── Report ──

const mw = (w: number): string => `${(w / 1e6).toFixed(1)} MW`;
const share = (part: number, whole: number): string => `${whole > 0 ? ((100 * part) / whole).toFixed(1) : '0.0'}%`;
const kt = (t: number): string => (t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : `${Math.round(t / 1e3)}k`);
const total = (b: FileBurn): number => b.w.output + b.w.write + b.w.rewrite + b.w.read + b.w.input;
const median = (xs: number[]): number => [...xs].sort((a, c) => a - c)[Math.floor(xs.length / 2)] ?? 0;

// ── Tuning ──

// A kind with fewer transcripts than this keeps the default window.
const MIN_AGENTS = 20;
// Windows within this share of the cheapest count as tied; the largest wins, as it compacts least.
const TIE = 0.01;
export const ceilingOf = (env = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW): number => Number(env) || 200e3;
// Windows the owner sets, which the tuner reports but never changes. The main
// session's compaction loses the run's state and holds the owner for about a
// minute, which the replay's token cost does not count (owner, 2026-10-24: at
// 400k the week's replay cost 4-5% more tokens across the host and compacted
// the main session 70% less).
export const PINNED: Record<string, number> = { root: 400e3 };

export type Tuned = {
  kind: string;
  agents: number;
  window: number; // the best window, no larger than the ceiling
  best: number; // the best window of all WINDOWS
  saving: number; // the share of the replayed W the window saves against the ceiling
  compactions: [number, number]; // at the ceiling, at the window
  reread: number; // tokens read again per compaction
  compactMs: number; // mean wall time of a compaction
};

/**
 * The compaction window each kind of agent costs least at. Each compaction
 * also costs what the agent reads again after it: written once, then read by
 * every later call, at the kind's measured re-read per compaction.
 */
export function tune(burns: FileBurn[], ceiling = ceilingOf()): Tuned[] {
  const sum = (bs: FileBurn[], f: (b: FileBurn) => number) => bs.reduce((s, b) => s + f(b), 0);
  const perCompaction = (bs: FileBurn[], f: (b: FileBurn) => number): number | undefined => {
    const c = sum(bs, (b) => b.compactions);
    return c > 0 ? sum(bs, f) / c : undefined;
  };
  const fleet = perCompaction(burns, (b) => b.reread) ?? 20e3;
  const kinds = new Map<string, FileBurn[]>();
  for (const b of burns) if (Object.keys(b.windows).length > 0) kinds.set(b.kind, [...(kinds.get(b.kind) ?? []), b]);
  const out: Tuned[] = [];
  for (const [kind, bs] of kinds) {
    if (bs.length < MIN_AGENTS && !PINNED[kind]) continue;
    const reread = perCompaction(bs, (b) => b.reread) ?? fleet;
    const at = (window: number) => sum(bs, (b) => b.windows[window]?.[0] ?? 0);
    const compactionsAt = (window: number) => sum(bs, (b) => b.windows[window]?.[1] ?? 0);
    const cost = (window: number) => at(window) + reread * (1.25 * compactionsAt(window) + 0.1 * sum(bs, (b) => b.windows[window]?.[2] ?? 0));
    const least = Math.min(...WINDOWS.map(cost));
    const best = Math.max(...WINDOWS.filter((w) => cost(w) <= least * (1 + TIE)));
    const allowed = WINDOWS.filter((w) => w <= ceiling);
    const now = Math.max(...allowed);
    const window = PINNED[kind] ?? Math.max(...allowed.filter((w) => cost(w) <= Math.min(...allowed.map(cost)) * (1 + TIE)));
    out.push({
      kind,
      agents: bs.length,
      window,
      best,
      saving: 1 - cost(window) / cost(now),
      compactions: [compactionsAt(now), compactionsAt(window)],
      reread: Math.round(reread),
      compactMs: Math.round(perCompaction(bs, (b) => b.compactMs) ?? 0),
    });
  }
  return out.sort((a, c) => c.agents - a.agents);
}

/** The burn of every host, as Markdown. */
export function report(hosts: HostBurn[], ceiling = ceilingOf()): string {
  const all = hosts.flatMap((h) => h.burns);
  const W = all.reduce((s, b) => s + total(b), 0);
  const sum = (f: (b: FileBurn) => number, of = all) => of.reduce((s, b) => s + f(b), 0);
  const out: string[] = [`## Burn, last ${hosts[0]?.days ?? 7} days: ${mw(W)}`, ''];
  out.push('| Host | W | Calls | Mean context | Read | Write | Rewrite | Output |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const h of hosts) {
    const hw = sum(total, h.burns);
    const calls = sum((b) => b.calls, h.burns);
    const part = (k: keyof FileBurn['w']) => share(sum((b) => b.w[k], h.burns), hw);
    out.push(
      `| ${h.host}${h.complete ? '' : ' (partial)'} | ${mw(hw)} | ${calls} | ${kt(sum((b) => b.ctxSum, h.burns) / Math.max(calls, 1))} | ${part('read')} | ${part('write')} | ${part('rewrite')} | ${part('output')} |`,
    );
  }
  const cats = new Map<string, number>();
  for (const b of all) for (const [k, v] of Object.entries(b.cats)) cats.set(k, (cats.get(k) ?? 0) + v);
  out.push('', '### What the context holds', '', '| Held | W | Share |', '| --- | --- | --- |');
  for (const [k, v] of [...cats].sort((a, c) => c[1] - a[1]).slice(0, 12)) out.push(`| ${k} | ${mw(v)} | ${share(v, W)} |`);
  const kinds = new Map<string, FileBurn[]>();
  for (const b of all) kinds.set(b.kind, [...(kinds.get(b.kind) ?? []), b]);
  out.push('', '### Agent kinds', '', '| Kind | Agents | W | Start context | Mean context | Calls each |', '| --- | --- | --- | --- | --- | --- |');
  for (const [k, bs] of [...kinds].sort((a, c) => sum(total, c[1]) - sum(total, a[1])).slice(0, 10)) {
    const calls = sum((b) => b.calls, bs);
    out.push(
      `| ${k} | ${bs.length} | ${mw(sum(total, bs))} | ${kt(median(bs.map((b) => b.base[0] ?? 0)))} | ${kt(sum((b) => b.ctxSum, bs) / Math.max(calls, 1))} | ${Math.round(calls / bs.length)} |`,
    );
  }
  const t = (k: keyof FileBurn['tokens']) => sum((b) => b.tokens[k]);
  out.push(
    '',
    '### Levers',
    '',
    `- Context, not output, is the cost: reading, writing and re-writing it is ${share(W - sum((b) => b.w.output), W)} of W.`,
    `- Thinking is ${share(t('thinking'), t('output'))} of output tokens, and replies held in context cost ${share(cats.get('assistant') ?? 0, W)} of W.`,
    `- Tool results over ${BIG / 1e3}k chars cost ${share(sum((b) => b.big), W)} of W; bashOutputMaxChars moves them to a file.`,
    `- Cache misses re-wrote ${kt(t('rewrite'))} tokens (${share(sum((b) => b.w.rewrite), W)} of W); ${share(t('rewrite5m'), t('rewrite'))} of them in 5-minute-TTL calls.`,
    `- ${sum((b) => b.compactions)} compactions; the base prompt each segment starts from costs ${share(cats.get('base') ?? 0, W)} of W.`,
  );
  out.push('', `### Compaction window (now ${kt(ceiling)})`, '', '| Kind | Agents | Window | Saves | Compactions | Re-read each | Time each |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const k of tune(all, ceiling))
    out.push(
      `| ${k.kind} | ${k.agents} | ${kt(k.window)}${k.best > ceiling ? ` (best ${kt(k.best)})` : ''} | ${share(k.saving, 1)} | ${k.compactions[0]} → ${k.compactions[1]} | ${kt(k.reread)} | ${Math.round(k.compactMs / 1e3)} s |`,
    );
  const items = all.flatMap((b) => b.top.map((i) => ({ ...i, project: b.project }))).sort((a, c) => c.w - a.w);
  out.push('', '### Costliest items', '', '| W | Tokens | Held | Project | Item |', '| --- | --- | --- | --- | --- |');
  for (const i of items.slice(0, 15)) out.push(`| ${mw(i.w)} | ${kt(i.tokens)} | ${i.cat} | ${i.project} | ${i.label.replace(/\|/g, '/')} |`);
  return out.join('\n');
}

if (import.meta.main) {
  if (existsSync(root)) console.log(JSON.stringify(hostBurn()));
  else console.log(JSON.stringify({ host: hostname(), days, files: 0, complete: true, burns: [] }));
}
