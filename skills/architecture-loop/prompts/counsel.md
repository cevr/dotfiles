# Counsel prompt

This is what the batch's reviewer reads: these questions go into the spec's Risks, and the unit's reviewer runs them through the `counsel-review` skill, on the batch's workspace. A fresh read-only agent gets the same prompt when the other model is unreachable, and the ledger row says so. Write the prompt to `<pass dir>/counsel-<batch>.md`.

```
Read `~/.claude/skills/architecture-loop/safety.md` and `<workspace>/NORTH_STAR.md` → Owner rules in full before any action, and follow them.

Never stop to ask the owner, and never end your work waiting for an answer. When a question comes up, read the principles in `~/Developer/personal/dotfiles/principles/` that bear on it, decide by them and `NORTH_STAR.md`, write "decided by <principle>" in your report, and go on. Report only the owner classes in the architecture-loop skill's Autonomy as owner questions, each with your recommendation, and keep working on the rest.

Read-only review of commits `<base>..HEAD` on `<workspace path>` (<one line: what the project is>). Use `git log --oneline <base>..HEAD` and `git show <hash>`. Read NORTH_STAR.md and <ledger path>. Edit no tracked file; a scratch test goes under <pass dir>, so `git status` is clean when you finish.

<One numbered question per risky commit, naming the invariant that could break: behavior a refactor claims to preserve, a scope or subscription that must still close, a message that must apply once and in order, a persisted row that must still decode, a guard that could now report live code as dead, a type that got wider so a wrong program compiles, a test that passes for the wrong reason, a north star a commit quietly broke.>

<For a UI batch, one more question: "Do the changed lines follow `~/.claude/skills/architecture-loop/ui-guidance.md`? Name each violation the change adds, with file:line.">

Real defects only. Per question: OK, or the defect with file:line, a concrete failure (input or event order → wrong output), severity, reproduced yes/no. End with the list of files you read.
```

The apply agent fixes each defect with a test that is red first. The reviewer then reviews that fixup's delta, and the rounds go on until it accepts, or until the third failed round makes the batch stuck and the orchestrator re-plans it. In gent, fixups that merged without a second look were how each pass's regressions reached the next pass. A defect left unfixed gets a written rejection on the ledger.
