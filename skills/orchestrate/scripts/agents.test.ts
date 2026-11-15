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
  expect(strength.some((p) => p.includes('become follow-up units'))).toBe(true);
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

test('the committed agents match protocol.md and safety.md (run bun agents.ts)', () => {
  expect(Object.keys(ROLES) as Role[]).toEqual(['planner', 'implementor', 'verifier']);
  expect(stale()).toEqual([]);
});
