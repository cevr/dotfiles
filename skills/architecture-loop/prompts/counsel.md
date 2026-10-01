# Counsel prompt

One round per batch, on the batch's workspace, through the `counsel-review` skill; a fresh read-only agent gets the same prompt when the other model is unreachable. Write the prompt to `<pass dir>/counsel-<batch>.md`.

```
Read `~/.claude/skills/architecture-loop/safety.md` and `<workspace>/NORTH_STAR.md` → Owner rules in full before any action, and follow them.

Read-only review of commits `<base>..HEAD` on `<workspace path>` (<one line: what the project is>). Use `git log --oneline <base>..HEAD` and `git show <hash>`. Read NORTH_STAR.md and <ledger path>. Edit no tracked file; a scratch test goes under <pass dir>, so `git status` is clean when you finish.

<One numbered question per risky commit, naming the invariant that could break: behavior a refactor claims to preserve, a scope or subscription that must still close, a message that must apply once and in order, a persisted row that must still decode, a guard that could now report live code as dead, a type that got wider so a wrong program compiles, a test that passes for the wrong reason, a north star a commit quietly broke.>

Real defects only. Per question: OK, or the defect with file:line, a concrete failure (input or event order → wrong output), severity, reproduced yes/no. End with the list of files you read.
```

The apply agent fixes each defect with a test that is red first, in one fixup round. A defect left unfixed gets a written rejection on the ledger.
