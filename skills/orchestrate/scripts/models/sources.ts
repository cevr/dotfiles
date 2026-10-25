// Agents read from each harness's transcripts: Claude Code subagents and main
// sessions, and Codex rollouts. Each parser takes a transcript's text, so the
// tests feed it synthetic lines.
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
};

// The role comes from the Agent description and the first words of the prompt.
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
export function claudeAgent(text: string, id: string, session: string, description = '', main = false): Agent | undefined {
  const models = new Map<string, number>();
  const seen = new Set<string>();
  const tokens = zero();
  let first = 0, last = 0, prompt = '', final = '', compacted = false, cwd: string | undefined;
  for (const d of lines(text)) {
    if (d.timestamp) { const t = Date.parse(d.timestamp); first ||= t; last = t; }
    cwd ??= d.cwd;
    if (d.type === 'system' && /compact/.test(d.subtype ?? '')) compacted = true;
    if (d.type === 'user' && !prompt && !d.isMeta) {
      const c = d.message?.content;
      prompt = typeof c === 'string' ? c : (c ?? []).map((x: any) => x?.text ?? '').join(' ');
    }
    const m = d.message;
    if (d.type === 'assistant') for (const x of m?.content ?? []) if (x?.type === 'text' && x.text?.trim()) final = x.text;
    if (d.type !== 'assistant' || !m?.model?.startsWith('claude-') || seen.has(m.id)) continue;
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
  const role = main ? 'root' : roleOf(head);
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
export function codexAgent(text: string, id: string): Agent | undefined {
  const models = new Map<string, number>();
  let first = 0, last = 0, prompt = '', final = '', compacted = false, cwd: string | undefined, effort: string | undefined, session = id;
  let total: any;
  for (const d of lines(text)) {
    if (d.timestamp) { const t = Date.parse(d.timestamp); first ||= t; last = t; }
    const p = d.payload ?? {};
    if (d.type === 'session_meta') { cwd ??= p.cwd; session = p.forked_from_id ?? p.parent_thread_id ?? p.id ?? id; }
    if (d.type === 'turn_context' && p.model) { models.set(p.model, (models.get(p.model) ?? 0) + 1); effort = p.effort ?? effort; }
    if (d.type === 'compacted' || p.type === 'context_compacted') compacted = true;
    if (d.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) total = p.info.total_token_usage;
    if (d.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const t = (p.content ?? []).map((x: any) => x?.text ?? '').join(' ');
      if (t.trim()) final = t;
    }
    if (d.type === 'response_item' && p.type === 'message' && p.role === 'user' && prompt.length < 4000) {
      const t = (p.content ?? []).map((x: any) => x?.text ?? '').join(' ');
      if (!INJECTED.test(t)) prompt += `${t} `;
    }
  }
  const model = top(models);
  if (!model || !total) return undefined;
  const cached = total.cached_input_tokens ?? 0;
  const tokens = { input: (total.input_tokens ?? 0) - cached, cacheWrite: total.cache_write_input_tokens ?? 0, cacheRead: cached, output: total.output_tokens ?? 0 };
  return {
    id, harness: 'codex', session, model, effort, role: roleOf(prompt.slice(0, 400).toLowerCase()),
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
        const a = claudeAgent(readFileSync(main, 'utf8'), session, session, '', true);
        if (a && a.last >= since) out.push(a);
      }
      for (const f of readdirSync(sdir)) {
        const path = join(sdir, f);
        if (!f.endsWith('.jsonl') || !newer(path, since)) continue;
        let desc = '';
        try { desc = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8')).description ?? ''; } catch {}
        const a = claudeAgent(readFileSync(path, 'utf8'), f.replace(/\.jsonl$/, ''), session, desc);
        if (a && a.last >= since) out.push(a);
      }
    }
  }
  return out;
}

/** Every Codex rollout active since `since`, under sessions/YYYY/MM/DD. */
export function codexAgents(root: string, since: number): Agent[] {
  const out: Agent[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, d.name);
      if (d.isDirectory()) walk(path);
      else if (/^rollout-.*\.jsonl$/.test(d.name) && newer(path, since)) {
        const a = codexAgent(readFileSync(path, 'utf8'), d.name.replace(/\.jsonl$/, ''));
        if (a && a.last >= since) out.push(a);
      }
    }
  };
  walk(root);
  return out;
}
