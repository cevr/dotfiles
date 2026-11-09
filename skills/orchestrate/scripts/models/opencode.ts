// OpenCode agents and rounds. Agents come from the running service's sessions
// (read over its HTTP API, never its database; the client is the miner's,
// retro/scripts/mine/opencode.ts). Rounds come from the orchestrate mod's call
// log, ~/.cache/orchestrate/opencode-agents.jsonl: one `call` line per subagent
// start (agent, model, description, pace), joined by callID to its `done`,
// `latched` or `denied` line. Both parsers are pure, so the tests feed them lines.
import { messagesOf, sessionsSince, type Endpoint, type SessionInfo } from '../../../retro/scripts/mine/opencode.ts';
import { costOf } from './prices.ts';
import { namedRole, roleOf, type Agent } from './sources.ts';

// A start's description begins like the hand-back line: `implementor auth r2`.
const DESCRIBED = /^(?:planner|implementor|reviewer|verifier)\s+(\S+)\s+r(\d+)\b/;

const textOf = (m: any) =>
  typeof m?.text === 'string' ? m.text : (m?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text ?? '').join(' ');

/**
 * One OpenCode session as an agent: a child is the role its agent or description names; a root,
 * the orchestrator (`root`). Only messages since `since` count. Undefined when no model answered.
 */
export function opencodeAgent(info: SessionInfo, msgs: any[], since = 0): Agent | undefined {
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const models = new Map<string, number>();
  let first = 0, last = 0, prompt = '', final = '', compacted = false, variant: string | undefined;
  for (const m of msgs) {
    const at: number = m.time?.created ?? 0;
    if (m.type === 'user' && !prompt) prompt = String(m.text ?? '');
    if (at < since) continue;
    first ||= at;
    last = at;
    if (m.type === 'compaction' && m.status === 'completed') compacted = true;
    if (m.type !== 'assistant') continue;
    const t = textOf(m);
    if (t.trim()) final = t;
    if (!m.model?.id) continue;
    models.set(m.model.id, (models.get(m.model.id) ?? 0) + 1);
    variant = m.model.variant ?? variant;
    const u = m.tokens ?? {};
    tokens.input += u.input ?? 0;
    tokens.cacheWrite += u.cache?.write ?? 0;
    tokens.cacheRead += u.cache?.read ?? 0;
    tokens.output += (u.output ?? 0) + (u.reasoning ?? 0);
  }
  const model = [...models].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!model) return undefined;
  const description = info.title ?? '';
  const role = info.parentID ? namedRole(description, prompt, info.agent ?? '') ?? roleOf(`${description} ${prompt.slice(0, 600)}`.toLowerCase()) : 'root';
  const tag = DESCRIBED.exec(description);
  return {
    id: info.id,
    harness: 'opencode',
    session: info.parentID ?? info.id,
    model: model.replace(/^claude-/, ''),
    effort: variant && variant !== 'default' ? variant : undefined,
    role,
    prompt: prompt.slice(0, 4000),
    final: final.slice(-600),
    cwd: info.location?.directory,
    min: (last - first) / 60000,
    tokens,
    cost: costOf(model, tokens),
    compacted,
    last,
    ...(tag ? { unit: tag[1], round: Number(tag[2]) } : {}),
  };
}

/** Every OpenCode subagent active since `since`, and every root that started one. */
export async function opencodeAgents(ep: Endpoint, since: number): Promise<Agent[]> {
  const infos = await sessionsSince(ep, since);
  const parents = new Set(infos.map((s) => s.parentID).filter(Boolean));
  const out: Agent[] = [];
  for (const info of infos) {
    if (!info.parentID && !parents.has(info.id)) continue;
    const a = opencodeAgent(info, await messagesOf(ep, info.id), since);
    if (a) out.push(a);
  }
  return out;
}

export type Round = {
  at: number;
  parent: string;
  callID: string;
  role: string; // the agent the mod ran it as
  asked: string; // the agent the caller named
  model: string; // `<model>@<effort>`, or `(agent default)` when the call named none
  description: string;
  reason: string; // why the mod chose the agent: kept, general, fallback, ...
  background: boolean;
  followUp: boolean; // the call named an existing child
  paceHeld: boolean;
  fate: 'started' | 'latched' | 'denied' | 'error' | 'unknown';
  child?: string;
  why?: string;
  ran?: string; // the model id it ran on, as models/prices.ts keys it (`claude-opus-5-5`)
  experiment?: { arm: 'trial' | 'control'; model: string; fellBack?: string }; // its model-experiment arm (the mod's experiment.ts)
};

