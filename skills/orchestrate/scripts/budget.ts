#!/usr/bin/env bun
// The Claude account pool's budget, before a wave and before each agent.
//
// It reads each account's weekly and 5-hour use from `teamclaude status --json`
// and each host's load from its transcripts (budget/host.ts, run over SSH on
// each host in ORCHESTRATE_HOSTS). From those it sets the pool's pace in
// weighted tokens per hour (budget/pace.ts): spend 99% of every account before
// its weekly reset, more by day than by night, under the weekly and 5-hour
// ceilings. Each agent kind's cost comes from its own transcripts over 7 days.
//
// Usage: bun budget.ts [--rotate] [--cap <n>] [--costs] [--burn [--days <n>]] [--tune]
//        bun budget.ts --admit [--cap <n>] --session <id> --cwd <dir> --type <subagent_type> --description <text>
//   --rotate  sets teamclaude's account priorities to the weekly reset order,
//             so the account whose quota expires first serves first. The
//             status mod runs it every minute.
//   --cap     fixes the agent cap instead of deriving it from the pace; with
//             --admit, no agent starts past it.
//   --costs   prints each project and agent kind's cost per active hour.
//   --burn    prints where every host's tokens went (budget/burn.ts): what
//             the context held, each agent kind's start and mean context,
//             and the levers that would cut the most.
//   --tune    writes the compaction window each agent kind on this host costs
//             least at to ~/.cache/orchestrate/compact.json, for the status
//             mod; exits 3 when the transcripts were only partly read in time.
//   --admit   decides one new agent (the guard-agent hook): exit 0 to start
//             it, 1 to hold it, with the reason on stdout.
// Exits 1 when the active agents reach the cap, 2 when a host is unreachable.
// Settings: ~/.config/orchestrate/budget.json overrides budget/pace.ts DEFAULTS. On
// both hosts it links to orchestrate/budget.json in dotfiles.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ceilingOf, hostBurn, report, tune, type HostBurn } from './budget/burn.ts';
import { hostLoad, kindFor, projectFor, type HostLoad } from './budget/host.ts';
import {
  admit,
  calibrate,
  DEFAULTS,
  estimate,
  isNight,
  limitsOf,
  reservedFree,
  target,
  type Account,
  type Config,
  type Sample,
} from './budget/pace.ts';

const MINUTE = 60e3;
const UNMEASURED_CAP = 8;
const CACHE = join(homedir(), '.cache', 'orchestrate');

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
};
const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

const config: Config = { ...DEFAULTS, ...readJson(join(homedir(), '.config', 'orchestrate', 'budget.json'), {}) };
const now = Date.now();

// ── Accounts ──

type Week = Account & { name: string; priority: number; perHour: number };

function accounts(): Week[] | undefined {
  try {
    const run = Bun.spawnSync(['teamclaude', 'status', '--json'], { timeout: 5e3 });
    if (run.exitCode !== 0) return undefined;
    const list: Record<string, any>[] = JSON.parse(run.stdout.toString()).accounts ?? [];
    return list
      .filter((a) => a.disabled !== true && typeof a.quota?.unified7dReset === 'number')
      .map((a) => ({
        name: String(a.name),
        priority: Number(a.priority ?? 0),
        used7d: Math.min(1, Number(a.quota.unified7d ?? 0)),
        reset7d: a.quota.unified7dReset,
        used5h: Math.min(1, Number(a.quota.unified5h ?? 0)),
        reset5h: typeof a.quota.unified5hReset === 'number' ? a.quota.unified5hReset : undefined,
        perHour: Number(a.quota.forecast?.unified7d?.ratePerHour ?? 0),
      }));
  } catch {
    return undefined;
  }
}

// ── Hosts ──

type Load = HostLoad & { error?: string };
const HOST_SOURCE = join(import.meta.dir, 'budget', 'host.ts');
const remotes = (process.env.ORCHESTRATE_HOSTS ?? '').split(/[\s,]+/).filter(Boolean);

