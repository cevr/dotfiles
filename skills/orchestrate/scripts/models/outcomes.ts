// What each orchestrate worker's phase produced, joined to its agent. A worker
// ends with `<role> <unit> r<N>: <verdict> <path>` (protocol.md), and each
// verdict file states its verdict on its first line, so the join reads files,
// not prose. A worker with no hand-back line is joined by the unit and round its
// codex-bridge thread named, else by the unit files its prompt names, or by a
// working directory that holds the unit's log.md. A batch's verifier
// (`verifier batch-<k> r1`) judges every unit of its batch, so it joins each
// of them (joinUnits).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Agent } from './sources.ts';

export type Phase = 'plan' | 'implement' | 'verify' | 'decide';
export type Outcome = { phase: Phase; unit: string; round: number; result: string; fate: string };

// `reviewer` is the verifier's former name. An older run also ran a separate check after
// review, also named verifier, whose file is `round-N-verify.md` (`pass` or `fail`); both
// read as the verify phase, and that file tells the older check apart (Join `check`).
const ROLE: Record<string, Phase> = { planner: 'plan', implementor: 'implement', reviewer: 'verify', verifier: 'verify' };
const CHECK_FILE = /^(?:round-\d+-verify|verify-\d+)\.md$/;
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

export type Join = { phase: Phase; dir: string; unit: string; round: number; own?: string; check?: boolean };

const logAt = (unit: string) => { try { return statSync(join(unit, 'log.md')).mtimeMs; } catch { return 0; } };

/**
 * The phase this agent ran, its unit and round: from its last message, else its bridge thread's
 * unit (`find` lists the unit dirs of that name), else its prompt.
 */
export function joinUnit(a: Agent, final: string, find: (unit: string) => string[] = () => []): Join | undefined {
  const hands = [...final.matchAll(HAND_BACK)];
  const h = hands[hands.length - 1];
  const handDir = h && dirname(home(h[4]));
  const handUnit = handDir && unitOf(handDir);
  if (h && handUnit) {
    const check = CHECK_FILE.test(basename(h[4])) || h[3] === 'pass' || h[3] === 'fail';
    return { phase: ROLE[h[1]], dir: handDir, unit: handUnit, round: Number(h[2]), own: h[3], ...(check ? { check } : {}) };
  }
  if (a.role === 'root') return undefined;
  const phase: Phase | undefined = a.role === 'plan' || a.role === 'implement' || a.role === 'verify' ? a.role : undefined;
  if (!phase) return undefined;
  const rounds = [...a.prompt.matchAll(/round-(\d+)-/g), ...a.prompt.matchAll(/\bround[ -]?(\d+)\b/gi)].map((x) => Number(x[1]));
  const round = rounds.length ? Math.max(...rounds) : 1;
  const named = [...a.prompt.matchAll(UNIT_FILE)].map((m) => home(m[1]));
  const said = /\bunit dir(?:ectory)? is `?((?:~|\/)[^\s`'"]+?)\/?\.?(?=[\s`'"]|$)/i.exec(a.prompt)?.[1];
  const dirs = [...named, ...(said ? [home(said)] : []), ...(a.cwd ? [a.cwd] : [])];
  if (a.unit) {
    // A dir the prompt names wins; else the unit of that name whose log changed nearest the agent's end.
    const dir = dirs.find((d) => basename(unitOf(d) ?? '') === a.unit);
    const unit = dir ? unitOf(dir)! : find(a.unit).filter(isUnit).sort((x, y) => Math.abs(logAt(x) - a.last) - Math.abs(logAt(y) - a.last))[0];
    if (unit) return { phase, dir: dir ?? unit, unit, round: Math.max(a.round ?? 1, round) };
  }
  for (const dir of dirs) {
    const unit = unitOf(dir);
    if (unit) return { phase, dir, unit, round };
  }
  return undefined;
}

