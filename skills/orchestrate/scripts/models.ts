#!/usr/bin/env bun
// The model eval: per orchestrate phase and model, what an agent costs and what
// its phase produced. Agents come from Claude Code subagents and main sessions
// and from Codex rollouts; outcomes come from the unit's verdict files and log.
// Run it on each host: units and transcripts live where they ran.
// Usage: bun models.ts [--since 2026-10-17] [--json]
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { joinUnit, outcomeOf, type Outcome, type Phase } from './models/outcomes.ts';
import { bridgeUnits, claudeAgents, codexAgents, type Agent } from './models/sources.ts';
import { ROOTS, unitDirs } from './runs.ts';

const args = process.argv.slice(2);
const sinceAt = args.indexOf('--since');
const since = sinceAt >= 0 ? Date.parse(args[sinceAt + 1]) : Date.now() - 7 * 86400e3;
const json = args.includes('--json');

// codex-bridge's state dir, as the bridge finds it.
const bridge = process.env.CODEX_BRIDGE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'codex-bridge');
const agents = [...claudeAgents(join(homedir(), '.claude/projects'), since), ...codexAgents(join(homedir(), '.codex/sessions'), since, bridgeUnits(bridge))];
const label = (a: Agent) => (a.effort ? `${a.model}@${a.effort}` : a.model);

// Each worker's phase outcome; the orchestrator's (decide) is the units its workers touched.
type Row = { agent: Agent; outcome?: Outcome };
// A bridge thread's unit is a name; its dir is found once, among the units active in the window.
let byName: Map<string, string[]> | undefined;
const find = (unit: string) => {
  byName ??= unitDirs(ROOTS, since).reduce((m, d) => m.set(basename(d), [...(m.get(basename(d)) ?? []), d]), new Map<string, string[]>());
  return byName.get(unit) ?? [];
};
const rows: Row[] = agents.map((agent) => {
  const j = joinUnit(agent, agent.final, find);
  return { agent, outcome: j ? outcomeOf(j) : undefined };
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
console.log(`agents ${agents.length} (claude ${agents.filter((a) => a.harness === 'claude').length}, codex ${agents.filter((a) => a.harness === 'codex').length}), API-priced $${priced.reduce((s, a) => s + a.cost!, 0).toFixed(0)}; "?" = no price row in models/prices.ts`);
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
  review: (os) => `changes ${pct(os.filter((o) => o.result === 'changes').length, os.length)}, escaped to verify ${os.filter((o) => o.result === 'escaped').length}`,
  verify: (os) => `fail ${pct(os.filter((o) => o.result === 'fail').length, os.length)}`,
  decide: (os) => `units ${os.reduce((s, o) => s + parseInt(o.unit), 0)}, merged ${os.reduce((s, o) => s + parseInt(o.result), 0)}`,
};
const joined = rows.filter((r) => r.outcome);
const workers = rows.filter((r) => ['plan', 'implement', 'review', 'verify'].includes(r.agent.role));
console.log(`\nOutcome: phase      model                 n   headline; results   (n = unit rounds; joined ${joined.length} of ${workers.length} plan, implement, review and verify agents to a unit)`);
for (const [key, rs] of group(joined, (r) => `${r.outcome!.phase}\t${label(r.agent)}`)) {
  const [phase, model] = key.split('\t') as [Phase, string];
  // One result per unit and round: a round that took several agents of one model counts once.
  const os = [...new Map(rs.map((r) => [`${r.outcome!.unit} ${r.outcome!.round}`, r.outcome!])).values()];
  const results = phase === 'decide' ? '' : group(os, (o) => o.result).map(([k, v]) => `${k} ${v.length}`).join(', ');
  console.log(`         ${phase.padEnd(10)} ${model.padEnd(20)} ${String(os.length).padStart(4)}   ${HEADLINE[phase](os)}${results ? `; ${results}` : ''}`);
}
