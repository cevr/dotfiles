#!/usr/bin/env bun
// The load on the shared Claude account pool, before a wave: the Claude
// subagents with a turn in the last 10 minutes on this host and on each host
// in ORCHESTRATE_HOSTS, and the weighted spend of the last 5 hours. Exits 1
// when the active agents across all hosts reach the cap, 2 when a host is
// unreachable.
//
// The cap follows the weekly quota, from `teamclaude status --json` on this
// host. Each account's weekly quota expires at its own reset, so the pace is
// the slowest burn that spends 99% of every account before it resets. The cap
// is the sessions that pace pays for, at the current burn per active session,
// less the root sessions, which no guard stops. With no burn to measure, the
// cap is 8.
//
// Usage: bun budget.ts [--cap <n>] [--projects <dir>] [--rotate]
//   --cap fixes the cap instead.
//   --rotate sets teamclaude's account priorities to the reset order, so the
//   account whose quota expires first serves first. The status mod runs it
//   every minute.
//   ORCHESTRATE_HOSTS: space- or comma-separated SSH aliases. Each host runs
//   this file read-only from stdin (`bun run - --host-json`), so it needs only
//   bun and its own ~/.claude/projects. Codex Counsel runs do not count.
//   Weighted tokens (W): input + 1.25 × cache-create(5m) + 2 × cache-create(1h)
//   + 0.1 × cache-read + 5 × output, the Anthropic price ratios.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

const ACTIVE_MS = 10 * 60e3;
const WINDOW_MS = 5 * 60 * 60e3;

type HostLoad = { host: string; agents: number; roots: number; weighted: number; error?: string };

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const projects = option('--projects') ?? join(homedir(), '.claude', 'projects');
const fixedCap = option('--cap');
const UNMEASURED_CAP = 8;

function transcripts(dir: string, sinceMs: number, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) transcripts(p, sinceMs, out);
    else if (e.name.endsWith('.jsonl') && statSync(p).mtimeMs >= sinceMs) out.push(p);
  }
  return out;
}

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

function localLoad(): HostLoad {
  const now = Date.now();
  let agents = 0;
  let roots = 0;
  let weighted = 0;
  for (const file of transcripts(projects, now - WINDOW_MS)) {
    // One message spans several lines; the last line of a message id carries its final usage.
    const turns = new Map<string, { t: number; u: Usage }>();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"assistant"')) continue;
      let d: { type?: string; timestamp?: string; message?: { id?: string; usage?: Usage } };
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const t = Date.parse(d.timestamp ?? '');
      if (d.type !== 'assistant' || !d.message?.usage || !(t >= now - WINDOW_MS)) continue;
      turns.set(d.message.id ?? `line-${turns.size}`, { t, u: d.message.usage });
    }
    let lastTurn = 0;
    for (const { t, u } of turns.values()) {
      weighted += weightOf(u);
      lastTurn = Math.max(lastTurn, t);
    }
    if (lastTurn < now - ACTIVE_MS) continue;
    if (file.includes('/subagents/')) agents++;
    else roots++;
  }
  return { host: hostname(), agents, roots, weighted: Math.round(weighted) };
}

if (args.includes('--host-json')) {
  console.log(JSON.stringify(localLoad()));
  process.exit(0);
}

const source = readFileSync(import.meta.path, 'utf8');
const remotes = (process.env.ORCHESTRATE_HOSTS ?? '').split(/[\s,]+/).filter(Boolean);

