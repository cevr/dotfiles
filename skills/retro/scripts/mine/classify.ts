// What every harness's reader shares: the row shapes the miner writes, and the
// rules that tell the owner's words from a peer's, a wrapper's and a secret.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export type Kind = 'msg' | 'slash' | 'interrupt' | 'limit' | 'peer' | 'tool-error';
export type Message = { src: string; project: string; session: string; ts?: string; kind: Kind; text: string };
export type Session = {
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
  // OpenCode only: the harness records these per session.
  parent?: string;
  agent?: string;
  model?: string; // `<model>@<variant>`, the variant being the effort it ran at
  input?: number;
  cost?: number;
  toolErrors?: Record<string, number>;
  notices?: Record<string, number>; // synthetic messages by source: subagent, shell, wake, mail, questions
};

export const newSession = (src: string, proj: string, session: string, sub: boolean, bytes: number): Session => ({
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

export const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
export const LIMIT = /hit your [\w -]*limit|usage limit|rate limit|rate-limit|weekly limit|quota|\b429\b|limit reached|cannot be used for \d+s/i;

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
/** A clipper that collapses whitespace and, when `redact`, blanks secret-looking strings. */
export const cleaner = (redact: boolean) => (text: string, n = 300) => {
  const t = redact ? text.replace(SECRET, '[REDACTED]') : text;
  return t.replace(/\s+/g, ' ').trim().slice(0, n);
};

// Turns that are not the owner typing: harness wrappers and notifications.
export const WRAPPED = [
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
    // OpenCode: a session that moved or restarted another, and a wake's fresh session
    String.raw`^You (?:were|are being) restarted\b|^OpenCode was (?:rebuilt|restarted|updated)\b`,
    String.raw`^You are taking over a [\w ]+ session\b|^You are a subagent spawned by\b`,
    String.raw`\bStarted by wake w\d+`,
    // probe prompts a script sends a model to test it
    String.raw`^"?Reply with exactly\b`,
    String.raw`\bNonce \d+`,
    // the PR-checker monitor, and the wake mod's alarm, monitor and wake-up notices
    String.raw`A review or checker state changed`,
    String.raw`^\[wake-up `,
    String.raw`^⏰ ?(?:Wake|Monitor|Alarm|Latch)\b`,
    String.raw`^Alarm w[0-9a-z]{6}\b`,
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
export const isPeer = (text: string) => PEER.test(text) || RECEIPT_MARKS.filter((m) => m.test(text)).length >= 3;

/** The skill dirs under `<home>/.claude/skills`: the names a `$name` or `/name` mention can mean. */
export const skillDirsIn = (home: string) =>
  new Set(
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
export const skillReads = (text: string) => [...text.matchAll(SKILL_PATH)].map((m) => m[1]!);
export const skillMentions = (text: string, dirs: Set<string>) =>
  [...text.matchAll(/(?:^|\s)[$/]([a-z][\w-]*)/g)].map((m) => m[1]!).filter((n) => dirs.has(n));
/** Read- and mention-based use counts once per session, unless a skill call already counted it. */
export const settle = (st: Session, used: Set<string>) => {
  for (const name of used) st.skills[name] ??= 1;
};
