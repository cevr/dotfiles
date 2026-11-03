import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentFile, codexFile, retired, ROLES, stale, type Role } from './agents.ts';

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

## Reviewer

Review it.
`;
const safety = '# SAFETY\n\nEvery loop agent reads this.\n\nSAFETY (mandatory):\n\n- Write files with Write.\n';

describe('agentFile', () => {
  test("carries the shared sections, its own role's section and the safety rules, and no other role", () => {
    const text = agentFile('reviewer', protocol, safety);
    expect(text).toStartWith('---\nname: orchestrate-reviewer\ndescription: ');
    for (const part of ['## Ending a step', '## Rounds', '## Reviewer\n\nReview it.', '- Write files with Write.']) expect(text).toContain(part);
    for (const part of ['## Planner', '## Implementor', 'Intro for the orchestrator', 'Every loop agent reads this']) expect(text).not.toContain(part);
  });

  test('the Codex file carries the same instructions, with the role\'s effort and no pinned model', () => {
    const text = codexFile('implementor', protocol, safety);
    expect(text).toContain('name = "orchestrate-implementor"');
    expect(text).toContain('model_reasoning_effort = "max"');
    expect(text).not.toMatch(/^model = /m);
    expect(text).toContain("developer_instructions = '''\nYou are the implementor of one orchestrate unit.");
    expect(text).toContain('## Implementor\n\nBuild it.');
    expect(() => codexFile('planner', protocol.replace('Plan it.', "Plan it '''."), safety)).toThrow();
  });

  test('fails loudly when protocol.md loses a section a role needs', () => {
    expect(() => agentFile('reviewer', protocol.replace('## Reviewer', '## Critic'), safety)).toThrow();
  });
});

test("a file written for a role the script no longer has is retired; a hand-written agent is not", () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  const written = agentFile('reviewer', protocol, safety);
  writeFileSync(join(dir, 'orchestrate-verifier.md'), written.replace('orchestrate-reviewer', 'orchestrate-verifier'));
  writeFileSync(join(dir, 'orchestrate-reviewer.md'), written);
  writeFileSync(join(dir, 'orchestrate-notes.md'), '---\nname: orchestrate-notes\n---\nA hand-written agent.\n');
  expect(retired([dir], ['planner', 'implementor', 'reviewer'])).toEqual([join(dir, 'orchestrate-verifier.md')]);
});

test('the committed agents match protocol.md and safety.md (run bun agents.ts)', () => {
  expect(Object.keys(ROLES) as Role[]).toEqual(['planner', 'implementor', 'reviewer']);
  expect(stale()).toEqual([]);
});
