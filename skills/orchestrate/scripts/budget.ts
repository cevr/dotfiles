#!/usr/bin/env bun
// The Claude account pool's budget, before a wave and before each agent.
//
// It reads each account's weekly and 5-hour use from `teamclaude status --json`
// and each host's load from its transcripts (budget/host.ts, run over SSH on
// each host in ORCHESTRATE_HOSTS). From those it sets the pool's pace in
// weighted tokens per hour (budget/pace.ts): spend 99% of every account before
// its weekly reset at an even rate, under the weekly and 5-hour
// ceilings. Each agent kind's cost comes from its own transcripts over 7 days.
//
// Usage: bun budget.ts [--rotate] [--cap <n>] [--costs] [--burn [--days <n>]] [--tune]
//        bun budget.ts --resume-at
//        bun budget.ts --admit [--cap <n>] --session <id> --cwd <dir> --type <subagent_type> --description <text>
//        bun budget.ts --wait <ticket>
//        bun budget.ts --codex [--admit --model <slug|family> [--role <role>] [--thread <id>] [--reserve <%/h>] [--week <used%>,<reset s>,<mins>]]
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
//   --resume-at  prints when the first account can serve again (ISO time; now
//             when one can serve now), so a quota wait sleeps until then.
//   --admit   decides one new agent (the guard-agent hook): exit 0 to start
//             it, 1 to hold it, with the reason on stdout. A held agent waits
//             in the queue (budget/queue.ts) as a ticket.
//   --wait    keeps a ticket alive and exits 0 when its turn comes, 3 when it
//             is gone. The held session runs it as a background command.
//   --codex   prints the Codex account's pace instead (budget/codex-pace.ts):
//             what 1% of its week costs in each model family's tokens, the
//             burn now, the pace and each family and role's cost. With
//             --admit it decides one Codex turn (the codex-bridge asks before
//             every turn): exit 0 to start it, 1 to hold it, 2 when nothing
//             can be measured. --thread names the thread a next turn
//             continues; --reserve adds the turns just started (%/h);
//             --week is the week as Codex reports it now (percent used,
//             reset in Unix seconds, window minutes), which the session
//             files show only once a turn has run since an early reset.
// Exits 1 when the active agents reach the cap, 2 when a host is unreachable.
// Settings: ~/.config/orchestrate/budget.json overrides budget/pace.ts DEFAULTS. On
// both hosts it links to orchestrate/budget.json in dotfiles.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { ceilingOf, hostBurn, report, tune, type HostBurn } from './budget/burn.ts';
import { codexLoad, familyOf, type CodexLoad } from './budget/codex-host.ts';
import * as codex from './budget/codex-pace.ts';
import { hostLoad, kindFor, projectFor, queuePath, type HostLoad } from './budget/host.ts';
import {
  calibrate,
  DEFAULTS,
  estimate,
  resumeAt,
  target,
  type Account,
  type Config,
  type Sample,
} from './budget/pace.ts';
import { live, order, serve, update } from './budget/queue.ts';

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

const settings = readJson<Partial<Config> & { codex?: { target?: number } }>(join(homedir(), '.config', 'orchestrate', 'budget.json'), {});
const config: Config = { ...DEFAULTS, ...settings };
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

// A remote host's result is kept `maxAge` in the file `name`: the guard asks on every Agent call, a waiter every 10 s.
async function remoteCached<T extends { host: string }>(alias: string, name: string, now: number, maxAge: number, read: () => Promise<T>): Promise<T> {
  const cached = join(CACHE, `${name}-${alias.replace(/[^\w.-]/g, '_')}.json`);
  const hit = readJson<{ at: number; load: T } | undefined>(cached, undefined);
  if (hit && now - hit.at < maxAge) return hit.load;
  const load: T = { ...(await read()), host: alias };
  writeJson(cached, { at: now, load });
  return load;
}

const remoteLoad = (alias: string, now: number, maxAge: number): Promise<Load> =>
  remoteCached<Load>(alias, 'remote', now, maxAge, () => remote<HostLoad>(alias, HOST_SOURCE, '--deadline-ms 3000')).catch((e) => ({
    host: alias,
    sessions: [],
    w1h: 0,
    kinds: [],
    complete: false,
    queue: [],
    error: failure(e),
  }));

// ── Codex ──

