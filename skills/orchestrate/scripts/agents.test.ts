import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentFile, codexFile, instructions, retired, ROLES, stale, type Role } from './agents.ts';
import { block as render } from './round-policy.ts';

const protocol = `# Worker protocol

Intro for the orchestrator.

## Ending a step

End with a hand-back line.

<!-- round-policy v1 protocol: fixture -->
<!-- /round-policy -->

## Rounds

Rounds count.

## Planner

Plan it.

## Implementor

Build it.

## Verifier

Verify it.
`;
const safety = '# SAFETY\n\nEvery loop agent reads this.\n\nSAFETY (mandatory):\n\n- Write files with Write.\n';

describe('agentFile', () => {
  test("carries the shared sections, its own role's section and the safety rules, and no other role", () => {
    const text = agentFile('verifier', protocol, safety);
    expect(text).toStartWith('---\nname: verifier\ndescription: ');
    for (const part of ['## Ending a step', '## Rounds', '## Verifier\n\nVerify it.', '- Write files with Write.']) expect(text).toContain(part);
    for (const part of ['## Planner', '## Implementor', 'Intro for the orchestrator', 'Every loop agent reads this']) expect(text).not.toContain(part);
    // protocol.md's round-policy block becomes this role's policy, and only its own.
    expect(text).toContain(render('verifier'));
    expect(text).not.toContain('<!-- round-policy v1 protocol: fixture -->');
  });

  test('the Codex file carries the same instructions, with the role\'s effort and no pinned model', () => {
    const text = codexFile('implementor', protocol, safety);
    expect(text).toContain('name = "implementor"');
    expect(text).toContain('model_reasoning_effort = "max"');
    expect(text).not.toMatch(/^model = /m);
    expect(text).toContain("developer_instructions = '''\nYou are the implementor of one orchestrate unit.");
    expect(text).toContain('## Implementor\n\nBuild it.');
    expect(() => codexFile('planner', protocol.replace('Plan it.', "Plan it '''."), safety)).toThrow();
  });

  test('fails loudly when protocol.md loses a section a role needs', () => {
    expect(() => agentFile('verifier', protocol.replace('## Verifier', '## Critic'), safety)).toThrow();
  });
});

test("a file written for a role the script no longer has, or under a role's former name, is retired; a hand-written agent is not", () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  const written = agentFile('verifier', protocol, safety);
  writeFileSync(join(dir, 'reviewer.md'), written.replace('name: verifier', 'name: reviewer'));
  writeFileSync(join(dir, 'orchestrate-verifier.md'), written.replace('name: verifier', 'name: orchestrate-verifier'));
  writeFileSync(join(dir, 'verifier.md'), written);
  writeFileSync(join(dir, 'notes.md'), '---\nname: notes\n---\nA hand-written agent.\n');
  expect(retired([dir], ['planner', 'implementor', 'verifier']).sort()).toEqual([join(dir, 'orchestrate-verifier.md'), join(dir, 'reviewer.md')]);
});

test('the verifier blocks only on a shown failure', () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, path), 'utf8');
  const text = instructions('verifier', read('../protocol.md'), read('../../loop/safety.md'));
  const passages = text.split(/\n\s*\n|\n\s*(?:\d+\.|-) /);
  const classes = ['a failure a run shows a user would hit', 'a red gate, acceptance check or CI', 'data loss', 'a reserved action'];
  expect(passages.some((p) => classes.every((c) => p.includes(c)))).toBe(true);

  const strength = passages.filter((p) => p.includes('Test strength'));
  expect(strength.some((p) => p.includes('acceptance narrower than the spec'))).toBe(true);
  expect(strength.some((p) => p.includes('become follow-up units'))).toBe(false);
  for (const p of strength) if (/round \d/.test(p)) expect(p).toContain('from round 1');

  for (const banned of [/From round 3/, /in rounds 1 and 2/, /A rule violation is a Major/]) expect(text).not.toMatch(banned);
  const proofs = text.split(/(?<=\.)\s+/).filter((s) => /Blocker or Major is filed only with/.test(s));
  expect(proofs.length).toBe(1);
  expect(proofs[0]).not.toMatch(/a mutant the tests let through/);
  // The verifier still hunts product failures, and findings.ts still finds its sections.
  for (const kept of ['Attack the change', 'acceptance check exactly as written', 'the sections Blockers and Major']) expect(text).toContain(kept);

  const skill = read('../SKILL.md');
  expect(skill).not.toContain('Tests converge after round 2');
  expect(skill).toContain('blocks only on a shown failure');
});

const readHere = (path: string) => readFileSync(join(import.meta.dir, path), 'utf8');
const realProtocol = readHere('../protocol.md');
const realSafety = readHere('../../loop/safety.md');

/** The whole Markdown paragraph that starts with `lead`: every line up to the next blank line. */
const paragraph = (text: string, lead: string) => text.split(/\n\s*\n/).find((p) => p.trimStart().startsWith(lead))?.trim();

/** The refusal rule as it stood before nothing-is-hard (unit E changes it, with its mechanism), plus the one sentence. */
const REFUSAL =
  '**Refusals.** At the first permission or classifier refusal, stop that step and report the exact `!` command, or the allow rule, that would let it through. Never work around it or ask for permission in chat. A refusal is authority, not difficulty.';

