// OpenCode sessions, read through the running service's HTTP API, never its
// database. The service registers itself in $XDG_STATE_HOME/opencode/service.json
// ({ url, password }); requests use basic auth as user `opencode`, as the fork's
// own client does (packages/client/src/service-probe.ts).
//
// `opencodeSession` is pure: it takes a session's info and its projected
// messages (GET /api/session/:id/message) and returns the miner's rows, so the
// tests feed it a fixture.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  bump,
  isPeer,
  LIMIT,
  newSession,
  settle,
  skillMentions,
  skillReads,
  WRAPPED,
  type Message,
  type Session,
} from './classify.ts';

export type Endpoint = { url: string; authorization?: string };

/** The running service's address and auth, or undefined when none is registered. */
export function serviceEndpoint(
  file = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'opencode', 'service.json'),
): Endpoint | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const info = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof info.url !== 'string') return undefined;
    const authorization = typeof info.password === 'string' ? `Basic ${btoa(`opencode:${info.password}`)}` : undefined;
    return { url: info.url, authorization };
  } catch {
    return undefined;
  }
}

const get = async (ep: Endpoint, path: string): Promise<any> => {
  const res = await fetch(new URL(path, ep.url), {
    headers: ep.authorization ? { authorization: ep.authorization } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`opencode ${path}: HTTP ${res.status}`);
  return res.json();
};

/** Whether the service answers; its version when it does. */
export const probe = async (ep: Endpoint) => {
  try {
    return String((await get(ep, '/api/info')).version ?? '?');
  } catch {
    return undefined;
  }
};

export type SessionInfo = {
  id: string;
  parentID?: string;
  agent?: string;
  model?: { id: string; providerID?: string; variant?: string };
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  outcome?: string;
  time: { created: number; updated: number };
  title?: string;
  location?: { directory?: string };
};

/** Every session, root and child, updated since `since`, newest first. The list pages newest first by update. */
export async function sessionsSince(ep: Endpoint, since: number): Promise<SessionInfo[]> {
  const out: SessionInfo[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await get(ep, `/api/session?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const data: SessionInfo[] = page.data ?? [];
    for (const s of data) if (s.time.updated >= since) out.push(s);
    if (data.length < 200 || !page.cursor?.next || data.some((s) => s.time.updated < since)) return out;
    cursor = page.cursor.next;
  }
}

/** A session's projected messages, oldest first. A cursor carries its order, so only the first page names it. */
export async function messagesOf(ep: Endpoint, id: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await get(ep, `/api/session/${id}/message?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=asc'}`);
    const data: any[] = page.data ?? [];
    out.push(...data);
    if (data.length < 200 || !page.cursor?.next) return out;
    cursor = page.cursor.next;
  }
}

export type Options = {
  since: number;
  clean: (text: string, n?: number) => string;
  skillDirs: Set<string>;
};

/** `<model>@<variant>`: the variant is the effort the session ran at. */
export const modelLabel = (m?: { id: string; variant?: string }) => (m ? (m.variant && m.variant !== 'default' ? `${m.id}@${m.variant}` : m.id) : '');

const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : undefined);

// The tools a kernel cell called, in order: `tools.read(...)`, `tools.shell.handle(...)`.
const cellTools = (code: string) => [...code.matchAll(/\btools\.(\w+)/g)].map((m) => m[1]!);
const READ_IN_CELL = /\btools\.read\(\s*\{\s*(?:path|filePath|file_path)\s*:\s*["'`]([^"'`]+)["'`]/g;

/** The tool a call's error belongs to: a kernel cell that called one kind of tool names it. */
export const toolOf = (name: string, input: any) => {
  if (name !== 'kernel') return name;
  const used = [...new Set(cellTools(String(input?.code ?? '')))];
  return used.length === 1 ? `kernel:${used[0]}` : 'kernel';
};

/**
 * One OpenCode session's rows for the miner. Only messages created since `since`
 * count, so a session older than the window adds only its window's usage.
 * A child session's user turns are its parent's brief, not the owner's; a root
 * session's user turns are the owner's unless another agent wrote them (isPeer).
 */
export function opencodeSession(info: SessionInfo, msgs: any[], opts: Options): { session: Session; messages: Message[] } {
  const { since, clean } = opts;
  const sub = Boolean(info.parentID);
  const project = info.location?.directory ?? '';
  const st = newSession('opencode', project, info.id, sub, 0);
  st.parent = info.parentID;
  st.agent = info.agent;
  st.model = modelLabel(info.model);
  st.input = 0;
  st.cost = 0;
  st.toolErrors = {};
  st.notices = {};
  const out: Message[] = [];
  const reads: Record<string, number> = {};
  const used = new Set<string>();
  const push = (ts: string | undefined, kind: Message['kind'], text: string) =>
    out.push({ src: 'opencode', project, session: info.id, ts, kind, text });
  const models = new Map<string, number>();
  for (const m of msgs) {
    const at: number = m.time?.created ?? 0;
    if (at < since) continue;
    const ts = iso(at);
    st.first ??= ts;
    st.last = ts;
    switch (m.type) {
      case 'compaction':
        if (m.status === 'completed') st.compactions++;
        break;
      case 'skill':
        bump(st.skills, String(m.name ?? m.skill));
        break;
      case 'synthetic':
        bump(st.notices!, String(m.metadata?.source ?? 'other'));
        // Mail is another session writing to this one: a peer.
        if (m.metadata?.source === 'mail' && !sub) {
          st.peer++;
          push(ts, 'peer', clean(String(m.text ?? '')));
        }
        break;
      case 'user': {
        for (const s of m.skills ?? []) used.add(String(s?.name ?? s?.id ?? s));
        if (sub) break;
        const text = String(m.text ?? '').trim();
        if (!text) break;
        if (isPeer(text)) {
          st.peer++;
          push(ts, 'peer', clean(text));
        } else if (text.startsWith('/') && /^\/[\w:-]+(?:\s|$)/.test(text)) {
          const name = text.slice(1).split(/\s/)[0]!;
          bump(st.slash, name);
          if (opts.skillDirs.has(name)) used.add(name);
          push(ts, 'slash', clean(text));
        } else if (!WRAPPED.some((w) => text.startsWith(w))) {
          st.human++;
          for (const name of skillMentions(text, opts.skillDirs)) used.add(name);
          push(ts, 'msg', clean(text));
        }
        break;
      }
      case 'assistant': {
        const t = m.tokens ?? {};
        st.input! += t.input ?? 0;
        st.cacheRead += t.cache?.read ?? 0;
        st.cacheWrite += t.cache?.write ?? 0;
        st.output += (t.output ?? 0) + (t.reasoning ?? 0);
        st.cost! += m.cost ?? 0;
        if (m.model) {
          const label = modelLabel(m.model);
          models.set(label, (models.get(label) ?? 0) + 1);
        }
        for (const e of [m.error, m.retry?.error].filter(Boolean)) {
          const text = `${e.type ?? ''}: ${e.message ?? ''}`;
          if (e.type === 'aborted') {
            st.interrupts++;
            if (!sub) push(ts, 'interrupt', '');
          } else if (LIMIT.test(text)) {
            st.limits++;
            if (!sub) push(ts, 'limit', clean(text, 160));
          }
        }
        for (const c of m.content ?? []) {
          if (c?.type !== 'tool') continue;
          const input = c.state?.input ?? {};
          const raw = JSON.stringify(input);
          if (c.name === 'subagent' || /\btools\.subagent\(/.test(String(input.code ?? ''))) st.agents++;
          if (c.name === 'skill') bump(st.skills, String(input.id ?? input.name ?? input.skill ?? '?'));
          else for (const id of String(input.code ?? '').matchAll(/\btools\.skill\(\s*\{\s*(?:id|name)\s*:\s*["'`]([\w:-]+)/g)) bump(st.skills, id[1]!);
          for (const name of skillReads(raw)) used.add(name);
          if (c.name === 'read' && typeof input.path === 'string') bump(reads, input.path);
          for (const r of String(input.code ?? '').matchAll(READ_IN_CELL)) bump(reads, r[1]!);
          if (c.state?.status === 'error') {
            const tool = toolOf(c.name, input);
            bump(st.toolErrors!, tool);
            const e = c.state.error ?? {};
            push(ts, 'tool-error', clean(`${tool}: ${e.type ?? ''}: ${e.message ?? ''}`, 200));
          }
        }
        break;
      }
    }
  }
  // The model the session ran most, which a mid-session switch can change from its info's.
  const top = [...models].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top) st.model = top;
  settle(st, used);
  st.rereads = Object.fromEntries(Object.entries(reads).filter(([, n]) => n >= 4));
  // A child's own messages never count as the owner's; its tool errors still say what broke.
  return { session: st, messages: sub ? out.filter((m) => m.kind === 'tool-error') : out };
}