if (args.includes('--codex')) {
  const admitting = args.includes('--admit');
  // An admission waits on this: the bridge gives it a minute.
  const deadline = admitting ? 10e3 : 60e3;
  type Codex = CodexLoad & { error?: string };
  const source = join(import.meta.dir, 'budget', 'codex-host.ts');
  const loads: Codex[] = [
    codexLoad(now, now + deadline),
    ...(await Promise.all(
      remotes.map((a) =>
        remoteCached<Codex>(a, 'remote-codex', now, admitting ? MINUTE : 0, () => remote<CodexLoad>(a, source, `--deadline-ms ${deadline}`)).catch(
          (e): Codex => ({ host: a, complete: false, hours: [], snapshots: [], threads: [], live: [], w1h: 0, interactive1h: {}, error: failure(e) }),
        ),
      ),
    )),
  ];
  const unreachable = loads.filter((l) => l.error);
  const snapshots = loads.flatMap((l) => l.snapshots);
  const [used, resetsAt, windowMinutes] = (option('--week') ?? '').split(',').map(Number);
  if (Number.isFinite(used) && resetsAt && windowMinutes) snapshots.push({ at: now, used: used!, resetsAt: resetsAt * 1e3, windowMinutes });
  // The fit needs every host's tokens against the account's rise; a fit from
  // one host would put the cost of a percent far too low. Until all are read,
  // the last whole fit stands in for a day.
  const fitPath = join(CACHE, 'codex-fit.json');
  const whole = loads.every((l) => !l.error && l.complete);
  const kept = readJson<{ at: number; fit: codex.Fit } | undefined>(fitPath, undefined);
  const week = codex.weekNow(snapshots, now);
  let fit: codex.Fit | undefined;
  if (whole) {
    fit = codex.fitWeek(codex.windows(loads.flatMap((l) => l.hours), snapshots), week?.resetsAt);
    writeJson(fitPath, { at: now, fit });
  } else if (kept && now - kept.at < 24 * 60 * MINUTE) fit = kept.fit;
  const weeklyTarget = settings.codex?.target ?? config.weeklyTarget;
  const pace = week && codex.target(week, now, { ...config, weeklyTarget });

  if (admitting) {
    const family = familyOf(option('--model'));
    const role = option('--role') ?? 'none';
    const why = unreachable.length
      ? `${unreachable.map((l) => `${l.host} unreachable (${l.error})`).join(', ')}, so its threads' burn is unknown`
      : !pace
        ? 'no host has seen the week\'s use'
        : !fit
          ? 'no fit of the cost of the week is in hand'
          : undefined;
    const reserve = Number(option('--reserve') ?? 0) || 0;
    const d = why || !pace || !fit ? undefined : codex.admit({ loads, fit, pctph: pace.pctph, family, role, thread: option('--thread'), reserve });
    if (!d) {
      console.log(`unmeasured: ${why ?? `no ${family} or other thread has run long enough to cost`}`);
      process.exit(2);
    }
    console.log(`${d.ok ? 'admit' : 'hold'}: ${d.reason}`);
    process.exit(d.ok ? 0 : 1);
  }

  const mw = (n: number): string => `${(n / 1e6).toFixed(1)} MW`;
  const p = (n: number): string => `${n.toFixed(2)} %/h`;
  const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  for (const l of loads) {
    console.log(
      l.error
        ? `${l.host}: unreachable (${l.error})`
        : `${l.host}: ${l.live.length} threads live in 10 min; ${mw(l.w1h)} in 1 h${l.complete ? '' : ' (scan catching up)'}`,
    );
  }
  if (fit) {
    const families = Object.keys(fit.k).sort((a, b) => fit.k[b]! - fit.k[a]!);
    const backed = (f: string) => (fit.windows[f] ? `${fit.windows[f]} windows` : 'shared');
    console.log(
      `cost (${fit.span ?? '7 days'}, ${fit.sharedWindows} windows${whole ? '' : '; the last whole fit'}): 1% of the week ≈ ${families.map((f) => `${mw(1 / fit.k[f]!)} of ${f} (${backed(f)})`).join(' / ')}`,
    );
  } else console.log('cost: no fit yet');
  if (week && pace) {
    console.log(`week: ${week.used}% used, resets ${when(week.resetsAt)}; pace ${p(pace.pctph)} (even ${p(pace.floor)}, rolling ${p(pace.rolling)}, ceiling ${p(pace.ceiling)})`);
  } else console.log('week: no host has seen its use');
  if (fit) {
    const interactive: Record<string, number> = {};
    for (const l of loads) for (const [f, w] of Object.entries(l.interactive1h)) interactive[f] = (interactive[f] ?? 0) + w;
    const threads = codex.burn(loads.flatMap((l) => l.live), {}, fit);
    const all = codex.burn(loads.flatMap((l) => l.live), interactive, fit);
    console.log(`burn now: ${p(all)} (threads ${p(threads)}, interactive ${p(all - threads)})${pace ? (all > pace.pctph ? '; over pace: new threads hold' : '; room for more') : ''}`);
  }
  const threads = loads.flatMap((l) => l.threads);
  const groups = new Map<string, { family: string; role: string; wph: number[] }>();
  for (const t of threads) {
    const g = groups.get(`${t.family}\0${t.role}`) ?? { family: t.family, role: t.role, wph: [] };
    g.wph.push(...codex.wph([t]));
    groups.set(`${t.family}\0${t.role}`, g);
  }
  const rows = [...groups.values()]
    .filter((g) => g.wph.length)
    .map((g) => ({ ...g, mid: [...g.wph].sort((a, b) => a - b)[Math.floor(g.wph.length / 2)]! }))
    .sort((a, b) => b.mid - a.mid);
  console.log('| Family | Role | Threads | W/h (median) | Week %/h |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const k = fit && codex.kOf(fit, r.family);
    console.log(`| ${r.family} | ${r.role} | ${r.wph.length} | ${mw(r.mid)} | ${k ? p(r.mid * k) : '?'} |`);
  }
  process.exit(unreachable.length ? 2 : 0);
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

if (args.includes('--resume-at')) {
  const week = accounts();
  const at = week && resumeAt(week, now);
  if (at === undefined) {
    console.error('no account reset is known: teamclaude status failed or lists no quota');
    process.exit(2);
  }
  console.log(new Date(at).toISOString());
  process.exit(0);
}

// ── The pool now ──

const samplesPath = join(CACHE, 'samples.json');

/** The accounts, every host's load and the pace, with remote loads at most `remoteAge` old. */
async function pool(remoteAge: number) {
  const now = Date.now();
  const week = accounts();
  const loads: Load[] = [hostLoad(now), ...(await Promise.all(remotes.map((a) => remoteLoad(a, now, remoteAge))))];
  const sessions = loads.flatMap((l) => l.sessions);
  const kinds = loads.flatMap((l) => l.kinds);
  const w1h = loads.reduce((n, l) => n + l.w1h, 0);
  // Calibration takes a sample a minute, however often a waiter reads the pool,
  // and only with every host read: one host's tokens against the whole pool's
  // quota rise would put the pool's burn several times too high.
  const samples = readJson<Sample[]>(samplesPath, []).filter((s) => s.at > now - 2 * 60 * MINUTE);
  if (week?.length && !loads.some((l) => l.error) && (samples.at(-1)?.at ?? 0) <= now - MINUTE) {
    samples.push({ at: now, used7d: week.map((a) => a.used7d), used5h: week.map((a) => a.used5h), w1h });
    writeJson(samplesPath, samples);
  }
  const k = calibrate(samples);
  // Until an hour of samples exists, teamclaude's own weekly forecast stands in.
  const forecast = week?.reduce((n, a) => n + a.perHour, 0) ?? 0;
  if (!k.k7 && forecast > 0 && w1h > 0) k.k7 = forecast / w1h;
  const pace = week?.length ? target(week, now, config, k) : undefined;
  // The other hosts' live tickets; this host's are read under the queue's lock.
  const remoteTickets = loads.slice(1).flatMap((l) => (l.queue ?? []).filter((t) => live(t, now)));
  return { now, week, loads, sessions, kinds, w1h, k, pace, targetWph: pace?.targetWph, remoteTickets };
}

// Without a pace, an unmeasured pool admits no more than UNMEASURED_CAP agents.
const capOf = (targetWph: number | undefined): number | undefined =>
  option('--cap') !== undefined ? Number(option('--cap')) : targetWph === undefined ? UNMEASURED_CAP : undefined;

// ── Admission ──

if (args.includes('--admit')) {
  const p = await pool(MINUTE);
  const session = option('--session') ?? '';
  const project = projectFor(session, option('--cwd') ?? process.cwd());
  const description = option('--description') ?? '';
  const kind = kindFor(option('--type'), description);
  const estimateWph = estimate(p.kinds, project, kind) ?? 0;
  const out = update(queuePath, p.now, (mine) => {
    // The same Agent call again: the session's ticket for this type and description.
    let ticket = mine.find((t) => t.session === session && t.kind === kind && t.description === description);
    if (ticket?.granted !== undefined) {
      ticket.started ??= p.now;
      return { ok: true, ticket, reason: `ticket ${ticket.id}'s turn came` };
    }
    if (!ticket) {
      ticket = { id: randomUUID().slice(0, 8), session, project, kind, description, estimateWph, host: hostname(), at: p.now, beat: p.now };
      mine.push(ticket);
    }
    ticket.beat = p.now;
    const d = serve({ ticket, tickets: [...mine, ...p.remoteTickets], sessions: p.sessions, targetWph: p.targetWph ?? Infinity, cap: capOf(p.targetWph) });
    if (d.ok) ticket.granted = ticket.started = p.now;
    return { ...d, ticket };
  });
  console.log(`${out.ok ? 'admit' : 'hold'}: ${out.reason}`);
  if (!out.ok) {
    console.log(
      `Queued as ticket ${out.ticket.id}. Run \`bun ${import.meta.path} --wait ${out.ticket.id}\` as a background command (run_in_background), and go on with other work. It exits when this agent's turn comes: then call Agent again at once, with the same subagent_type and description. Set no timer and do not poll.`,
    );
  }
  process.exit(out.ok ? 0 : 1);
}

if (args.includes('--wait')) {
  const id = option('--wait') ?? '';
  let said = '';
  for (;;) {
    const p = await pool(15e3);
    const out = update(queuePath, p.now, (mine) => {
      const ticket = mine.find((t) => t.id === id);
      if (!ticket || ticket.granted !== undefined) return { ticket };
      ticket.beat = p.now;
      const d = serve({ ticket, tickets: [...mine, ...p.remoteTickets], sessions: p.sessions, targetWph: p.targetWph ?? Infinity, cap: capOf(p.targetWph) });
      if (d.ok) ticket.granted = p.now;
      return { ticket, reason: d.reason };
    });
    if (!out.ticket) {
      console.log(`ticket ${id} is gone: no waiter kept it alive for 2 minutes, or its grant passed 5 minutes unused. Call Agent again to queue it anew.`);
      process.exit(3);
    }
    if (out.ticket.granted !== undefined) {
      console.log(`granted: ticket ${id}'s turn came. Call Agent now with the same subagent_type and description ("${out.ticket.description}"). The grant holds 5 minutes.`);
      process.exit(0);
    }
    if (out.reason && out.reason !== said) console.log(`waiting: ${(said = out.reason)}`);
    await Bun.sleep(10e3);
  }
}

const { week, loads, sessions, kinds, k, pace, targetWph } = await pool(MINUTE);

if (week?.length && args.includes('--rotate')) {
  // Accounts with weekly quota serve in reset order; spent accounts go last.
  const due = [...week].sort((a, b) => (a.reset7d ?? 0) - (b.reset7d ?? 0));
  const order = [...due.filter((a) => a.used7d < 1), ...due.filter((a) => a.used7d >= 1)];
  order.forEach((a, i) => {
    if (a.priority !== i) Bun.spawnSync(['teamclaude', 'priority', a.name, String(i)], { stdout: 'ignore' });
  });
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
    `weekly: burn ${p(burnWph)}/h; pace ${p(targetWph ?? 0)}/h, weekly ceiling ${pct(pace.week.ceiling)}/h${five}; ${verdict}`,
  );
}

const tickets = loads.flatMap((l) => (l.queue ?? []).filter((t) => live(t, now)));
if (tickets.length) {
  const waiting = order(tickets, sessions);
  console.log(
    `queue: ${waiting.map((t) => `${t.project} ${t.kind} (${t.host})`).join(', ') || 'none waiting'}; ${tickets.length - waiting.length} granted`,
  );
}

const unreachable = loads.filter((l) => l.error).length;
const weighted = loads.reduce((n, l) => n + l.w1h, 0);
console.log(`budget: ${agents}/${cap} agents, ${mw(weighted)} in 1 h${unreachable ? `, ${unreachable} host(s) not counted` : ''}`);
// An unreachable host's load is unknown, so the count proves nothing below the cap.
process.exit(agents >= cap ? 1 : unreachable ? 2 : 0);
