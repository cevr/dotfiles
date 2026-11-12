#!/usr/bin/env bun
// The model eval: per orchestrate phase and model, what an agent costs and what
// its phase produced. Agents come from Claude Code subagents and main sessions,
// from Codex rollouts, and from the running OpenCode service's sessions; outcomes
// come from the unit's verdict files and log. OpenCode's rounds (each subagent
// start, and whether it started, latched or was denied) come from the orchestrate
// mod's call log. Run it on each host: units and transcripts live where they ran.
// `--experiment` prints only the finished planner A/B's view (models/experiment.ts): from
// EXPERIMENT_SINCE the mod started half the planner units on Fable and half on Opus, until the owner
// made Fable the planner (2026-11-12, the mod's `planner` option) and new starts stopped carrying an
// arm. It reads the call-log lines that carry one, so the comparison stays readable: per arm, the
// starts, tokens and cost per start, and the units' fates, counted from EXPERIMENT_SINCE unless
// --since says otherwise. Fable's planner rows since then are in the main view, by phase and model.
// Both views add the limit % of one account each agent spent (models/limits.ts), from the OpenCode
// pool's limit tally ($XDG_STATE_HOME/opencode-pool/limits.json, or --limits <file>, the output of
// opencode/scripts/pool-limits.ts --json): per arm per plan, and per phase and model family per
// finished task, with the time and the finished share.
// Usage: bun models.ts [--since 2026-10-17] [--json] [--no-opencode] [--experiment] [--limits <file>]
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { probe, serviceEndpoint } from '../../retro/scripts/mine/opencode.ts';
import { armStats, EXPERIMENT_SINCE, experimentTable } from './models/experiment.ts';
import { limitRows, limitTable, readRates } from './models/limits.ts';
import { opencodeAgents, roundsOf, roundsTable, ROUNDS_HEADER } from './models/opencode.ts';
import { joinUnits, outcomeOf, type Outcome, type Phase } from './models/outcomes.ts';
import { bridgeUnits, claudeAgents, codexAgents, type Agent } from './models/sources.ts';
import { ROOTS, unitDirs } from './runs.ts';

const args = process.argv.slice(2);
const sinceAt = args.indexOf('--since');
// The planner A/B's arms ran from EXPERIMENT_SINCE: its view counts no start before it unless --since says so.
const since = sinceAt >= 0 ? Date.parse(args[sinceAt + 1]) : args.includes('--experiment') ? EXPERIMENT_SINCE : Date.now() - 7 * 86400e3;
const json = args.includes('--json');
// The pool's limit rates (models/limits.ts): the tally file it writes, or --limits <file> (pool-limits.ts --json's output).
const limitsAt = args.indexOf('--limits');
const rates = readRates(limitsAt >= 0 ? args[limitsAt + 1] : undefined);

// codex-bridge's state dir, as the bridge finds it.
const bridge = process.env.CODEX_BRIDGE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'codex-bridge');
const ep = args.includes('--no-opencode') ? undefined : serviceEndpoint();
const opencode = ep && (await probe(ep)) ? await opencodeAgents(ep, since) : [];
const callLog = join(homedir(), '.cache/orchestrate/opencode-agents.jsonl');
const rounds = existsSync(callLog) ? roundsOf(readFileSync(callLog, 'utf8'), since) : [];
const agents = [
  ...claudeAgents(join(homedir(), '.claude/projects'), since),
  ...codexAgents(join(homedir(), '.codex/sessions'), since, bridgeUnits(bridge)),
  ...opencode,
];
const label = (a: Agent) => (a.effort ? `${a.model}@${a.effort}` : a.model);

// Each worker's phase outcome; the orchestrator's (decide) is the units its workers touched.
type Row = { agent: Agent; outcome?: Outcome };
// A bridge thread's unit is a name; its dir is found once, among the units active in the window.
let byName: Map<string, string[]> | undefined;
const find = (unit: string) => {
  byName ??= unitDirs(ROOTS, since).reduce((m, d) => m.set(basename(d), [...(m.get(basename(d)) ?? []), d]), new Map<string, string[]>());
  return byName.get(unit) ?? [];
};
// A batch verifier judged each unit of its batch: one row per unit, so its verdicts count per unit.
const rows: Row[] = agents.flatMap((agent) => {
  const js = joinUnits(agent, agent.final, find);
  return js.length ? js.map((j) => ({ agent, outcome: outcomeOf(j) })) : [{ agent }];
});
const units = new Map<string, Set<string>>();
const merged = new Map<string, Set<string>>();
for (const r of rows) {
  if (!r.outcome) continue;
  const s = r.agent.session;
  units.set(s, (units.get(s) ?? new Set()).add(r.outcome.unit));
  if (r.outcome.fate === 'merged') merged.set(s, (merged.get(s) ?? new Set()).add(r.outcome.unit));
}
for (const r of rows)
  if (r.agent.role === 'root' && units.has(r.agent.id))
    r.outcome = { phase: 'decide', unit: `${units.get(r.agent.id)!.size} units`, round: 0, result: `${merged.get(r.agent.id)?.size ?? 0} merged`, fate: '' };

