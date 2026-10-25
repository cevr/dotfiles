import { describe, expect, test } from 'bun:test';
import { agentFile, ROLES, stale, type Role } from './agents.ts';

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

## Verifier

Prove it.
`;
const safety = '# SAFETY\n\nEvery loop agent reads this.\n\nSAFETY (mandatory):\n\n- Write files with Write.\n';

describe('agentFile', () => {
  test("carries the shared sections, its own role's section and the safety rules, and no other role", () => {
    const text = agentFile('reviewer', protocol, safety);
    expect(text).toStartWith('---\nname: orchestrate-reviewer\ndescription: ');
    for (const part of ['## Ending a step', '## Rounds', '## Reviewer\n\nReview it.', '- Write files with Write.']) expect(text).toContain(part);
    for (const part of ['## Planner', '## Implementor', '## Verifier', 'Intro for the orchestrator', 'Every loop agent reads this']) expect(text).not.toContain(part);
  });

  test('fails loudly when protocol.md loses a section a role needs', () => {
    expect(() => agentFile('verifier', protocol.replace('## Verifier', '## Prover'), safety)).toThrow();
  });
});

test('the committed agents match protocol.md and safety.md (run bun agents.ts)', () => {
  expect(Object.keys(ROLES) as Role[]).toHaveLength(4);
  expect(stale()).toEqual([]);
});