/** Count each root's children: the subagents it started, whether its calls show it or not. */
export function countChildren(sessions: Session[]) {
  const byId = new Map(sessions.filter((s) => s.src === 'opencode').map((s) => [s.session, s]));
  const kids = new Map<string, number>();
  for (const s of byId.values()) if (s.parent) kids.set(s.parent, (kids.get(s.parent) ?? 0) + 1);
  for (const [id, n] of kids) {
    const p = byId.get(id);
    if (p) p.agents = Math.max(p.agents, n);
  }
}

const M = (n: number) => `${(n / 1e6).toFixed(1)}M`;

/** The digest's OpenCode section: per role and model, then tool errors by tool and by message, then notices. */
export function opencodeDigest(sessions: Session[], messages: Message[]): string[] {
  const oc = sessions.filter((s) => s.src === 'opencode');
  if (!oc.length) return [];
  type Row = { n: number; input: number; read: number; write: number; output: number; cost: number; compacted: number; compactions: number; errors: number; limits: number };
  const rows = new Map<string, Row>();
  for (const s of oc) {
    const k = `${s.sub ? s.agent ?? '?' : `root:${s.agent ?? '?'}`}\t${s.model ?? ''}`;
    const r = rows.get(k) ?? { n: 0, input: 0, read: 0, write: 0, output: 0, cost: 0, compacted: 0, compactions: 0, errors: 0, limits: 0 };
    r.n++;
    r.input += s.input ?? 0;
    r.read += s.cacheRead;
    r.write += s.cacheWrite;
    r.output += s.output;
    r.cost += s.cost ?? 0;
    r.compactions += s.compactions;
    if (s.compactions) r.compacted++;
    r.errors += Object.values(s.toolErrors ?? {}).reduce((a, b) => a + b, 0);
    r.limits += s.limits;
    rows.set(k, r);
  }
  const tools: Record<string, number> = {};
  const notices: Record<string, number> = {};
  for (const s of oc) {
    for (const [k, n] of Object.entries(s.toolErrors ?? {})) tools[k] = (tools[k] ?? 0) + n;
    for (const [k, n] of Object.entries(s.notices ?? {})) notices[k] = (notices[k] ?? 0) + n;
  }
  // An error's message with its paths, numbers and quoted strings blanked, so one kind groups.
  const shape = (t: string) => t.replace(/(["'`]).*?\1/g, '"…"').replace(/\/[\w./-]+/g, '/…').replace(/\d+/g, '#').slice(0, 110);
  const byShape = new Map<string, { n: number; sessions: Set<string> }>();
  for (const m of messages) {
    if (m.src !== 'opencode' || m.kind !== 'tool-error') continue;
    const g = byShape.get(shape(m.text)) ?? { n: 0, sessions: new Set() };
    g.n++;
    g.sessions.add(m.session);
    byShape.set(shape(m.text), g);
  }
  const sorted = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  return [
    `### By role and model`,
    ``,
    `A root row is a main session (\`root:<agent>\`); the rest are subagents by their agent. Tokens and API cost are the harness's own, inside the window.`,
    ``,
    `| Role | Model@variant | Sessions | Input | Cache-read | Cache-write | Output | Cost $ | Compacted | Compactions | Tool errors | Limit errors |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...[...rows]
      .sort((a, b) => b[1].cost - a[1].cost)
      .map(([k, r]) => {
        const [role, model] = k.split('\t');
        return `| ${role} | ${model} | ${r.n} | ${M(r.input)} | ${M(r.read)} | ${M(r.write)} | ${M(r.output)} | ${r.cost.toFixed(0)} | ${r.compacted} | ${r.compactions} | ${r.errors} | ${r.limits} |`;
      }),
    ``,
    `### Tool errors`,
    ``,
    `By tool (a kernel cell that called one kind of tool is named \`kernel:<tool>\`): ${sorted(tools).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}.`,
    ``,
    ...[...byShape]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 25)
      .map(([k, g]) => `- ${g.n}x in ${g.sessions.size} sessions: ${k}`),
    ``,
    `Notices (synthetic messages by source): ${sorted(notices).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}.`,
    ``,
  ];
}

/** Mine every OpenCode session the service holds for the window, `concurrency` at a time. */
export async function mineOpencode(ep: Endpoint, opts: Options, concurrency = 4) {
  const infos = await sessionsSince(ep, opts.since);
  const sessions: Session[] = [];
  const messages: Message[] = [];
  let next = 0;
  const worker = async () => {
    while (next < infos.length) {
      const info = infos[next++]!;
      const r = opencodeSession(info, await messagesOf(ep, info.id), opts);
      sessions.push(r.session);
      messages.push(...r.messages);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  countChildren(sessions);
  return { sessions, messages };
}