// The model experiment's arms (the mod's `experiment` option): starts, tokens and cost per start, and the units' fates.
if (args.includes('--experiment')) {
  const tokens = new Map(opencode.map((a) => [a.id, a.tokens]));
  const minutes = new Map(opencode.map((a) => [a.id, a.min]));
  const outcomes = rows.flatMap((r) => (r.outcome ? [r.outcome] : []));
  for (const line of experimentTable(armStats(rounds, (child) => tokens.get(child), outcomes, { minutesOf: (child) => minutes.get(child), rates })))
    console.log(line);
  if (!Object.keys(rates).length) console.log('  (no limit rates: the pool has written no tally yet; pass --limits <pool-limits.ts --json output>)');
  if (!opencode.length) console.log('  (no OpenCode service answered: tokens and cost are unjoined)');
  process.exit(0);
}

if (json) {
  console.log(JSON.stringify(rows.map(({ agent: { prompt, final, ...a }, outcome }) => ({ ...a, outcome }))));
  process.exit(0);
}

const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const money = (xs: (number | null)[]) => (xs.some((x) => x === null) ? '?' : med(xs as number[]).toFixed(2));
const group = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return [...m].sort(([a], [b]) => a.localeCompare(b));
};

const priced = agents.filter((a) => a.cost !== null);
console.log(`agents ${agents.length} (claude ${agents.filter((a) => a.harness === 'claude').length}, codex ${agents.filter((a) => a.harness === 'codex').length}, opencode ${opencode.length}), API-priced $${priced.reduce((s, a) => s + a.cost!, 0).toFixed(0)}; "?" = no price row in models/prices.ts`);
console.log('\nCost: role       model                 n   med-$  med-min  med-in-M  med-out-k  compacted');
for (const [key, xs] of group(agents, (a) => `${a.role}\t${label(a)}`)) {
  const [role, model] = key.split('\t');
  const input = med(xs.map((x) => x.tokens.input + x.tokens.cacheWrite + x.tokens.cacheRead)) / 1e6;
  console.log(`      ${role.padEnd(10)} ${model.padEnd(20)} ${String(xs.length).padStart(4)} ${money(xs.map((x) => x.cost)).padStart(7)} ${med(xs.map((x) => x.min)).toFixed(1).padStart(8)} ${input.toFixed(1).padStart(9)} ${(med(xs.map((x) => x.tokens.output)) / 1e3).toFixed(1).padStart(10)} ${pct(xs.filter((x) => x.compacted).length, xs.length).padStart(10)}`);
}

// One headline per phase, then every result's share.
const HEADLINE: Record<Phase, (os: Outcome[]) => string> = {
  plan: (os) => `units merged ${pct(os.filter((o) => o.result === 'merged').length, os.length)}`,
  implement: (os) => {
    const r1 = os.filter((o) => o.round === 1);
    return `r1 accepted ${pct(r1.filter((o) => o.result === 'accepted').length, r1.length)} (${r1.length}), all rounds ${pct(os.filter((o) => o.result === 'accepted').length, os.length)}`;
  },
  verify: (os) => {
    // An older run's separate check after review ends `pass` or `fail`; a verifier's findings, the rest.
    const checks = os.filter((o) => o.result === 'pass' || o.result === 'fail');
    const rounds = os.filter((o) => !checks.includes(o));
    const escaped = rounds.filter((o) => o.result === 'escaped').length;
    const older = checks.length ? `, older check fail ${pct(checks.filter((o) => o.result === 'fail').length, checks.length)} (${checks.length})` : '';
    return `changes ${pct(rounds.filter((o) => o.result === 'changes').length, rounds.length)}${escaped ? `, escaped the older check ${escaped}` : ''}${older}`;
  },
  decide: (os) => `units ${os.reduce((s, o) => s + parseInt(o.unit), 0)}, merged ${os.reduce((s, o) => s + parseInt(o.result), 0)}`,
};
const joined = rows.filter((r) => r.outcome);
const workers = agents.filter((a) => ['plan', 'implement', 'verify'].includes(a.role));
const joinedWorkers = new Set(joined.filter((r) => workers.includes(r.agent)).map((r) => r.agent)).size;
console.log(`\nOutcome: phase      model                 n   headline; results   (n = unit rounds; joined ${joinedWorkers} of ${workers.length} plan, implement and verify agents to a unit)`);
for (const [key, rs] of group(joined, (r) => `${r.outcome!.phase}\t${label(r.agent)}`)) {
  const [phase, model] = key.split('\t') as [Phase, string];
  // One result per unit and round: a round that took several agents of one model counts once.
  const os = [...new Map(rs.map((r) => [`${r.outcome!.unit} ${r.outcome!.round}`, r.outcome!])).values()];
  const results = phase === 'decide' ? '' : group(os, (o) => o.result).map(([k, v]) => `${k} ${v.length}`).join(', ');
  console.log(`         ${phase.padEnd(10)} ${model.padEnd(20)} ${String(os.length).padStart(4)}   ${HEADLINE[phase](os)}${results ? `; ${results}` : ''}`);
}

// Efficiency per finished task: per phase and model family, the limit % of one account each spent (the pool's rates).
const limited = limitRows(rows, rates);
if (limited.length) {
  console.log(`\nLimit: phase      family         % of one account's shared week (95% range) per finished task · per agent · time · finished share${Object.keys(rates).length ? '' : '   (no rates: the pool has written no tally; --limits <file>)'}`);
  for (const line of limitTable(limited)) console.log(line);
}

// OpenCode's rounds: every start the orchestrate mod logged, by the role it ran as and the model the call named.
if (rounds.length) {
  console.log(`\n${ROUNDS_HEADER}   (${rounds.length} starts in ${callLog}; follow = the call named an existing child)`);
  for (const line of roundsTable(rounds)) console.log(line);
}
