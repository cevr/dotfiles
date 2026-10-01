# Guardrails

Read by the guardrails sweep, by any apply batch that builds a check, and at triage.

A defect class found twice gets a check, built in the batch that fixes the second instance, placed by what can see it:

| The defect is                                                   | The check lives in                                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A syntactic pattern (a banned call, an import shape)            | A lint rule, tested red on a fixture. A rule true of any Effect code goes upstream to `oxlint-plugin-effect` (`~/Developer/personal/effect-oxlint`), released there, and the project consumes the release; a project rule that duplicates an upstream one switches to upstream. A project-only rule goes in the repo's own oxlint plugin. |
| A layer importing one it must not                               | `no-restricted-imports` overrides in `.oxlintrc.json`, or the repo's boundary guard.                                                                                                |
| A wrong program the types could reject                          | The types, proved by an `@ts-expect-error` line in a `*.types.ts` test.                                                                                                             |
| A wrong result only running code shows                          | A test at the tier where the risk lives, red on the defect.                                                                                                                         |
| A test that waits a fixed time                                  | `effect/noFixedWaitInTests`; the test waits on the condition it asserts.                                                                                                            |
| A merge that took one side's file whole                         | A merge audit after every merge (redo git's merge of the two parents; print each line a parent added that the merge dropped).                                                      |
| A doc naming what the code no longer has                        | A docs test over the READMEs and project skills.                                                                                                                                    |

Hooks stay fast: pre-commit checks staged files only and finishes in seconds. A slow check goes into the gate and CI, never into pre-commit or pre-push.
