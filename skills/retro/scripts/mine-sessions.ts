#!/usr/bin/env bun
// Mine Claude Code and Codex transcripts into a small digest, so a retro reads
// kilobytes of the owner's own words instead of whole transcripts.
//
// Usage: bun mine-sessions.ts [--since <days>d | <ISO date>] [--project <substring>]
//                             [--out <dir>] [--max-mb <n>] [--no-redact]
//
//   --since    only transcripts touched since then (default 30d)
//   --project  keep a session whose Claude project dir or Codex cwd contains it
//   --out      output dir (default $TMPDIR/mine-sessions)
//   --max-mb   skip transcripts larger than this, and count them (default 200)
//   --no-redact  keep secret-looking strings (default: redacted)
//
// Reads every ~/.claude*/projects (both accounts) and ~/.codex/sessions.
// Writes:
//   messages.jsonl  one line per owner message, slash command, interrupt,
//                   limit error or peer message: {src, project, session, ts, kind, text}
//   sessions.jsonl  one line per transcript: tokens, compactions, skills,
//                   slash commands, agent spawns, peer messages, files read 4+ times
//   digest.md       totals, the costliest sessions, and the owner's repeated
//                   messages ranked by how many sessions repeat them
//
// A `peer` message is a user turn another agent wrote (an orchestrator, an
// advisor, a subagent hand-back, a lock or gate receipt, a tagged notice, a role
// brief, a PR watcher, or a broadcast: one text in 3+ sessions within 15 min).
// It is counted per session and kept out of owner counts and repeated groups.
// Skills count Claude `Skill` calls, plus once per session per skill: a Claude
// `Read` or Codex command naming `skills/<name>/SKILL.md`, and a `$<name>` or
// `/<name>` token in an owner message when <name> is a dir in ~/.claude/skills.
// Skills and slash commands are detected on the full text, before clipping.

import { Glob } from 'bun';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const sinceArg = flag('--since') ?? '30d';
const since = /^\d+d$/.test(sinceArg) ? Date.now() - Number.parseInt(sinceArg, 10) * 864e5 : Date.parse(sinceArg);
if (Number.isNaN(since)) {
  console.error(`--since: expected <days>d or a date, got ${sinceArg}`);
  process.exit(2);
}
const project = flag('--project');
const out = flag('--out') ?? join(tmpdir(), 'mine-sessions');
const maxBytes = Number(flag('--max-mb') ?? 200) * 1024 * 1024;
const redact = !argv.includes('--no-redact');
const home = homedir();

