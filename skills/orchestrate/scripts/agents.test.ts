import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentFile, codexFile, instructions, retired, ROLES, stale, type Role } from './agents.ts';

const protocol = `# Worker protocol

Intro for the orchestrator.

## Ending a step

End with a hand-back line.

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
      'step is `ready` only when every item of its spec is done',
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

test('a thing not done has exactly three names, and the timebox uses one of them', () => {
  const text = instructions('implementor', realProtocol, realSafety);
  const ending = paragraph(text, "A verifier's line names its batch")!;
  // The three cases a reader can tell apart: a named dependency, the round's own measured limit, or work outside the spec.
  for (const name of ['`waits on <dependency>`', '`continues next round`', '`finding outside the unit`']) expect([name, ending.includes(name)]).toEqual([name, true]);
  expect(ending).toContain('the timebox by the clock, or the run\'s failure cap by its count');
  expect(ending).toContain('Effort is none of these.');
  // Case: the timebox passes with one runnable item unfinished. Timebox says `blocked`, and names the item the way Ending allows.
  expect(paragraph(text, '**Timebox.**')).toContain('hand back `blocked` with `state.md` current, each unfinished item `continues next round`, and `blocked.md` (as Questions says) quoting the clock');
  // The verifier: a required check that could not run is `stuck`; only what lies beyond those checks is Unproven.
  const verifier = instructions('verifier', realProtocol, realSafety);
  expect(verifier).toContain('What this host cannot run, beyond the checks of step 1, goes under Unproven');
  expect(verifier).toContain('a check of step 1 that could not run or ran unclear is `stuck`');
  // A refused item waits on the allow rule the refusal named: the Refusals rule's own report.
  expect(ending).toContain('the allow rule a refusal named');
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
  const skill = readHere('../SKILL.md');
  for (const line of skill.split('\n').filter((l) => /same lane|lane's next round/.test(l) && /finding|proves/.test(l)))
    expect([line.slice(0, 60), /unit's change introduced/.test(line) && /base head shows too becomes a follow-up unit/.test(line)]).toEqual([line.slice(0, 60), true]);
});

test("the principle gives a refusal no disposition of its own: the worker's Refusals rule decides what stops", () => {
  const principle = readHere('../../principle-nothing-is-hard/SKILL.md');
  const bullet = principle.split('\n').find((line) => line.startsWith('- **A refusal is authority, not difficulty.**'))!;
  expect(bullet).toBeDefined();
  // Case: a permission refusal with no accepted form, one refused item, another runnable item. The role rule stops the step;
  // the principle must not tell the worker to go on, and it must point at that rule.
  expect(bullet).not.toMatch(/go on|continue|rest of the work|carry on|keep working/i);
  expect(bullet).toContain("the worker protocol's Refusals section");
  expect(paragraph(instructions('implementor', realProtocol, realSafety), '**Refusals.**')).toContain('stop that step');
});

test('the committed agents match protocol.md and safety.md (run bun agents.ts)', () => {
  expect(Object.keys(ROLES) as Role[]).toEqual(['planner', 'implementor', 'verifier']);
  expect(stale()).toEqual([]);
});
