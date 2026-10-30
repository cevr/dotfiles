// Agents read from each harness's transcripts: Claude Code subagents and main
// sessions, and Codex rollouts. Each parser takes a transcript's text, so the
// tests feed it synthetic lines. A transcript that spans the window's start
// counts only its usage inside the window.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { costOf, type Tokens } from './prices.ts';

export type Agent = {
  id: string;
  harness: 'claude' | 'codex';
  session: string; // the main session that spawned it, or its own id
  model: string;
  effort?: string;
  role: string;
  prompt: string; // its task, for the unit join
  final: string; // the end of its last message: the hand-back line
  cwd?: string;
  min: number;
  tokens: Tokens;
  cost: number | null;
  compacted: boolean;
  last: number;
  unit?: string; // the orchestrate unit and round a Codex thread's start named, from codex-bridge
  round?: number;
};

const ROLE: Record<string, string> = { planner: 'plan', implementor: 'implement', reviewer: 'review', verifier: 'verify' };

/** The role an orchestrate worker was given: its role agent, the description's first word, or the first role its protocol prompt names. */
export const namedRole = (description: string, prompt: string, type = '') => {
  const word = /orchestrate-(planner|implementor|reviewer|verifier)$/.exec(type)?.[1]
    ?? /^(planner|implementor|reviewer|verifier)\b/i.exec(description.trim())?.[1]
    ?? (prompt.includes('protocol.md') ? /\b(planner|implementor|reviewer|verifier)\b/i.exec(prompt)?.[1] : undefined);
  return word ? ROLE[word.toLowerCase()] : undefined;
};

// Any other agent's role comes from the Agent description and the first words of the prompt.
export const roleOf = (head: string) =>
  /\breview|counsel|findings/.test(head) ? 'review'
  : /\bverif/.test(head) ? 'verify'
  : /\bplanner|\bplan\b|write spec/.test(head) && !/implement/.test(head) ? 'plan'
  : /implement|round[- ]?\d|\bfix|\bbuild|spec\.md/.test(head) ? 'implement'
  : /explore|search|research|read-only|investigat/.test(head) ? 'explore'
  : 'other';

const zero = (): Tokens => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
const lines = (text: string) => text.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const top = (counts: Map<string, number>) => [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];

/** One Claude Code transcript. A message spans several lines; its usage counts once. */
export function claudeAgent(text: string, id: string, session: string, description = '', main = false, type = '', since = 0): Agent | undefined {
  const models = new Map<string, number>();
  const seen = new Set<string>();
  const tokens = zero();
  let first = 0, last = 0, prompt = '', final = '', compacted = false, cwd: string | undefined;
  for (const d of lines(text)) {
    if (d.timestamp) { last = Date.parse(d.timestamp); if (last >= since) first ||= last; }
    const inside = last >= since;
    cwd ??= d.cwd;
    if (d.type === 'system' && /compact/.test(d.subtype ?? '') && inside) compacted = true;
    if (d.type === 'user' && !prompt && !d.isMeta) {
      const c = d.message?.content;
      prompt = typeof c === 'string' ? c : (c ?? []).map((x: any) => x?.text ?? '').join(' ');
    }
    const m = d.message;
    if (d.type === 'assistant') for (const x of m?.content ?? []) if (x?.type === 'text' && x.text?.trim()) final = x.text;
    if (d.type !== 'assistant' || !m?.model?.startsWith('claude-') || seen.has(m.id) || !inside) continue;
    seen.add(m.id);
    models.set(m.model, (models.get(m.model) ?? 0) + 1);
    const u = m.usage ?? {};
    tokens.input += u.input_tokens ?? 0;
    tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
    tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
  }
  const model = top(models);
  if (!model) return undefined;
  const head = `${description} ${prompt.slice(0, 600)}`.toLowerCase();
  const role = main ? 'root' : namedRole(description, prompt, type) ?? roleOf(head);
  // A reviewer that runs counsel-review hands the review to the other family: its row says so.
  const via = role === 'review' && /counsel/.test(head) ? '+counsel' : '';
  return {
    id, harness: 'claude', session, model: model.replace('claude-', '') + via, role,
    prompt: prompt.slice(0, 4000), final: final.slice(-600), cwd, min: (last - first) / 60000, tokens, cost: costOf(model, tokens), compacted, last,
  };
}

