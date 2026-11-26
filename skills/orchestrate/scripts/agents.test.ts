import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentFile, codexFile, instructions, retired, ROLES, stale, type Role } from './agents.ts';

const protocol = `# Worker protocol

Intro for the orchestrator.

## Every role

Hand back a stat block.

## Planner

Plan it.

## Implementor

Build it.

## Verifier

Verify it.
`;
const safety = '# SAFETY\n\nEvery loop agent reads this.\n\nSAFETY (mandatory):\n\n- Write files with Write.\n';

describe('agentFile', () => {
  test("carries the shared section, its own role's section and the safety rules, and no other role", () => {
    const text = agentFile('verifier', protocol, safety);
    expect(text).toStartWith('---\nname: verifier\ndescription: ');
    for (const part of ['## Every role', '## Verifier\n\nVerify it.', '- Write files with Write.']) expect(text).toContain(part);
    for (const part of ['## Planner', '## Implementor', 'Intro for the orchestrator', 'Every loop agent reads this']) expect(text).not.toContain(part);
  });

  test("the Codex file carries the same instructions, with the role's effort and no pinned model", () => {
    const text = codexFile('implementor', protocol, safety);
    expect(text).toContain('name = "implementor"');
    expect(text).toContain('model_reasoning_effort = "max"');
    expect(text).not.toMatch(/^model = /m);
    expect(text).toContain("developer_instructions = '''\nYou are the implementor of one orchestrate unit");
    expect(text).toContain('## Implementor\n\nBuild it.');
    expect(() => codexFile('planner', protocol.replace('Plan it.', "Plan it '''."), safety)).toThrow();
  });

  test('fails loudly when protocol.md loses a section a role needs', () => {
    expect(() => agentFile('verifier', protocol.replace('## Verifier', '## Critic'), safety)).toThrow();
    expect(() => agentFile('verifier', protocol.replace('## Every role', '## Shared'), safety)).toThrow();
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

const readHere = (path: string) => readFileSync(join(import.meta.dir, path), 'utf8');
const realProtocol = readHere('../protocol.md');
const realSafety = readHere('../../loop/safety.md');

test('every role carries the kept rules: the brief is the bar, nothing-is-hard, the refusal rule, the stat block, questions to the orchestrator', () => {
  for (const role of Object.keys(ROLES) as Role[]) {
    const text = instructions(role, realProtocol, realSafety);
    for (const part of [
      'The brief is the whole bar: add no check, gate, sign-off or review round above it.',
      'principle-nothing-is-hard',
      'Hold or block only for a failing run at this head',
      '<role> <unit> r<N>: <verdict> <path of your file>',
      'Head: <40-hex>',
      'go to the orchestrator, never the owner',
      'never work around it',
      "never signal `-1`, 0 or 1",
      'SAFETY (mandatory',
    ])
      expect([role, part, text.includes(part)]).toEqual([role, part, true]);
  }
});

test('the verifier runs, never reviews, and files only what a run proves, in three verdict words', () => {
  const text = instructions('verifier', realProtocol, realSafety);
  for (const part of ['you do not review it: you run it', 'File only what a run proves', 'Leave out what you did not run', '`pass`, `issues`', '`blocked` (what could not run; it never passes)'])
    expect([part, text.includes(part)]).toEqual([part, true]);
  for (const gone of [/Test strength/, /Blocker or Major/, /On base/, /guard:/, /ACCEPTED|CHANGES REQUIRED/]) expect(text).not.toMatch(gone);
});

test('each role prompt is short: the implementor and the verifier near 5k characters', () => {
  for (const role of Object.keys(ROLES) as Role[]) {
    const size = instructions(role, realProtocol, realSafety).length;
    expect([role, size <= 5_600]).toEqual([role, true]);
  }
});

test('the committed agents match protocol.md and safety.md (run bun agents.ts)', () => {
  expect(Object.keys(ROLES) as Role[]).toEqual(['planner', 'implementor', 'verifier']);
  expect(stale()).toEqual([]);
});