const SECRET = new RegExp(
  [
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`,
    String.raw`\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{12,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
    String.raw`\bAKIA[0-9A-Z]{12,}`,
    String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?`,
    String.raw`\bBearer\s+\S+`,
    String.raw`\b[A-Za-z0-9_]*(?:api[_-]?key|token|secret|passw(?:or)?d)[A-Za-z0-9_]*\s*[=:]\s*\S+`,
    // long mixed-case-and-digit runs: keys with no known prefix (git hashes are lowercase hex, kept)
    String.raw`\b(?=[A-Za-z0-9_+-]*[A-Z])(?=[A-Za-z0-9_+-]*[a-z])(?=[A-Za-z0-9_+-]*\d)[A-Za-z0-9_+-]{32,}={0,2}`,
  ].join('|'),
  'gi',
);
const clean = (text: string, n = 300) => {
  const t = redact ? text.replace(SECRET, '[REDACTED]') : text;
  return t.replace(/\s+/g, ' ').trim().slice(0, n);
};

type Kind = 'msg' | 'slash' | 'interrupt' | 'limit' | 'peer';
type Message = { src: string; project: string; session: string; ts?: string; kind: Kind; text: string };
type Session = {
  src: string;
  project: string;
  session: string;
  sub: boolean;
  bytes: number;
  first?: string;
  last?: string;
  human: number;
  peer: number;
  interrupts: number;
  compactions: number;
  limits: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  skills: Record<string, number>;
  slash: Record<string, number>;
  agents: number;
  rereads: Record<string, number>;
  skipped?: true;
};

const messages: Message[] = [];
const sessions: Session[] = [];
const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
const LIMIT = /hit your [\w -]*limit|usage limit|rate limit|weekly limit|quota|\b429\b|limit reached/i;

async function* lines(file: string) {
  yield* createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY });
}

const newSession = (src: string, proj: string, session: string, sub: boolean, bytes: number): Session => ({
  src,
  project: proj,
  session,
  sub,
  bytes,
  human: 0,
  peer: 0,
  interrupts: 0,
  compactions: 0,
  limits: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  skills: {},
  slash: {},
  agents: 0,
  rereads: {},
});

// Turns that are not the owner typing: harness wrappers and notifications.
const WRAPPED = [
  '<local-command',
  '<system-reminder',
  '<task-notification',
  '<bash-',
  '<user-prompt-submit-hook',
  '<agent-notification',
  '<monitor',
  'Caveat:',
  'This session is being continued',
];

// Turns another agent wrote: orchestrator and advisor messages, subagent
// hand-backs, cross-session relays, PR watchers, and lock or gate receipts.
const PEER = new RegExp(
  [
    String.raw`^<(?:cross-session-message|teammate-message)`,
    String.raw`^\[(?:Advisor|Subagent hand-back|Orchestrator|Peer)\b`,
    String.raw`^Another Claude session sent a message`,
    String.raw`^Delegated task node:`,
    String.raw`reached a terminal state`,
    String.raw`^Act as the [\w -]*sub-agent`,
    String.raw`^Update on pull request #\d+`,
    String.raw`^(?:Peer|Advisor|Root)\b[\w /-]{0,30}\b(?:context|update|note|release|direct)`,
    String.raw`^From [\w-]+ \(?w\d+:p\w+`,
    // lock and gate receipts
    String.raw`released the lock|\block (?:is )?released|\bslot (?:is )?released`,
    String.raw`\b(?:READY|RELEASED?)\b`,
    String.raw`^Round \d+ ready:`,
    // tagged notices and briefs one agent sends another
    String.raw`^\[[A-Z][^\]\n]{2,200}\]`,
    String.raw`^\[[A-Z][\w ]{2,40};`,
    String.raw`^Root\b|^(?:Advisor|Peer|Reviewer|Verifier|Implementor|Planner)\b[:,]`,
    String.raw`^Context handoff \(`,
    String.raw`^Read (?:and follow )?\S*\/\S+ (?:in full|first)\b`,
    String.raw`^You are an? [\w -]{0,40}\b(?:reviewer|implementor|implementer|verifier|planner|worker|agent)\b`,
    String.raw`Reply with nothing`,
    String.raw`^(?:From|Follow-up from|Restarted by) (?:the )?[\w -]{2,30} (?:session|on the \w+)\b`,
    String.raw`^(?:Peer completion|Advisor decisions) from\b`,
  ].join('|'),
);

// A receipt: one agent reporting exact state to another. Three or more of its
// marks (hashes, UTC times, absolute paths, lock and verdict words) and it is
// not the owner typing.
const RECEIPT_MARKS = [
  /\b[0-9a-f]{7,40}\b[\s\S]*\b[0-9a-f]{7,40}\b/,
  /\[REDACTED\]/,
  /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b|\bUTC\b/,
  /(?:^|\s)(?:\/tmp|\/home|~)\/[\w.-]+\/\S+/,
  /\b(?:lock|flock|gate|receipt|released?|sealed|immutable|ACCEPT|REQUEST_CHANGES|finite|staged)\b/,
  /\b(?:tree|parent|patch|SHA-?256|PID|exits?|verified|retained|frozen|pinned)\b/,
];
const isPeer = (text: string) => PEER.test(text) || RECEIPT_MARKS.filter((m) => m.test(text)).length >= 3;

const skillDirs = new Set(
  (() => {
    try {
      return readdirSync(join(home, '.claude', 'skills'), { withFileTypes: true })
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
        .map((d) => d.name);
    } catch {
      return [];
    }
  })(),
);
const SKILL_PATH = /skills\/([\w-]+)\/SKILL\.md/g;
const skillReads = (text: string) => [...text.matchAll(SKILL_PATH)].map((m) => m[1]!);
const skillMentions = (text: string) =>
  [...text.matchAll(/(?:^|\s)[$/]([a-z][\w-]*)/g)].map((m) => m[1]!).filter((n) => skillDirs.has(n));
// Read- and mention-based use counts once per session, unless a Skill call already counted it.
const settle = (st: Session, used: Set<string>) => {
  for (const name of used) st.skills[name] ??= 1;
};

const listFiles = (dir: string, pattern: string) => {
  try {
    return [...new Glob(pattern).scanSync({ cwd: dir, absolute: true })];
  } catch {
    return [];
  }
};
const fresh = (file: string) => {
  try {
    const s = statSync(file);
    return s.mtimeMs >= since ? s.size : undefined;
  } catch {
    return undefined;
  }
};

async function claude(store: string) {
  const root = join(home, store, 'projects');
  const src = store.replace(/^\./, '');
  const files = [
    ...listFiles(root, '*/*.jsonl').map((f) => [f, false] as const),
    ...listFiles(root, '*/*/subagents/*.jsonl').map((f) => [f, true] as const),
  ];
  for (const [file, sub] of files) {
    const proj = file.slice(root.length + 1).split('/')[0]!;
    if (project && !proj.includes(project)) continue;
    const bytes = fresh(file);
    if (bytes === undefined) continue;
    const st = newSession(src, proj, file.split('/').pop()!.replace(/\.jsonl$/, ''), sub, bytes);
    sessions.push(st);
    if (bytes > maxBytes) {
      st.skipped = true;
      continue;
    }
    const seen = new Set<string>();
    const reads: Record<string, number> = {};
    const used = new Set<string>();
    for await (const line of lines(file)) {
      if (line === '') continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const ts: string | undefined = e.timestamp;
      if (ts) {
        st.first ??= ts;
        st.last = ts;
      }
      if (e.type === 'system' && e.subtype === 'compact_boundary') {
        st.compactions++;
        continue;
      }
      const m = e.message ?? {};
      if (e.type === 'assistant') {
        if (e.isApiErrorMessage) {
          const text = (m.content ?? []).map((b: any) => b?.text ?? '').join(' ');
          if (LIMIT.test(text)) {
            st.limits++;
            if (!sub) messages.push({ src, project: proj, session: st.session, ts, kind: 'limit', text: clean(text, 160) });
          }
        }
        if (m.id && !seen.has(m.id)) {
          seen.add(m.id);
          const u = m.usage ?? {};
          st.cacheRead += u.cache_read_input_tokens ?? 0;
          st.cacheWrite += u.cache_creation_input_tokens ?? 0;
          st.output += u.output_tokens ?? 0;
        }
        for (const b of m.content ?? []) {
          if (b?.type !== 'tool_use') continue;
          if (b.name === 'Skill') bump(st.skills, String(b.input?.skill));
          else if (b.name === 'Agent' || b.name === 'Task') st.agents++;
          else if (b.name === 'Read') {
            const path = String(b.input?.file_path);
            bump(reads, path);
            for (const name of skillReads(path)) used.add(name);
          }
        }
        continue;
      }
      if (e.type !== 'user' || sub || e.isMeta || e.isCompactSummary || e.isSidechain) continue;
      if (e.origin?.kind && e.origin.kind !== 'human') continue;
      // SDK sessions (`okra counsel`, scripts) carry prompts a program wrote, not the owner.
      if (String(e.entrypoint ?? '').startsWith('sdk')) continue;
      const c = m.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        if (c.some((b: any) => b?.type === 'tool_result')) continue;
        text = c
          .filter((b: any) => b?.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
      }
      text = text.trim();
      if (!text) continue;
      const cmd = /<command-name>(.*?)<\/command-name>/.exec(text);
      if (cmd) {
        const name = cmd[1]!.trim();
        bump(st.slash, name);
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? '';
        messages.push({ src, project: proj, session: st.session, ts, kind: 'slash', text: clean(`${name} ${args}`) });
      } else if (text.startsWith('[Request interrupted')) {
        st.interrupts++;
        messages.push({ src, project: proj, session: st.session, ts, kind: 'interrupt', text: '' });
      } else if (isPeer(text)) {
        st.peer++;
        messages.push({ src, project: proj, session: st.session, ts, kind: 'peer', text: clean(text) });
      } else if (!WRAPPED.some((w) => text.startsWith(w))) {
        st.human++;
        for (const name of skillMentions(text)) used.add(name);
        messages.push({ src, project: proj, session: st.session, ts, kind: 'msg', text: clean(text) });
      }
    }
    settle(st, used);
    st.rereads = Object.fromEntries(Object.entries(reads).filter(([, n]) => n >= 4));
  }
}

async function codex() {
  const root = join(home, '.codex', 'sessions');
  for (const file of listFiles(root, '**/*.jsonl')) {
    const bytes = fresh(file);
    if (bytes === undefined) continue;
    const st = newSession('codex', '', file.split('/').pop()!.replace(/\.jsonl$/, ''), false, bytes);
    if (bytes > maxBytes) {
      st.skipped = true;
      sessions.push(st);
      continue;
    }
    let exec = false;
    let total: any;
    const pending: Message[] = [];
    const seen = new Set<string>();
    const used = new Set<string>();
    for await (const line of lines(file)) {
      // Most lines are tool traffic; parse only the kinds this digest reads.
      const head = line.slice(0, 400);
      if (/"(custom_tool_call|function_call|item_completed)"/.test(head)) {
        if (!line.includes('SKILL.md')) continue;
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        const p = e.payload ?? {};
        // The call's own text, never its output: a listing or a grep result names skills it did not use.
        const text =
          p.type === 'custom_tool_call'
            ? p.input
            : p.type === 'function_call'
              ? p.arguments
              : p.item?.type === 'CommandExecution'
                ? p.item.command
                : undefined;
        for (const name of skillReads(String(text ?? ''))) used.add(name);
        continue;
      }
      if (!/"(session_meta|user_message|user|token_count|compacted|error|stream_error|turn_aborted)"/.test(head))
        continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const ts: string | undefined = e.timestamp;
      if (ts) {
        st.first ??= ts;
        st.last = ts;
      }
      const p = e.payload ?? {};
      if (e.type === 'session_meta') {
        st.project ||= p.cwd ?? '';
        if (p.source && typeof p.source === 'object' && 'subagent' in p.source) st.sub = true;
        if (p.source === 'exec') exec = true;
      } else if (e.type === 'compacted') st.compactions++;
      else if (p.type === 'token_count') total = p.info?.total_token_usage ?? total;
      else if (p.type === 'error' || p.type === 'stream_error') {
        const text = String(p.message ?? '');
        if (LIMIT.test(text)) {
          st.limits++;
          pending.push({ src: 'codex', project: '', session: st.session, ts, kind: 'limit', text: clean(text, 160) });
        }
      } else if (p.type === 'turn_aborted') {
        st.interrupts++;
      } else if (p.type === 'user_message' || (p.type === 'message' && p.role === 'user')) {
        // Older rollouts log an `event_msg` user_message; newer ones only the `response_item`.
        const text = (
          p.type === 'user_message'
            ? String(p.message ?? '')
            : (p.content ?? [])
                .filter((b: any) => b?.type === 'input_text' || b?.type === 'text')
                .map((b: any) => b.text)
                .join('\n')
        ).trim();
        if (!text || text.startsWith('# AGENTS.md') || seen.has(text.slice(0, 200))) continue;
        seen.add(text.slice(0, 200));
        // `okra counsel` and other exec runs are prompts a program wrote, not the owner.
        if (exec) continue;
        if (isPeer(text)) {
          st.peer++;
          pending.push({ src: 'codex', project: '', session: st.session, ts, kind: 'peer', text: clean(text) });
          continue;
        }
        if (text.startsWith('<')) continue;
        st.human++;
        for (const name of skillMentions(text)) used.add(name);
        pending.push({ src: 'codex', project: '', session: st.session, ts, kind: 'msg', text: clean(text) });
      }
    }
    if (project && !st.project.includes(project)) continue;
    settle(st, used);
    if (total) {
      st.cacheRead = total.cached_input_tokens ?? 0;
      st.output = total.output_tokens ?? 0;
    }
    sessions.push(st);
    if (!st.sub) for (const m of pending) messages.push({ ...m, project: st.project });
  }
}

const claudeStores = readdirSync(home).filter((d) => /^\.claude[\w-]*$/.test(d) && existsSync(join(home, d, 'projects')));
for (const store of claudeStores) await claude(store);
await codex();

mkdirSync(out, { recursive: true });
// A transcript touched since `since` can hold older turns; keep only the window.
const inWindow = messages.filter((m) => !m.ts || Date.parse(m.ts) >= since);
messages.length = 0;
messages.push(...inWindow);
messages.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));