async function remoteLoad(alias: string): Promise<HostLoad> {
  const proc = Bun.spawn(
    ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, 'PATH="$HOME/.bun/bin:$PATH" bun run - --host-json'],
    { stdin: new Blob([source]), stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  try {
    if (code !== 0) throw new Error(err.trim().split('\n').pop() || `ssh exit ${code}`);
    return { ...(JSON.parse(out.trim().split('\n').pop() ?? '') as HostLoad), host: alias };
  } catch (e) {
    return { host: alias, agents: 0, roots: 0, weighted: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

const HOUR = 3600e3;
const TARGET = 0.99;

// Rates are in weeks of one account per hour; teamclaude forecasts each one.
type Week = { name: string; priority: number; used: number; resetAt: number; perHour: number };

function weeks(): Week[] | undefined {
  try {
    const run = Bun.spawnSync(['teamclaude', 'status', '--json'], { timeout: 5e3 });
    if (run.exitCode !== 0) return undefined;
    const accounts: Record<string, any>[] = JSON.parse(run.stdout.toString()).accounts ?? [];
    return accounts
      .filter((a) => a.disabled !== true && typeof a.quota?.unified7dReset === 'number')
      .map((a) => ({
        name: String(a.name),
        priority: Number(a.priority ?? 0),
        used: Math.min(1, Number(a.quota.unified7d ?? 0)),
        resetAt: a.quota.unified7dReset,
        perHour: Number(a.quota.forecast?.unified7d?.ratePerHour ?? 0),
      }));
  } catch {
    return undefined;
  }
}

function pace(list: Week[], now: number) {
  const due = list.filter((a) => a.resetAt > now).sort((a, b) => a.resetAt - b.resetAt);
  const burn = list.reduce((n, a) => n + a.perHour, 0);
  // Floor: the quota expiring by each reset must be spent by then.
  let expiring = 0;
  let floor = 0;
  // Ceiling: the quota left, plus each earlier reset's refill, must last to each reset.
  let fuel = due.reduce((n, a) => n + (1 - a.used), 0);
  let ceiling = Infinity;
  // Unused: one account serves at a time, soonest reset first, at the current burn.
  let at = now;
  let unused = 0;
  for (const a of due) {
    const hours = (a.resetAt - now) / HOUR;
    expiring += Math.max(0, TARGET - a.used);
    floor = Math.max(floor, expiring / hours);
    ceiling = Math.min(ceiling, fuel / hours);
    fuel += a.used;
    const spent = burn > 0 ? Math.min(1 - a.used, (burn * Math.max(0, a.resetAt - at)) / HOUR) : 0;
    if (burn > 0) at += (spent / burn) * HOUR;
    unused += Math.max(0, TARGET - a.used - spent);
  }
  return { due, burn, floor, ceiling, unused };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const week = weeks();
const paced = week?.length ? pace(week, Date.now()) : undefined;

if (paced && args.includes('--rotate')) {
  // Spent accounts go last; an account's reset moves it back in the order.
  const order = [...paced.due.filter((a) => a.used < 1), ...paced.due.filter((a) => a.used >= 1)];
  order.forEach((a, i) => {
    if (a.priority !== i) Bun.spawnSync(['teamclaude', 'priority', a.name, String(i)], { stdout: 'ignore' });
  });
}

const loads = [localLoad(), ...(await Promise.all(remotes.map(remoteLoad)))];
const mw = (n: number): string => `${(n / 1e6).toFixed(0)} MW`;
for (const l of loads) {
  console.log(
    l.error
      ? `${l.host}: unreachable (${l.error})`
      : `${l.host}: ${l.agents} agents, ${l.roots} roots active in 10 min; ${mw(l.weighted)} in 5 h`,
  );
}
const agents = loads.reduce((n, l) => n + l.agents, 0);
const roots = loads.reduce((n, l) => n + l.roots, 0);
const perSession = paced && paced.burn > 0 && agents + roots > 0 ? paced.burn / (agents + roots) : undefined;
const cap =
  fixedCap !== undefined
    ? Number(fixedCap)
    : paced && paced.floor <= 0
      ? 0
      : paced && perSession
        ? Math.max(0, Math.floor(paced.floor / perSession) - roots)
        : UNMEASURED_CAP;
if (paced) {
  const verdict =
    paced.burn > paced.ceiling
      ? 'over pace: a weekly limit comes before the next reset'
      : paced.burn > paced.floor
        ? 'ahead of pace: quota runs out early, then waits for resets'
        : `under pace: ${pct(paced.unused)} of an account's week expires unused`;
  const ceiling = Number.isFinite(paced.ceiling) ? `, a weekly limit above ${pct(paced.ceiling)}/h` : '';
  const each = perSession ? `, ${pct(perSession)}/h per session` : '';
  console.log(`weekly: burn ${pct(paced.burn)}/h${each}; pace ${pct(paced.floor)}/h${ceiling}; ${verdict}`);
}
const weighted = loads.reduce((n, l) => n + l.weighted, 0);
const unreachable = loads.filter((l) => l.error).length;
console.log(
  `budget: ${agents}/${cap} agents, ${mw(weighted)} in 5 h${unreachable ? `, ${unreachable} host(s) not counted` : ''}`,
);
// An unreachable host's load is unknown, so the count proves nothing below the cap.
process.exit(agents >= cap ? 1 : unreachable ? 2 : 0);
