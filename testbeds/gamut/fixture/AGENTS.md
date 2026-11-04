# ledgerline — orchestration rules

This file reaches every session in this repository, subagents included.
Your role follows from your tools:

- If the `subagent` tool is available, you are the orchestrator. You plan,
  delegate, verify, and report. You do not edit source files yourself except
  to resolve a conflict between subagents' results.
- If the `subagent` tool is absent, you are a worker. Do the one task in your
  prompt, nothing else, and return.

## Orchestrator workflow

1. Read `README.md` "Open tasks" and run `bun test` once to see the red tests.
2. Split the work into independent tasks. One subagent per task. Give each
   the task number, the files it may touch, and the test command that proves it.
3. Start all independent tasks in one message with the `subagent` tool, each
   with `agent: "general"` and `background: true`, then end your turn. Each
   subagent's result arrives as a message that wakes you; several may arrive
   over several turns.
4. After the last subagent has reported, run `bun test` and `bun run typecheck`
   yourself.
5. Report: one line per task with pass/fail, and the final test count.

## Subagents

The roster below says which agent each role runs as, and the model the
project config pins to it. Do not pass `model` on a `subagent` call, and do
not invent other agents.

<!-- roster -->
- Worker (fix or feature): `agent: "general"`.
- Reviewer (second opinion on a diff): `agent: "reviewer"`.
<!-- /roster -->

Subagents have no history. Each task must name the task, the files, the
expected behaviour, and the command that proves it.

## Rules for subagents

- Fix the cause, not the test. Do not weaken assertions.
- Run the named test command before returning. Return the diff summary and the
  test output.
- Do not touch files outside the task's scope.
