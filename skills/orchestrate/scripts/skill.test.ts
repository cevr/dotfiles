// The orchestrate skill's docs check: the core stays small, routes by mode, keeps the owner's rules, names
// nothing the machine cut deleted, and every link and script it names exists. Run from anywhere:
// `bun test skills/orchestrate/scripts/skill.test.ts`.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { instructions, ROLES, type Role } from './agents.ts';
import { block as render } from './round-policy.ts';

const SKILL_DIR = resolve(import.meta.dir, '..');
const REPO = resolve(SKILL_DIR, '..', '..');
const read = (path: string) => readFileSync(path, 'utf8');
const skill = read(join(SKILL_DIR, 'SKILL.md'));
const protocol = read(join(SKILL_DIR, 'protocol.md'));
const template = read(join(SKILL_DIR, 'spec-template.md'));
const references = readdirSync(join(SKILL_DIR, 'references'))
  .filter((name) => name.endsWith('.md'))
  .map((name) => join(SKILL_DIR, 'references', name));
const docs = [join(SKILL_DIR, 'SKILL.md'), join(SKILL_DIR, 'protocol.md'), join(SKILL_DIR, 'spec-template.md'), ...references];
const core = `${skill}\n${protocol}`;

const MODES = ['single fix', 'lane', 'batch', 'deep', 'long run'];
const plain = (cell: string) => cell.replace(/[*`]/g, '').trim();

// The caps grew by what nothing-is-hard needs (owner's orchestrator, round 2): a rule is never cut to fit a cap.
test('the core files fit their byte caps', () => {
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
  expect({ skill: bytes(skill) <= 12_500, protocol: bytes(protocol) <= 14_500, template: bytes(template) <= 2_500 }).toEqual({
    skill: true,
    protocol: true,
    template: true,
  });
});

describe('the modes', () => {
  const lines = skill.split('\n');
  const rows = lines.filter((line) => line.startsWith('|')).map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  const table = rows.filter((cells) => MODES.includes(plain(cells[0] ?? '')));

  test('one table names the five modes in order, lane marked the default', () => {
    expect(table.map((cells) => plain(cells[0]!))).toEqual(MODES);
    const lane = table.find((cells) => plain(cells[0]!) === 'lane')!;
    expect(lane.slice(1).join(' ')).toMatch(/\bdefault\b/);
    for (const cells of table.filter((cells) => plain(cells[0]!) !== 'lane')) expect(cells.slice(1).join(' ')).not.toMatch(/\bdefault\b/);
  });

  const heading = (mode: string) => lines.findIndex((line) => /^#{2,4} /.test(line) && plain(line.replace(/^#+ /, '')) === mode);
  const rules = (mode: string) => {
    const at = heading(mode);
    const end = lines.findIndex((line, index) => index > at && /^#{1,4} /.test(line));
    return lines.slice(at + 1, end < 0 ? undefined : end).filter((line) => line.trim() !== '');
  };

  test("each mode's rules sit under its own heading, after the table, in order, in six lines at most", () => {
    const tableAt = lines.findIndex((line) => line.startsWith('|') && plain(line.split('|')[1] ?? '') === 'single fix');
    const at = MODES.map(heading);
    expect(at.every((index) => index > tableAt)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const mode of MODES) expect([mode, rules(mode).length > 0 && rules(mode).length <= 6]).toEqual([mode, true]);
  });

  // Rules a shortening once dropped (nothing-is-hard r1): each pinned in the mode a root reads for it.
  test("lane keeps one land and one full gate per host, and long run keeps the patch-id rule", () => {
    expect(rules('lane').join('\n')).toContain("One land and one full gate per host at a time: the land's merge check runs before its push.");
    for (const mode of ['batch', 'long run']) expect([mode, rules(mode).join('\n')]).toEqual([mode, expect.stringContaining('the same `git patch-id` keeps its verdict')]);
  });

  test('the mode rules link the review pages and the decision trail', () => {
    const modeText = MODES.flatMap(rules).join('\n');
    for (const page of ['../code-review/references/interrogate.md', '../code-review/references/blast-radius.md', 'references/trail.md'])
      expect(modeText).toContain(`](${page})`);
  });
});

describe('the kept rules', () => {
  const kept: ReadonlyArray<readonly [string, RegExp]> = [
    ['a fresh verifier in a clean checkout', /fresh[^.\n]*clean checkout/i],
    ['the focused round gate, each leg under a minute', /focused[^.\n]*each leg under a minute/i],
    ['a receipt', /\breceipt\b/i],
    ['one full gate per host at a time', /one full gate per host at a time/i],
    ['a workspace per unit', /one workspace per unit/i],
    ['verification is Claude Opus only and never Codex', /Verification and review run only on Claude Opus\. When Claude is held, latch and wait; never start a verifier on Codex\./],
    ['deploy is reserved', /reserved[^\n]*\bdeploy\b/i],
    ['publish is reserved', /reserved[^\n]*\bpublish\b/i],
    ['paid runs are reserved', /reserved[^\n]*paid runs/i],
    ['a force-push to a shared branch is reserved', /reserved[^\n]*force-push to a shared branch/i],
    ['non-additive format changes are reserved', /reserved[^\n]*non-additive/i],
    ['a dead worker gives no verdict', /dead worker gives no verdict/i],
    ['a dead verifier never counts as accepted', /A dead verifier never counts as `accepted`/],
    ['the third failed round', /third failed round/i],
    ['owner questions never wait in a dialog', /never wait in a dialog/i],
    ['scope never grows inside a running unit', /Scope never grows inside a running unit/i],
    ['the verifier blocks only on a shown failure', /blocks only on a shown failure/],
  ];
  for (const [name, pattern] of kept) test(name, () => expect(core).toMatch(pattern));

  test("verify-bar's four block classes, word for word, in one passage", () => {
    const classes = ['a failure a run shows a user would hit', 'a red gate, acceptance check or CI', 'data loss', 'a reserved action'];
    expect(core.split(/\n\s*\n/).some((passage) => classes.every((each) => passage.includes(each)))).toBe(true);
  });
});

describe('nothing names what was deleted', () => {
  const deleted: ReadonlyArray<RegExp> = [
    /\bdeparts:/,
    /\(departs/,
    /cadence/i,
    /pipeline/i,
    /FindingUnfolded|VerdictPending|LandPartial|BatchNotDue/,
    /--trend/,
    /machine\.jsonl|ledger/i,
    /formal-opencode/,
  ];
  for (const path of docs)
    test(path.slice(SKILL_DIR.length + 1), () => {
      const text = read(path);
      const drift = path.endsWith('run-rules.md') ? text.replace(/skill drift/gi, '') : text;
      expect([...deleted.filter((pattern) => pattern.test(text)).map(String), ...(/\bdrift\b/i.test(drift) ? ['/drift/'] : [])]).toEqual([]);
    });
});

test("loop and dream name orchestrate's modes, not the deleted machine or its file names", () => {
  const gone: ReadonlyArray<RegExp> = [/(?:through|states of) (?:its|the) machine\b(?!')/i, /Fresh implementor\)/, /`verify-\*\.md`/];
  const said = ['loop', 'dream'].flatMap((name) => {
    const text = read(join(REPO, 'skills', name, 'SKILL.md'));
    return gone.filter((pattern) => pattern.test(text)).map((pattern) => `${name}: ${pattern}`);
  });
  expect(said).toEqual([]);
});

describe('links and scripts resolve', () => {
  /** A link's file: relative to the doc, or a `~/` path into this checkout. */
  const target = (doc: string, link: string) => {
    const path = link.split('#')[0]!;
    if (path.startsWith('~/.claude/skills/')) return join(REPO, 'skills', path.slice('~/.claude/skills/'.length));
    if (path.startsWith('~/Developer/personal/dotfiles/')) return join(REPO, path.slice('~/Developer/personal/dotfiles/'.length));
    return resolve(dirname(doc), path);
  };
  for (const doc of docs)
    test(doc.slice(SKILL_DIR.length + 1), () => {
      const text = read(doc);
      const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!).filter((link) => !/^(https?:|#|mailto:)/.test(link));
      expect(links.filter((link) => !existsSync(target(doc, link)))).toEqual([]);
      const scripts = [...text.matchAll(/([\w.~/-]*?)scripts\/([\w-]+)\.ts/g)].map(([, prefix, name]) =>
        prefix!.endsWith('opencode/') ? join(REPO, 'opencode', 'scripts', `${name}.ts`) : join(SKILL_DIR, 'scripts', `${name}.ts`),
      );
      expect(scripts.filter((path) => !existsSync(path))).toEqual([]);
    });
});

test('protocol.md still makes every role prompt, each smaller than at the base plus its end-of-step rows', () => {
  // Bytes of each role's instructions generated at 2541c442, the base of unit skill-modes. The decision table's rows
  // (round-policy.ts) replaced the prose that said how a step ends, and a rule is never cut to fit: the bound grows by them.
  const BASE: Record<Role, number> = { planner: 9461, implementor: 11411, verifier: 17653 };
  const safety = read(join(REPO, 'skills', 'loop', 'safety.md'));
  for (const role of Object.keys(ROLES) as Role[]) {
    const text = instructions(role, protocol, safety);
    for (const part of [`## ${role[0]!.toUpperCase()}${role.slice(1)}`, '## Ending a step', 'SAFETY (mandatory']) expect(text).toContain(part);
    expect([role, Buffer.byteLength(text, 'utf8') < BASE[role] + Buffer.byteLength(render(role), 'utf8')]).toEqual([role, true]);
  }
});
