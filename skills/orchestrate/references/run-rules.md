# A run's own rules

A run may keep one rules file, `<run dir>/common.md`, that every worker reads after `protocol.md`. It holds what the skill cannot know about this project. It never restates the skill, and it never overrides it.

## What goes in it

- **Project facts.** The repo and its paths, the gate and test commands, the tool flags, each worker's thread share, the ports, the lock files, the services and how to start them, the reviewers to request, the papercuts the run found (a hook that runs an install, a test that needs a flag).
- **Additions.** A rule the skill has no word on, such as the owner's rules for this project. An owner rule that outlives the run goes to `NORTH_STAR.md` → Owner rules, and the file links it instead of copying it.

## What stays out

- **Anything the skill says.** The roles, the rounds, the hand-back, focused checks, batches, verification, heavy-check shares, the Sabbath, the safety rules. A restated rule goes stale when the skill changes, and the workers then follow the copy.
- **Overrides.** The file never says that it, a spec or a brief wins over the skill, and never pins a skill version ("orchestrate dotfiles c496317").

## Departures

When the run truly needs to work against a skill default, write it as one line:

```
Departs from <the skill's rule, by its name>: <why this run needs it, with the evidence>
```

Each departure is a candidate skill change. At close, offer each one upstream as a follow-up: either the skill takes it (for every run), or the run was wrong and the line goes. The OpenCode plugin lists every `Departs from` line in the run dir's own Markdown files when it tells the root that the skill changed (below), so a departure the skill now covers is found.

On OpenCode a departure can also be stated in the call the batch machine would refuse: `(departs: <why>)` at the end of a role call's description, or `departs: "<why>"` in a `rift` land's input. The plugin lets that call through and records the departure, with the rule it broke and the why, in its ledger (`~/.cache/orchestrate/machine.jsonl`). Write the run's `Departs from` line too when the departure is a standing rule of the run, not a single call.

## When the skill changes

The skill changes while runs are live. Each run dir records the skill version the run last saw, in `<run dir>/skill-version` (the newest commit that touched `skills/orchestrate` in the dotfiles checkout). On OpenCode, when the root goes idle and the installed skill is newer, the orchestrate plugin sends it one note per version: the commit subjects since, the run's departures, and the reconcile below. On another host, check at each batch boundary: `git -C ~/.claude/skills/orchestrate log --oneline $(cat <run dir>/skill-version)..HEAD -- .`, then write the new hash into `skill-version`.

To reconcile:

1. Read the changed parts of `SKILL.md` and `protocol.md`.
2. In the rules file, delete each rule the skill now covers, keep the project facts, and rewrite each rule that now contradicts the skill as a departure, or delete it.
3. Tell running workers only at their next round boundary, in one message, as the skill's Scope rule says.