// `anthropic/claude-opus-5-5#medium` → `opus-5-5@medium`, as the models table spells it.
const spell = (model?: string) => {
  if (!model) return '(agent default)';
  const [id, effort] = model.replace(/^[\w-]+\//, '').replace(/^claude-/, '').split('#');
  return effort && effort !== 'default' ? `${id}@${effort}` : id!;
};

/** The call log's rounds since `since`: each `call` with its outcome line. */
export function roundsOf(text: string, since = 0): Round[] {
  const rounds = new Map<string, Round>();
  for (const line of text.split('\n')) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(d.at ?? '');
    if (!(at >= since) || typeof d.callID !== 'string') continue;
    if (d.kind === 'call') {
      // Only a new start of the experiment's role carries an arm; a follow-up never does.
      const e = d.experiment;
      const arm = e?.arm === 'trial' || e?.arm === 'control' ? { arm: e.arm, model: String(e.model ?? ''), ...(e.fellBack ? { fellBack: String(e.fellBack) } : {}) } : undefined;
      const ran = typeof d.model === 'string' ? d.model.replace(/^[\w-]+\//, '').split('#')[0] : undefined;
      rounds.set(d.callID, {
        ...(ran ? { ran } : {}),
        ...(arm ? { experiment: arm } : {}),
        at,
        parent: d.sessionID,
        callID: d.callID,
        role: d.agent ?? '?',
        asked: d.asked ?? '',
        model: spell(d.model),
        description: d.description ?? '',
        reason: d.reason ?? '',
        background: Boolean(d.background),
        followUp: Boolean(d.child),
        paceHeld: d.pace?.ok === false,
        fate: 'unknown',
        child: d.child,
      });
      continue;
    }
    const r = rounds.get(d.callID);
    if (d.kind === 'denied') {
      // A denial can come with no call line: the mod refused before it logged one.
      const base = r ?? { at, parent: d.sessionID, callID: d.callID, role: '?', asked: '', model: '(not started)', description: '', reason: '', background: false, followUp: false, paceHeld: true, fate: 'unknown' as const };
      rounds.set(d.callID, { ...base, fate: 'denied', why: d.why });
    } else if (r && d.kind === 'latched') rounds.set(d.callID, { ...r, fate: 'latched', child: d.child ?? r.child, why: d.why ?? d.opens });
    else if (r && d.kind === 'done') rounds.set(d.callID, { ...r, fate: d.status === 'error' ? 'error' : r.fate === 'latched' ? 'latched' : 'started', child: d.child ?? r.child });
  }
  return [...rounds.values()].sort((a, b) => a.at - b.at);
}

/** Rows of the rounds table: per role and model@effort, the calls and what became of them. */
export function roundsTable(rounds: Round[]): string[] {
  const groups = new Map<string, Round[]>();
  for (const r of rounds) groups.set(`${r.role}\t${r.model}`, [...(groups.get(`${r.role}\t${r.model}`) ?? []), r]);
  const n = (rs: Round[], f: (r: Round) => boolean) => rs.filter(f).length;
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, rs]) => {
      const [role, model] = k.split('\t');
      return `      ${role!.padEnd(12)} ${model!.padEnd(22)} ${String(rs.length).padStart(4)} ${String(n(rs, (r) => r.followUp)).padStart(7)} ${String(n(rs, (r) => r.background)).padStart(5)} ${String(n(rs, (r) => r.reason === 'fallback')).padStart(9)} ${String(n(rs, (r) => r.fate === 'latched')).padStart(8)} ${String(n(rs, (r) => r.fate === 'denied')).padStart(7)} ${String(n(rs, (r) => r.fate === 'error')).padStart(6)}`;
    });
}
export const ROUNDS_HEADER = 'Rounds: role         model                     n  follow   bg  fallback  latched  denied  error';
