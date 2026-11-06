# Risk questions

These questions go into the batch spec's Risks. The unit's verifier checks each one directly in its clean checkout of the batch's head, along with its acceptance check (orchestrate's `protocol.md`, Verifier). Write them to `<pass dir>/risks-<batch>.md` and paste them into the spec.

```
Read-only review of commits `<base>..HEAD` on `<workspace path>` (<one line: what the project is>). Read NORTH_STAR.md and <ledger path>.

<One numbered question per risky commit, naming the invariant that could break: behavior a refactor claims to preserve, a scope or subscription that must still close, a message that must apply once and in order, a persisted row that must still decode, a guard that could now report live code as dead, a type that got wider so a wrong program compiles, a test that passes for the wrong reason, a north star a commit quietly broke.>

<For a UI batch, one more question: "Do the changed lines follow `~/.claude/skills/loop/ui-guidance.md`? Name each violation the change adds, with file:line.">

Real defects only. Per question: OK, or the defect with file:line, a concrete failure (input or event order → wrong output), severity, and its proof at the head.
```

The apply agent fixes each defect with a test that is red first. The verifier then checks that fixup's delta, and the rounds go on until it accepts, or until the third failed round makes the batch stuck and the orchestrator re-plans it. Fixups that merge without a second look carry each pass's regressions into the next. A defect left unfixed gets a written rejection on the ledger.