// Run one of budget/'s scripts on a remote host, reading it from stdin, and parse its last line.
async function remote<T>(alias: string, source: string, flags: string): Promise<T> {
  const proc = Bun.spawn(
    ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', alias, `PATH="$HOME/.bun/bin:$PATH" bun run - ${flags}`],
    { stdin: Bun.file(source), stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.trim().split('\n').pop() || `ssh exit ${code}`);
  return JSON.parse(out.trim().split('\n').pop() ?? '') as T;
}
const failure = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// A remote host's load is kept a minute: the guard asks on every Agent call.
async function remoteLoad(alias: string): Promise<Load> {
  const cached = join(CACHE, `remote-${alias.replace(/[^\w.-]/g, '_')}.json`);
  const hit = readJson<{ at: number; load: Load } | undefined>(cached, undefined);
  if (hit && now - hit.at < MINUTE) return hit.load;
  try {
    const load: Load = { ...(await remote<HostLoad>(alias, HOST_SOURCE, '--deadline-ms 3000')), host: alias };
    writeJson(cached, { at: now, load });
    return load;
  } catch (e) {
    return { host: alias, sessions: [], w1h: 0, kinds: [], complete: false, error: failure(e) };
  }
}

if (args.includes('--burn')) {
  const flags = `--days ${Number(option('--days') ?? 7)} --deadline-ms 240000`;
  const hosts: HostBurn[] = [hostBurn(now)];
  for (const r of await Promise.allSettled(remotes.map((a) => remote<HostBurn>(a, join(import.meta.dir, 'budget', 'burn.ts'), flags).then((h) => ({ ...h, host: a })))))
    if (r.status === 'fulfilled') hosts.push(r.value);
    else console.log(`unreachable: ${failure(r.reason)}`);
  console.log(report(hosts));
  process.exit(0);
}

if (args.includes('--tune')) {
  const host = hostBurn(now);
  if (!host.complete) {
    console.log(`partial: ${host.burns.length} of ${host.files} transcripts read; run again`);
    process.exit(3);
  }
  const ceiling = ceilingOf();
  const kinds = tune(host.burns, ceiling);
  writeJson(join(CACHE, 'compact.json'), { at: now, ceiling, windows: Object.fromEntries(kinds.map((k) => [k.kind, k.window])), kinds });
  for (const k of kinds) console.log(`${k.kind}: ${k.window / 1e3}k (best ${k.best / 1e3}k), saves ${(100 * k.saving).toFixed(1)}%`);
  process.exit(0);
}

const week = accounts();
const loads: Load[] = [hostLoad(now), ...(await Promise.all(remotes.map(remoteLoad)))];
const sessions = loads.flatMap((l) => l.sessions);
const kinds = loads.flatMap((l) => l.kinds);
const w1h = loads.reduce((n, l) => n + l.w1h, 0);

// ── Calibration ──

const samplesPath = join(CACHE, 'samples.json');
const samples = readJson<Sample[]>(samplesPath, []).filter((s) => s.at > now - 2 * 60 * MINUTE);
if (week?.length) {
  samples.push({ at: now, used7d: week.map((a) => a.used7d), used5h: week.map((a) => a.used5h), w1h });
  writeJson(samplesPath, samples);
}
const k = calibrate(samples);
// Until an hour of samples exists, teamclaude's own weekly forecast stands in.
const forecast = week?.reduce((n, a) => n + a.perHour, 0) ?? 0;
if (!k.k7 && forecast > 0 && w1h > 0) k.k7 = forecast / w1h;

const pace = week?.length ? target(week, now, config, k) : undefined;
const targetWph = pace?.targetWph;
const night = isNight(now, config);

if (week?.length && args.includes('--rotate')) {
  // Accounts with weekly quota serve in reset order; spent accounts go last.
  const due = [...week].sort((a, b) => (a.reset7d ?? 0) - (b.reset7d ?? 0));
  const order = [...due.filter((a) => a.used7d < 1), ...due.filter((a) => a.used7d >= 1)];
  order.forEach((a, i) => {
    if (a.priority !== i) Bun.spawnSync(['teamclaude', 'priority', a.name, String(i)], { stdout: 'ignore' });
  });
}

// ── Admission ──

if (args.includes('--admit')) {
  const project = projectFor(option('--session'), option('--cwd') ?? process.cwd());
  const kind = kindFor(option('--type'), option('--description'));
  const est = estimate(kinds, project, kind);
  const cap = option('--cap') === undefined ? undefined : Number(option('--cap'));
  // Without a pace or cost history only the cap and the project limits decide.
  const d = admit({ targetWph: targetWph ?? Infinity, sessions, project, estimateWph: est ?? 0, night, c: config, cap });
  console.log(`${d.ok ? 'admit' : 'hold'}: ${d.reason}`);
  process.exit(d.ok ? 0 : 1);
}

// ── Report ──

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const mw = (n: number): string => `${(n / 1e6).toFixed(1)} MW`;

if (args.includes('--costs')) {
  const rows = kinds
    .map((c) => ({ ...c, mid: [...c.wph].sort((a, b) => a - b)[Math.floor(c.wph.length / 2)] ?? 0 }))
    .sort((a, b) => b.mid - a.mid);
  console.log('| Project | Kind | Agents | W/h (median) | Week %/h |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    console.log(`| ${r.project} | ${r.kind} | ${r.agents} | ${mw(r.mid)} | ${k.k7 ? pct(r.mid * k.k7) : '?'} |`);
  }
  process.exit(0);
}

for (const l of loads) {
  const subs = l.sessions.filter((s) => s.sub).length;
  console.log(
    l.error
      ? `${l.host}: unreachable (${l.error})`
      : `${l.host}: ${subs} agents, ${l.sessions.length - subs} roots active in 10 min; ${mw(l.w1h)} in 1 h${l.complete ? '' : ' (scan catching up)'}`,
  );
}

const burnWph = sessions.reduce((n, s) => n + s.recentWph, 0);
const agents = sessions.filter((s) => s.sub).length;
const typical = estimate(kinds, '', '');
const free = reservedFree(sessions, config);
const cap =
  option('--cap') !== undefined
    ? Number(option('--cap'))
    : targetWph === undefined || !typical
      ? UNMEASURED_CAP
      : agents + Math.max(0, Math.floor((targetWph - burnWph) / typical));

if (pace && k.k7) {
  const p = (wph: number) => pct(wph * k.k7!);
  const verdict =
    burnWph > pace.week.ceiling / k.k7
      ? 'over pace: a weekly limit comes before the next reset'
      : targetWph !== undefined && burnWph > targetWph
        ? 'over pace: hold new agents'
        : 'room for more';
  const five = k.k5 ? `, 5h ceiling ${p(pace.five / k.k5)}/h` : '';
  console.log(
    `weekly: burn ${p(burnWph)}/h; pace ${p(targetWph ?? 0)}/h${night ? ' (night)' : ''}, weekly ceiling ${pct(pace.week.ceiling)}/h${five}; ${verdict}`,
  );
}

const limited = Object.keys(config.projectAgents);
if (limited.length) {
  const running = (p: string) => sessions.filter((s) => s.project === p && s.sub).length;
  const range = (p: string) => {
    const { min, max } = limitsOf(config, p);
    return min === max ? `${min}` : `${min}–${Number.isFinite(max) ? max : '∞'}`;
  };
  console.log(`projects: ${limited.map((p) => `${p} ${running(p)}/${range(p)}`).join(', ')}; ${free} under their minimum`);
}

const unreachable = loads.filter((l) => l.error).length;
const weighted = loads.reduce((n, l) => n + l.w1h, 0);
console.log(`budget: ${agents}/${cap} agents, ${mw(weighted)} in 1 h${unreachable ? `, ${unreachable} host(s) not counted` : ''}`);
// An unreachable host's load is unknown, so the count proves nothing below the cap.
process.exit(agents >= cap ? 1 : unreachable ? 2 : 0);