// Codex injects these as user messages before the task.
const INJECTED = /^\s*(# AGENTS\.md|<environment_context>|<user_instructions>|<permissions)/;

/** One Codex rollout. token_count totals are cumulative, so the last one is the session's. */
export function codexAgent(text: string, id: string, since = 0): Agent | undefined {
  const models = new Map<string, number>();
  let first = 0, last = 0, prompt = '', final = '', compacted = false, cwd: string | undefined, effort: string | undefined, session = id;
  let total: any, before: any, type = '', opening: string | undefined;
  for (const d of lines(text)) {
    if (d.timestamp) { last = Date.parse(d.timestamp); if (last >= since) first ||= last; }
    const p = d.payload ?? {};
    if (d.type === 'session_meta') { cwd ??= p.cwd; session = p.forked_from_id ?? p.parent_thread_id ?? p.id ?? id; }
    // The model of the window's own turns: usage before `since` is not counted, so neither is its model,
    // past the one in force when the window opened.
    if (d.type === 'turn_context' && p.model) {
      if (last >= since) models.set(p.model, (models.get(p.model) ?? 0) + 1);
      else opening = p.model;
      effort = p.effort ?? effort;
    }
    if ((d.type === 'compacted' || p.type === 'context_compacted') && last >= since) compacted = true;
    if (d.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      total = p.info.total_token_usage;
      if (last < since) before = total;
    }
    if (d.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const t = (p.content ?? []).map((x: any) => x?.text ?? '').join(' ');
      if (t.trim()) final = t;
    }
    if (d.type === 'response_item' && p.type === 'message' && p.role === 'user' && prompt.length < 4000) {
      const t = (p.content ?? []).map((x: any) => x?.text ?? '').join(' ');
      if (!INJECTED.test(t)) prompt += `${t} `;
    }
    // A role agent (spawn_agent's agent_type, or a codex-bridge thread) opens its developer instructions with its role.
    if (d.type === 'response_item' && p.type === 'message' && p.role === 'developer' && !type) {
      const role = /^You are the (planner|implementor|reviewer|verifier) of one orchestrate unit\./.exec(p.content?.[0]?.text ?? '')?.[1];
      if (role) type = `orchestrate-${role}`;
    }
  }
  const model = top(models) ?? opening;
  if (!model || !total) return undefined;
  // token_count totals are cumulative: the window's usage is the last total less the last one before it.
  const used = (k: string) => (total[k] ?? 0) - (before?.[k] ?? 0);
  const cached = used('cached_input_tokens');
  const tokens = { input: used('input_tokens') - cached, cacheWrite: used('cache_write_input_tokens'), cacheRead: cached, output: used('output_tokens') };
  return {
    id, harness: 'codex', session, model, effort, role: namedRole('', prompt, type) ?? roleOf(prompt.slice(0, 400).toLowerCase()),
    prompt: prompt.slice(0, 4000), final: final.slice(-600), cwd, min: (last - first) / 60000, tokens, cost: costOf(model, tokens), compacted, last,
  };
}

const newer = (path: string, since: number) => { try { return statSync(path).mtimeMs >= since; } catch { return false; } };

/** Every Claude subagent, and every main session that spawned one, active since `since`. */
export function claudeAgents(root: string, since: number): Agent[] {
  const out: Agent[] = [];
  if (!existsSync(root)) return out;
  for (const project of readdirSync(root)) {
    const pdir = join(root, project);
    if (!statSync(pdir).isDirectory()) continue;
    for (const session of readdirSync(pdir)) {
      const sdir = join(pdir, session, 'subagents');
      if (!existsSync(sdir) || !newer(sdir, since)) continue;
      const main = join(pdir, `${session}.jsonl`);
      if (newer(main, since)) {
        const a = claudeAgent(readFileSync(main, 'utf8'), session, session, '', true, '', since);
        if (a && a.last >= since) out.push(a);
      }
      for (const f of readdirSync(sdir)) {
        const path = join(sdir, f);
        if (!f.endsWith('.jsonl') || !newer(path, since)) continue;
        let meta: { description?: string; agentType?: string } = {};
        try { meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {}
        const a = claudeAgent(readFileSync(path, 'utf8'), f.replace(/\.jsonl$/, ''), session, meta.description ?? '', false, meta.agentType ?? '', since);
        if (a && a.last >= since) out.push(a);
      }
    }
  }
  return out;
}

export type BridgeTag = { unit: string; round?: number };

// A start's description begins like the hand-back line: `implementor sheet r2`.
const HANDBACK = /^(?:planner|implementor|reviewer|verifier)\s+(\S+)\s+r(\d+)\b/;

/**
 * The unit and round each codex-bridge thread's start named, by thread id: from each thread
 * in state.json, then from bridge.log's JSON lines, which outlive the state's pruning. A start
 * that passed no `unit` is joined by its description. A thread the bridge opened again is
 * tagged under its app-server id too, which names its rollout.
 */
export function bridgeUnits(dir: string): Map<string, BridgeTag> {
  const out = new Map<string, BridgeTag>();
  const tag = (ids: unknown[], unit: unknown, round: unknown, description: unknown) => {
    const named = typeof description === 'string' ? HANDBACK.exec(description) : null;
    const u = typeof unit === 'string' && unit ? unit : named?.[1];
    const r = typeof round === 'number' ? round : named ? Number(named[2]) : undefined;
    if (!u) return;
    for (const id of ids) if (typeof id === 'string' && !out.has(id)) out.set(id, { unit: u, round: r });
  };
  try {
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    for (const t of Object.values<any>(state.threads ?? {})) tag([t?.id, t?.codexId], t?.unit, t?.round, t?.description);
  } catch {}
  try { for (const l of lines(readFileSync(join(dir, 'bridge.log'), 'utf8'))) tag([l?.thread, l?.codexId], l?.unit, l?.round, l?.description); } catch {}
  return out;
}

/** Every Codex rollout active since `since`, under sessions/YYYY/MM/DD, with its bridge thread's unit and round. */
export function codexAgents(root: string, since: number, bridge = new Map<string, BridgeTag>()): Agent[] {
  const out: Agent[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, d.name);
      if (d.isDirectory()) walk(path);
      else if (/^rollout-.*\.jsonl$/.test(d.name) && newer(path, since)) {
        const a = codexAgent(readFileSync(path, 'utf8'), d.name.replace(/\.jsonl$/, ''), since);
        const thread = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.jsonl$)/.exec(d.name)?.[0];
        if (a && a.last >= since) out.push({ ...a, ...(thread && bridge.get(thread)) });
      }
    }
  };
  walk(root);
  return out;
}
