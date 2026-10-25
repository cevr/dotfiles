// What each orchestrate worker's phase produced, joined to its agent. A worker
// ends with `<role> <unit> r<N>: <verdict> <path>` (protocol.md), and each
// verdict file states its verdict on its first line, so the join reads files,
// not prose. A worker with no hand-back line is joined by the unit files its
// prompt names, or by a working directory that holds the unit's log.md.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Agent } from './sources.ts';

export type Phase = 'plan' | 'implement' | 'review' | 'verify' | 'decide';
export type Outcome = { phase: Phase; unit: string; round: number; result: string; fate: string };

const ROLE: Record<string, Phase> = { planner: 'plan', implementor: 'implement', reviewer: 'review', verifier: 'verify' };
const HAND_BACK = /\b(planner|implementor|reviewer|verifier) \S+ r(\d+): ([a-z()]+) (\S+\.md)/g;
const UNIT_FILE = /((?:~|\/)[^\s'"`()<>\[\]]*?)\/(?:spec|state|blocked|round-(\d+)-(?:request|findings|verify))\.md/g;

const home = (p: string) => resolve(p.replace(/^~(?=\/)/, homedir()));
const read = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } };

// First words of a verdict, in protocol.md's spelling and the older review-N.md one.
const VERDICT: [RegExp, string][] = [
  [/^(accept(ed)?|approved?)\b/, 'accepted'],
  [/^(changes|revise|request(ed)? changes|fixups)\b/, 'changes'],
  [/^(stuck|pass|fail)\b/, ''],
];

/** `Verdict: CHANGES REQUIRED` → `changes`, from the first line; a missing file or no verdict → undefined. */
export const verdictOf = (text: string | undefined) => {
  const first = (text?.split('\n').find((l) => l.trim()) ?? '').replace(/^[#*\s]+/, '').replace(/^verdict:?[*\s]*/i, '').toLowerCase();
  for (const [re, name] of VERDICT) {
    const m = re.exec(first);
    if (m) return name || m[1];
  }
  return undefined;
};

/** The unit's fate from its log: merged, dropped, or the state it stopped in. */
export const fateOf = (log: string | undefined) => {
  if (!log) return 'unknown';
  if (/→\s*(?:merged|done)\b|\bmerged [0-9a-f]{7}/.test(log)) return 'merged';
  if (/→\s*dropped\b/.test(log)) return 'dropped';
  return 'open';
};

// A unit dir holds log.md; a run dir holds plan.md beside its own log. A rewrite keeps its
// round files in a folder under the unit (`<unit>/rewrite/`), so the unit is the nearest
// folder up with a log.
const isUnit = (dir: string) => existsSync(join(dir, 'log.md')) && !existsSync(join(dir, 'plan.md'));
const unitOf = (dir: string) => [dir, dirname(dir)].find(isUnit);

export type Join = { phase: Phase; dir: string; unit: string; round: number; own?: string };

/** The phase this agent ran, its unit and round, from its last message or else its prompt. */
export function joinUnit(a: Agent, final: string): Join | undefined {
  const hands = [...final.matchAll(HAND_BACK)];
  const h = hands[hands.length - 1];
  const handDir = h && dirname(home(h[4]));
  const handUnit = handDir && unitOf(handDir);
  if (h && handUnit) return { phase: ROLE[h[1]], dir: handDir, unit: handUnit, round: Number(h[2]), own: h[3] };
  if (a.role === 'root') return undefined;
  const phase: Phase | undefined = a.role === 'plan' || a.role === 'implement' || a.role === 'review' || a.role === 'verify' ? a.role : undefined;
  if (!phase) return undefined;
  const rounds = [...a.prompt.matchAll(/round-(\d+)-/g), ...a.prompt.matchAll(/\bround[ -]?(\d+)\b/gi)].map((x) => Number(x[1]));
  const round = rounds.length ? Math.max(...rounds) : 1;
  const named = [...a.prompt.matchAll(UNIT_FILE)].map((m) => home(m[1]));
  const said = /\bunit dir(?:ectory)? is `?((?:~|\/)[^\s`'"]+?)\/?\.?(?=[\s`'"]|$)/i.exec(a.prompt)?.[1];
  for (const dir of [...named, ...(said ? [home(said)] : []), ...(a.cwd ? [a.cwd] : [])]) {
    const unit = unitOf(dir);
    if (unit) return { phase, dir, unit, round };
  }
  return undefined;
}

/** What the phase produced. A reviewer's `accepted` that its verifier failed is `escaped`. */
export function outcomeOf(j: Join, files = read): Outcome {
  const at = (...names: string[]) => names.map((n) => files(join(j.dir, n))).find((t) => t !== undefined);
  const review = verdictOf(at(`round-${j.round}-findings.md`, `review-${j.round}.md`));
  const verify = verdictOf(at(`round-${j.round}-verify.md`, `verify-${j.round}.md`));
  const unit = j.unit.split('/').slice(-2).join('/');
  const fate = fateOf(files(join(j.unit, 'log.md')));
  const result =
    j.phase === 'plan' ? fate
    : j.phase === 'implement' ? (review === 'accepted' && verify === 'fail' ? 'failed verify' : review ?? 'no review')
    : j.phase === 'review' ? ((review ?? j.own) === 'accepted' && verify === 'fail' ? 'escaped' : review ?? j.own ?? 'no file')
    : verify ?? j.own ?? 'no file';
  return { phase: j.phase, unit, round: j.round, result, fate };
}
