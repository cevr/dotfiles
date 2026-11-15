# A run's own rules

A run may keep one rules file, `<run dir>/common.md`, that every worker reads after `protocol.md`. It holds what the skill cannot know about this project, and nothing else:

- **Project facts.** The repo and its paths, the gate and test commands, tool flags, each worker's thread share, ports, lock files, services and how to start them, reviewers, the papercuts the run found (a hook that runs an install, a test that needs a flag).
- **Owner additions** the skill has no word on. One that outlives the run goes to `NORTH_STAR.md` → Owner rules, and the file links it.

It never restates the skill (a copy goes stale when the skill changes) and never overrides it. When the run truly needs to work against a skill default, it writes one line:

```
Departs from <the skill's rule, by its name>: <why this run needs it, with the evidence>
```

Each departure is offered upstream at close: the skill takes it, or the line goes.

## When the skill changes

On OpenCode, the plugin's skill-moved note tells the root when the installed skill is newer than the one the run saw (`<run dir>/skill-version`). Reconcile the rules file once: delete what the skill now covers, keep the project facts, and write each remaining departure in the form above. A running worker hears of the change only at its next round boundary, in one message.