// A batch's files sit in the run dir: `batch-<k>.md` (the orchestrator's hand-off) and
// `batch-<k>-findings.md` (the verifier's verdicts). A batch verifier's hand-back names the
// findings file; its prompt names the hand-off.
const BATCH_FILE = /^batch-(\d+)(?:-findings)?\.md$/;
const BATCH_NAMED = /((?:~|\/)[^\s'"`()<>\[\]]*?)\/batch-(\d+)(?:-findings)?\.md/;
const ROUND_FILE = /((?:~|\/)?[^\s'"`()<>\[\]|*]*?)round-(\d+)-(findings|request)\.md/g;

/**
 * Every unit a batch judged, with its round: the requests `batch-<k>.md` lists, the findings
 * `batch-<k>-findings.md` lists, and each unit whose log moved it to `verify rN batch-<k>.md`.
 */
export function batchUnits(run: string, k: number, files = read): Join[] {
  const rounds = new Map<string, number>();
  const add = (dir: string | undefined, round: number) => {
    if (dir && unitOf(dir)) rounds.set(dir, Math.max(rounds.get(dir) ?? 0, round));
  };
  // A path in a batch file is absolute, or relative to the run dir or to the repo that holds it.
  const dirOf = (prefix: string) => {
    if (/^[~/]/.test(prefix)) return home(prefix);
    const rel = prefix.replace(/\/$/, '');
    if (!rel) return undefined;
    const inRun = rel.split('/').indexOf(basename(run));
    return [join(run, rel), inRun >= 0 ? join(run, ...rel.split('/').slice(inRun + 1)) : undefined].find((d) => d && unitOf(d));
  };
  for (const [name, kind] of [[`batch-${k}.md`, 'request'], [`batch-${k}-findings.md`, 'findings']])
    for (const m of (files(join(run, name)) ?? '').matchAll(ROUND_FILE)) if (m[3] === kind) add(dirOf(m[1]), Number(m[2]));
  let subdirs: string[] = [];
  try { subdirs = readdirSync(run, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(run, d.name)); } catch {}
  const moved = new RegExp(`→\\s*verify r(\\d+)\\b.*\\bbatch-${k}\\.md`, 'g');
  for (const dir of subdirs) for (const m of (files(join(dir, 'log.md')) ?? '').matchAll(moved)) add(dir, Number(m[1]));
  return [...rounds].map(([dir, round]) => ({ phase: 'verify' as const, dir, unit: unitOf(dir)!, round }));
}

/**
 * Every unit and round this agent's phase judged: a batch verifier's are its batch's units, by
 * its hand-back line or, with none, the batch file its prompt names; any other agent's is joinUnit's.
 */
export function joinUnits(a: Agent, final: string, find: (unit: string) => string[] = () => [], files = read): Join[] {
  const hands = [...final.matchAll(HAND_BACK)];
  const h = hands[hands.length - 1];
  const k = h && (BATCH_FILE.exec(basename(h[4])) ?? /^batch-(\d+)$/.exec(h[0].split(' ')[1]))?.[1];
  if (k) return batchUnits(dirname(home(h[4])), Number(k), files);
  const named = !h && a.role === 'verify' ? BATCH_NAMED.exec(a.prompt) : null;
  if (named) return batchUnits(home(named[1]), Number(named[2]), files);
  const j = joinUnit(a, final, find);
  return j ? [j] : [];
}

/**
 * What the phase produced. A verifier's result is its findings' verdict; an older run's separate
 * check's is its `pass` or `fail`, and an `accepted` that check failed is `escaped`.
 */
export function outcomeOf(j: Join, files = read): Outcome {
  const at = (...names: string[]) => names.map((n) => files(join(j.dir, n))).find((t) => t !== undefined);
  const findings = verdictOf(at(`round-${j.round}-findings.md`, `review-${j.round}.md`));
  const check = verdictOf(at(`round-${j.round}-verify.md`, `verify-${j.round}.md`));
  const unit = j.unit.split('/').slice(-2).join('/');
  const fate = fateOf(files(join(j.unit, 'log.md')));
  const result =
    j.phase === 'plan' ? fate
    : j.phase === 'implement' ? (findings === 'accepted' && check === 'fail' ? 'failed check' : findings ?? 'no findings')
    : j.check ? check ?? j.own ?? 'no file'
    : (findings ?? j.own) === 'accepted' && check === 'fail' ? 'escaped' : findings ?? j.own ?? 'no file';
  return { phase: j.phase, unit, round: j.round, result, fate };
}