test('every role carries nothing-is-hard, and the whole refusal paragraph is the base rule plus one sentence', () => {
  for (const role of Object.keys(ROLES) as Role[]) {
    const text = instructions(role, realProtocol, realSafety);
    for (const part of [
      'Difficulty is never a reason (principle-nothing-is-hard)',
      'nor does a long context',
      'the assumption cites its principle by name and is never the lesser option for effort',
    ])
      expect([role, text.includes(part)]).toEqual([role, true]);
    expect([role, paragraph(text, '**Refusals.**')]).toEqual([role, REFUSAL]);
    // A prompt rule, not an install-time check: no role is told to enforce anything on install.
    expect([role, /install/i.test(text)]).toEqual([role, false]);
  }
  // Negative control: a sentence on the very next line belongs to the same paragraph, and the pin sees it.
  const widened = realProtocol.replace(REFUSAL, `${REFUSAL}\nThen go on with the rest of the work.`);
  expect(widened).not.toBe(realProtocol);
  expect(paragraph(instructions('implementor', widened, realSafety), '**Refusals.**')).not.toBe(REFUSAL);
});

test('a finding goes by where it came from, in one way in every prompt and the skill that route it', () => {
  // Pair: a weak test the unit wrote, and a written-rule break the base head shows too. Neither fails a round; they route apart.
  const unit = 'the same lane closes in its next round, before that lane takes another unit';
  const base = 'one the base has too (shown at the base head) becomes a follow-up unit';
  for (const role of Object.keys(ROLES) as Role[]) {
    const rounds = paragraph(instructions(role, realProtocol, realSafety), 'A round is one request')!;
    expect([role, rounds.includes('never fails a round, and goes by where it came from')]).toEqual([role, true]);
    expect([role, rounds.includes(unit), rounds.includes(base)]).toEqual([role, true, true]);
  }
  const verifier = instructions('verifier', realProtocol, realSafety);
  expect(verifier).toContain('one the unit\'s change introduced to its lane\'s next round, one the base head shows too to a follow-up unit');
  expect(verifier).toContain('marked `unit` if the unit\'s change introduced it or `base` if the base head shows it too');
  // No unqualified route survives: a sentence that sends these to the same lane names the unit's change as their source.
  for (const role of Object.keys(ROLES) as Role[])
    for (const sentence of instructions(role, realProtocol, realSafety).split(/(?<=\.)\s+/).filter((s) => /same lane|its lane's next round/.test(s)))
      expect([role, /unit's change introduced/.test(sentence)]).toEqual([role, true]);
  // The root's two routing clauses, found by where they stand (the lane's verify step, the verifier's bar), not by the
  // words wanted in them: the old unconditional "Each finding becomes a fix unit." there turns this red.
  expect(skillRoutes(readHere('../SKILL.md'))).toEqual({ lane: [true, true], verify: [true, true] });
});

/** The orchestrator skill's lane-verify and What-blocks bullets: does each route a unit's own finding to its lane and a base one to a follow-up unit? */
function skillRoutes(skill: string) {
  const bullet = (start: string) => {
    const line = skill.split('\n').find((l) => l.startsWith(start));
    if (line === undefined) throw new Error(`no SKILL.md bullet starts ${start}`);
    return [/unit's change introduced[^.;]*(its lane's next round|the same lane)/.test(line), /base head shows too becomes a follow-up unit/.test(line)];
  };
  return { lane: bullet('- When a `land` or `status` answer starts'), verify: bullet('- **Every verify is a fresh verifier') };
}

test('the routing pin turns red on the old unconditional lane route', () => {
  const skill = readHere('../SKILL.md');
  const old = skill.replace(/(- When a `land` or `status` answer starts[^\n]*?start the subagent call it answers\.)[^\n]*/, '$1 Each finding becomes a fix unit.');
  expect(old).not.toBe(skill);
  expect(skillRoutes(old).lane).toEqual([false, false]);
});

test("the principle gives a refusal no disposition of its own: the worker's Refusals rule decides what stops", () => {
  const principle = readHere('../../principle-nothing-is-hard/SKILL.md');
  const bullet = principle.split('\n').find((line) => line.startsWith('- **A refusal is authority, not difficulty.**'))!;
  expect(bullet).toBeDefined();
  expect(refusalDisposition(bullet)).toEqual({ roleFirst: true, ownDisposition: false });
  for (const role of Object.keys(ROLES) as Role[])
    expect([role, paragraph(instructions(role, realProtocol, realSafety), '**Refusals.**')!.startsWith('**Refusals.** At the first permission or classifier refusal, stop that step and report the exact')]).toEqual([role, true]);
  // Both inputs, red: the 22r bullet (a named form is followed; only otherwise the role decides) and 22q's (go on).
  expect(refusalDisposition('- **A refusal is authority, not difficulty.** When it names the accepted form ("commit first", "use a script file"), follow that form. Otherwise your role\'s own rule decides what stops (a worker\'s: the worker protocol\'s Refusals section); this principle changes nothing there.')).toEqual({ roleFirst: false, ownDisposition: true });
  expect(refusalDisposition('- **A refusal is authority, not difficulty.** Stop that action, report it, and go on with the rest of the work.')).toEqual({ roleFirst: false, ownDisposition: true });
});

/**
 * The principle's refusal bullet, for both inputs (a refusal that names an accepted form, and one that names none):
 * does the role's own rule decide first in both, and does the principle itself act (follow a form now, go on)?
 */
function refusalDisposition(bullet: string) {
  const roleFirst = /Whether or not it names an accepted form[^.]*your role's own rule decides/.test(bullet) && bullet.includes("the worker protocol's Refusals section") && /used only in a later step that authorises it/.test(bullet);
  const ownDisposition = /go on|continue|rest of the work|carry on|keep working|follow (that|the) form|Otherwise your role/i.test(bullet);
  return { roleFirst, ownDisposition };
}

test('the committed agents match protocol.md and safety.md (run bun agents.ts)', () => {
  expect(Object.keys(ROLES) as Role[]).toEqual(['planner', 'implementor', 'verifier']);
  expect(stale()).toEqual([]);
});
