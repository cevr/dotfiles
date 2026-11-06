#!/usr/bin/env bun
// Mine Claude Code, Codex and OpenCode sessions into a small digest, so a retro
// reads kilobytes of the owner's own words instead of whole transcripts.
//
// Usage: bun mine-sessions.ts [--since <days>d | <ISO date>] [--project <substring>]
//                             [--out <dir>] [--max-mb <n>] [--no-redact] [--no-opencode]
//
//   --since    only transcripts touched since then (default 30d)
//   --project  keep a session whose Claude project dir, Codex cwd or OpenCode directory contains it
//   --out      output dir (default $TMPDIR/mine-sessions)
//   --max-mb   skip transcripts larger than this, and count them (default 200)
//   --no-redact  keep secret-looking strings (default: redacted)
//   --no-opencode  skip OpenCode
//
// Reads every ~/.claude*/projects (both accounts), ~/.codex/sessions, and the
// running OpenCode service's sessions over its HTTP API (mine/opencode.ts; never
// its database), root and child, counting only messages inside the window.
// Writes:
//   messages.jsonl  one line per owner message, slash command, interrupt,
//                   limit error, peer message or OpenCode tool error:
//                   {src, project, session, ts, kind, text}
//   sessions.jsonl  one line per transcript: tokens, compactions, skills,
//                   slash commands, agent spawns, peer messages, files read 4+ times;
//                   an OpenCode one adds parent, agent, model@variant, input, cost,
//                   toolErrors and notices (synthetic messages by source)
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
import {
  bump,
  cleaner,
  isPeer,
  LIMIT,
  newSession,
  settle,
  skillDirsIn,
  skillMentions as mentionsIn,
  skillReads,
  WRAPPED,
  type Message,
  type Session,
} from './mine/classify.ts';
import { mineOpencode, opencodeDigest, probe, serviceEndpoint } from './mine/opencode.ts';

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

const clean = cleaner(redact);

const messages: Message[] = [];
const sessions: Session[] = [];

async function* lines(file: string) {
  yield* createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY });
}

const skillDirs = skillDirsIn(home);
const skillMentions = (text: string) => mentionsIn(text, skillDirs);

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

// OpenCode, through its running service. No service, or one that does not answer, is said in the digest.
let opencodeNote = 'skipped (--no-opencode)';
if (!argv.includes('--no-opencode')) {
  const ep = serviceEndpoint();
  const version = ep && (await probe(ep));
  if (!ep) opencodeNote = 'no service registered ($XDG_STATE_HOME/opencode/service.json)';
  else if (!version) opencodeNote = `the service at ${ep.url} did not answer`;
  else {
    const mined = await mineOpencode(ep, { since, clean, skillDirs });
    const kept = mined.sessions.filter((s) => !project || s.project.includes(project));
    const ids = new Set(kept.map((s) => s.session));
    sessions.push(...kept);
    messages.push(...mined.messages.filter((m) => ids.has(m.session)));
    opencodeNote = `service ${version} at ${ep.url}, ${kept.length} sessions`;
  }
}

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
  `| Source | Project | Session | Sub | Role, model | Cache-read | Compactions | Agents |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ...costly.map(
    (s) =>
      `| ${s.src} | ${s.project} | ${s.session} | ${s.sub ? 'y' : ''} | ${s.agent ? `${s.agent} ${s.model}` : ''} | ${M(s.cacheRead)} | ${s.compactions} | ${s.agents} |`,
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
  `## OpenCode`,
  ``,
  `OpenCode: ${opencodeNote}.`,
  ``,
  ...opencodeDigest(sessions, messages),
].join('\n');
writeFileSync(join(out, 'digest.md'), digest);

console.log(`${messages.length} messages, ${sessions.length} transcripts -> ${out}/{digest.md,messages.jsonl,sessions.jsonl}`);
