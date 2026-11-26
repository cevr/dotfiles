# Unit spec template

One copy per unit, in `<run dir>/<unit>/spec.md`, for a capable reader with no context. The shared rules live in `protocol.md`.

```markdown
# <unit> — spec (orchestrator-owned; agents do not edit it)

Run `<run>` · unit dir `<run dir>/<unit>`

## Goal
<The result, in the owner's words where he gave any.>

## Workspace
<workspace path>, branch `<branch>`, base `<main hash>`.

## Owns / Do not touch
<The files this unit may change; files other units own, and shared resources with their one owner.>

## Acceptance law
<Runnable, red now: the command and the output that means done. A property, a model-based test, or a Quint model when steps interleave.>

## Affected checks
<The touched packages' tests and typecheck, lint of changed files, as commands. Never the full gate.>

## Reserved
<Actions only the orchestrator or the owner takes.>

Finish the whole list; be economical.
```