// A broadcast: the same text in 3 or more sessions within 15 minutes. The owner
// types into one session at a time; an orchestrator fans one notice out.
const key = (t: string) =>
  t
    .toLowerCase()
    .replace(/[`'"*_]/g, '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
const BROADCAST_MS = 15 * 60e3;
const byKey = new Map<string, Message[]>();
for (const m of messages) if (m.kind === 'msg' && m.text.length >= 12 && m.ts) byKey.set(key(m.text), [...(byKey.get(key(m.text)) ?? []), m]);
const bySession = new Map(sessions.map((s) => [s.session, s]));
for (const group of byKey.values()) {
  const fanned = group.filter((m) => {
    const near = group.filter((o) => Math.abs(Date.parse(o.ts!) - Date.parse(m.ts!)) <= BROADCAST_MS);
    return new Set(near.map((o) => o.session)).size >= 3;
  });
  for (const m of fanned) {
    m.kind = 'peer';
    const st = bySession.get(m.session);
    if (st) {
      st.human--;
      st.peer++;
    }
  }
}
writeFileSync(join(out, 'messages.jsonl'), messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
writeFileSync(join(out, 'sessions.jsonl'), sessions.map((s) => JSON.stringify(s)).join('\n') + '\n');

// Repeated directions: group the owner's messages by the same normalized key.
const groups = new Map<string, { text: string; count: number; sessions: Set<string> }>();
for (const m of messages) {
  if (m.kind !== 'msg' || m.text.length < 12) continue;
  const g = groups.get(key(m.text)) ?? { text: m.text, count: 0, sessions: new Set() };
  g.count++;
  g.sessions.add(m.session);
  groups.set(key(m.text), g);
}
const repeated = [...groups.values()]
  .filter((g) => g.sessions.size >= 2)
  .sort((a, b) => b.sessions.size - a.sessions.size || b.count - a.count)
  .slice(0, 60);

const M = (n: number) => `${(n / 1e6).toFixed(1)}M`;
const bySrc = new Map<
  string,
  { n: number; sub: number; human: number; peer: number; read: number; compactions: number; limits: number; skipped: number }
>();
for (const s of sessions) {
  const t = bySrc.get(s.src) ?? { n: 0, sub: 0, human: 0, peer: 0, read: 0, compactions: 0, limits: 0, skipped: 0 };
  t.n++;
  if (s.sub) t.sub++;
  t.human += s.human;
  t.peer += s.peer;
  t.read += s.cacheRead;
  t.compactions += s.compactions;
  t.limits += s.limits;
  if (s.skipped) t.skipped++;
  bySrc.set(s.src, t);
}
const skills: Record<string, { uses: number; sessions: number }> = {};
for (const s of sessions)
  for (const [k, n] of Object.entries(s.skills)) {
    const t = (skills[k] ??= { uses: 0, sessions: 0 });
    t.uses += n;
    t.sessions++;
  }
const costly = [...sessions].sort((a, b) => b.cacheRead - a.cacheRead).slice(0, 15);

const digest = [
  `# Session digest`,
  ``,
  `Since ${new Date(since).toISOString().slice(0, 10)}${project ? `, project ~ ${project}` : ''}. Secrets ${redact ? 'redacted' : 'NOT redacted'}. Files: messages.jsonl, sessions.jsonl.`,
  ``,
  `## Totals`,
  ``,
  `| Source | Transcripts | Subagent | Owner msgs | Peer msgs | Cache-read | Compactions | Limit errors | Skipped (size) |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ...[...bySrc].map(
    ([src, t]) =>
      `| ${src} | ${t.n} | ${t.sub} | ${t.human} | ${t.peer} | ${M(t.read)} | ${t.compactions} | ${t.limits} | ${t.skipped} |`,
  ),
  ``,
  `## Costliest transcripts`,
  ``,
  `| Source | Project | Session | Sub | Cache-read | Compactions | Agents |`,
  `| --- | --- | --- | --- | --- | --- | --- |`,
  ...costly.map(
    (s) => `| ${s.src} | ${s.project} | ${s.session} | ${s.sub ? 'y' : ''} | ${M(s.cacheRead)} | ${s.compactions} | ${s.agents} |`,
  ),
  ``,
  `## Skills used`,
  ``,
  `Uses, then sessions. Claude Skill calls count each call; a SKILL.md read or a $/slash mention counts once per session.`,
  ``,
  Object.entries(skills)
    .sort((a, b) => b[1].sessions - a[1].sessions || b[1].uses - a[1].uses)
    .map(([k, t]) => `${k} ${t.uses}/${t.sessions}`)
    .join(', ') || 'none',
  ``,
  `## Repeated owner messages (2+ sessions)`,
  ``,
  `Each is a candidate direction to encode. Check it against the skills, principles and AGENTS.md before proposing it.`,
  ``,
  ...repeated.map((g) => `- ${g.sessions.size} sessions, ${g.count}x: ${g.text.slice(0, 160)}`),
  ``,
].join('\n');
writeFileSync(join(out, 'digest.md'), digest);

console.log(`${messages.length} messages, ${sessions.length} transcripts -> ${out}/{digest.md,messages.jsonl,sessions.jsonl}`);
